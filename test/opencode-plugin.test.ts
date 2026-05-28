import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import plugin from "../apps/opencode-plugin/src/server.ts";
import { listCliTasks, startCliTask } from "@skastr0/background-tasks-core/cli-store";

const makeContext = () =>
  ({
    client: {
      app: {
        log: async () => undefined,
      },
      session: {
        prompt: async () => undefined,
      },
    },
    directory: process.cwd(),
    worktree: process.cwd(),
    project: { id: "test", worktree: process.cwd() },
    serverUrl: new URL("http://localhost"),
    $: async () => undefined,
    experimental_workspace: {
      register: () => undefined,
    },
  }) as never;

describe("OpenCode server wrapper", () => {
  test("registers thin tools and cleans session tasks on delete", async () => {
    const root = await mkdtemp(join(tmpdir(), "background-tasks-plugin-test-"));
    const previousHome = process.env.BACKGROUND_TASKS_HOME;
    process.env.BACKGROUND_TASKS_HOME = root;
    try {
      const hooks = await plugin.server(makeContext());
      expect(Object.keys(hooks.tool ?? {}).sort()).toEqual([
        "bg_logs",
        "bg_restart",
        "bg_start",
        "bg_status",
        "bg_stop",
      ]);

      await Effect.runPromise(
        startCliTask({
          id: "bg_owned",
          command: "sleep",
          args: ["20"],
          parentSessionId: "ses_deleted",
        }),
      );

      await hooks.event?.({
        event: {
          type: "session.deleted",
          properties: { info: { id: "ses_deleted" } },
        },
      } as never);

      const tasks = await Effect.runPromise(listCliTasks());
      expect(tasks.find((task) => task.id === "bg_owned")?.status).toBe("killed");
    } finally {
      if (previousHome === undefined) {
        delete process.env.BACKGROUND_TASKS_HOME;
      } else {
        process.env.BACKGROUND_TASKS_HOME = previousHome;
      }
      await rm(root, { recursive: true, force: true });
    }
  });
});
