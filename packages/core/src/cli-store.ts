import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Effect, Schema } from "effect";
import {
  CliStoreError,
  CommandInputError,
  SpawnFailed,
  TaskAlreadyRunning,
  TaskNotFound,
  TaskWaitTimedOut,
} from "./domain/errors.ts";

export const CliTaskStatus = Schema.Literal("running", "exited", "killed", "failed");
export type CliTaskStatus = typeof CliTaskStatus.Type;

export const CliTaskRecord = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  command: Schema.String,
  args: Schema.Array(Schema.String),
  workdir: Schema.String,
  env: Schema.Record({ key: Schema.String, value: Schema.String }),
  tags: Schema.Array(Schema.String),
  status: CliTaskStatus,
  pid: Schema.optional(Schema.Number),
  exitCode: Schema.optional(Schema.Number),
  logPath: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  startedAt: Schema.optional(Schema.String),
  exitedAt: Schema.optional(Schema.String),
  restartCount: Schema.Number,
  parentSessionId: Schema.optional(Schema.String),
  notifyOnExit: Schema.Boolean,
});
export type CliTaskRecord = typeof CliTaskRecord.Type;

const CliRegistry = Schema.Struct({
  tasks: Schema.Array(CliTaskRecord),
});
type CliRegistry = typeof CliRegistry.Type;

export interface CliStorePaths {
  readonly root: string;
  readonly registry: string;
  readonly logs: string;
}

export interface CliStartInput {
  readonly id?: string;
  readonly name?: string;
  readonly command: string;
  readonly args?: readonly string[];
  readonly workdir?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly tags?: readonly string[];
  readonly parentSessionId?: string;
  readonly notifyOnExit?: boolean;
}

export interface CliLogsOptions {
  readonly lines?: number;
}

export interface CliWaitOptions {
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
}

const defaultRoot = () =>
  process.env.BACKGROUND_TASKS_HOME ??
  join(process.env.HOME ?? process.cwd(), ".local", "state", "background-tasks");

export const resolveCliStorePaths = (root = defaultRoot()): CliStorePaths => {
  const resolvedRoot = resolve(root);
  return {
    root: resolvedRoot,
    registry: join(resolvedRoot, "tasks.json"),
    logs: join(resolvedRoot, "logs"),
  };
};

const nowIso = () => new Date().toISOString();

const normalizeId = (input: CliStartInput): string =>
  input.id?.trim() || `bg_${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;

const normalizeTags = (tags: readonly string[] | undefined): readonly string[] =>
  Array.from(new Set((tags ?? []).map((tag) => tag.trim()).filter(Boolean)));

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const decodeRegistry = Schema.decodeUnknown(CliRegistry);

const ensureStore = (paths: CliStorePaths) =>
  Effect.tryPromise({
    try: async () => {
      await mkdir(paths.logs, { recursive: true });
      if (!existsSync(paths.registry)) {
        await writeFile(paths.registry, `${JSON.stringify({ tasks: [] }, null, 2)}\n`);
      }
    },
    catch: (cause) =>
      new CliStoreError({
        operation: "initialize",
        path: paths.root,
        reason: String(cause),
      }),
  });

const readRegistry = (paths: CliStorePaths) =>
  Effect.gen(function* () {
    yield* ensureStore(paths);
    const raw = yield* Effect.tryPromise({
      try: () => readFile(paths.registry, "utf8"),
      catch: (cause) =>
        new CliStoreError({
          operation: "readRegistry",
          path: paths.registry,
          reason: String(cause),
        }),
    });
    const parsed = yield* Effect.try({
      try: () => JSON.parse(raw) as unknown,
      catch: (cause) =>
        new CliStoreError({
          operation: "parseRegistry",
          path: paths.registry,
          reason: String(cause),
        }),
    });
    return yield* decodeRegistry(parsed).pipe(
      Effect.mapError(
        (cause) =>
          new CliStoreError({
            operation: "decodeRegistry",
            path: paths.registry,
            reason: String(cause),
          }),
      ),
    );
  });

const writeRegistry = (paths: CliStorePaths, registry: CliRegistry) =>
  Effect.tryPromise({
    try: async () => {
      await mkdir(dirname(paths.registry), { recursive: true });
      await writeFile(paths.registry, `${JSON.stringify(registry, null, 2)}\n`);
    },
    catch: (cause) =>
      new CliStoreError({
        operation: "writeRegistry",
        path: paths.registry,
        reason: String(cause),
      }),
  });

const refreshTask = (task: CliTaskRecord): CliTaskRecord => {
  if (!task.pid || task.status !== "running") {
    return task;
  }
  if (isProcessAlive(task.pid)) {
    return task;
  }
  return {
    ...task,
    status: "exited",
    updatedAt: nowIso(),
    exitedAt: nowIso(),
  };
};

export const listCliTasks = (paths = resolveCliStorePaths()) =>
  Effect.gen(function* () {
    const registry = yield* readRegistry(paths);
    const tasks = registry.tasks.map(refreshTask);
    if (JSON.stringify(tasks) !== JSON.stringify(registry.tasks)) {
      yield* writeRegistry(paths, { tasks });
    }
    return tasks;
  });

export const getCliTask = (id: string, paths = resolveCliStorePaths()) =>
  Effect.gen(function* () {
    const tasks = yield* listCliTasks(paths);
    const task = tasks.find((candidate) => candidate.id === id);
    if (!task) {
      return yield* new TaskNotFound({ id });
    }
    return task;
  });

export const startCliTask = (input: CliStartInput, paths = resolveCliStorePaths()) =>
  Effect.gen(function* () {
    const command = input.command.trim();
    if (!command) {
      return yield* new CommandInputError({
        command: "start",
        message: "command must not be blank",
        details: {
          field: "command",
          expected: "non-empty string",
          hint: "Provide a command in the start payload.",
          retryable: false,
        },
      });
    }

    const registry = yield* readRegistry(paths);
    const id = normalizeId(input);
    if (registry.tasks.some((task) => task.id === id && refreshTask(task).status === "running")) {
      return yield* new TaskAlreadyRunning({ id });
    }

    const workdir = resolve(input.workdir ?? process.cwd());
    const logPath = join(paths.logs, `${id}.log`);
    const subprocess = yield* Effect.try({
      try: () =>
        Bun.spawn([command, ...(input.args ?? [])], {
          cwd: workdir,
          env: { ...process.env, ...(input.env ?? {}) },
          stdout: Bun.file(logPath),
          stderr: Bun.file(logPath),
          stdin: "ignore",
        }),
      catch: (cause) => new SpawnFailed({ command, reason: String(cause) }),
    });
    subprocess.unref();

    const timestamp = nowIso();
    const task: CliTaskRecord = {
      id,
      name: input.name?.trim() || command,
      command,
      args: [...(input.args ?? [])],
      workdir,
      env: { ...(input.env ?? {}) },
      tags: normalizeTags(input.tags),
      status: "running",
      pid: subprocess.pid,
      logPath,
      createdAt: timestamp,
      updatedAt: timestamp,
      startedAt: timestamp,
      restartCount: 0,
      ...(input.parentSessionId ? { parentSessionId: input.parentSessionId } : {}),
      notifyOnExit: input.notifyOnExit ?? false,
    };

    const nextTasks = registry.tasks.filter((candidate) => candidate.id !== id).concat(task);
    yield* writeRegistry(paths, { tasks: nextTasks });
    return task;
  });

export const stopCliTask = (id: string, paths = resolveCliStorePaths()) =>
  Effect.gen(function* () {
    const registry = yield* readRegistry(paths);
    const task = registry.tasks.find((candidate) => candidate.id === id);
    if (!task) {
      return yield* new TaskNotFound({ id });
    }
    const refreshed = refreshTask(task);
    if (refreshed.pid && refreshed.status === "running") {
      try {
        process.kill(refreshed.pid, "SIGTERM");
      } catch {
        // Treat missing processes as already stopped and persist terminal state below.
      }
    }
    const stopped: CliTaskRecord = {
      ...refreshed,
      status: "killed",
      updatedAt: nowIso(),
      exitedAt: nowIso(),
    };
    yield* writeRegistry(paths, {
      tasks: registry.tasks.map((candidate) => (candidate.id === id ? stopped : candidate)),
    });
    return stopped;
  });

export const restartCliTask = (id: string, paths = resolveCliStorePaths()) =>
  Effect.gen(function* () {
    const previous = yield* getCliTask(id, paths);
    if (previous.status === "running") {
      yield* stopCliTask(id, paths);
    }
    const restarted = yield* startCliTask(
      {
        id,
        name: previous.name,
        command: previous.command,
        args: previous.args,
        workdir: previous.workdir,
        env: previous.env,
        tags: previous.tags,
        parentSessionId: previous.parentSessionId,
        notifyOnExit: previous.notifyOnExit,
      },
      paths,
    );
    return { ...restarted, restartCount: previous.restartCount + 1 };
  }).pipe(
    Effect.tap((task) =>
      readRegistry(paths).pipe(
        Effect.flatMap((registry) =>
          writeRegistry(paths, {
            tasks: registry.tasks.map((candidate) => (candidate.id === task.id ? task : candidate)),
          }),
        ),
      ),
    ),
  );

export const readCliTaskLogs = (
  id: string,
  options: CliLogsOptions = {},
  paths = resolveCliStorePaths(),
) =>
  Effect.gen(function* () {
    const task = yield* getCliTask(id, paths);
    const text = yield* Effect.tryPromise({
      try: async () => (existsSync(task.logPath) ? readFile(task.logPath, "utf8") : ""),
      catch: (cause) =>
        new CliStoreError({
          operation: "readLogs",
          path: task.logPath,
          reason: String(cause),
        }),
    });
    const lines = text.length ? text.replace(/\n$/, "").split(/\r?\n/) : [];
    return {
      task,
      lines: options.lines ? lines.slice(-options.lines) : lines,
      totalLines: lines.length,
    };
  });

const terminalStatuses = new Set<CliTaskStatus>(["exited", "killed", "failed"]);

export const waitForCliTask = (
  id: string,
  options: CliWaitOptions = {},
  paths = resolveCliStorePaths(),
) =>
  Effect.gen(function* () {
    const timeoutMs = options.timeoutMs ?? 60_000;
    const pollIntervalMs = options.pollIntervalMs ?? 250;
    if (timeoutMs < 0 || !Number.isFinite(timeoutMs)) {
      return yield* new CommandInputError({
        command: "wait",
        message: "timeoutMs must be a non-negative finite number",
        details: {
          field: "timeoutMs",
          expected: "non-negative finite number",
          received: timeoutMs,
          retryable: false,
        },
      });
    }

    const deadline = Date.now() + timeoutMs;
    let task = yield* getCliTask(id, paths);
    while (!terminalStatuses.has(task.status)) {
      if (Date.now() >= deadline) {
        return yield* new TaskWaitTimedOut({ id, timeoutMs });
      }
      yield* Effect.sleep(`${pollIntervalMs} millis`);
      task = yield* getCliTask(id, paths);
    }

    return task;
  });
