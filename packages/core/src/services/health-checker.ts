import * as Command from "@effect/platform/Command";
import * as HttpClient from "@effect/platform/HttpClient";
import * as NodeContext from "@effect/platform-node/NodeContext";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as net from "node:net";
import { Effect, FiberMap, Layer, Schedule, Stream } from "effect";
import { HealthCheckFailed } from "../domain/errors.ts";
import {
  getHealthProbeIntervalMs,
  getHealthProbeStartupTimeoutMs,
  getHealthProbeTimeoutMs,
  type CommandHealthProbe,
  type HealthProbe,
  type HealthResult,
  type HttpHealthProbe,
  type TcpHealthProbe,
} from "../domain/health-probe.ts";
import {
  transitionStatus,
  type Task,
  type TaskEvent as TaskTransitionEvent,
  type TaskStatus,
} from "../domain/task.ts";
import { TaskManager } from "./task-manager.ts";

const defaultHttpExpectedStatus = 200;
const defaultCommandExpectedExitCode = 0;
const monitoredStatuses = new Set<TaskStatus>(["starting", "healthy", "unhealthy", "running"]);

interface ProbeExecutionContext {
  readonly id: string;
  readonly workdir: string;
  readonly env: Readonly<Record<string, string>>;
}

const formatUnknownError = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "object" && error !== null && "_tag" in error) {
    return String(error._tag);
  }

  return String(error);
};

const responseTimeFrom = (startedAt: number): number => Math.max(0, Date.now() - startedAt);

const hasHealthProbe = (
  task: Task,
): task is Task & {
  readonly healthProbe: { readonly _tag: "Some"; readonly value: HealthProbe };
} => task.healthProbe._tag === "Some";

const shouldMonitorTask = (
  task: Task,
): task is Task & {
  readonly healthProbe: { readonly _tag: "Some"; readonly value: HealthProbe };
} => monitoredStatuses.has(task.status) && hasHealthProbe(task);

const toProbeExecutionContext = (
  task: Pick<Task, "id" | "workdir" | "env">,
): ProbeExecutionContext => ({
  id: task.id,
  workdir: task.workdir,
  env: task.env,
});

const toHealthCheckFailed = (
  context: ProbeExecutionContext,
  probe: HealthProbe,
  reason: string,
): HealthCheckFailed =>
  new HealthCheckFailed({
    id: context.id,
    probe: probe.type,
    reason,
  });

export const isWithinStartupGracePeriod = (
  task: Task,
  probe: HealthProbe,
  now = Date.now(),
): boolean => {
  if (task.status !== "starting") {
    return false;
  }

  const startedAt =
    task.timestamps.startedAt._tag === "Some"
      ? task.timestamps.startedAt.value.getTime()
      : task.timestamps.createdAt.getTime();

  return now - startedAt < getHealthProbeStartupTimeoutMs(probe);
};

const runHttpHealthProbe = Effect.fn("HealthChecker.runHttpHealthProbe")(function* (
  context: ProbeExecutionContext,
  probe: HttpHealthProbe,
) {
  const client = yield* HttpClient.HttpClient;
  const startedAt = Date.now();
  const expectedStatus = probe.expectedStatus ?? defaultHttpExpectedStatus;

  const response = yield* client.get(probe.url).pipe(
    Effect.timeout(getHealthProbeTimeoutMs(probe)),
    Effect.mapError((error) =>
      toHealthCheckFailed(context, probe, `HTTP probe failed: ${formatUnknownError(error)}`),
    ),
  );

  const responseTimeMs = responseTimeFrom(startedAt);
  if (response.status === expectedStatus) {
    const result: HealthResult = { healthy: true, responseTimeMs };
    return result;
  }

  const result: HealthResult = {
    healthy: false,
    responseTimeMs,
    detail: `expected status ${expectedStatus}, received ${response.status}`,
  };
  return result;
});

const connectTcp = (probe: TcpHealthProbe) =>
  Effect.tryPromise({
    try: (signal) =>
      new Promise<void>((resolve, reject) => {
        const socket = net.createConnection({ host: probe.host, port: probe.port });

        const cleanup = () => {
          socket.removeListener("connect", onConnect);
          socket.removeListener("timeout", onTimeout);
          socket.removeListener("error", onError);
          signal.removeEventListener("abort", onAbort);
        };

        const fail = (error: unknown) => {
          cleanup();
          socket.destroy();
          reject(error);
        };

        const onConnect = () => {
          cleanup();
          socket.end();
          resolve();
        };

        const onTimeout = () =>
          fail(new Error(`connection timed out after ${getHealthProbeTimeoutMs(probe)}ms`));
        const onError = (error: Error) => fail(error);
        const onAbort = () => fail(new Error("connection aborted"));

        socket.setTimeout(getHealthProbeTimeoutMs(probe));
        socket.once("connect", onConnect);
        socket.once("timeout", onTimeout);
        socket.once("error", onError);
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    catch: (error) => error,
  });

const runTcpHealthProbe = Effect.fn("HealthChecker.runTcpHealthProbe")(function* (
  context: ProbeExecutionContext,
  probe: TcpHealthProbe,
) {
  const startedAt = Date.now();

  yield* connectTcp(probe).pipe(
    Effect.timeout(getHealthProbeTimeoutMs(probe)),
    Effect.mapError((error) =>
      toHealthCheckFailed(context, probe, `TCP probe failed: ${formatUnknownError(error)}`),
    ),
  );

  const result: HealthResult = {
    healthy: true,
    responseTimeMs: responseTimeFrom(startedAt),
  };
  return result;
});

const runCommandHealthProbe = Effect.fn("HealthChecker.runCommandHealthProbe")(function* (
  context: ProbeExecutionContext,
  probe: CommandHealthProbe,
) {
  const startedAt = Date.now();
  const expectedExitCode = probe.expectedExitCode ?? defaultCommandExpectedExitCode;
  const command = Command.make(probe.command).pipe(
    Command.workingDirectory(context.workdir),
    Command.env(context.env),
    Command.runInShell(true),
  );

  const maybeExitCode = yield* Command.exitCode(command).pipe(
    Effect.mapError((error) =>
      toHealthCheckFailed(context, probe, `command probe failed: ${formatUnknownError(error)}`),
    ),
    Effect.timeoutOption(getHealthProbeTimeoutMs(probe)),
  );

  if (maybeExitCode._tag === "None") {
    return yield* Effect.fail(toHealthCheckFailed(context, probe, "command probe timed out"));
  }

  const exitCode = maybeExitCode.value;

  const responseTimeMs = responseTimeFrom(startedAt);
  if (exitCode === expectedExitCode) {
    const result: HealthResult = { healthy: true, responseTimeMs };
    return result;
  }

  const result: HealthResult = {
    healthy: false,
    responseTimeMs,
    detail: `expected exit code ${expectedExitCode}, received ${exitCode}`,
  };
  return result;
});

export const runHealthProbe = Effect.fn("HealthChecker.runHealthProbe")(function* (
  context: ProbeExecutionContext,
  probe: HealthProbe,
) {
  switch (probe.type) {
    case "http":
      return yield* runHttpHealthProbe(context, probe);
    case "tcp":
      return yield* runTcpHealthProbe(context, probe);
    case "command":
      return yield* runCommandHealthProbe(context, probe);
  }
});

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

export class HealthChecker extends Effect.Service<HealthChecker>()("@bg-tasks/HealthChecker", {
  scoped: Effect.gen(function* () {
    const taskManager = yield* TaskManager;
    const probeFibers = yield* FiberMap.make<string, void, never>();
    const activeProbeIntervals = new Map<string, number>();

    const publishHealthChanged = Effect.fnUntraced(function* (
      taskId: string,
      healthy: boolean,
      detail?: string,
    ) {
      yield* taskManager.publishEvent({
        type: "health_changed",
        taskId,
        healthy,
        ...(detail ? { detail } : {}),
      });
    });

    const updateHealthState = Effect.fn("HealthChecker.updateHealthState")(function* (
      taskId: string,
      healthy: boolean,
      detail?: string,
    ) {
      const transition: TaskTransitionEvent = healthy
        ? "health-probe-passed"
        : "health-probe-failed";

      const mutation = yield* taskManager.mutateTask(taskId, (task) =>
        withUpdatedStatus(task, transitionStatus(task.status, transition)),
      );

      if (!mutation || mutation._tag === "None") {
        return;
      }

      const { previous, next: nextTask } = mutation.value;
      if (previous.status !== nextTask.status) {
        switch (nextTask.status) {
          case "healthy":
            yield* publishHealthChanged(taskId, true, detail);
            break;
          case "unhealthy":
            yield* publishHealthChanged(taskId, false, detail);
            break;
        }
      }
    });

    const logStartupFailure = (task: Task, detail: string) =>
      Effect.logWarning(
        `health probe for ${task.id} failed during startup grace period: ${detail}`,
      );

    const runProbeForTask = Effect.fn("HealthChecker.runProbeForTask")(function* (
      task: Pick<Task, "id" | "workdir" | "env">,
      probe: HealthProbe,
    ) {
      return yield* runHealthProbe(toProbeExecutionContext(task), probe);
    });

    const checkTask = Effect.fn("HealthChecker.checkTask")(function* (taskId: string) {
      const task = yield* taskManager
        .status(taskId)
        .pipe(Effect.catchTag("TaskNotFound", () => Effect.succeed(undefined)));
      if (!task || !shouldMonitorTask(task)) {
        return;
      }

      const probe = task.healthProbe.value;
      const result = yield* runProbeForTask(task, probe).pipe(
        Effect.catchTag("HealthCheckFailed", (error) =>
          isWithinStartupGracePeriod(task, probe)
            ? logStartupFailure(task, error.reason).pipe(Effect.as(undefined))
            : updateHealthState(task.id, false, error.reason).pipe(Effect.as(undefined)),
        ),
      );

      if (!result) {
        return;
      }

      if (result.healthy) {
        yield* updateHealthState(task.id, true, result.detail);
        return;
      }

      if (isWithinStartupGracePeriod(task, probe)) {
        yield* logStartupFailure(task, result.detail ?? "probe reported unhealthy");
        return;
      }

      yield* updateHealthState(task.id, false, result.detail);
    });

    const checkAllTasks = Effect.fn("HealthChecker.checkAllTasks")(function* () {
      const tasks = yield* taskManager.list();
      yield* Effect.forEach(
        tasks,
        (task) => (shouldMonitorTask(task) ? checkTask(task.id) : Effect.void),
        {
          concurrency: "unbounded",
          discard: true,
        },
      );
    });

    const runProbeLoop = (taskId: string, intervalMs: number) =>
      checkTask(taskId).pipe(
        Effect.repeat({ schedule: Schedule.spaced(intervalMs) }),
        Effect.catchAllCause((cause) =>
          Effect.logError(`health probe loop for ${taskId} crashed: ${cause}`),
        ),
        Effect.asVoid,
      );

    const syncProbeLoops = Effect.fn("HealthChecker.syncProbeLoops")(function* (
      registry: Map<string, Task>,
    ) {
      const nextIntervals = new Map<string, number>();

      for (const task of registry.values()) {
        if (!shouldMonitorTask(task)) {
          continue;
        }

        const intervalMs = getHealthProbeIntervalMs(task.healthProbe.value);
        nextIntervals.set(task.id, intervalMs);

        if (activeProbeIntervals.get(task.id) === intervalMs) {
          continue;
        }

        activeProbeIntervals.set(task.id, intervalMs);
        yield* FiberMap.run(probeFibers, task.id, runProbeLoop(task.id, intervalMs));
      }

      const inactiveTaskIds = Array.from(activeProbeIntervals.keys()).filter(
        (taskId) => !nextIntervals.has(taskId),
      );
      for (const taskId of inactiveTaskIds) {
        activeProbeIntervals.delete(taskId);
        yield* FiberMap.remove(probeFibers, taskId);
      }
    });

    yield* taskManager
      .subscribeToChanges()
      .pipe(
        Stream.runForEach(syncProbeLoops),
        Effect.retry(Schedule.spaced("1 second")),
        Effect.forkScoped,
      );

    return {
      runProbe: runProbeForTask,
      checkTask,
      checkAllTasks,
    };
  }),
  dependencies: [TaskManager.Default, NodeHttpClient.layer, NodeContext.layer],
}) {
  static layer(taskManagerLayer: Layer.Layer<TaskManager> = TaskManager.Default) {
    return this.DefaultWithoutDependencies.pipe(
      Layer.provideMerge(taskManagerLayer),
      Layer.provideMerge(NodeHttpClient.layer),
      Layer.provideMerge(NodeContext.layer),
    );
  }
}
