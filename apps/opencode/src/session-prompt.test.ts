import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { promptWithSessionContext } from "./session-prompt";

describe("background-tasks TUI promptWithSessionContext", () => {
  test("parses latest user message context before injecting", async () => {
    const promptCalls: unknown[] = [];
    const client = {
      session: {
        messages: async () => ({
          data: [
            { info: { role: "assistant" } },
            {
              info: {
                role: "user",
                agent: "orchestrator-engineer",
                model: { providerID: "openai", modelID: "gpt-5.5", variant: "high" },
              },
            },
          ],
        }),
        prompt: async (input: unknown) => {
          promptCalls.push(input);
        },
      },
    };

    await Effect.runPromise(
      promptWithSessionContext(client, "ses_123", {
        noReply: true,
        parts: [{ type: "text", text: "Synthetic context", synthetic: true }],
      }),
    );

    expect(promptCalls).toEqual([
      {
        sessionID: "ses_123",
        agent: "orchestrator-engineer",
        model: { providerID: "openai", modelID: "gpt-5.5" },
        variant: "high",
        noReply: true,
        parts: [{ type: "text", text: "Synthetic context", synthetic: true }],
      },
    ]);
  });
});
