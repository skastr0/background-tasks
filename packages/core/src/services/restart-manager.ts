import { Effect, FiberMap, Layer, Schedule, Stream } from "effect";
import { calculateBackoffDelay, type RestartPolicy } from "../domain/health-probe.ts";
import type { Task } from "../domain/task.ts";
import { TaskManager, type TaskNotificationEvent } from "./task-manager.ts";

type RestartTrigger = { readonly type: "exit" } | { readonly type: "health" };

const activeStatuses = new Set<Task["status"]>(["starting", "healthy", "unhealthy", "running"]);

const withFailedStatus = (task: Task): Task => {
  if (task.status === "failed") {
    return task;
  }

  const now = new Date();
  return {
    ...task,
    status: "failed",
    timestamps: {
      ...task.timestamps,
      updatedAt: now,
      exitedAt: { _tag: "Some", value: now },
      lastStatusChangeAt: now,
    },
  };
};

export class RestartManager extends Effect.Service<RestartManager>()("@bg-tasks/RestartManager", {
  scoped: Effect.gen(function* () {
    const taskManager = yield* TaskManager;
    const pendingRestarts = yield* FiberMap.make<string, void, never>();

    const markRestartLimitExceeded = Effect.fn("RestartManager.markRestartLimitExceeded")(
      function* (task: Task, policy: RestartPolicy) {
        if (activeStatuses.has(task.status)) {
          yield* taskManager.kill(task.id).pipe(
            Effect.catchTag("TaskAlreadyRunning", () => Effect.void),
            Effect.catchTag("TaskNotFound", () => Effect.void),
          );
        }

        const mutation = yield* taskManager.mutateTask(task.id, withFailedStatus);
        if (!mutation || mutation._tag === "None") {
          return;
        }

        if (mutation.value.previous.status === "failed") {
          return;
        }

        yield* taskManager.publishEvent({
          type: "restart_limit_exceeded",
          taskId: task.id,
          maxRetries: policy.maxRetries,
        });
      },
    );

    const shouldRestart = (
      task: Task,
    ): task is Task & {
      readonly restartPolicy: { readonly _tag: "Some"; readonly value: RestartPolicy };
    } => task.restartPolicy._tag === "Some" && task.restartPolicy.value.onFailure;

    const scheduleRestart = Effect.fn("RestartManager.scheduleRestart")(function* (
      task: Task,
      trigger: RestartTrigger,
    ) {
      if (!shouldRestart(task)) {
        return;
      }

      const policy = task.restartPolicy.value;
      if (task.restartCount >= policy.maxRetries) {
        yield* markRestartLimitExceeded(task, policy);
        return;
      }

      const delayMs = calculateBackoffDelay(policy, task.restartCount + 1);
      yield* Effect.sleep(delayMs);

      const current = yield* taskManager
        .status(task.id)
        .pipe(Effect.catchTag("TaskNotFound", () => Effect.succeed(undefined)));
      if (!current || current.restartCount !== task.restartCount) {
        return;
      }

      switch (trigger.type) {
        case "exit":
          if (current.status !== "exited") {
            return;
          }
          break;
        case "health":
          if (current.status !== "unhealthy") {
            return;
          }
          break;
      }

      yield* taskManager.restart(task.id).pipe(
        Effect.catchTag("TaskNotFound", () => Effect.void),
        Effect.catchTag("TaskAlreadyRunning", () => Effect.void),
      );
    });

    const enqueueRestart = Effect.fn("RestartManager.enqueueRestart")(function* (
      task: Task,
      trigger: RestartTrigger,
    ) {
      yield* FiberMap.run(
        pendingRestarts,
        task.id,
        scheduleRestart(task, trigger).pipe(
          Effect.catchAllCause((cause) =>
            Effect.logError(`restart scheduling for ${task.id} crashed: ${cause}`),
          ),
          Effect.asVoid,
        ),
        { onlyIfMissing: true },
      );
    });

    const handleEvent = Effect.fn("RestartManager.handleEvent")(function* (
      event: TaskNotificationEvent,
    ) {
      switch (event.type) {
        case "exited": {
          if (event.exitCode === 0) {
            return;
          }

          const task = yield* taskManager
            .status(event.taskId)
            .pipe(Effect.catchTag("TaskNotFound", () => Effect.succeed(undefined)));
          if (!task || !shouldRestart(task)) {
            return;
          }

          yield* enqueueRestart(task, { type: "exit" });
          return;
        }
        case "health_changed": {
          if (event.healthy) {
            return;
          }

          const task = yield* taskManager
            .status(event.taskId)
            .pipe(Effect.catchTag("TaskNotFound", () => Effect.succeed(undefined)));
          if (!task || !shouldRestart(task)) {
            return;
          }

          yield* enqueueRestart(task, { type: "health" });
          return;
        }
      }
    });

    yield* Effect.gen(function* () {
      const subscription = yield* taskManager.subscribeToEvents();
      yield* Stream.fromQueue(subscription).pipe(
        Stream.runForEach((event) =>
          handleEvent(event).pipe(
            Effect.catchAllCause((cause) =>
              Effect.logError(`restart manager event loop failed: ${cause}`),
            ),
          ),
        ),
        Effect.retry(Schedule.spaced("1 second")),
        Effect.forkScoped,
      );
    });

    return {
      handleEvent,
    };
  }),
  dependencies: [TaskManager.Default],
}) {
  static layer(taskManagerLayer: Layer.Layer<TaskManager> = TaskManager.Default) {
    return this.DefaultWithoutDependencies.pipe(Layer.provideMerge(taskManagerLayer));
  }
}
