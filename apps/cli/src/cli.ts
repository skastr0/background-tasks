#!/usr/bin/env bun

import {
  getCliTask,
  listCliTasks,
  readCliTaskLogs,
  restartCliTask,
  startCliTask,
  stopCliTask,
  type CliStartInput,
} from "@background-tasks/core/cli-store";
import { Effect } from "effect";

interface ParsedArgs {
  readonly command: string;
  readonly positionals: readonly string[];
  readonly flags: Readonly<Record<string, string | boolean | readonly string[]>>;
}

const usage = {
  ok: false,
  error:
    "usage: background-tasks <start|status|list|logs|stop|restart> [--json] [command options]",
};

const parseArgs = (argv: readonly string[]): ParsedArgs => {
  const [, , command = "", ...rest] = argv;
  const flags: Record<string, string | boolean | string[]> = {};
  const positionals: string[] = [];

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const key = token.slice(2);
    if (key === "json") {
      flags.json = true;
      continue;
    }
    const next = rest[index + 1];
    if (!next || next.startsWith("--")) {
      flags[key] = true;
      continue;
    }

    if (key === "tag" || key === "arg") {
      const existing = flags[key];
      flags[key] = Array.isArray(existing) ? [...existing, next] : [next];
    } else {
      flags[key] = next;
    }
    index += 1;
  }

  return { command, positionals, flags };
};

const readString = (
  flags: ParsedArgs["flags"],
  key: string,
): string | undefined => {
  const value = flags[key];
  return typeof value === "string" ? value : undefined;
};

const readStrings = (flags: ParsedArgs["flags"], key: string): readonly string[] | undefined => {
  const value = flags[key];
  if (Array.isArray(value)) {
    return value;
  }
  return typeof value === "string" ? [value] : undefined;
};

const writeJson = (value: unknown) => {
  console.log(JSON.stringify(value, null, 2));
};

const parseStartInput = (args: ParsedArgs): CliStartInput => {
  const command = readString(args.flags, "command") ?? args.positionals[0];
  if (!command) {
    throw new Error("start requires --command or a positional command");
  }
  return {
    id: readString(args.flags, "id"),
    name: readString(args.flags, "name"),
    command,
    args: readStrings(args.flags, "arg") ?? args.positionals.slice(1),
    workdir: readString(args.flags, "workdir"),
    tags: readStrings(args.flags, "tag"),
    notifyOnExit: args.flags["notify-on-exit"] === true,
  };
};

const runParsed = (args: ParsedArgs) => {
  switch (args.command) {
    case "start":
      return startCliTask(parseStartInput(args)).pipe(
        Effect.map((task) => ({ ok: true, task })),
      );
    case "status": {
      const id = readString(args.flags, "id") ?? args.positionals[0];
      return id
        ? getCliTask(id).pipe(Effect.map((task) => ({ ok: true, task })))
        : Effect.succeed(usage);
    }
    case "list":
      return listCliTasks().pipe(Effect.map((tasks) => ({ ok: true, tasks })));
    case "logs": {
      const id = readString(args.flags, "id") ?? args.positionals[0];
      const lines = Number(readString(args.flags, "lines") ?? "0");
      return id
        ? readCliTaskLogs(id, { ...(lines > 0 ? { lines } : {}) }).pipe(
            Effect.map((logs) => ({ ok: true, logs })),
          )
        : Effect.succeed(usage);
    }
    case "stop": {
      const id = readString(args.flags, "id") ?? args.positionals[0];
      return id
        ? stopCliTask(id).pipe(Effect.map((task) => ({ ok: true, task })))
        : Effect.succeed(usage);
    }
    case "restart": {
      const id = readString(args.flags, "id") ?? args.positionals[0];
      return id
        ? restartCliTask(id).pipe(Effect.map((task) => ({ ok: true, task })))
        : Effect.succeed(usage);
    }
    default:
      return Effect.succeed(usage);
  }
};

export const runCli = (argv: readonly string[]) =>
  (runParsed(parseArgs(argv)) as Effect.Effect<unknown, unknown>).pipe(
    Effect.matchCause({
      onFailure: (cause) => {
        process.exitCode = 1;
        return { ok: false, error: cause.toString() };
      },
      onSuccess: (value) => value,
    }),
    Effect.tap((value) => Effect.sync(() => writeJson(value))),
  );

if (import.meta.main) {
  await Effect.runPromise(runCli(Bun.argv));
}
