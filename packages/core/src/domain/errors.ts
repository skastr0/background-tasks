import { Schema } from "effect";

const NonNegativeInt = Schema.Int.pipe(Schema.nonNegative());

export class TaskNotFound extends Schema.TaggedError<TaskNotFound>()("TaskNotFound", {
  id: Schema.String,
}) {}

export class SpawnFailed extends Schema.TaggedError<SpawnFailed>()("SpawnFailed", {
  command: Schema.String,
  reason: Schema.String,
}) {}

export class HealthCheckFailed extends Schema.TaggedError<HealthCheckFailed>()(
  "HealthCheckFailed",
  {
    id: Schema.String,
    probe: Schema.String,
    reason: Schema.String,
  },
) {}

export class RestartLimitExceeded extends Schema.TaggedError<RestartLimitExceeded>()(
  "RestartLimitExceeded",
  {
    id: Schema.String,
    maxRetries: NonNegativeInt,
  },
) {}

export class TaskAlreadyRunning extends Schema.TaggedError<TaskAlreadyRunning>()(
  "TaskAlreadyRunning",
  {
    id: Schema.String,
  },
) {}

export class TaskAccessDenied extends Schema.TaggedError<TaskAccessDenied>()("TaskAccessDenied", {
  id: Schema.String,
  sessionId: Schema.String,
  ownerSessionId: Schema.String,
}) {}

export class BackgroundTasksUnavailableInSubagent extends Schema.TaggedError<BackgroundTasksUnavailableInSubagent>()(
  "BackgroundTasksUnavailableInSubagent",
  {
    sessionId: Schema.String,
    parentSessionId: Schema.String,
  },
) {}

export class ProcessKilled extends Schema.TaggedError<ProcessKilled>()("ProcessKilled", {
  id: Schema.String,
  signal: Schema.String,
}) {}

export class LogBufferConfigurationError extends Schema.TaggedError<LogBufferConfigurationError>()(
  "LogBufferConfigurationError",
  {
    taskId: Schema.String,
    maxSize: Schema.Number,
    reason: Schema.String,
  },
) {}

export class LogBufferQueryError extends Schema.TaggedError<LogBufferQueryError>()(
  "LogBufferQueryError",
  {
    taskId: Schema.String,
    operation: Schema.String,
    offset: Schema.Number,
    limit: Schema.Number,
    reason: Schema.String,
  },
) {}

export class CliUnavailable extends Schema.TaggedError<CliUnavailable>()("CliUnavailable", {
  cli: Schema.String,
  installHint: Schema.String,
}) {}

export const BackgroundTaskError = Schema.Union(
  TaskNotFound,
  SpawnFailed,
  HealthCheckFailed,
  RestartLimitExceeded,
  TaskAlreadyRunning,
  TaskAccessDenied,
  BackgroundTasksUnavailableInSubagent,
  ProcessKilled,
  LogBufferConfigurationError,
  LogBufferQueryError,
  CliUnavailable,
);

export type BackgroundTaskError = typeof BackgroundTaskError.Type;
