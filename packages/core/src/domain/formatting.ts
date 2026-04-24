import type { Task } from "./task.ts";

interface CommandInput {
  readonly command: string;
  readonly args?: readonly string[];
}

export function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }

  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }

  return `${seconds}s`;
}

const taskStartTimestamp = (task: Pick<Task, "timestamps">): number =>
  task.timestamps.startedAt._tag === "Some"
    ? task.timestamps.startedAt.value.getTime()
    : task.timestamps.createdAt.getTime();

const taskExitTimestamp = (task: Pick<Task, "timestamps">): number =>
  task.timestamps.exitedAt._tag === "Some" ? task.timestamps.exitedAt.value.getTime() : Date.now();

export const taskDurationMs = (task: Pick<Task, "timestamps">): number =>
  Math.max(0, taskExitTimestamp(task) - taskStartTimestamp(task));

export const formatCommand = (input: CommandInput): string =>
  [input.command, ...(input.args ?? [])].join(" ").trim();
