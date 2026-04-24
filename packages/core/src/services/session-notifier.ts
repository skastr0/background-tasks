import { Context, Effect, Layer, Stream } from "effect";
import { escapeXml, formatDuration, taskDurationMs } from "../domain/formatting.ts";
import type { Task } from "../domain/task.ts";
import { TaskManager, type TaskEvent } from "./task-manager.ts";

export interface SessionNotificationClient {
  readonly notifySession: (sessionId: string, message: string) => Effect.Effect<void>;
}

export const SessionNotificationClient = Context.GenericTag<SessionNotificationClient>(
  "@bg-tasks/SessionNotificationClient",
);

type ExitTaskEvent = Extract<TaskEvent, { readonly type: "exited" | "killed" | "failed" }>;
type LogMatchedTaskEvent = Extract<TaskEvent, { readonly type: "log_matched" }>;
type NotifiableTaskEvent = ExitTaskEvent | LogMatchedTaskEvent;

const isNotifiableTaskEvent = (event: TaskEvent): event is NotifiableTaskEvent =>
  event.type === "exited" ||
  event.type === "killed" ||
  event.type === "failed" ||
  event.type === "log_matched";

const stripLogLineNumber = (line: string): string => line.replace(/^\d+:\s/, "");
const padLineNumber = (lineNumber: number): string => String(lineNumber).padStart(5, "0");

const formatRestartAttempts = (task: Task): string => {
  const maxRetries = task.restartPolicy._tag === "Some" ? task.restartPolicy.value.maxRetries : 0;
  return `${task.restartCount}/${maxRetries}`;
};

const formatWatcherNotification = (event: LogMatchedTaskEvent, task: Task): string => {
  const renderedLine = `${padLineNumber(event.lineNumber)}| ${event.text}`;

  return `<bg_log_watcher watcher="${escapeXml(event.watcherId)}" task="${escapeXml(task.name)}" task_id="${escapeXml(task.id)}" pattern="${escapeXml(event.pattern)}" suppressed="${event.suppressedCount}" line_number="${event.lineNumber}" line="${escapeXml(renderedLine)}" />`;
};

export const formatSessionNotification = (
  event: NotifiableTaskEvent,
  task: Task,
  lastLogLine?: string,
): string => {
  if (event.type === "log_matched") {
    return formatWatcherNotification(event, task);
  }

  const lines = [
    `<bg_task_event type="${event.type}">`,
    `  Task: ${escapeXml(task.name)} (${escapeXml(task.id)})`,
  ];

  switch (event.type) {
    case "exited":
      lines.push(`  Exit Code: ${event.exitCode}`);
      lines.push(`  Duration: ${formatDuration(event.duration)}`);
      break;
    case "killed":
      lines.push(`  Signal: ${escapeXml(event.signal)}`);
      lines.push(`  Duration: ${formatDuration(taskDurationMs(task))}`);
      break;
    case "failed":
      lines.push(`  Reason: ${escapeXml(event.reason)}`);
      lines.push(`  Duration: ${formatDuration(taskDurationMs(task))}`);
      break;
  }

  lines.push(`  Restart Attempts: ${formatRestartAttempts(task)}`);

  if (lastLogLine && lastLogLine.length > 0) {
    lines.push(`  Last Log Line: ${escapeXml(lastLogLine)}`);
  }

  lines.push(`</bg_task_event>`);
  return lines.join("\n");
};

export class SessionNotifier extends Effect.Service<SessionNotifier>()(
  "@bg-tasks/SessionNotifier",
  {
    scoped: Effect.gen(function* () {
      const taskManager = yield* TaskManager;
      const client = yield* SessionNotificationClient;

      const getLastLogLine = Effect.fn("SessionNotifier.getLastLogLine")(function* (
        taskId: string,
      ) {
        const lastLine = yield* taskManager
          .lastLogLine(taskId)
          .pipe(Effect.catchTag("TaskNotFound", () => Effect.succeed(undefined)));

        return lastLine ? stripLogLineNumber(lastLine) : undefined;
      });

      const handleEvent = Effect.fn("SessionNotifier.handleEvent")(function* (event: TaskEvent) {
        if (!isNotifiableTaskEvent(event)) {
          return;
        }

        const task = yield* taskManager
          .status(event.taskId)
          .pipe(Effect.catchTag("TaskNotFound", () => Effect.succeed(undefined)));
        if (!task) {
          return;
        }

        if (task.parentSessionId._tag !== "Some") {
          return;
        }
        const sessionId = task.parentSessionId.value;

        if (event.type !== "log_matched" && !task.notifyOnExit) {
          return;
        }

        const lastLogLine =
          event.type === "log_matched" ? undefined : yield* getLastLogLine(task.id);
        const message = formatSessionNotification(event, task, lastLogLine);

        yield* client
          .notifySession(sessionId, message)
          .pipe(
            Effect.catchAllCause((cause) =>
              Effect.logWarning(
                `session notification failed for ${task.id} (${sessionId}): ${cause}`,
              ),
            ),
          );
      });

      yield* Effect.gen(function* () {
        const subscription = yield* taskManager.subscribeToEvents();
        yield* Stream.fromQueue(subscription).pipe(
          Stream.runForEach((event) =>
            handleEvent(event).pipe(
              Effect.catchAllCause((cause) =>
                Effect.logError(`session notifier event loop failed: ${cause}`),
              ),
            ),
          ),
          Effect.forkScoped,
        );
      });

      return {
        handleEvent,
      };
    }),
  },
) {
  static layer(
    clientLayer: Layer.Layer<SessionNotificationClient>,
    taskManagerLayer: Layer.Layer<TaskManager> = TaskManager.Default,
  ) {
    return this.Default.pipe(Layer.provideMerge(clientLayer), Layer.provideMerge(taskManagerLayer));
  }
}
