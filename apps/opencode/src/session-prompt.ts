import { Effect, Schema } from "effect";

const ModelRefSchema = Schema.Struct({
  providerID: Schema.String,
  modelID: Schema.String,
  variant: Schema.optional(Schema.String),
});

const MessageInfoSchema = Schema.Struct({
  role: Schema.String,
  agent: Schema.optional(Schema.String),
  model: Schema.optional(ModelRefSchema),
});

const SessionMessageSchema = Schema.Struct({
  info: Schema.optional(MessageInfoSchema),
});

const SessionMessagesPayloadSchema = Schema.Struct({ data: Schema.Array(SessionMessageSchema) });

const PromptPartSchema = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
  synthetic: Schema.optional(Schema.Boolean),
});

type PromptPart = typeof PromptPartSchema.Type;

type SessionPromptContext = {
  readonly agent: string;
  readonly model: { readonly providerID: string; readonly modelID: string };
  readonly variant?: string;
};

export type TuiSessionPromptClient = {
  readonly session: {
    readonly messages: (input: { readonly sessionID: string }) => Promise<unknown>;
    readonly prompt: (input: {
      readonly sessionID: string;
      readonly agent: string;
      readonly model: { readonly providerID: string; readonly modelID: string };
      readonly variant?: string;
      readonly noReply: boolean;
      readonly parts: Array<PromptPart>;
    }) => Promise<unknown>;
  };
};

class SessionPromptContextError extends Schema.TaggedError<SessionPromptContextError>()(
  "SessionPromptContextError",
  {
    sessionID: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

class SessionPromptSendError extends Schema.TaggedError<SessionPromptSendError>()(
  "SessionPromptSendError",
  {
    sessionID: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

const parseSessionMessagesPayload = (sessionID: string, payload: unknown) =>
  Schema.decodeUnknown(SessionMessagesPayloadSchema)(
    Array.isArray(payload) ? { data: payload } : payload,
  ).pipe(
    Effect.map((parsed) => parsed.data),
    Effect.mapError(
      (cause) =>
        new SessionPromptContextError({
          sessionID,
          message: "Failed to parse session messages response.",
          cause,
        }),
    ),
  );

const latestPromptContext = (
  sessionID: string,
  messages: ReadonlyArray<typeof SessionMessageSchema.Type>,
) =>
  Effect.sync((): SessionPromptContext | undefined => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const info = messages[index]?.info;
      if (!info || info.role !== "user" || !info.agent || !info.model) continue;

      return {
        agent: info.agent,
        model: { providerID: info.model.providerID, modelID: info.model.modelID },
        ...(info.model.variant === undefined ? {} : { variant: info.model.variant }),
      };
    }

    return undefined;
  }).pipe(
    Effect.flatMap((context) =>
      context === undefined
        ? Effect.fail(
            new SessionPromptContextError({
              sessionID,
              message: "No user message with agent/model context exists in the session.",
            }),
          )
        : Effect.succeed(context),
    ),
  );

const readPromptContext = Effect.fn("background-tasks-tui.readPromptContext")(function* (
  client: TuiSessionPromptClient,
  sessionID: string,
) {
  const payload = yield* Effect.tryPromise({
    try: () => client.session.messages({ sessionID }),
    catch: (cause) =>
      new SessionPromptContextError({
        sessionID,
        message: "Failed to read session messages.",
        cause,
      }),
  });

  const messages = yield* parseSessionMessagesPayload(sessionID, payload);
  return yield* latestPromptContext(sessionID, messages);
});

export const promptWithSessionContext = Effect.fn(
  "background-tasks-tui.promptWithSessionContext",
)(function* (
  client: TuiSessionPromptClient,
  sessionID: string,
  input: {
    readonly noReply: boolean;
    readonly parts: ReadonlyArray<PromptPart>;
  },
) {
  const context = yield* readPromptContext(client, sessionID);
  yield* Effect.tryPromise({
    try: () =>
      client.session.prompt({
        sessionID,
        agent: context.agent,
        model: context.model,
        ...(context.variant === undefined ? {} : { variant: context.variant }),
        noReply: input.noReply,
        parts: [...input.parts],
      }),
    catch: (cause) =>
      new SessionPromptSendError({
        sessionID,
        message: "Failed to send context-safe session prompt.",
        cause,
      }),
  });
});
