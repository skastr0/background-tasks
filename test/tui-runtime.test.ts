import { describe, expect, test } from "bun:test";
import type { TuiPluginMeta } from "@opencode-ai/plugin/tui";
import {
  composeDraftFromTask,
  composeDraftToSpawnRequest,
  emptyComposeDraft,
  parseArgsInput,
  parseTagsInput,
  type ComposeDraft,
} from "../apps/opencode-tui/src/runtime.ts";

const meta: TuiPluginMeta = {
  id: "background-tasks-tui",
  source: "file",
  spec: "apps/opencode-tui/src/tui.ts",
  target: "apps/opencode-tui/src/tui.ts",
  first_time: Date.now(),
  last_time: Date.now(),
  time_changed: Date.now(),
  load_count: 1,
  fingerprint: "test",
  state: "same",
};

void meta;

describe("background tasks TUI runtime helpers", () => {
  test("converts compose drafts for agent and custom flows", () => {
    const draft = emptyComposeDraft("/tmp/worktree");
    const agentRequest = composeDraftToSpawnRequest(
      {
        ...draft,
        cli: "gemini",
        prompt: "Investigate failing tests",
        model: "gemini-pro",
        tags: "research, bugs",
      },
      "ses_agent",
    );

    expect(agentRequest).toEqual({
      mode: "agent",
      cli: "gemini",
      prompt: "Investigate failing tests",
      workdir: "/tmp/worktree",
      model: "gemini-pro",
      tags: ["research", "bugs"],
      notifyOnExit: true,
      parentSessionId: "ses_agent",
    });

    const customDraft: ComposeDraft = {
      mode: "custom",
      cli: "custom",
      prompt: "",
      command: "python",
      args: 'script.py --flag "two words"',
      workdir: "/tmp/worktree",
      model: "",
      tags: "ops",
      notifyOnExit: false,
    };

    expect(composeDraftToSpawnRequest(customDraft)).toEqual({
      mode: "custom",
      command: "python",
      args: ["script.py", "--flag", "two words"],
      description: "python",
      workdir: "/tmp/worktree",
      tags: ["ops"],
      notifyOnExit: false,
    });
  });

  test("extracts drafts and tokenizes tags and args", () => {
    expect(parseTagsInput("alpha, beta ,, gamma")).toEqual(["alpha", "beta", "gamma"]);
    expect(parseArgsInput('one "two words" three')).toEqual(["one", "two words", "three"]);

    const draft = composeDraftFromTask({
      id: "bg_123",
      name: "Claude Code: inspect",
      command: "claude",
      args: ["--print", "-p", "Inspect the repo", "--model", "sonnet"],
      workdir: "/tmp/worktree",
      tags: ["agent", "claude", "review"],
      status: "running",
      restartCount: 0,
      notifyOnExit: true,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      lastStatusChangeAt: new Date(0).toISOString(),
      logLineCount: 0,
    });

    expect(draft.mode).toBe("agent");
    expect(draft.cli).toBe("claude");
    expect(draft.prompt).toBe("Inspect the repo");
    expect(draft.tags).toBe("review");
  });
});
