import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  listCliTasks,
  readCliTaskLogs,
  resolveCliStorePaths,
  restartCliTask,
  startCliTask,
  stopCliTask,
} from "@background-tasks/core/cli-store";

const withStore = async <A>(run: (paths: ReturnType<typeof resolveCliStorePaths>) => Promise<A>) => {
  const root = await mkdtemp(join(tmpdir(), "background-tasks-test-"));
  try {
    return await run(resolveCliStorePaths(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const runEffect = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);

describe("CLI task store", () => {
  test("starts, lists, reads logs, restarts, and stops a task", async () => {
    await withStore(async (paths) => {
      const task = await runEffect(
        startCliTask(
          {
            id: "bg_test",
            name: "test task",
            command: "sh",
            args: ["-c", "printf 'ready\\n'; sleep 20"],
            tags: ["test"],
          },
          paths,
        ),
      );

      expect(task.id).toBe("bg_test");
      expect(task.status).toBe("running");

      const listed = await runEffect(listCliTasks(paths));
      expect(listed.map((item) => item.id)).toEqual(["bg_test"]);

      await Bun.sleep(100);
      const logs = await runEffect(readCliTaskLogs("bg_test", {}, paths));
      expect(logs.lines).toContain("ready");

      const restarted = await runEffect(restartCliTask("bg_test", paths));
      expect(restarted.restartCount).toBe(1);
      expect(restarted.status).toBe("running");

      const stopped = await runEffect(stopCliTask("bg_test", paths));
      expect(stopped.status).toBe("killed");
    });
  });
});
