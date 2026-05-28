#!/usr/bin/env bun

import { Args, CliConfig, CommandDescriptor, HelpDoc, Options, ValidationError } from "@effect/cli";
import { BunContext } from "@effect/platform-bun";
import {
  getCliTask,
  listCliTasks,
  readCliTaskLogs,
  resolveCliStorePaths,
  restartCliTask,
  startCliTask,
  stopCliTask,
  waitForCliTask,
  type CliStartInput,
  type CliStorePaths,
} from "@skastr0/background-tasks-core/cli-store";
import { CommandInputError, type BackgroundTaskError } from "@skastr0/background-tasks-core";
import { Effect, JSONSchema, Option, ParseResult, Schema } from "effect";
import { readFile, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";

const cliVersion = "0.1.0";
const executableName = "background-tasks";
const defaultLogLines = 100;

const outputModes = ["auto", "inline", "artifact"] as const;
type OutputMode = (typeof outputModes)[number];

interface CliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly readStdin: () => Promise<string>;
}

export interface RunCliOptions {
  readonly io?: Partial<CliIo>;
  readonly paths?: CliStorePaths;
}

export interface RunCliResult {
  readonly exitCode: number;
  readonly command: string;
}

interface ArtifactRecord {
  readonly key: string;
  readonly label: string;
  readonly kind: string;
  readonly absolute_path: string;
  readonly relative_path: string;
  readonly size_bytes: number;
  readonly created_at: string;
}

type EnvelopeError = {
  readonly type: string;
  readonly message: string;
  readonly details?: unknown;
};

type CommandSuccess = {
  readonly ok: true;
  readonly command: string;
  readonly data: unknown;
};

type CommandFailure = {
  readonly ok: false;
  readonly command: string;
  readonly error: EnvelopeError;
};

type CommandOutput =
  | {
      readonly kind: "envelope";
      readonly command: string;
      readonly data: unknown;
      readonly exitCode?: number;
    }
  | {
      readonly kind: "stream";
      readonly command: string;
      readonly frames: readonly unknown[];
      readonly exitCode?: number;
    };

const defaultIo: CliIo = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  readStdin: () => Bun.stdin.text(),
};

const makeIo = (io: Partial<CliIo> | undefined): CliIo => ({
  stdout: io?.stdout ?? defaultIo.stdout,
  stderr: io?.stderr ?? defaultIo.stderr,
  readStdin: io?.readStdin ?? defaultIo.readStdin,
});

const NonEmptyString = Schema.String.pipe(Schema.minLength(1));
const PositiveInt = Schema.Int.pipe(Schema.positive());
const TaskId = NonEmptyString;
const CliTaskStatus = Schema.Literal("running", "exited", "killed", "failed");

const StartPayload = Schema.Struct({
  id: Schema.optional(NonEmptyString),
  name: Schema.optional(NonEmptyString),
  command: NonEmptyString,
  args: Schema.optional(Schema.Array(Schema.String)),
  workdir: Schema.optional(NonEmptyString),
  env: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })),
  tags: Schema.optional(Schema.Array(Schema.String)),
  parentSessionId: Schema.optional(NonEmptyString),
  notifyOnExit: Schema.optional(Schema.Boolean),
});
type StartPayload = typeof StartPayload.Type;
const StartInput = Schema.Union(StartPayload, Schema.Array(StartPayload));
type StartInput = typeof StartInput.Type;

const StatusPayload = Schema.Struct({
  id: TaskId,
});
type StatusPayload = typeof StatusPayload.Type;

const ListPayload = Schema.Struct({
  ids: Schema.optional(Schema.Array(TaskId)),
  status: Schema.optional(CliTaskStatus),
  tag: Schema.optional(NonEmptyString),
  tags: Schema.optional(Schema.Array(NonEmptyString)),
});
type ListPayload = typeof ListPayload.Type;

const LogsPayload = Schema.Struct({
  id: TaskId,
  lines: Schema.optional(PositiveInt),
});
type LogsPayload = typeof LogsPayload.Type;

const StopPayload = Schema.Struct({
  id: TaskId,
});
type StopPayload = typeof StopPayload.Type;
const StopInput = Schema.Union(StopPayload, Schema.Array(StopPayload));
type StopInput = typeof StopInput.Type;

const RestartPayload = Schema.Struct({
  id: TaskId,
});
type RestartPayload = typeof RestartPayload.Type;
const RestartInput = Schema.Union(RestartPayload, Schema.Array(RestartPayload));
type RestartInput = typeof RestartInput.Type;

const WaitPayload = Schema.Struct({
  id: TaskId,
});
type WaitPayload = typeof WaitPayload.Type;

const EventsPayload = Schema.Struct({
  id: TaskId,
  lines: Schema.optional(PositiveInt),
});
type EventsPayload = typeof EventsPayload.Type;

const PayloadArg = Args.text({ name: "payload" }).pipe(
  Args.withDefault("{}"),
  Args.withDescription("JSON object, @file, or - for stdin"),
);

const TargetArg = Args.text({ name: "target" }).pipe(
  Args.withDefault(""),
  Args.withDescription("Command target such as start or schema list"),
);

const outputOption = Options.choice("output", outputModes).pipe(
  Options.withDefault("auto"),
  Options.withDescription("Large output policy"),
);
const waitOption = Options.boolean("wait").pipe(Options.withDescription("Wait for terminal task state"));
const streamOption = Options.boolean("stream").pipe(Options.withDescription("Emit NDJSON event frames"));
const timeoutOption = Options.integer("timeout").pipe(
  Options.withDefault(60),
  Options.withDescription("Timeout in seconds"),
);
const concurrencyOption = Options.integer("concurrency").pipe(
  Options.withDefault(5),
  Options.withDescription("Maximum concurrent batch items"),
);

const lifecycleOptions = Options.all({
  output: outputOption,
  wait: waitOption,
  stream: streamOption,
  timeout: timeoutOption,
  concurrency: concurrencyOption,
});

const readOptions = Options.all({
  output: outputOption,
  stream: streamOption,
  timeout: timeoutOption,
  concurrency: concurrencyOption,
});

const listOptions = Options.all({
  output: outputOption,
  concurrency: concurrencyOption,
});

const noPayloadOptions = Options.all({
  output: outputOption,
});

const command = (
  name: string,
  options: Options.Options<any> = lifecycleOptions,
  args: Args.Args<any> = PayloadArg,
  description?: string,
) => {
  const descriptor = CommandDescriptor.make(name, options, args);
  return description ? descriptor.pipe(CommandDescriptor.withDescription(description)) : descriptor;
};

const schemaCommand = CommandDescriptor.make("schema").pipe(
  CommandDescriptor.withSubcommands([
    ["schema list", CommandDescriptor.make("list", noPayloadOptions)],
    ["schema show", CommandDescriptor.make("show", noPayloadOptions, TargetArg)],
  ]),
);

const examplesCommand = CommandDescriptor.make("examples").pipe(
  CommandDescriptor.withSubcommands([
    ["examples list", CommandDescriptor.make("list", noPayloadOptions)],
    ["examples show", CommandDescriptor.make("show", noPayloadOptions, TargetArg)],
  ]),
);

export const backgroundTasksCommand = CommandDescriptor.make(executableName).pipe(
  CommandDescriptor.withDescription("Agentic control-plane CLI for managed background tasks"),
  CommandDescriptor.withSubcommands([
    ["start", command("start", lifecycleOptions, PayloadArg, "Submit and start one or more tasks")],
    ["status", command("status", lifecycleOptions, PayloadArg, "Inspect a task")],
    ["list", command("list", listOptions, PayloadArg, "List tasks")],
    ["logs", command("logs", readOptions, PayloadArg, "Read task logs")],
    ["stop", command("stop", lifecycleOptions, PayloadArg, "Stop one or more tasks")],
    ["restart", command("restart", lifecycleOptions, PayloadArg, "Restart one or more tasks")],
    ["wait", command("wait", lifecycleOptions, PayloadArg, "Wait for a task to reach terminal state")],
    ["events", command("events", readOptions, PayloadArg, "Read task event frames")],
    ["doctor", CommandDescriptor.make("doctor", noPayloadOptions)],
    ["capabilities", CommandDescriptor.make("capabilities", noPayloadOptions)],
    ["schema", schemaCommand],
    ["examples", examplesCommand],
  ]),
);

const commandSchemas = [
  {
    command: "start",
    schema_id: "background-tasks.start.input/v1",
    description: "Submit/start one task object or an array of task objects.",
    schema: StartInput,
  },
  {
    command: "status",
    schema_id: "background-tasks.status.input/v1",
    description: "Inspect one task by id.",
    schema: StatusPayload,
  },
  {
    command: "list",
    schema_id: "background-tasks.list.input/v1",
    description: "List tasks, optionally filtered by ids, status, tag, or tags.",
    schema: ListPayload,
  },
  {
    command: "logs",
    schema_id: "background-tasks.logs.input/v1",
    description: "Read bounded task logs with optional artifact output.",
    schema: LogsPayload,
  },
  {
    command: "stop",
    schema_id: "background-tasks.stop.input/v1",
    description: "Stop one task object or an array of task objects.",
    schema: StopInput,
  },
  {
    command: "restart",
    schema_id: "background-tasks.restart.input/v1",
    description: "Restart one task object or an array of task objects.",
    schema: RestartInput,
  },
  {
    command: "wait",
    schema_id: "background-tasks.wait.input/v1",
    description: "Wait for one task to reach exited, killed, or failed.",
    schema: WaitPayload,
  },
  {
    command: "events",
    schema_id: "background-tasks.events.input/v1",
    description: "Read status and bounded log event frames for a task.",
    schema: EventsPayload,
  },
] as const;

const examples = [
  {
    command: "start",
    examples: [
      {
        name: "start custom command",
        input: {
          id: "bg_demo",
          name: "demo server",
          command: "sh",
          args: ["-c", "printf 'ready\\n'; sleep 60"],
          tags: ["demo"],
        },
      },
      {
        name: "batch start",
        input: [
          { id: "bg_one", command: "sleep", args: ["30"] },
          { id: "bg_two", command: "sleep", args: ["30"] },
        ],
      },
    ],
  },
  {
    command: "status",
    examples: [{ name: "inspect task", input: { id: "bg_demo" } }],
  },
  {
    command: "list",
    examples: [{ name: "running demo tasks", input: { status: "running", tag: "demo" } }],
  },
  {
    command: "logs",
    examples: [{ name: "last 50 lines", input: { id: "bg_demo", lines: 50 } }],
  },
  {
    command: "stop",
    examples: [{ name: "stop task", input: { id: "bg_demo" } }],
  },
  {
    command: "restart",
    examples: [{ name: "restart task", input: { id: "bg_demo" } }],
  },
  {
    command: "wait",
    examples: [{ name: "wait for terminal state", input: { id: "bg_demo" } }],
  },
  {
    command: "events",
    examples: [{ name: "read event frames", input: { id: "bg_demo", lines: 20 } }],
  },
] as const;

const parseJson = (command: string, text: string) =>
  Effect.try({
    try: () => JSON.parse(text) as unknown,
    catch: (cause) =>
      new CommandInputError({
        command,
        message: "payload must be valid JSON",
        details: {
          expected: "JSON object or array",
          received: text.slice(0, 200),
          cause: String(cause),
          retryable: false,
        },
      }),
  });

const readPayloadText = (command: string, source: string, io: CliIo) => {
  if (source === "-") {
    return Effect.tryPromise({
      try: () => io.readStdin(),
      catch: (cause) =>
        new CommandInputError({
          command,
          message: "failed to read payload from stdin",
          details: { cause: String(cause), retryable: true },
        }),
    });
  }

  if (source.startsWith("@")) {
    const filePath = resolve(source.slice(1));
    return Effect.tryPromise({
      try: () => readFile(filePath, "utf8"),
      catch: (cause) =>
        new CommandInputError({
          command,
          message: "failed to read payload file",
          details: {
            path: filePath,
            cause: String(cause),
            hint: "Provide an existing JSON payload file after @.",
            retryable: false,
          },
        }),
    });
  }

  return Effect.succeed(source);
};

const parseErrorDetails = (error: ParseResult.ParseError) => ({
  expected: "payload matching the command schema",
  issues: ParseResult.ArrayFormatter.formatErrorSync(error),
  hint: "Run schema show for the command and retry with a matching JSON payload.",
  retryable: false,
});

const decodePayload = <A, I>(
  command: string,
  schema: Schema.Schema<A, I>,
  source: string,
  io: CliIo,
) =>
  readPayloadText(command, source, io).pipe(
    Effect.flatMap(parseJson.bind(undefined, command)),
    Effect.flatMap((value) =>
      Schema.decodeUnknown(schema)(value).pipe(
        Effect.mapError(
          (error) =>
            new CommandInputError({
              command,
              message: "payload does not match command schema",
              details: parseErrorDetails(error),
            }),
        ),
      ),
    ),
  );

const timeoutMs = (seconds: number) => Math.max(0, Math.floor(seconds * 1000));

const validateConcurrency = (
  command: string,
  concurrency: number,
): Effect.Effect<number, CommandInputError> => {
  if (concurrency > 0 && Number.isInteger(concurrency)) {
    return Effect.succeed(concurrency);
  }

  return Effect.fail(
    new CommandInputError({
      command,
      message: "concurrency must be a positive integer",
      details: {
        field: "concurrency",
        expected: "positive integer",
        received: concurrency,
        retryable: false,
      },
    }),
  );
};

const toCliStartInput = (input: StartPayload): CliStartInput => ({
  ...(input.id ? { id: input.id } : {}),
  ...(input.name ? { name: input.name } : {}),
  command: input.command,
  ...(input.args ? { args: input.args } : {}),
  ...(input.workdir ? { workdir: input.workdir } : {}),
  ...(input.env ? { env: input.env } : {}),
  ...(input.tags ? { tags: input.tags } : {}),
  ...(input.parentSessionId ? { parentSessionId: input.parentSessionId } : {}),
  ...(input.notifyOnExit !== undefined ? { notifyOnExit: input.notifyOnExit } : {}),
});

const envelope = (command: string, data: unknown): CommandOutput => ({
  kind: "envelope",
  command,
  data,
});

const makeBatch = <A, B>(
  command: string,
  inputs: readonly A[],
  concurrency: number,
  runOne: (input: A) => Effect.Effect<B, unknown>,
) =>
  Effect.gen(function* () {
    const results = yield* Effect.forEach(
      inputs.map((input, index) => ({ input, index })),
      ({ input, index }) =>
        runOne(input).pipe(
          Effect.match({
            onFailure: (error) => ({
              index,
              ok: false as const,
              error: formatError(command, error),
            }),
            onSuccess: (data) => ({
              index,
              ok: true as const,
              target:
                "id" in (input as Record<string, unknown>)
                  ? { id: (input as { id: string }).id }
                  : undefined,
              data,
            }),
          }),
        ),
      { concurrency },
    );
    const successCount = results.filter((result) => result.ok).length;
    const errorCount = results.length - successCount;
    const outcome =
      errorCount === 0 ? "succeeded" : successCount === 0 ? "failed" : "partial_failure";
    return {
      kind: "envelope" as const,
      command,
      exitCode: errorCount > 0 ? 1 : 0,
      data: {
        outcome,
        total: results.length,
        success_count: successCount,
        error_count: errorCount,
        concurrency,
        results,
      },
    };
  });

const makeLogArtifact = (taskId: string, logPath: string, paths: CliStorePaths) =>
  Effect.promise(async (): Promise<ArtifactRecord> => {
    const file = await stat(logPath).catch(() => ({ size: 0 }));
    return {
      key: `task.${taskId}.logs`,
      label: "task log",
      kind: "text",
      absolute_path: logPath,
      relative_path: relative(paths.root, logPath),
      size_bytes: file.size,
      created_at: new Date().toISOString(),
    };
  });

const handleStart = (
  payload: StartInput,
  options: { readonly wait: boolean; readonly timeout: number; readonly concurrency: number },
  paths: CliStorePaths,
) => {
  const runOne = (input: StartPayload) =>
    startCliTask(toCliStartInput(input), paths).pipe(
      Effect.flatMap((task) =>
        options.wait
          ? waitForCliTask(task.id, { timeoutMs: timeoutMs(options.timeout) }, paths).pipe(
            Effect.map((waitedTask) => ({
              task: waitedTask,
              lifecycle: {
                submitted_at: task.createdAt,
                waited: true,
                status: waitedTask.status,
                terminal_status: waitedTask.status,
              },
            })),
            )
          : Effect.succeed({
              task,
              lifecycle: {
                submitted_at: task.createdAt,
                waited: false,
                status: task.status,
                terminal_status: null as string | null,
              },
            }),
      ),
    );

  if (Array.isArray(payload)) {
    return makeBatch("start", payload, options.concurrency, runOne);
  }

  return runOne(payload as StartPayload).pipe(Effect.map((data) => envelope("start", data)));
};

const handleStatus = (
  payload: StatusPayload,
  options: { readonly wait: boolean; readonly timeout: number },
  paths: CliStorePaths,
) =>
  (options.wait
    ? waitForCliTask(payload.id, { timeoutMs: timeoutMs(options.timeout) }, paths)
    : getCliTask(payload.id, paths)
  ).pipe(
    Effect.map((task) =>
      envelope("status", {
        task_id: task.id,
        status: task.status,
        task,
      }),
    ),
  );

const handleList = (payload: ListPayload, paths: CliStorePaths) =>
  listCliTasks(paths).pipe(
    Effect.map((tasks) => {
      const idFilter = new Set(payload.ids ?? []);
      const tagFilter = new Set([...(payload.tags ?? []), ...(payload.tag ? [payload.tag] : [])]);
      const filtered = tasks.filter(
        (task) =>
          (idFilter.size === 0 || idFilter.has(task.id)) &&
          (!payload.status || task.status === payload.status) &&
          (tagFilter.size === 0 || [...tagFilter].every((tag) => task.tags.includes(tag))),
      );
      return envelope("list", {
        total: filtered.length,
        tasks: filtered,
      });
    }),
  );

const handleLogs = (
  payload: LogsPayload,
  options: { readonly output: OutputMode; readonly stream: boolean },
  paths: CliStorePaths,
) =>
  readCliTaskLogs(payload.id, { lines: payload.lines ?? defaultLogLines }, paths).pipe(
    Effect.flatMap((result) =>
      makeLogArtifact(payload.id, result.task.logPath, paths).pipe(
        Effect.map((artifact) => {
          const frames = result.lines.map((line, index) => ({
            type: "task.log.line",
            task_id: result.task.id,
            sequence: index + 1,
            timestamp: new Date().toISOString(),
            data: { line },
          }));

          if (options.stream) {
            return {
              kind: "stream" as const,
              command: "logs",
              frames: [
                {
                  type: "task.logs.started",
                  task_id: result.task.id,
                  sequence: 0,
                  timestamp: new Date().toISOString(),
                  data: { total_lines: result.totalLines },
                },
                ...frames,
                {
                  type: "task.logs.completed",
                  task_id: result.task.id,
                  sequence: frames.length + 1,
                  timestamp: new Date().toISOString(),
                  data: { emitted_lines: frames.length },
                },
              ],
            };
          }

          const hasMore = result.totalLines > result.lines.length;
          const inline = {
            task_id: result.task.id,
            total_lines: result.totalLines,
            shown_lines: result.lines.length,
            has_more: hasMore,
            lines: result.lines,
          };

          if (options.output === "artifact" || (options.output === "auto" && hasMore)) {
            return envelope("logs", {
              kind: "summary+artifact",
              summary: `Showing ${result.lines.length} of ${result.totalLines} log lines for ${result.task.id}.`,
              inline,
              artifact,
            });
          }

          return envelope("logs", inline);
        }),
      ),
    ),
  );

const handleStop = (
  payload: StopInput,
  options: { readonly concurrency: number },
  paths: CliStorePaths,
) => {
  const runOne = (input: StopPayload) =>
    stopCliTask(input.id, paths).pipe(
      Effect.map((task) => ({
        task_id: task.id,
        status: task.status,
        task,
      })),
    );

  if (Array.isArray(payload)) {
    return makeBatch("stop", payload, options.concurrency, runOne);
  }

  return runOne(payload as StopPayload).pipe(Effect.map((data) => envelope("stop", data)));
};

const handleRestart = (
  payload: RestartInput,
  options: { readonly wait: boolean; readonly timeout: number; readonly concurrency: number },
  paths: CliStorePaths,
) => {
  const runOne = (input: RestartPayload) =>
    restartCliTask(input.id, paths).pipe(
      Effect.flatMap((task) =>
        options.wait
          ? waitForCliTask(task.id, { timeoutMs: timeoutMs(options.timeout) }, paths)
          : Effect.succeed(task),
      ),
      Effect.map((task) => ({
        task_id: task.id,
        status: task.status,
        task,
      })),
    );

  if (Array.isArray(payload)) {
    return makeBatch("restart", payload, options.concurrency, runOne);
  }

  return runOne(payload as RestartPayload).pipe(
    Effect.map((data) => envelope("restart", data)),
  );
};

const handleWait = (
  payload: WaitPayload,
  options: { readonly timeout: number },
  paths: CliStorePaths,
) =>
  waitForCliTask(payload.id, { timeoutMs: timeoutMs(options.timeout) }, paths).pipe(
    Effect.map((task) =>
      envelope("wait", {
        task_id: task.id,
        status: task.status,
        task,
      }),
    ),
  );

const handleEvents = (
  payload: EventsPayload,
  options: { readonly stream: boolean },
  paths: CliStorePaths,
) =>
  Effect.all({
    task: getCliTask(payload.id, paths),
    logs: readCliTaskLogs(payload.id, { lines: payload.lines ?? defaultLogLines }, paths),
  }).pipe(
    Effect.map(({ task, logs }) => {
      const frames = [
        {
          type: "task.status.snapshot",
          task_id: task.id,
          sequence: 0,
          timestamp: new Date().toISOString(),
          data: { status: task.status, task },
        },
        ...logs.lines.map((line, index) => ({
          type: "task.log.line",
          task_id: task.id,
          sequence: index + 1,
          timestamp: new Date().toISOString(),
          data: { line },
        })),
      ];

      return options.stream
        ? {
            kind: "stream" as const,
            command: "events",
            frames,
          }
        : envelope("events", {
            task_id: task.id,
            total: frames.length,
            frames,
          });
    }),
  );

const handleDoctor = (paths: CliStorePaths) =>
  Effect.promise(async () => {
    const registry = await stat(paths.registry).catch(() => undefined);
    const logs = await stat(paths.logs).catch(() => undefined);
    return envelope("doctor", {
      status: "ok",
      version: cliVersion,
      store: {
        root: paths.root,
        registry: paths.registry,
        registry_exists: Boolean(registry),
        logs: paths.logs,
        logs_exists: Boolean(logs),
      },
      recovery: {
        missing_store: "Run start to initialize the local store.",
        schema_help: "Run schema list and schema show <command> to inspect payload contracts.",
      },
    });
  });

const handleCapabilities = () =>
  Effect.succeed(
    envelope("capabilities", {
      protocol_version: "background-tasks-cli/v1",
      cli_shape: "client/server-control-plane",
      payload_modes: ["inline-json", "@file", "stdin:-"],
      output_modes: outputModes,
      lifecycle: ["start", "status", "wait", "stop", "restart", "logs", "events"],
      discovery: ["doctor", "capabilities", "schema list", "schema show", "examples list", "examples show"],
      artifacts: {
        supported: true,
        commands: ["logs"],
        default_log_lines: defaultLogLines,
      },
      batch: {
        supported: true,
        commands: ["start", "stop", "restart"],
        default_concurrency: 5,
      },
    }),
  );

const schemaSummary = () => ({
  schemas: commandSchemas.map(({ command, schema_id, description }) => ({
    command,
    schema_id,
    description,
  })),
});

const jsonSchemaFor = (schema: Schema.Schema.Any) => JSONSchema.make(schema);

const handleSchemaList = () => Effect.succeed(envelope("schema list", schemaSummary()));

const handleSchemaShow = (target: string) => {
  const spec = commandSchemas.find((entry) => entry.command === target.trim());
  if (!spec) {
    return Effect.fail(
      new CommandInputError({
        command: "schema show",
        message: "unknown schema target",
        details: {
          target,
          available: commandSchemas.map((entry) => entry.command),
          retryable: false,
        },
      }),
    );
  }

  return Effect.succeed(
    envelope("schema show", {
      command: spec.command,
      schema_id: spec.schema_id,
      description: spec.description,
      schema: jsonSchemaFor(spec.schema),
    }),
  );
};

const handleExamplesList = () =>
  Effect.succeed(
    envelope("examples list", {
      commands: examples.map(({ command, examples }) => ({
        command,
        count: examples.length,
      })),
    }),
  );

const handleExamplesShow = (target: string) => {
  const spec = examples.find((entry) => entry.command === target.trim());
  if (!spec) {
    return Effect.fail(
      new CommandInputError({
        command: "examples show",
        message: "unknown examples target",
        details: {
          target,
          available: examples.map((entry) => entry.command),
          retryable: false,
        },
      }),
    );
  }

  return Effect.succeed(envelope("examples show", spec));
};

const nestedSubcommand = (value: unknown) => {
  const subcommand = (value as { readonly subcommand?: Option.Option<readonly [string, unknown]> })
    .subcommand;
  return subcommand && Option.isSome(subcommand) ? subcommand.value : undefined;
};

const executeCommand = (
  commandId: string,
  value: unknown,
  io: CliIo,
  paths: CliStorePaths,
): Effect.Effect<CommandOutput, BackgroundTaskError> => {
  const parsed = value as {
    readonly args?: string;
    readonly options?: {
      readonly output?: OutputMode;
      readonly wait?: boolean;
      readonly stream?: boolean;
      readonly timeout?: number;
      readonly concurrency?: number;
    };
  };
  const payloadSource = parsed.args ?? "{}";
  const options = {
    output: parsed.options?.output ?? "auto",
    wait: parsed.options?.wait ?? false,
    stream: parsed.options?.stream ?? false,
    timeout: parsed.options?.timeout ?? 60,
    concurrency: parsed.options?.concurrency ?? 5,
  };

  return validateConcurrency(commandId, options.concurrency).pipe(
    Effect.flatMap((concurrency) => {
      switch (commandId) {
        case "start":
          return decodePayload("start", StartInput, payloadSource, io).pipe(
            Effect.flatMap((payload) => handleStart(payload, { ...options, concurrency }, paths)),
          );
        case "status":
          return decodePayload("status", StatusPayload, payloadSource, io).pipe(
            Effect.flatMap((payload) => handleStatus(payload, options, paths)),
          );
        case "list":
          return decodePayload("list", ListPayload, payloadSource, io).pipe(
            Effect.flatMap((payload) => handleList(payload, paths)),
          );
        case "logs":
          return decodePayload("logs", LogsPayload, payloadSource, io).pipe(
            Effect.flatMap((payload) => handleLogs(payload, options, paths)),
          );
        case "stop":
          return decodePayload("stop", StopInput, payloadSource, io).pipe(
            Effect.flatMap((payload) => handleStop(payload, { concurrency }, paths)),
          );
        case "restart":
          return decodePayload("restart", RestartInput, payloadSource, io).pipe(
            Effect.flatMap((payload) => handleRestart(payload, { ...options, concurrency }, paths)),
          );
        case "wait":
          return decodePayload("wait", WaitPayload, payloadSource, io).pipe(
            Effect.flatMap((payload) => handleWait(payload, options, paths)),
          );
        case "events":
          return decodePayload("events", EventsPayload, payloadSource, io).pipe(
            Effect.flatMap((payload) => handleEvents(payload, options, paths)),
          );
        case "doctor":
          return handleDoctor(paths);
        case "capabilities":
          return handleCapabilities();
        case "schema": {
          const nested = nestedSubcommand(value);
          if (!nested) {
            return Effect.fail(
              new CommandInputError({
                command: "schema",
                message: "schema requires list or show",
                details: { available: ["list", "show"], retryable: false },
              }),
            );
          }
          const [nestedId, nestedValue] = nested;
          const target = (nestedValue as { readonly args?: string }).args ?? "";
          return nestedId === "schema list" ? handleSchemaList() : handleSchemaShow(target);
        }
        case "examples": {
          const nested = nestedSubcommand(value);
          if (!nested) {
            return Effect.fail(
              new CommandInputError({
                command: "examples",
                message: "examples requires list or show",
                details: { available: ["list", "show"], retryable: false },
              }),
            );
          }
          const [nestedId, nestedValue] = nested;
          const target = (nestedValue as { readonly args?: string }).args ?? "";
          return nestedId === "examples list" ? handleExamplesList() : handleExamplesShow(target);
        }
        default:
          return Effect.fail(
            new CommandInputError({
              command: commandId,
              message: "unknown command",
              details: {
                command: commandId,
                retryable: false,
              },
            }),
          );
      }
    }),
  );
};

const handleParsedValue = (value: unknown, io: CliIo, paths: CliStorePaths) => {
  const subcommand = nestedSubcommand(value);
  if (!subcommand) {
    return Effect.fail(
      new CommandInputError({
        command: executableName,
        message: "missing subcommand",
        details: {
          available: [
            "start",
            "status",
            "list",
            "logs",
            "stop",
            "restart",
            "wait",
            "events",
            "doctor",
            "capabilities",
            "schema",
            "examples",
          ],
          retryable: false,
        },
      }),
    );
  }

  const [commandId, commandValue] = subcommand;
  return executeCommand(commandId, commandValue, io, paths);
};

const handleBuiltIn = (option: { readonly _tag: string }) => {
  switch (option._tag) {
    case "ShowVersion":
      return Effect.succeed(
        envelope("version", {
          version: cliVersion,
        }),
      );
    case "ShowHelp":
      return Effect.succeed(
        envelope("help", {
          help: HelpDoc.toAnsiText(
            (option as unknown as { readonly helpDoc: HelpDoc.HelpDoc }).helpDoc,
          ),
          next_steps: ["capabilities", "schema list", "examples list"],
        }),
      );
    default:
      return Effect.fail(
        new CommandInputError({
          command: executableName,
          message: `unsupported built-in option: ${option._tag}`,
          details: {
            supported: ["--help", "--version"],
            retryable: false,
          },
        }),
      );
  }
};

const inferCommand = (argv: readonly string[]) => {
  const words = argv
    .slice(2)
    .filter((word) => !word.startsWith("--"))
    .filter((word) => word !== "-" && !word.startsWith("@"))
    .filter((word) => !word.trim().startsWith("{") && !word.trim().startsWith("["));
  return words.length ? words.slice(0, 2).join(" ") : executableName;
};

const parseArgv = (argv: readonly string[]) =>
  CommandDescriptor.parse(
    backgroundTasksCommand,
    [executableName, ...argv.slice(2)],
    CliConfig.defaultConfig,
  ).pipe(Effect.provide(BunContext.layer));

const formatValidationError = (command: string, error: ValidationError.ValidationError) => ({
  type: "CommandInputError",
  message: HelpDoc.toAnsiText(error.error).trim(),
  details: {
    validation_tag: error._tag,
    hint: "Run capabilities, schema list, or examples list to discover valid commands.",
    retryable: false,
  },
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const formatError = (command: string, error: unknown): EnvelopeError => {
  if (ValidationError.isValidationError(error)) {
    return formatValidationError(command, error);
  }

  if (!isRecord(error) || typeof error._tag !== "string") {
    return {
      type: "UnexpectedCliError",
      message: error instanceof Error ? error.message : String(error),
      details: { retryable: false },
    };
  }

  switch (error._tag) {
    case "CommandInputError":
      return {
        type: "CommandInputError",
        message: typeof error.message === "string" ? error.message : "invalid command input",
        ...(error.details !== undefined ? { details: error.details } : {}),
      };
    case "TaskNotFound":
      return {
        type: "TaskNotFound",
        message: `task not found: ${String(error.id)}`,
        details: {
          id: error.id,
          hint: "Run list to discover known task ids.",
          retryable: false,
        },
      };
    case "TaskAlreadyRunning":
      return {
        type: "TaskAlreadyRunning",
        message: `task is already running: ${String(error.id)}`,
        details: {
          id: error.id,
          hint: "Use status, stop, or restart for this task id.",
          retryable: false,
        },
      };
    case "TaskWaitTimedOut":
      return {
        type: "TaskWaitTimedOut",
        message: `timed out waiting for task: ${String(error.id)}`,
        details: {
          id: error.id,
          timeout_ms: error.timeoutMs,
          next_step: "Retry wait with a larger --timeout or inspect status.",
          retryable: true,
        },
      };
    case "SpawnFailed":
      return {
        type: "SpawnFailed",
        message: `failed to spawn command: ${String(error.command)}`,
        details: {
          command: error.command,
          reason: error.reason,
          hint: "Verify the command exists and the workdir is valid.",
          retryable: false,
        },
      };
    case "CliStoreError":
      return {
        type: "CliStoreError",
        message: `task store operation failed: ${String(error.operation)}`,
        details: {
          operation: error.operation,
          path: error.path,
          reason: error.reason,
          retryable: true,
        },
      };
    default:
      return {
        type: error._tag,
        message: typeof error.message === "string" ? error.message : error._tag,
        details: {
          ...error,
          retryable: false,
        },
      };
  }
};

const writeJson = (write: (text: string) => void, value: unknown) => {
  write(`${JSON.stringify(value, null, 2)}\n`);
};

export const runCli = (argv: readonly string[], options: RunCliOptions = {}) =>
  Effect.gen(function* () {
    const io = makeIo(options.io);
    const paths = options.paths ?? resolveCliStorePaths();
    const command = inferCommand(argv);
    const result = yield* parseArgv(argv).pipe(
      Effect.flatMap((directive) => {
        if (directive._tag === "BuiltIn") {
          return handleBuiltIn(directive.option);
        }

        if (directive.leftover.length > 0) {
          return Effect.fail(
            new CommandInputError({
              command,
              message: "unknown arguments received",
              details: {
                leftover: directive.leftover,
                retryable: false,
              },
            }),
          );
        }

        return handleParsedValue(directive.value, io, paths);
      }),
      Effect.either,
    );

    if (result._tag === "Left") {
      const failure: CommandFailure = {
        ok: false,
        command,
        error: formatError(command, result.left),
      };
      writeJson(io.stderr, failure);
      return { exitCode: 1, command };
    }

    if (result.right.kind === "stream") {
      for (const frame of result.right.frames) {
        io.stdout(`${JSON.stringify(frame)}\n`);
      }
      return { exitCode: result.right.exitCode ?? 0, command: result.right.command };
    }

    const success: CommandSuccess = {
      ok: true,
      command: result.right.command,
      data: result.right.data,
    };
    writeJson(io.stdout, success);
    return {
      exitCode: result.right.exitCode ?? 0,
      command: result.right.command,
    };
  });

if (import.meta.main) {
  const result = await Effect.runPromise(runCli(Bun.argv));
  process.exitCode = result.exitCode;
}
