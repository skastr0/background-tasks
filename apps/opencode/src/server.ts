import { tool, type Hooks, type Plugin, type PluginModule } from "@opencode-ai/plugin";
import {
  listCliTasks,
  readCliTaskLogs,
  restartCliTask,
  startCliTask,
  stopCliTask,
} from "@skastr0/background-tasks-core/cli-store";
import { Effect } from "effect";

const pluginId = "background-tasks";
const serviceName = "background-tasks";

const run = <A>(effect: Effect.Effect<A, Error>) =>
  Effect.runPromise(effect).catch((error) => {
    throw error instanceof Error ? error : new Error(String(error));
  });

const safeLog = async (
  client: Parameters<Plugin>[0]["client"],
  level: "debug" | "info" | "warn" | "error",
  message: string,
  extra?: Record<string, unknown>,
) => {
  try {
    await client.app.log({ body: { service: serviceName, level, message, extra } });
  } catch {
    // Logging must not make tools fail.
  }
};

const makeTools = (ctx: Parameters<Plugin>[0]) => ({
  bg_start: tool({
    description: "Start a managed background task.",
    args: {
      command: tool.schema.string().min(1),
      args: tool.schema.array(tool.schema.string()).optional(),
      workdir: tool.schema.string().optional(),
      name: tool.schema.string().optional(),
      tags: tool.schema.array(tool.schema.string()).optional(),
      notify_on_exit: tool.schema.boolean().optional(),
    },
    async execute(input, toolCtx) {
      const task = await run(
        startCliTask({
          command: input.command,
          args: input.args,
          workdir: input.workdir ?? toolCtx.worktree ?? ctx.worktree,
          name: input.name,
          tags: input.tags,
          parentSessionId: toolCtx.sessionID,
          notifyOnExit: input.notify_on_exit,
        }),
      );
      return JSON.stringify({ ok: true, task }, null, 2);
    },
  }),
  bg_status: tool({
    description: "List background task status for the current session.",
    args: {
      id: tool.schema.string().optional(),
    },
    async execute(input, toolCtx) {
      const tasks = await run(listCliTasks());
      const visible = tasks.filter(
        (task) =>
          (!input.id || task.id === input.id) &&
          (!task.parentSessionId || task.parentSessionId === toolCtx.sessionID),
      );
      return JSON.stringify({ ok: true, tasks: visible }, null, 2);
    },
  }),
  bg_logs: tool({
    description: "Read background task logs.",
    args: {
      id: tool.schema.string().min(1),
      lines: tool.schema.number().optional(),
    },
    async execute(input, toolCtx) {
      const result = await run(readCliTaskLogs(input.id, { lines: input.lines }));
      if (result.task.parentSessionId && result.task.parentSessionId !== toolCtx.sessionID) {
        return JSON.stringify({ ok: false, error: `task not found: ${input.id}` }, null, 2);
      }
      return JSON.stringify({ ok: true, logs: result }, null, 2);
    },
  }),
  bg_stop: tool({
    description: "Stop a background task.",
    args: {
      id: tool.schema.string().min(1),
    },
    async execute(input) {
      const task = await run(stopCliTask(input.id));
      return JSON.stringify({ ok: true, task }, null, 2);
    },
  }),
  bg_restart: tool({
    description: "Restart a background task.",
    args: {
      id: tool.schema.string().min(1),
    },
    async execute(input) {
      const task = await run(restartCliTask(input.id));
      return JSON.stringify({ ok: true, task }, null, 2);
    },
  }),
});

const server: Plugin = async (ctx) => {
  await safeLog(ctx.client, "info", "Background tasks wrapper initialized", {
    tools: ["bg_start", "bg_status", "bg_logs", "bg_stop", "bg_restart"],
  });

  return {
    tool: makeTools(ctx),
    "chat.message": async () => {
      await safeLog(ctx.client, "debug", "Background tasks chat hook observed");
    },
    event: async ({ event }) => {
      if (event.type !== "session.deleted") {
        return;
      }
      const sessionId = event.properties.info.id;
      const tasks = await run(listCliTasks());
      await Promise.all(
        tasks
          .filter((task) => task.parentSessionId === sessionId && task.status === "running")
          .map((task) => run(stopCliTask(task.id))),
      );
      await safeLog(ctx.client, "debug", "Cleaned up background tasks for deleted session", {
        sessionId,
      });
    },
  } satisfies Hooks;
};

export default {
  id: pluginId,
  server,
} satisfies PluginModule;
