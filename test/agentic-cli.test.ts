import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { runCli } from "../apps/cli/src/cli.ts";
import {
  listCliTasks,
  resolveCliStorePaths,
  stopCliTask,
  type CliStorePaths,
} from "@skastr0/background-tasks-core/cli-store";

const argv = (...args: readonly string[]) => ["bun", "background-tasks", ...args];

const withStore = async <A>(run: (paths: CliStorePaths) => Promise<A>) => {
  const root = await mkdtemp(join(tmpdir(), "background-tasks-agentic-cli-test-"));
  const paths = resolveCliStorePaths(root);
  try {
    return await run(paths);
  } finally {
    const tasks = await Effect.runPromise(listCliTasks(paths)).catch(() => []);
    await Promise.all(
      tasks
        .filter((task) => task.status === "running")
        .map((task) => Effect.runPromise(stopCliTask(task.id, paths)).catch(() => undefined)),
    );
    await rm(root, { recursive: true, force: true });
  }
};

const runCommand = async (
  paths: CliStorePaths,
  args: readonly string[],
  options: { readonly stdin?: string } = {},
) => {
  let stdout = "";
  let stderr = "";
  const result = await Effect.runPromise(
    runCli(argv(...args), {
      paths,
      io: {
        stdout: (text) => {
          stdout += text;
        },
        stderr: (text) => {
          stderr += text;
        },
        readStdin: async () => options.stdin ?? "",
      },
    }),
  );
  return { result, stdout, stderr };
};

const parseJson = (text: string) => JSON.parse(text) as Record<string, any>;

describe("agentic CLI", () => {
  test("accepts inline JSON and returns lifecycle envelopes", async () => {
    await withStore(async (paths) => {
      const start = await runCommand(paths, [
        "start",
        '{"id":"bg_inline","command":"sh","args":["-c","printf ready; sleep 20"],"tags":["cli"]}',
      ]);

      expect(start.result.exitCode).toBe(0);
      expect(start.stderr).toBe("");
      expect(parseJson(start.stdout)).toMatchObject({
        ok: true,
        command: "start",
        data: { task: { id: "bg_inline", status: "running" } },
      });

      const status = await runCommand(paths, ["status", '{"id":"bg_inline"}']);
      expect(parseJson(status.stdout)).toMatchObject({
        ok: true,
        command: "status",
        data: { task_id: "bg_inline", status: "running" },
      });

      const stop = await runCommand(paths, ["stop", '{"id":"bg_inline"}']);
      expect(parseJson(stop.stdout)).toMatchObject({
        ok: true,
        command: "stop",
        data: { task_id: "bg_inline", status: "killed" },
      });
    });
  });

  test("accepts @file and stdin JSON payload modes", async () => {
    await withStore(async (paths) => {
      const payloadPath = join(paths.root, "payload.json");
      await writeFile(
        payloadPath,
        JSON.stringify({
          id: "bg_file",
          command: "sh",
          args: ["-c", "printf file-mode; sleep 20"],
        }),
      );

      const start = await runCommand(paths, ["start", `@${payloadPath}`]);
      expect(parseJson(start.stdout)).toMatchObject({
        ok: true,
        command: "start",
        data: { task: { id: "bg_file", status: "running" } },
      });

      const status = await runCommand(paths, ["status", "-"], {
        stdin: '{"id":"bg_file"}',
      });
      expect(parseJson(status.stdout)).toMatchObject({
        ok: true,
        command: "status",
        data: { task_id: "bg_file", status: "running" },
      });

      await runCommand(paths, ["stop", '{"id":"bg_file"}']);
    });
  });

  test("returns structured failures on stderr", async () => {
    await withStore(async (paths) => {
      const invalid = await runCommand(paths, ["start", '{"command":']);
      expect(invalid.result.exitCode).toBe(1);
      expect(invalid.stdout).toBe("");
      expect(parseJson(invalid.stderr)).toMatchObject({
        ok: false,
        command: "start",
        error: {
          type: "CommandInputError",
        },
      });

      const missing = await runCommand(paths, ["status", '{"id":"missing"}']);
      expect(missing.result.exitCode).toBe(1);
      expect(parseJson(missing.stderr)).toMatchObject({
        ok: false,
        command: "status",
        error: {
          type: "TaskNotFound",
          details: { id: "missing" },
        },
      });
    });
  });

  test("summarizes logs with artifact records by default", async () => {
    await withStore(async (paths) => {
      await runCommand(paths, [
        "start",
        '{"id":"bg_logs","command":"sh","args":["-c","printf \\"one\\\\ntwo\\\\nthree\\\\n\\"; sleep 20"]}',
      ]);
      await Bun.sleep(100);

      const logs = await runCommand(paths, ["logs", '{"id":"bg_logs","lines":2}']);
      expect(parseJson(logs.stdout)).toMatchObject({
        ok: true,
        command: "logs",
        data: {
          kind: "summary+artifact",
          inline: {
            task_id: "bg_logs",
            total_lines: 3,
            shown_lines: 2,
            has_more: true,
          },
          artifact: {
            key: "task.bg_logs.logs",
            kind: "text",
          },
        },
      });

      const events = await runCommand(paths, ["events", "--stream", '{"id":"bg_logs","lines":1}']);
      const frames = events.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(frames.map((frame) => frame.type)).toEqual([
        "task.status.snapshot",
        "task.log.line",
      ]);

      await runCommand(paths, ["stop", '{"id":"bg_logs"}']);
    });
  });

  test("exposes discovery commands", async () => {
    await withStore(async (paths) => {
      const capabilities = await runCommand(paths, ["capabilities"]);
      expect(parseJson(capabilities.stdout)).toMatchObject({
        ok: true,
        command: "capabilities",
        data: {
          payload_modes: ["inline-json", "@file", "stdin:-"],
          discovery: expect.arrayContaining(["schema list", "examples show"]),
        },
      });

      const schemaList = await runCommand(paths, ["schema", "list"]);
      expect(parseJson(schemaList.stdout).data.schemas.map((schema: any) => schema.command)).toContain(
        "start",
      );

      const schemaShow = await runCommand(paths, ["schema", "show", "start"]);
      expect(parseJson(schemaShow.stdout)).toMatchObject({
        ok: true,
        command: "schema show",
        data: { schema_id: "background-tasks.start.input/v1" },
      });

      const examplesShow = await runCommand(paths, ["examples", "show", "start"]);
      expect(parseJson(examplesShow.stdout)).toMatchObject({
        ok: true,
        command: "examples show",
        data: { command: "start" },
      });
    });
  });

  test("builds the CLI entrypoint", async () => {
    const outdir = await mkdtemp(join(tmpdir(), "background-tasks-build-smoke-"));
    try {
      const proc = Bun.spawn(
        [
          "bun",
          "build",
          "apps/cli/src/cli.ts",
          "--outdir",
          outdir,
          "--target",
          "bun",
          "--format",
          "esm",
        ],
        {
          cwd: process.cwd(),
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const exitCode = await proc.exited;
      expect(exitCode).toBe(0);
    } finally {
      await rm(outdir, { recursive: true, force: true });
    }
  });
});
