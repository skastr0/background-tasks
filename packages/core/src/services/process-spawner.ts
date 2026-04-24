import * as Command from "@effect/platform/Command";
import * as CommandExecutor from "@effect/platform/CommandExecutor";
import type * as PlatformError from "@effect/platform/Error";
import * as NodeContext from "@effect/platform-node/NodeContext";
import { Effect, Exit, Fiber, Stream } from "effect";
import { formatCommand } from "../domain/formatting.ts";
import { ProcessKilled, SpawnFailed } from "../domain/errors.ts";
import type { SpawnInput } from "../domain/task.ts";
import { LogBuffer, type LogBufferInstance } from "./log-buffer.ts";

const stderrPrefix = "[stderr] ";
const signalExitPattern = /receipt of signal:\s*([A-Z0-9]+)/i;
const sharedOutputConfig = {
  capacity: 64,
  replay: 32,
  idleTimeToLive: "5 seconds",
} as const;

export interface ManagedProcess {
  readonly pid: number;
  readonly exitCode: Effect.Effect<CommandExecutor.ExitCode, SpawnFailed | ProcessKilled>;
  readonly kill: (
    signal?: CommandExecutor.Signal,
  ) => Effect.Effect<void, SpawnFailed | ProcessKilled>;
  readonly isRunning: Effect.Effect<boolean, SpawnFailed>;
  readonly stdout: Stream.Stream<string, SpawnFailed>;
  readonly stderr: Stream.Stream<string, SpawnFailed>;
  readonly buffer: LogBufferInstance;
}

export interface ProcessOutputLine {
  readonly label: "stdout" | "stderr";
  readonly text: string;
}

export type ProcessOutputLineHandler = (line: ProcessOutputLine) => Effect.Effect<void, never>;

interface ManagedOutput {
  readonly stream: Stream.Stream<string, SpawnFailed>;
  readonly drain: Effect.Effect<void, SpawnFailed>;
}

const getTaskId = (input: SpawnInput): string => {
  const explicitId = input.id?.trim();
  const name = input.name.trim();
  return explicitId && explicitId.length > 0
    ? explicitId
    : name.length > 0
      ? name
      : formatCommand(input);
};

const toSpawnFailed = (input: SpawnInput, reason: string): SpawnFailed =>
  new SpawnFailed({
    command: formatCommand(input),
    reason,
  });

const mapPlatformErrorToSpawnFailed =
  (input: SpawnInput, context: string) =>
  (error: PlatformError.PlatformError): SpawnFailed =>
    toSpawnFailed(input, `${context}: ${error.message}`);

const extractSignal = (error: PlatformError.PlatformError): string | undefined => {
  if (error._tag !== "SystemError") {
    return undefined;
  }

  return error.description?.match(signalExitPattern)?.[1];
};

const makeManagedOutput = Effect.fn("ProcessSpawner.makeManagedOutput")(function* (
  input: SpawnInput,
  buffer: LogBufferInstance,
  label: "stdout" | "stderr",
  raw: Stream.Stream<Uint8Array, PlatformError.PlatformError>,
  onOutputLine?: ProcessOutputLineHandler,
) {
  const toRenderedLine = (line: string) => (label === "stderr" ? `${stderrPrefix}${line}` : line);
  const appendToBuffer = (line: string) => buffer.append(`${toRenderedLine(line)}\n`);
  const dispatchOutputLine = (line: string) => {
    if (!onOutputLine) {
      return Effect.void;
    }

    return onOutputLine({ label, text: toRenderedLine(line) }).pipe(
      Effect.forkScoped,
      Effect.asVoid,
    );
  };

  const shared = yield* raw.pipe(
    Stream.decodeText("utf-8"),
    Stream.splitLines,
    Stream.mapError(mapPlatformErrorToSpawnFailed(input, `${label} stream failed`)),
    Stream.share(sharedOutputConfig),
  );

  const fiber = yield* shared.pipe(
    Stream.runForEach((line) =>
      appendToBuffer(line).pipe(Effect.zipRight(dispatchOutputLine(line))),
    ),
    Effect.fork,
  );

  return {
    stream: shared,
    drain: Fiber.join(fiber),
  } satisfies ManagedOutput;
});

const mapExitCode = (
  processId: string,
  input: SpawnInput,
  exitCode: Effect.Effect<CommandExecutor.ExitCode, PlatformError.PlatformError>,
): Effect.Effect<CommandExecutor.ExitCode, SpawnFailed | ProcessKilled> =>
  exitCode.pipe(
    Effect.mapError((error) => {
      const signal = extractSignal(error);

      if (signal) {
        return new ProcessKilled({
          id: processId,
          signal,
        });
      }

      return mapPlatformErrorToSpawnFailed(input, "process exit failed")(error);
    }),
  );

export class ProcessSpawner extends Effect.Service<ProcessSpawner>()("@bg-tasks/ProcessSpawner", {
  scoped: Effect.gen(function* () {
    const commandExecutor = yield* CommandExecutor.CommandExecutor;
    const logBuffer = yield* LogBuffer;

    const spawn = Effect.fn("ProcessSpawner.spawn")(function* (
      input: SpawnInput,
      options?: { readonly onOutputLine?: ProcessOutputLineHandler },
    ) {
      const workdir = input.workdir ?? globalThis.process.cwd();

      const processId = getTaskId(input);
      const buffer = yield* logBuffer.make(processId);
      const command = Command.make(input.command, ...(input.args ?? [])).pipe(
        Command.workingDirectory(workdir),
        Command.env(input.env ?? {}),
        Command.runInShell(input.useShell ?? true),
      );

      const spawnedProcess = yield* Command.start(command).pipe(
        Effect.provideService(CommandExecutor.CommandExecutor, commandExecutor),
        Effect.mapError(mapPlatformErrorToSpawnFailed(input, "failed to spawn process")),
      );

      const stdout = yield* makeManagedOutput(
        input,
        buffer,
        "stdout",
        spawnedProcess.stdout,
        options?.onOutputLine,
      );
      const stderr = yield* makeManagedOutput(
        input,
        buffer,
        "stderr",
        spawnedProcess.stderr,
        options?.onOutputLine,
      );
      const waitForOutput = Effect.all([stdout.drain, stderr.drain], { discard: true });
      const exitCode: ManagedProcess["exitCode"] = Effect.gen(function* () {
        const result = yield* Effect.exit(mapExitCode(processId, input, spawnedProcess.exitCode));
        yield* waitForOutput;

        if (Exit.isSuccess(result)) {
          return result.value;
        }

        return yield* Effect.failCause(result.cause);
      });
      const kill: ManagedProcess["kill"] = (signal: CommandExecutor.Signal = "SIGTERM") =>
        Effect.gen(function* () {
          yield* spawnedProcess
            .kill(signal)
            .pipe(
              Effect.mapError(
                mapPlatformErrorToSpawnFailed(input, `failed to kill process with ${signal}`),
              ),
            );
          yield* exitCode;
        }).pipe(Effect.asVoid);

      return {
        pid: Number(spawnedProcess.pid),
        exitCode,
        kill,
        isRunning: spawnedProcess.isRunning.pipe(
          Effect.mapError(mapPlatformErrorToSpawnFailed(input, "failed to inspect process state")),
        ),
        stdout: stdout.stream,
        stderr: stderr.stream,
        buffer,
      } satisfies ManagedProcess;
    });

    return { spawn };
  }),
  dependencies: [LogBuffer.Default, NodeContext.layer],
}) {}
