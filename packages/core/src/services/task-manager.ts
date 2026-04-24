import type * as PlatformError from "@effect/platform/Error";
import * as FileSystem from "@effect/platform/FileSystem";
import * as NodeContext from "@effect/platform-node/NodeContext";
import {
  Context,
  Deferred,
  Effect,
  Either,
  FiberMap,
  Layer,
  Option as EffectOption,
  PubSub,
  Queue,
  Stream,
  SubscriptionRef,
  Cause,
} from "effect";
import { SpawnFailed, TaskAlreadyRunning, TaskNotFound } from "../domain/errors.ts";
import type { HealthProbe, RestartPolicy } from "../domain/health-probe.ts";
import {
  none,
  some,
  transitionStatus,
  type Option,
  type SpawnInput,
  type Task,
  type TaskEvent as TaskTransitionEvent,
  type TaskStatus,
} from "../domain/task.ts";
import { formatCommand, taskDurationMs } from "../domain/formatting.ts";
import { LogBuffer, type LogBufferInstance, type LogBufferQueryOptions } from "./log-buffer.ts";
import { ProcessSpawner, type ManagedProcess, type ProcessOutputLine } from "./process-spawner.ts";

export const defaultTaskManagerMaxConcurrentTasks = 10;
export const defaultTaskManagerTerminalTaskTtlMs = 5 * 60_000;
export const defaultTaskManagerTotalLogBytesCap = 32 * 1024 * 1024;
export const defaultTaskManagerEvictionSweepIntervalMs = 1_000;
export const defaultTaskManagerWatcherThrottleMs = 30_000;
const defaultEvictedRecordRetentionMs = 60_000;
const shutdownSignalGracePeriodMs = 250;
const shutdownSignalPollIntervalMs = 10;
const shutdownSleepState = new Int32Array(new SharedArrayBuffer(4));

export interface TaskManagerConfiguration {
  readonly maxConcurrentTasks: number;
  readonly terminalTaskTtlMs: number;
  readonly totalLogBytesCap: number;
  readonly evictionSweepIntervalMs: number;
  readonly watcherThrottleMs: number;
}

export interface TaskListFilter {
  readonly tags?: readonly string[];
  readonly status?: TaskStatus | readonly TaskStatus[];
  readonly includeEvicted?: boolean;
  readonly ownerSessionId?: string;
}

export interface EvictedTaskRecord {
  readonly taskId: string;
  readonly evictedAt: Date;
  readonly reason: "ttl" | "memory_cap" | "cleanup";
  readonly ownerSessionId?: string;
}

export interface WatchLogsOptions {
  readonly ownerSessionId: string;
}

interface LogWatcher {
  readonly id: string;
  readonly ownerSessionId: string;
  readonly pattern: RegExp;
  readonly patternText: string;
}

interface SessionWatchState {
  readonly lastNotifiedAt: number;
  readonly suppressedCount: number;
}

export type TaskListResult = ReadonlyArray<Task> & {
  readonly evictedTaskIds: readonly string[];
};

const sharedActivePidsKey = Symbol.for("@bg-tasks/active-pids");

const sharedRecentlyEvictedTasksKey = Symbol.for("@bg-tasks/recently-evicted-tasks");

const sharedRecentlyEvictedTasks = (() => {
  const globalStore = globalThis as typeof globalThis & {
    [sharedRecentlyEvictedTasksKey]?: Map<string, EvictedTaskRecord>;
  };

  if (!globalStore[sharedRecentlyEvictedTasksKey]) {
    globalStore[sharedRecentlyEvictedTasksKey] = new Map<string, EvictedTaskRecord>();
  }

  return globalStore[sharedRecentlyEvictedTasksKey];
})();

const sharedActivePids = (() => {
  const globalStore = globalThis as typeof globalThis & {
    [sharedActivePidsKey]?: Set<number>;
  };

  if (!globalStore[sharedActivePidsKey]) {
    globalStore[sharedActivePidsKey] = new Set<number>();
  }

  return globalStore[sharedActivePidsKey];
})();

export function resetTaskManagerSharedState(): void {
  sharedRecentlyEvictedTasks.clear();
  sharedActivePids.clear();
}

function sleepSync(ms: number): void {
  if (ms <= 0) {
    return;
  }

  Atomics.wait(shutdownSleepState, 0, 0, ms);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function terminateTrackedProcessSync(pid: number, initialSignal: NodeJS.Signals): void {
  if (!isProcessAlive(pid)) {
    sharedActivePids.delete(pid);
    return;
  }

  try {
    process.kill(pid, initialSignal);
  } catch {
    sharedActivePids.delete(pid);
    return;
  }

  const waitForExit = (deadline: number): boolean => {
    while (Date.now() < deadline) {
      if (!isProcessAlive(pid)) {
        return true;
      }

      sleepSync(Math.min(shutdownSignalPollIntervalMs, deadline - Date.now()));
    }

    return !isProcessAlive(pid);
  };

  const firstDeadline = Date.now() + shutdownSignalGracePeriodMs;
  if (waitForExit(firstDeadline)) {
    sharedActivePids.delete(pid);
    return;
  }

  if (initialSignal !== "SIGKILL") {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      sharedActivePids.delete(pid);
      return;
    }

    waitForExit(Date.now() + shutdownSignalGracePeriodMs);
  }

  sharedActivePids.delete(pid);
}

export function terminateTrackedBackgroundProcessesSync(signal: NodeJS.Signals = "SIGTERM"): void {
  for (const pid of Array.from(sharedActivePids)) {
    try {
      terminateTrackedProcessSync(pid, signal);
    } catch {
      // Ignore missing or already-exited processes during shutdown cleanup.
    }
  }
}

export type TaskEvent =
  | { readonly type: "spawned"; readonly taskId: string; readonly task: Task }
  | {
      readonly type: "health_changed";
      readonly taskId: string;
      readonly healthy: boolean;
      readonly detail?: string;
    }
  | { readonly type: "restarting"; readonly taskId: string; readonly attempt: number }
  | {
      readonly type: "exited";
      readonly taskId: string;
      readonly exitCode: number;
      readonly duration: number;
    }
  | { readonly type: "killed"; readonly taskId: string; readonly signal: string }
  | { readonly type: "failed"; readonly taskId: string; readonly reason: string }
  | {
      readonly type: "restart_limit_exceeded";
      readonly taskId: string;
      readonly maxRetries: number;
    }
  | {
      readonly type: "log_matched";
      readonly taskId: string;
      readonly watcherId: string;
      readonly lineNumber: number;
      readonly text: string;
      readonly pattern: string;
      readonly suppressedCount: number;
    };

export type TaskNotificationEvent = TaskEvent;

interface NormalizedSpawnInput {
  readonly id: string;
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly workdir: string;
  readonly env: Readonly<Record<string, string>>;
  readonly tags: readonly string[];
  readonly parentSessionId?: string;
  readonly healthProbe?: HealthProbe;
  readonly restartPolicy?: RestartPolicy;
  readonly notifyOnExit: boolean;
}

interface CreateTaskOptions {
  readonly restartCount: number;
  readonly createdAt?: Date;
}

interface CommandDescriptor {
  readonly command: string;
  readonly args?: readonly string[];
}

interface LogBufferUsage {
  readonly taskId: string;
  readonly bytes: number;
}

type StartOutcome = Either.Either<ManagedProcess, SpawnFailed>;

const TaskManagerConfigurationTag = Context.GenericTag<TaskManagerConfiguration>(
  "@bg-tasks/TaskManagerConfig",
);

const TaskManagerConfigurationDefault = Layer.succeed(TaskManagerConfigurationTag, {
  maxConcurrentTasks: defaultTaskManagerMaxConcurrentTasks,
  terminalTaskTtlMs: defaultTaskManagerTerminalTaskTtlMs,
  totalLogBytesCap: defaultTaskManagerTotalLogBytesCap,
  evictionSweepIntervalMs: defaultTaskManagerEvictionSweepIntervalMs,
  watcherThrottleMs: defaultTaskManagerWatcherThrottleMs,
} satisfies TaskManagerConfiguration);

const activeTaskStatuses = new Set<TaskStatus>(["starting", "healthy", "unhealthy", "running"]);
const terminalTaskStatuses = new Set<TaskStatus>(["exited", "killed", "failed"]);

const normalizeConcurrentLimit = (value: number): number => {
  if (Number.isSafeInteger(value) && value > 0) {
    return value;
  }

  return defaultTaskManagerMaxConcurrentTasks;
};

const normalizeNonNegativeInteger = (value: number, fallback: number): number => {
  if (Number.isSafeInteger(value) && value >= 0) {
    return value;
  }

  return fallback;
};

const normalizePositiveInteger = (value: number, fallback: number): number => {
  if (Number.isSafeInteger(value) && value > 0) {
    return value;
  }

  return fallback;
};

const isTerminalTaskStatus = (status: TaskStatus): boolean => terminalTaskStatuses.has(status);

const toSpawnFailed = (input: CommandDescriptor, reason: string): SpawnFailed =>
  new SpawnFailed({
    command: formatCommand(input),
    reason,
  });

const mapWorkingDirectoryError =
  (input: CommandDescriptor, workdir: string) =>
  (error: PlatformError.PlatformError): SpawnFailed =>
    toSpawnFailed(input, `working directory "${workdir}" is not accessible: ${error.message}`);

const normalizeCollection = (values: readonly string[] | undefined): readonly string[] =>
  Array.from(
    new Set((values ?? []).map((value) => value.trim()).filter((value) => value.length > 0)),
  );

const normalizeEnvironment = (
  env: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> => Object.freeze({ ...env });

const unwrapOption = <T>(option: Option<T>): T | undefined =>
  option._tag === "Some" ? option.value : undefined;

const taskExitTimestamp = (task: Pick<Task, "timestamps">): number =>
  task.timestamps.exitedAt._tag === "Some" ? task.timestamps.exitedAt.value.getTime() : Date.now();

const attachEvictedTaskIds = (
  tasks: Task[],
  evictedTaskIds: readonly string[] = [],
): TaskListResult => {
  const result = tasks as unknown as TaskListResult;
  Object.defineProperty(result, "evictedTaskIds", {
    value: Object.freeze([...evictedTaskIds]),
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return result;
};

const createTaskRecord = (input: NormalizedSpawnInput, options: CreateTaskOptions): Task => {
  const now = new Date();

  return {
    id: input.id,
    name: input.name,
    command: input.command,
    args: input.args,
    workdir: input.workdir,
    env: input.env,
    tags: input.tags,
    status: "starting",
    pid: none,
    exitCode: none,
    timestamps: {
      createdAt: options.createdAt ?? now,
      updatedAt: now,
      startedAt: none,
      exitedAt: none,
      lastStatusChangeAt: now,
    },
    restartCount: options.restartCount,
    parentSessionId: input.parentSessionId ? some(input.parentSessionId) : none,
    healthProbe: input.healthProbe ? some(input.healthProbe) : none,
    restartPolicy: input.restartPolicy ? some(input.restartPolicy) : none,
    notifyOnExit: input.notifyOnExit,
  };
};

const markTaskRunning = (task: Task, pid: number): Task => {
  const now = new Date();
  const nextStatus =
    task.healthProbe._tag === "Some"
      ? task.status
      : transitionStatus(task.status, "process-confirmed-running");

  return {
    ...task,
    pid: some(pid),
    exitCode: none,
    status: nextStatus,
    timestamps: {
      ...task.timestamps,
      updatedAt: now,
      startedAt: some(now),
      exitedAt: none,
      lastStatusChangeAt: nextStatus === task.status ? task.timestamps.lastStatusChangeAt : now,
    },
  };
};

const markTaskExited = (task: Task, exitCode: number): Task => {
  const now = new Date();
  const nextStatus = transitionStatus(task.status, "process-exited");

  return {
    ...task,
    status: nextStatus,
    exitCode: some(exitCode),
    timestamps: {
      ...task.timestamps,
      updatedAt: now,
      exitedAt: some(now),
      lastStatusChangeAt: nextStatus === task.status ? task.timestamps.lastStatusChangeAt : now,
    },
  };
};

const markTaskKilled = (task: Task): Task => {
  const now = new Date();
  const nextStatus = transitionStatus(task.status, "process-killed");

  return {
    ...task,
    status: nextStatus,
    timestamps: {
      ...task.timestamps,
      updatedAt: now,
      exitedAt: some(now),
      lastStatusChangeAt: nextStatus === task.status ? task.timestamps.lastStatusChangeAt : now,
    },
  };
};

const markTaskFailed = (task: Task): Task => {
  const now = new Date();
  const nextStatus: TaskStatus = "failed";

  return {
    ...task,
    status: nextStatus,
    timestamps: {
      ...task.timestamps,
      updatedAt: now,
      exitedAt: some(now),
      lastStatusChangeAt: task.status === nextStatus ? task.timestamps.lastStatusChangeAt : now,
    },
  };
};

const withUpdatedStatus = (task: Task, nextStatus: TaskStatus): Task => {
  if (nextStatus === task.status) {
    return task;
  }

  const now = new Date();
  return {
    ...task,
    status: nextStatus,
    timestamps: {
      ...task.timestamps,
      updatedAt: now,
      lastStatusChangeAt: now,
    },
  };
};

const matchesTaskFilter = (task: Task, filter?: TaskListFilter): boolean => {
  if (!filter) {
    return true;
  }

  const statusFilter =
    filter.status === undefined
      ? undefined
      : Array.isArray(filter.status)
        ? filter.status
        : [filter.status];
  const tagFilter = normalizeCollection(filter.tags);

  if (statusFilter && !statusFilter.includes(task.status)) {
    return false;
  }

  if (tagFilter.length > 0 && !tagFilter.every((tag) => task.tags.includes(tag))) {
    return false;
  }

  if (
    filter.ownerSessionId !== undefined &&
    unwrapOption(task.parentSessionId) !== filter.ownerSessionId
  ) {
    return false;
  }

  return true;
};

const taskToNormalizedSpawnInput = (task: Task): NormalizedSpawnInput => {
  const parentSessionId = unwrapOption(task.parentSessionId);
  const healthProbe = unwrapOption(task.healthProbe);
  const restartPolicy = unwrapOption(task.restartPolicy);

  return {
    id: task.id,
    name: task.name,
    command: task.command,
    args: task.args,
    workdir: task.workdir,
    env: task.env,
    tags: task.tags,
    ...(parentSessionId ? { parentSessionId } : {}),
    ...(healthProbe ? { healthProbe } : {}),
    ...(restartPolicy ? { restartPolicy } : {}),
    notifyOnExit: task.notifyOnExit,
  };
};

export class TaskManager extends Effect.Service<TaskManager>()("@bg-tasks/TaskManager", {
  scoped: Effect.gen(function* () {
    const configuration = yield* TaskManagerConfigurationTag;
    const fileSystem = yield* FileSystem.FileSystem;
    const processSpawner = yield* ProcessSpawner;
    const logBuffer = yield* LogBuffer;

    const tasksRef = yield* SubscriptionRef.make(new Map<string, Task>());
    const fibers = yield* FiberMap.make<string, void, never>();
    const semaphore = yield* Effect.makeSemaphore(
      normalizeConcurrentLimit(configuration.maxConcurrentTasks),
    );
    const events = yield* PubSub.unbounded<TaskEvent>();

    const attemptTokens = new Map<string, string>();
    const processHandles = new Map<string, ManagedProcess>();
    const logBuffers = new Map<string, LogBufferInstance>();
    const startupSignals = new Map<string, Deferred.Deferred<StartOutcome>>();
    const terminalTaskTimestamps = new Map<string, number>();
    const watchersByTask = new Map<string, Map<string, LogWatcher>>();
    const dormantWatchersByTask = new Map<string, Map<string, LogWatcher>>();
    const watcherCountsBySession = new Map<string, number>();
    const watchStatesBySession = new Map<string, SessionWatchState>();
    const taskLineCounts = new Map<string, number>();
    const recentlyEvictedTasks = sharedRecentlyEvictedTasks;

    const incrementSessionWatcherCount = (sessionId: string): void => {
      watcherCountsBySession.set(sessionId, (watcherCountsBySession.get(sessionId) ?? 0) + 1);
    };

    const decrementSessionWatcherCount = (sessionId: string): void => {
      const next = (watcherCountsBySession.get(sessionId) ?? 0) - 1;
      if (next > 0) {
        watcherCountsBySession.set(sessionId, next);
        return;
      }

      watcherCountsBySession.delete(sessionId);
      watchStatesBySession.delete(sessionId);
    };

    const formatWatcherPattern = (pattern: RegExp): string =>
      pattern.flags.length > 0 ? `/${pattern.source}/${pattern.flags}` : pattern.source;

    const consumeTaskWatchers = (
      container: Map<string, Map<string, LogWatcher>>,
      taskId: string,
    ): readonly LogWatcher[] => {
      const taskWatchers = container.get(taskId);
      if (!taskWatchers) {
        return [];
      }

      container.delete(taskId);
      return Array.from(taskWatchers.values());
    };

    const removeWatcherRegistration = (taskId: string, watcherId: string): boolean => {
      for (const container of [watchersByTask, dormantWatchersByTask]) {
        const taskWatchers = container.get(taskId);
        const watcher = taskWatchers?.get(watcherId);
        if (!taskWatchers || !watcher) {
          continue;
        }

        taskWatchers.delete(watcherId);
        decrementSessionWatcherCount(watcher.ownerSessionId);
        if (taskWatchers.size === 0) {
          container.delete(taskId);
        }

        return true;
      }

      return false;
    };

    const removeWatchersForTask = (taskId: string): void => {
      for (const watcher of [
        ...consumeTaskWatchers(watchersByTask, taskId),
        ...consumeTaskWatchers(dormantWatchersByTask, taskId),
      ]) {
        decrementSessionWatcherCount(watcher.ownerSessionId);
      }
    };

    const removeWatchersForSession = (sessionId: string): void => {
      for (const container of [watchersByTask, dormantWatchersByTask]) {
        for (const [taskId, taskWatchers] of container) {
          for (const watcher of Array.from(taskWatchers.values())) {
            if (watcher.ownerSessionId !== sessionId) {
              continue;
            }

            removeWatcherRegistration(taskId, watcher.id);
          }
        }
      }
    };

    const parkWatchersForTask = (taskId: string): void => {
      const taskWatchers = watchersByTask.get(taskId);
      if (!taskWatchers || taskWatchers.size === 0) {
        return;
      }

      watchersByTask.delete(taskId);
      dormantWatchersByTask.set(taskId, taskWatchers);
    };

    const restoreWatchersForTask = (taskId: string): void => {
      const taskWatchers = dormantWatchersByTask.get(taskId);
      if (!taskWatchers || taskWatchers.size === 0) {
        return;
      }

      dormantWatchersByTask.delete(taskId);
      watchersByTask.set(taskId, taskWatchers);
    };

    const clearDormantWatchersForTask = (taskId: string): void => {
      for (const watcher of consumeTaskWatchers(dormantWatchersByTask, taskId)) {
        decrementSessionWatcherCount(watcher.ownerSessionId);
      }
    };

    const resetTaskLineCount = (taskId: string): void => {
      taskLineCounts.set(taskId, 0);
    };

    const nextTaskLineNumber = (taskId: string): number => {
      const next = (taskLineCounts.get(taskId) ?? 0) + 1;
      taskLineCounts.set(taskId, next);
      return next;
    };

    const getWatcherCountForTask = (taskId: string): number =>
      (watchersByTask.get(taskId)?.size ?? 0) + (dormantWatchersByTask.get(taskId)?.size ?? 0);

    const publish = Effect.fnUntraced(function* (event: TaskEvent) {
      yield* PubSub.publish(events, event).pipe(Effect.asVoid);
    });

    const syncRetentionState = Effect.fnUntraced(function* (registry: ReadonlyMap<string, Task>) {
      yield* Effect.sync(() => {
        const currentTaskIds = new Set(registry.keys());

        for (const id of terminalTaskTimestamps.keys()) {
          if (!currentTaskIds.has(id)) {
            terminalTaskTimestamps.delete(id);
          }
        }

        for (const [id, task] of registry) {
          if (isTerminalTaskStatus(task.status)) {
            terminalTaskTimestamps.set(id, taskExitTimestamp(task));
            continue;
          }

          terminalTaskTimestamps.delete(id);
        }
      });
    });

    const purgeExpiredEvictedTasks = Effect.fnUntraced(function* (nowMs = Date.now()) {
      yield* Effect.sync(() => {
        for (const [id, record] of recentlyEvictedTasks) {
          if (nowMs - record.evictedAt.getTime() > defaultEvictedRecordRetentionMs) {
            recentlyEvictedTasks.delete(id);
          }
        }
      });
    });

    const getRecentlyEvictedTaskIds = Effect.fnUntraced(function* (ownerSessionId?: string) {
      yield* purgeExpiredEvictedTasks();

      return Array.from(recentlyEvictedTasks.values())
        .filter(
          (record) => ownerSessionId === undefined || record.ownerSessionId === ownerSessionId,
        )
        .sort((left, right) => right.evictedAt.getTime() - left.evictedAt.getTime())
        .map((record) => record.taskId);
    });

    const validateSpawnInput = Effect.fnUntraced(function* (
      input: SpawnInput,
      options?: { readonly id?: string },
    ) {
      const command = input.command.trim();
      if (command.length === 0) {
        return yield* Effect.fail(toSpawnFailed(input, "command must not be blank"));
      }

      const commandDescriptor: CommandDescriptor = input.args
        ? { command, args: input.args }
        : { command };
      const workdir = input.workdir?.trim().length
        ? input.workdir.trim()
        : globalThis.process.cwd();
      const info = yield* fileSystem
        .stat(workdir)
        .pipe(Effect.mapError(mapWorkingDirectoryError(commandDescriptor, workdir)));

      if (info.type !== "Directory") {
        return yield* Effect.fail(
          toSpawnFailed(commandDescriptor, `working directory "${workdir}" is not a directory`),
        );
      }

      const name =
        input.name.trim().length > 0 ? input.name.trim() : formatCommand(commandDescriptor);
      const normalizedId =
        options?.id ??
        input.id?.trim() ??
        `bg_${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
      const parentSessionId = input.parentSessionId?.trim();

      return {
        id: normalizedId,
        name,
        command,
        args: [...(input.args ?? [])],
        workdir,
        env: normalizeEnvironment(input.env),
        tags: normalizeCollection(input.tags),
        ...(parentSessionId ? { parentSessionId } : {}),
        ...(input.healthProbe ? { healthProbe: input.healthProbe } : {}),
        ...(input.restartPolicy ? { restartPolicy: input.restartPolicy } : {}),
        notifyOnExit: input.notifyOnExit ?? false,
      };
    });

    const getTask = Effect.fnUntraced(function* (id: string) {
      const registry = yield* SubscriptionRef.get(tasksRef);
      const task = registry.get(id);

      if (!task) {
        return yield* Effect.fail(new TaskNotFound({ id }));
      }

      return task;
    });

    const setTask = Effect.fnUntraced(function* (task: Task) {
      yield* SubscriptionRef.update(tasksRef, (registry) => {
        const updated = new Map(registry);
        updated.set(task.id, task);
        return updated;
      });
    });

    const evictTaskIfPresent = Effect.fnUntraced(function* (
      id: string,
      reason: EvictedTaskRecord["reason"],
    ) {
      const evictedAt = new Date();
      const removed = yield* SubscriptionRef.modify(tasksRef, (registry) => {
        const task = registry.get(id);
        if (!task) {
          return [none, registry] as const;
        }

        const updated = new Map(registry);
        updated.delete(id);
        return [some(task), updated] as const;
      });

      if (removed._tag === "None") {
        return removed;
      }

      const buffer = logBuffers.get(id);
      if (buffer) {
        yield* buffer.clear().pipe(Effect.orDie);
      }

      yield* Effect.sync(() => {
        attemptTokens.delete(id);
        processHandles.delete(id);
        startupSignals.delete(id);
        logBuffers.delete(id);
        terminalTaskTimestamps.delete(id);
        taskLineCounts.delete(id);
        removeWatchersForTask(id);
        recentlyEvictedTasks.set(id, {
          taskId: id,
          evictedAt,
          reason,
          ownerSessionId: unwrapOption(removed.value.parentSessionId),
        });
      });

      return removed;
    });

    const getLogBufferUsage = Effect.fnUntraced(function* () {
      return yield* Effect.forEach(
        Array.from(logBuffers.entries()),
        ([taskId, buffer]) => buffer.byteLength.pipe(Effect.map((bytes) => ({ taskId, bytes }))),
        { concurrency: "unbounded" },
      );
    });

    const enforceLogMemoryCap = Effect.fnUntraced(function* () {
      const usage: readonly LogBufferUsage[] = yield* getLogBufferUsage();
      const totalBytes = usage.reduce((sum, entry) => sum + entry.bytes, 0);
      if (totalBytes <= configuration.totalLogBytesCap) {
        return;
      }

      const registry = yield* SubscriptionRef.get(tasksRef);
      const terminalCandidates = usage
        .flatMap((entry) => {
          const task = registry.get(entry.taskId);
          if (!task || !isTerminalTaskStatus(task.status)) {
            return [];
          }

          return [
            {
              ...entry,
              terminalAt: terminalTaskTimestamps.get(entry.taskId) ?? taskExitTimestamp(task),
            },
          ];
        })
        .sort((left, right) => left.terminalAt - right.terminalAt);

      let remainingBytes = totalBytes;
      for (const candidate of terminalCandidates) {
        if (remainingBytes <= configuration.totalLogBytesCap) {
          break;
        }

        const removed = yield* evictTaskIfPresent(candidate.taskId, "memory_cap");
        if (removed._tag === "Some") {
          remainingBytes -= candidate.bytes;
        }
      }
    });

    const runEvictionSweep = Effect.fnUntraced(function* () {
      const nowMs = Date.now();
      yield* purgeExpiredEvictedTasks(nowMs);

      const registry = yield* SubscriptionRef.get(tasksRef);
      yield* syncRetentionState(registry);

      const expiredTaskIds = Array.from(registry.values())
        .filter((task) => {
          if (!isTerminalTaskStatus(task.status)) {
            return false;
          }

          const terminalAt = terminalTaskTimestamps.get(task.id) ?? taskExitTimestamp(task);
          return nowMs - terminalAt >= configuration.terminalTaskTtlMs;
        })
        .sort(
          (left, right) =>
            (terminalTaskTimestamps.get(left.id) ?? taskExitTimestamp(left)) -
            (terminalTaskTimestamps.get(right.id) ?? taskExitTimestamp(right)),
        )
        .map((task) => task.id);

      for (const id of expiredTaskIds) {
        yield* evictTaskIfPresent(id, "ttl");
      }

      yield* enforceLogMemoryCap();
    });

    const mutateTaskForAttempt = Effect.fnUntraced(function* (
      id: string,
      attemptToken: string,
      transform: (task: Task) => Task,
    ) {
      return yield* SubscriptionRef.modify(tasksRef, (registry) => {
        if (attemptTokens.get(id) !== attemptToken) {
          return [none, registry] as const;
        }

        const current = registry.get(id);
        if (!current) {
          return [none, registry] as const;
        }

        const next = transform(current);
        if (next === current) {
          return [some({ previous: current, next }), registry] as const;
        }

        const updated = new Map(registry);
        updated.set(id, next);
        return [some({ previous: current, next }), updated] as const;
      });
    });

    const completeStartSignal = Effect.fnUntraced(function* (
      signal: Deferred.Deferred<StartOutcome>,
      outcome: StartOutcome,
    ) {
      const alreadyCompleted = yield* Deferred.isDone(signal);
      if (!alreadyCompleted) {
        yield* Deferred.succeed(signal, outcome);
      }
    });

    const getOrCreateFallbackBuffer = Effect.fnUntraced(function* (
      id: string,
      attemptToken: string,
      initialLine?: string,
    ) {
      const existing = logBuffers.get(id);
      if (existing) {
        if (initialLine) {
          yield* existing.append(`${initialLine}\n`);
        }
        return existing;
      }

      const buffer = yield* logBuffer.make(id).pipe(Effect.orDie);
      if (initialLine) {
        yield* buffer.append(`${initialLine}\n`);
      }

      yield* Effect.sync(() => {
        if (attemptTokens.get(id) === attemptToken) {
          logBuffers.set(id, buffer);
        }
      });

      return buffer;
    });

    const markRunningForAttempt = Effect.fnUntraced(function* (
      id: string,
      attemptToken: string,
      pid: number,
    ) {
      yield* mutateTaskForAttempt(id, attemptToken, (task: Task) => markTaskRunning(task, pid));
    });

    const markExitedForAttempt = Effect.fnUntraced(function* (
      id: string,
      attemptToken: string,
      exitCode: number,
    ) {
      const mutation = yield* mutateTaskForAttempt(id, attemptToken, (task: Task) =>
        markTaskExited(task, exitCode),
      );
      if (
        mutation._tag === "Some" &&
        mutation.value.previous.status !== mutation.value.next.status
      ) {
        yield* Effect.sync(() => {
          parkWatchersForTask(id);
        });
        yield* publish({
          type: "exited",
          taskId: id,
          exitCode,
          duration: taskDurationMs(mutation.value.next),
        });
      }
    });

    const markKilledForAttempt = Effect.fnUntraced(function* (
      id: string,
      attemptToken: string,
      signal: string,
    ) {
      const mutation = yield* mutateTaskForAttempt(id, attemptToken, (task: Task) =>
        markTaskKilled(task),
      );
      if (
        mutation._tag === "Some" &&
        mutation.value.previous.status !== mutation.value.next.status
      ) {
        yield* Effect.sync(() => {
          parkWatchersForTask(id);
        });
        yield* publish({ type: "killed", taskId: id, signal });
      }
    });

    const markFailedForAttempt = Effect.fnUntraced(function* (
      id: string,
      attemptToken: string,
      reason: string,
    ) {
      yield* getOrCreateFallbackBuffer(id, attemptToken, reason);
      const mutation = yield* mutateTaskForAttempt(id, attemptToken, (task: Task) =>
        markTaskFailed(task),
      );
      if (
        mutation._tag === "Some" &&
        mutation.value.previous.status !== mutation.value.next.status
      ) {
        yield* Effect.sync(() => {
          parkWatchersForTask(id);
        });
        yield* publish({ type: "failed", taskId: id, reason });
      }
    });

    const awaitManagedProcess = Effect.fnUntraced(function* (
      id: string,
      attemptToken: string | undefined,
    ) {
      if (!attemptToken) {
        return yield* Effect.fail(new TaskAlreadyRunning({ id }));
      }

      const existing = processHandles.get(id);
      if (existing && attemptTokens.get(id) === attemptToken) {
        return existing;
      }

      const signal = startupSignals.get(id);
      if (!signal) {
        return yield* Effect.fail(new TaskAlreadyRunning({ id }));
      }

      const outcome = yield* Deferred.await(signal);
      if (Either.isRight(outcome) && attemptTokens.get(id) === attemptToken) {
        return outcome.right;
      }

      return yield* Effect.fail(new TaskAlreadyRunning({ id }));
    });

    const getTaskLogBuffer = Effect.fnUntraced(function* (id: string) {
      yield* getTask(id);

      const existing = logBuffers.get(id);
      if (existing) {
        return existing;
      }

      const signal = startupSignals.get(id);
      if (signal) {
        const outcome = yield* Deferred.await(signal);
        if (Either.isRight(outcome)) {
          return outcome.right.buffer;
        }
      }

      const buffer = yield* logBuffer.make(id).pipe(Effect.orDie);
      yield* Effect.sync(() => {
        if (!logBuffers.has(id)) {
          logBuffers.set(id, buffer);
        }
      });

      return logBuffers.get(id) ?? buffer;
    });

    const handleWatchedLine = (
      taskId: string,
      line: ProcessOutputLine,
    ): Effect.Effect<void, never> => {
      const lineNumber = nextTaskLineNumber(taskId);

      return Effect.gen(function* () {
        const taskWatchers = yield* Effect.sync(() =>
          Array.from(watchersByTask.get(taskId)?.values() ?? []),
        );
        if (taskWatchers.length === 0) {
          return;
        }

        const nowMs = Date.now();
        const matchedEvents = yield* Effect.sync(() => {
          const eventsToPublish: Array<Extract<TaskEvent, { readonly type: "log_matched" }>> = [];

          for (const watcher of taskWatchers) {
            watcher.pattern.lastIndex = 0;
            if (!watcher.pattern.test(line.text)) {
              continue;
            }

            const sessionState = watchStatesBySession.get(watcher.ownerSessionId) ?? {
              lastNotifiedAt: 0,
              suppressedCount: 0,
            };
            if (nowMs - sessionState.lastNotifiedAt < configuration.watcherThrottleMs) {
              watchStatesBySession.set(watcher.ownerSessionId, {
                lastNotifiedAt: sessionState.lastNotifiedAt,
                suppressedCount: sessionState.suppressedCount + 1,
              });
              continue;
            }

            eventsToPublish.push({
              type: "log_matched",
              taskId,
              watcherId: watcher.id,
              lineNumber,
              text: line.text,
              pattern: watcher.patternText,
              suppressedCount: sessionState.suppressedCount,
            });
            watchStatesBySession.set(watcher.ownerSessionId, {
              lastNotifiedAt: nowMs,
              suppressedCount: 0,
            });
          }

          return eventsToPublish;
        });

        yield* Effect.forEach(matchedEvents, publish, { discard: true });
      }).pipe(
        Effect.catchAllCause((cause) =>
          Effect.logWarning(`log watcher matching failed for ${taskId}: ${cause}`),
        ),
      );
    };

    const waitForTaskTerminal = Effect.fnUntraced(function* (id: string) {
      const current = yield* getTask(id);
      if (isTerminalTaskStatus(current.status)) {
        return current;
      }

      const maybeTask = yield* tasksRef.changes.pipe(
        Stream.map((registry) => registry.get(id)),
        Stream.filter(
          (task): task is Task => task !== undefined && isTerminalTaskStatus(task.status),
        ),
        Stream.take(1),
        Stream.runHead,
      );

      if (EffectOption.isSome(maybeTask)) {
        return maybeTask.value;
      }

      return yield* getTask(id);
    });

    const runTaskLifecycle = (
      taskId: string,
      attemptToken: string,
      input: NormalizedSpawnInput,
      signal: Deferred.Deferred<StartOutcome>,
    ) => {
      let spawnedPid: number | undefined;

      return Effect.scoped(
        Effect.gen(function* () {
          const managed = yield* processSpawner.spawn(input, {
            onOutputLine: (line) => handleWatchedLine(taskId, line),
          });
          spawnedPid = managed.pid;

          yield* Effect.sync(() => {
            if (attemptTokens.get(taskId) === attemptToken) {
              processHandles.set(taskId, managed);
              logBuffers.set(taskId, managed.buffer);
            }

            sharedActivePids.add(managed.pid);
          });

          yield* completeStartSignal(signal, Either.right(managed));
          yield* markRunningForAttempt(taskId, attemptToken, managed.pid);

          const exit = yield* Effect.either(managed.exitCode);
          if (Either.isRight(exit)) {
            yield* markExitedForAttempt(taskId, attemptToken, Number(exit.right));
            return;
          }

          switch (exit.left._tag) {
            case "ProcessKilled": {
              yield* markKilledForAttempt(taskId, attemptToken, exit.left.signal);
              return;
            }
            case "SpawnFailed": {
              yield* markFailedForAttempt(taskId, attemptToken, exit.left.reason);
              return;
            }
          }
        }).pipe(
          Effect.catchTag("SpawnFailed", (error) =>
            Effect.gen(function* () {
              yield* completeStartSignal(signal, Either.left(error));
              yield* markFailedForAttempt(taskId, attemptToken, error.reason);
            }),
          ),
          Effect.catchAllCause((cause) =>
            Effect.gen(function* () {
              const squashed = Cause.squash(cause);
              const reason = squashed instanceof Error ? squashed.message : String(squashed);
              yield* completeStartSignal(
                signal,
                Either.left(
                  new SpawnFailed({
                    command: formatCommand({ command: input.command, args: input.args }),
                    reason,
                  }),
                ),
              );
              yield* markFailedForAttempt(taskId, attemptToken, reason);
            }),
          ),
          Effect.ensuring(
            Effect.gen(function* () {
              yield* Effect.sync(() => {
                if (spawnedPid !== undefined) {
                  sharedActivePids.delete(spawnedPid);
                }

                if (attemptTokens.get(taskId) === attemptToken) {
                  attemptTokens.delete(taskId);
                  startupSignals.delete(taskId);
                  processHandles.delete(taskId);
                }
              });
              yield* semaphore.release(1);
            }),
          ),
        ),
      ).pipe(Effect.asVoid, Effect.orDie);
    };

    const startTask = Effect.fnUntraced(function* (
      task: Task,
      input: NormalizedSpawnInput,
      options?: {
        readonly preventActiveReplacement?: boolean;
        readonly restoreDormantWatchers?: boolean;
      },
    ) {
      const signal = yield* Deferred.make<StartOutcome>();
      const attemptToken = crypto.randomUUID();

      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          yield* semaphore.take(1);

          const currentRegistry = yield* SubscriptionRef.get(tasksRef);
          const currentTask = currentRegistry.get(task.id);
          if (
            options?.preventActiveReplacement !== false &&
            currentTask &&
            !isTerminalTaskStatus(currentTask.status)
          ) {
            yield* semaphore.release(1);
            return yield* Effect.fail(new TaskAlreadyRunning({ id: task.id }));
          }

          yield* Effect.sync(() => {
            attemptTokens.set(task.id, attemptToken);
            processHandles.delete(task.id);
            logBuffers.delete(task.id);
            startupSignals.set(task.id, signal);
            terminalTaskTimestamps.delete(task.id);
            resetTaskLineCount(task.id);
            if (options?.restoreDormantWatchers) {
              restoreWatchersForTask(task.id);
            } else {
              clearDormantWatchersForTask(task.id);
            }
            // Clear eviction markers only when a task ID is explicitly reused.
            // Doing this from the background registry-sync path races with
            // intermediate sweep snapshots while multiple terminal tasks are
            // being evicted in sequence.
            recentlyEvictedTasks.delete(task.id);
          });

          yield* setTask(task);
          yield* publish({ type: "spawned", taskId: task.id, task });

          yield* FiberMap.run(
            fibers,
            task.id,
            runTaskLifecycle(task.id, attemptToken, input, signal),
          );
          yield* restore(Deferred.await(signal));

          return yield* getTask(task.id);
        }).pipe(Effect.onError(() => semaphore.release(1).pipe(Effect.orDie))),
      );
    });

    const spawn = Effect.fn("TaskManager.spawn")(function* (input: SpawnInput) {
      const normalized = yield* validateSpawnInput(input);
      const task = createTaskRecord(normalized, { restartCount: 0 });
      return yield* startTask(task, normalized);
    });

    const kill = Effect.fn("TaskManager.kill")(function* (id: string) {
      const task = yield* getTask(id);
      if (!activeTaskStatuses.has(task.status)) {
        return yield* Effect.fail(new TaskAlreadyRunning({ id }));
      }

      const attemptToken = attemptTokens.get(id);
      const managed = yield* awaitManagedProcess(id, attemptToken);

      yield* managed.kill("SIGTERM").pipe(Effect.catchTag("ProcessKilled", () => Effect.void));

      return yield* waitForTaskTerminal(id);
    });

    const status = Effect.fn("TaskManager.status")(function* (id: string) {
      return yield* getTask(id);
    });

    const list = Effect.fn("TaskManager.list")(function* (filter?: TaskListFilter) {
      const registry = yield* SubscriptionRef.get(tasksRef);
      const tasks = Array.from(registry.values()).filter((task) => matchesTaskFilter(task, filter));
      const evictedTaskIds = filter?.includeEvicted
        ? yield* getRecentlyEvictedTaskIds(filter.ownerSessionId)
        : [];
      return attachEvictedTaskIds(tasks, evictedTaskIds);
    });

    const logs = Effect.fn("TaskManager.logs")(function* (
      id: string,
      options?: LogBufferQueryOptions,
    ) {
      const buffer = yield* getTaskLogBuffer(id);
      return yield* buffer.read(options);
    });

    const rawLogSnapshot = Effect.fn("TaskManager.rawLogSnapshot")(function* (id: string) {
      const buffer = yield* getTaskLogBuffer(id);
      return yield* buffer.snapshot;
    });

    const watchLogs = Effect.fn("TaskManager.watchLogs")(function* (
      id: string,
      pattern: RegExp,
      options: WatchLogsOptions,
    ) {
      const task = yield* getTask(id);

      const ownerSessionId = options.ownerSessionId.trim();
      const watcherId = `w_${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;

      yield* Effect.sync(() => {
        const watcherStore = isTerminalTaskStatus(task.status)
          ? dormantWatchersByTask
          : watchersByTask;
        const taskWatchers = watcherStore.get(id) ?? new Map<string, LogWatcher>();
        taskWatchers.set(watcherId, {
          id: watcherId,
          ownerSessionId,
          pattern,
          patternText: formatWatcherPattern(pattern),
        });
        watcherStore.set(id, taskWatchers);
        incrementSessionWatcherCount(ownerSessionId);
      });

      return watcherId;
    });

    const unwatchLogs = Effect.fn("TaskManager.unwatchLogs")(function* (
      id: string,
      watcherId: string,
    ) {
      yield* getTask(id);
      return yield* Effect.sync(() => removeWatcherRegistration(id, watcherId));
    });

    const watcherCount = Effect.fn("TaskManager.watcherCount")(function* (id: string) {
      yield* getTask(id);
      return yield* Effect.sync(() => getWatcherCountForTask(id));
    });

    const searchLogs = Effect.fn("TaskManager.searchLogs")(function* (
      id: string,
      pattern: RegExp,
      options?: LogBufferQueryOptions,
    ) {
      const buffer = yield* getTaskLogBuffer(id);
      return yield* buffer.search(pattern, options);
    });

    const lastLogLine = Effect.fn("TaskManager.lastLogLine")(function* (id: string) {
      const buffer = yield* getTaskLogBuffer(id);
      return yield* buffer.lastLine;
    });

    const restart = Effect.fn("TaskManager.restart")(function* (id: string) {
      const current = yield* getTask(id);
      const attempt = current.restartCount + 1;

      yield* publish({ type: "restarting", taskId: id, attempt });
      yield* kill(id).pipe(Effect.catchTag("TaskAlreadyRunning", () => Effect.void));

      const normalized = taskToNormalizedSpawnInput(current);
      const nextTask = createTaskRecord(normalized, {
        restartCount: attempt,
        createdAt: current.timestamps.createdAt,
      });

      return yield* startTask(nextTask, normalized, {
        preventActiveReplacement: false,
        restoreDormantWatchers: true,
      });
    });

    const cleanupBySession = Effect.fn("TaskManager.cleanupBySession")(function* (
      sessionId: string,
    ) {
      const ownedTasks = yield* list({ ownerSessionId: sessionId });
      yield* Effect.sync(() => {
        removeWatchersForSession(sessionId);
      });

      return yield* Effect.forEach(
        ownedTasks,
        (task) => (activeTaskStatuses.has(task.status) ? kill(task.id) : Effect.succeed(task)),
        { concurrency: "unbounded" },
      );
    });

    const removeTask = Effect.fn("TaskManager.removeTask")(function* (id: string) {
      const task = yield* getTask(id);
      if (activeTaskStatuses.has(task.status)) {
        return yield* Effect.fail(new TaskAlreadyRunning({ id }));
      }

      const removed = yield* evictTaskIfPresent(id, "cleanup");
      if (removed._tag === "None") {
        return yield* Effect.fail(new TaskNotFound({ id }));
      }

      return task;
    });

    const mutateTask = Effect.fnUntraced(function* (id: string, transform: (task: Task) => Task) {
      return yield* SubscriptionRef.modify(tasksRef, (registry) => {
        const current = registry.get(id);
        if (!current) {
          return [none, registry] as const;
        }

        const next = transform(current);
        if (next === current) {
          return [some({ previous: current, next }), registry] as const;
        }

        const updated = new Map(registry);
        updated.set(id, next);
        return [some({ previous: current, next }), updated] as const;
      });
    });

    const updateTaskStatus = Effect.fnUntraced(function* (
      id: string,
      transition: TaskTransitionEvent,
      detail?: string,
    ) {
      const mutation = yield* mutateTask(id, (task) =>
        withUpdatedStatus(task, transitionStatus(task.status, transition)),
      );
      if (!mutation || mutation._tag === "None") {
        return;
      }

      const { previous, next } = mutation.value;
      if (previous.status === next.status) {
        return;
      }

      switch (next.status) {
        case "healthy":
          yield* publish({
            type: "health_changed",
            taskId: id,
            healthy: true,
            ...(detail ? { detail } : {}),
          });
          break;
        case "unhealthy":
          yield* publish({
            type: "health_changed",
            taskId: id,
            healthy: false,
            ...(detail ? { detail } : {}),
          });
          break;
      }
    });

    const publishEvent = Effect.fnUntraced(function* (event: TaskEvent) {
      yield* publish(event);
    });

    const subscribeToEvents = (): Effect.Effect<
      Queue.Dequeue<TaskEvent>,
      never,
      import("effect").Scope.Scope
    > => PubSub.subscribe(events);

    const subscribeToChanges = () => tasksRef.changes;

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        watchersByTask.clear();
        dormantWatchersByTask.clear();
        watcherCountsBySession.clear();
        watchStatesBySession.clear();
        taskLineCounts.clear();
      }),
    );

    yield* syncRetentionState(new Map());
    yield* tasksRef.changes.pipe(
      Stream.runForEach((registry) =>
        syncRetentionState(registry).pipe(
          Effect.catchAllCause((cause) => Effect.logError(`task retention sync failed: ${cause}`)),
        ),
      ),
      Effect.forkScoped,
    );
    yield* Effect.forever(
      runEvictionSweep().pipe(
        Effect.catchAllCause((cause) => Effect.logError(`task eviction sweep failed: ${cause}`)),
        Effect.zipRight(Effect.sleep(`${configuration.evictionSweepIntervalMs} millis`)),
      ),
    ).pipe(Effect.forkScoped);

    return {
      spawn,
      kill,
      status,
      list,
      logs,
      rawLogSnapshot,
      watchLogs,
      unwatchLogs,
      watcherCount,
      searchLogs,
      lastLogLine,
      restart,
      cleanupBySession,
      removeTask,
      mutateTask,
      updateTaskStatus,
      publishEvent,
      subscribeToEvents,
      subscribeToChanges,
    };
  }),
  dependencies: [
    TaskManagerConfigurationDefault,
    ProcessSpawner.Default,
    LogBuffer.Default,
    NodeContext.layer,
  ],
}) {
  static layer(configuration: Partial<TaskManagerConfiguration> = {}) {
    resetTaskManagerSharedState();

    const mergedConfiguration = {
      maxConcurrentTasks: normalizeConcurrentLimit(
        configuration.maxConcurrentTasks ?? defaultTaskManagerMaxConcurrentTasks,
      ),
      terminalTaskTtlMs: normalizeNonNegativeInteger(
        configuration.terminalTaskTtlMs ?? defaultTaskManagerTerminalTaskTtlMs,
        defaultTaskManagerTerminalTaskTtlMs,
      ),
      totalLogBytesCap: normalizePositiveInteger(
        configuration.totalLogBytesCap ?? defaultTaskManagerTotalLogBytesCap,
        defaultTaskManagerTotalLogBytesCap,
      ),
      evictionSweepIntervalMs: normalizePositiveInteger(
        configuration.evictionSweepIntervalMs ?? defaultTaskManagerEvictionSweepIntervalMs,
        defaultTaskManagerEvictionSweepIntervalMs,
      ),
      watcherThrottleMs: normalizePositiveInteger(
        configuration.watcherThrottleMs ?? defaultTaskManagerWatcherThrottleMs,
        defaultTaskManagerWatcherThrottleMs,
      ),
    } satisfies TaskManagerConfiguration;

    return this.DefaultWithoutDependencies.pipe(
      Layer.provideMerge(Layer.succeed(TaskManagerConfigurationTag, mergedConfiguration)),
      Layer.provideMerge(ProcessSpawner.Default),
      Layer.provideMerge(LogBuffer.Default),
      Layer.provideMerge(NodeContext.layer),
    );
  }
}
