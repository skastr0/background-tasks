import crypto from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Task, TaskStatus } from "./domain/task.ts";

export interface BgControlPlanePaths {
  readonly stateDir: string;
  readonly worktree: string;
  readonly id: string;
  readonly rootDir: string;
  readonly logsDir: string;
  readonly actionsDir: string;
  readonly responsesDir: string;
  readonly snapshotPath: string;
}

export const bgControlPlaneRegistrationPrefix = "[BG_CONTROL_TOKEN]";

export interface BgTaskSnapshot {
  readonly id: string;
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly workdir: string;
  readonly tags: readonly string[];
  readonly status: TaskStatus;
  readonly pid?: number;
  readonly exitCode?: number;
  readonly restartCount: number;
  readonly parentSessionId?: string;
  readonly notifyOnExit: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt?: string;
  readonly exitedAt?: string;
  readonly lastStatusChangeAt: string;
  readonly logLineCount: number;
}

export interface BgControlPlaneSnapshot {
  readonly version: 1;
  readonly worktree: string;
  readonly updatedAt: string;
  readonly activeCount: number;
  readonly evictedTaskIds: readonly string[];
  readonly tasks: readonly BgTaskSnapshot[];
}

export interface BgControlPlaneLogReadOptions {
  readonly limit?: number;
  readonly offset?: number;
  readonly order?: "asc" | "desc";
  readonly pattern?: RegExp;
}

export interface BgControlPlaneLogLine {
  readonly lineNumber: number;
  readonly text: string;
}

export interface BgControlPlaneLogReadResult {
  readonly lines: readonly BgControlPlaneLogLine[];
  readonly totalLines: number;
  readonly filteredLines: number;
  readonly offset: number;
  readonly hasMore: boolean;
  readonly order: "asc" | "desc";
}

export type BgControlPlaneSpawnRequest =
  | {
      readonly mode: "agent";
      readonly cli: "claude" | "codex" | "gemini" | "opencode";
      readonly prompt: string;
      readonly workdir?: string;
      readonly model?: string;
      readonly notifyOnExit?: boolean;
      readonly extraArgs?: readonly string[];
      readonly tags?: readonly string[];
      readonly parentSessionId?: string;
    }
  | {
      readonly mode: "custom";
      readonly command: string;
      readonly args?: readonly string[];
      readonly workdir?: string;
      readonly env?: Readonly<Record<string, string>>;
      readonly name?: string;
      readonly description: string;
      readonly tags?: readonly string[];
      readonly notifyOnExit?: boolean;
      readonly parentSessionId?: string;
    };

export type BgControlPlaneActionRequest =
  | {
	      readonly id: string;
	      readonly createdAt: string;
	      readonly ownerSessionId: string;
	      readonly sessionCode: string;
	      readonly action: "spawn";
	      readonly input: BgControlPlaneSpawnRequest;
	    }
  | {
	      readonly id: string;
	      readonly createdAt: string;
	      readonly ownerSessionId: string;
	      readonly sessionCode: string;
	      readonly action: "kill" | "restart";
	      readonly taskId: string;
	    };

export type BgControlPlaneActionRequestInput =
  | {
	      readonly ownerSessionId: string;
	      readonly sessionCode: string;
	      readonly action: "spawn";
	      readonly input: BgControlPlaneSpawnRequest;
	    }
  | {
	      readonly ownerSessionId: string;
	      readonly sessionCode: string;
	      readonly action: "kill" | "restart";
	      readonly taskId: string;
	    };

export type BgControlPlaneActionResponse =
  | {
      readonly id: string;
      readonly action: BgControlPlaneActionRequest["action"];
      readonly ok: true;
      readonly message: string;
      readonly task?: BgTaskSnapshot;
      readonly updatedAt: string;
    }
  | {
      readonly id: string;
      readonly action: BgControlPlaneActionRequest["action"];
      readonly ok: false;
      readonly message: string;
      readonly updatedAt: string;
    };

const sanitizeSegment = (value: string): string =>
  value.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";

const taskStatuses = new Set<string>([
  "starting",
  "healthy",
  "unhealthy",
  "running",
  "exited",
  "killed",
  "failed",
]);

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null;

const hasErrnoCode = (error: unknown, code: string): boolean =>
  isRecord(error) && error.code === code;

const readString = (record: JsonRecord, key: string): string | undefined =>
  typeof record[key] === "string" ? record[key] : undefined;

const readNumber = (record: JsonRecord, key: string): number | undefined => {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
};

const readBoolean = (record: JsonRecord, key: string): boolean | undefined =>
  typeof record[key] === "boolean" ? record[key] : undefined;

const readStringArray = (record: JsonRecord, key: string): readonly string[] | undefined => {
  const value = record[key];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    return undefined;
  }

  return value;
};

const parseTaskStatus = (value: unknown): TaskStatus | undefined => {
  if (typeof value !== "string" || !taskStatuses.has(value)) {
    return undefined;
  }

  switch (value) {
    case "starting":
    case "healthy":
    case "unhealthy":
    case "running":
    case "exited":
    case "killed":
    case "failed":
      return value;
  }
};

const parseBgTaskSnapshot = (value: unknown): BgTaskSnapshot | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const id = readString(value, "id");
  const name = readString(value, "name");
  const command = readString(value, "command");
  const args = readStringArray(value, "args");
  const workdir = readString(value, "workdir");
  const tags = readStringArray(value, "tags");
  const status = parseTaskStatus(value.status);
  const restartCount = readNumber(value, "restartCount");
  const notifyOnExit = readBoolean(value, "notifyOnExit");
  const createdAt = readString(value, "createdAt");
  const updatedAt = readString(value, "updatedAt");
  const lastStatusChangeAt = readString(value, "lastStatusChangeAt");
  const logLineCount = readNumber(value, "logLineCount");

  if (
    !id ||
    !name ||
    !command ||
    !args ||
    !workdir ||
    !tags ||
    !status ||
    restartCount === undefined ||
    notifyOnExit === undefined ||
    !createdAt ||
    !updatedAt ||
    !lastStatusChangeAt ||
    logLineCount === undefined
  ) {
    return undefined;
  }

  const pid = readNumber(value, "pid");
  const exitCode = readNumber(value, "exitCode");
  const parentSessionId = readString(value, "parentSessionId");
  const startedAt = readString(value, "startedAt");
  const exitedAt = readString(value, "exitedAt");

  return {
    id,
    name,
    command,
    args,
    workdir,
    tags,
    status,
    ...(pid !== undefined ? { pid } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
    restartCount,
    ...(parentSessionId ? { parentSessionId } : {}),
    notifyOnExit,
    createdAt,
    updatedAt,
    ...(startedAt ? { startedAt } : {}),
    ...(exitedAt ? { exitedAt } : {}),
    lastStatusChangeAt,
    logLineCount,
  };
};

export const buildBgControlPlaneRegistrationMessage = (code: string): string =>
  `${bgControlPlaneRegistrationPrefix} ${code}`;

export const parseBgControlPlaneRegistrationMessage = (value: string): string | undefined => {
  if (!value.startsWith(bgControlPlaneRegistrationPrefix)) {
    return undefined;
  }

  const code = value.slice(bgControlPlaneRegistrationPrefix.length).trim();
  return /^[a-zA-Z0-9_-]{16,}$/.test(code) ? code : undefined;
};

const parseBgControlPlaneSnapshotValue = (value: unknown): BgControlPlaneSnapshot | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const version = readNumber(value, "version");
  const worktree = readString(value, "worktree");
  const updatedAt = readString(value, "updatedAt");
  const activeCount = readNumber(value, "activeCount");
  const evictedTaskIds = readStringArray(value, "evictedTaskIds");
  const tasksValue = value.tasks;

  if (
    version !== 1 ||
    !worktree ||
    !updatedAt ||
    activeCount === undefined ||
    !evictedTaskIds ||
    !Array.isArray(tasksValue)
  ) {
    return undefined;
  }

  const tasks = tasksValue
    .map(parseBgTaskSnapshot)
    .filter((task): task is BgTaskSnapshot => task !== undefined);

  if (tasks.length !== tasksValue.length) {
    return undefined;
  }

  return {
    version: 1,
    worktree,
    updatedAt,
    activeCount,
    evictedTaskIds,
    tasks,
  };
};

const parseBgControlPlaneSpawnRequest = (
  value: unknown,
): BgControlPlaneSpawnRequest | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const mode = readString(value, "mode");
  if (mode === "agent") {
    const cli = readString(value, "cli");
    const prompt = readString(value, "prompt");
    const extraArgs = readStringArray(value, "extraArgs");
    const tags = readStringArray(value, "tags");
    if (
      (cli !== "claude" && cli !== "codex" && cli !== "gemini" && cli !== "opencode") ||
      !prompt
    ) {
      return undefined;
    }

    const workdir = readString(value, "workdir");
    const model = readString(value, "model");
    const notifyOnExit = readBoolean(value, "notifyOnExit");
    const parentSessionId = readString(value, "parentSessionId");

    return {
      mode,
      cli,
      prompt,
      ...(workdir ? { workdir } : {}),
      ...(model ? { model } : {}),
      ...(notifyOnExit !== undefined ? { notifyOnExit } : {}),
      ...(extraArgs ? { extraArgs } : {}),
      ...(tags ? { tags } : {}),
      ...(parentSessionId ? { parentSessionId } : {}),
    };
  }

  if (mode === "custom") {
    const command = readString(value, "command");
    const description = readString(value, "description");
    const args = readStringArray(value, "args");
    const tags = readStringArray(value, "tags");
    if (!command || !description) {
      return undefined;
    }

    const workdir = readString(value, "workdir");
    const name = readString(value, "name");
    const parentSessionId = readString(value, "parentSessionId");
    const notifyOnExit = readBoolean(value, "notifyOnExit");
    const envValue = value.env;
    const env =
      isRecord(envValue) && Object.values(envValue).every((entry) => typeof entry === "string")
        ? Object.fromEntries(
            Object.entries(envValue).filter(
              (entry): entry is [string, string] => typeof entry[1] === "string",
            ),
          )
        : undefined;

    return {
      mode,
      command,
      description,
      ...(args ? { args } : {}),
      ...(workdir ? { workdir } : {}),
      ...(env ? { env } : {}),
      ...(name ? { name } : {}),
      ...(tags ? { tags } : {}),
      ...(notifyOnExit !== undefined ? { notifyOnExit } : {}),
      ...(parentSessionId ? { parentSessionId } : {}),
    };
  }

  return undefined;
};

const parseBgControlPlaneActionRequestValue = (
  value: unknown,
): BgControlPlaneActionRequest | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const id = readString(value, "id");
  const createdAt = readString(value, "createdAt");
  const ownerSessionId = readString(value, "ownerSessionId");
  const sessionCode = readString(value, "sessionCode");
  const action = readString(value, "action");
  if (!id || !createdAt || !ownerSessionId || !sessionCode || !action) {
    return undefined;
  }

  if (action === "spawn") {
    const input = parseBgControlPlaneSpawnRequest(value.input);
    return input ? { id, createdAt, ownerSessionId, sessionCode, action, input } : undefined;
  }

  if (action === "kill" || action === "restart") {
    const taskId = readString(value, "taskId");
    return taskId ? { id, createdAt, ownerSessionId, sessionCode, action, taskId } : undefined;
  }

  return undefined;
};

const parseBgControlPlaneActionResponseValue = (
  value: unknown,
): BgControlPlaneActionResponse | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const id = readString(value, "id");
  const action = readString(value, "action");
  const ok = readBoolean(value, "ok");
  const message = readString(value, "message");
  const updatedAt = readString(value, "updatedAt");
  if (
    !id ||
    !message ||
    !updatedAt ||
    ok === undefined ||
    (action !== "spawn" && action !== "kill" && action !== "restart")
  ) {
    return undefined;
  }

  if (!ok) {
    return { id, action, ok, message, updatedAt };
  }

  const task = value.task === undefined ? undefined : parseBgTaskSnapshot(value.task);
  if (value.task !== undefined && !task) {
    return undefined;
  }

  return {
    id,
    action,
    ok,
    message,
    ...(task ? { task } : {}),
    updatedAt,
  };
};

const optionValue = <T>(
  value: { readonly _tag: "None" } | { readonly _tag: "Some"; readonly value: T },
) => (value._tag === "Some" ? value.value : undefined);

const splitLogLines = (raw: string): readonly BgControlPlaneLogLine[] => {
  if (!raw.length) {
    return [];
  }

  const lines = raw.split(/\r?\n/);
  if (raw.endsWith("\n")) {
    lines.pop();
  }

  return lines.map((text, index) => ({
    lineNumber: index + 1,
    text,
  }));
};

const paginateAscending = <T>(items: readonly T[], offset: number, limit?: number) => {
  const startIndex = Math.min(offset, items.length);
  const endIndex = limit === undefined ? items.length : Math.min(startIndex + limit, items.length);
  return {
    items: items.slice(startIndex, endIndex),
    hasMore: endIndex < items.length,
    offset: startIndex,
  };
};

const paginateDescending = <T>(items: readonly T[], offset: number, limit?: number) => {
  const endIndex = Math.max(0, items.length - offset);
  const startIndex = limit === undefined ? 0 : Math.max(0, endIndex - limit);
  return {
    items: items.slice(startIndex, endIndex).reverse(),
    hasMore: startIndex > 0,
    offset,
  };
};

export function createBgControlPlanePaths(stateDir: string, worktree: string): BgControlPlanePaths {
  const hash = crypto.createHash("sha1").update(worktree).digest("hex").slice(0, 12);
  const id = `${sanitizeSegment(path.basename(worktree))}-${hash}`;
  const rootDir = path.join(stateDir, "background-tasks", id);
  return {
    stateDir,
    worktree,
    id,
    rootDir,
    logsDir: path.join(rootDir, "logs"),
    actionsDir: path.join(rootDir, "actions"),
    responsesDir: path.join(rootDir, "responses"),
    snapshotPath: path.join(rootDir, "snapshot.json"),
  };
}

export function createEmptyBgControlPlaneSnapshot(worktree: string): BgControlPlaneSnapshot {
  return {
    version: 1,
    worktree,
    updatedAt: new Date(0).toISOString(),
    activeCount: 0,
    evictedTaskIds: [],
    tasks: [],
  };
}

export function isActiveBgTaskStatus(status: TaskStatus): boolean {
  return (
    status === "starting" || status === "healthy" || status === "unhealthy" || status === "running"
  );
}

export async function ensureBgControlPlaneLayout(paths: BgControlPlanePaths): Promise<void> {
  await Promise.all([
    mkdir(paths.rootDir, { recursive: true }),
    mkdir(paths.logsDir, { recursive: true }),
    mkdir(paths.actionsDir, { recursive: true }),
    mkdir(paths.responsesDir, { recursive: true }),
  ]);
}

export async function writeAtomicText(filePath: string, content: string): Promise<void> {
  const tempPath = `${filePath}.${crypto.randomUUID()}.tmp`;
  await writeFile(tempPath, content, "utf8");
  await rename(tempPath, filePath);
}

export async function writeAtomicJson(filePath: string, value: unknown): Promise<void> {
  await writeAtomicText(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export async function readBgControlPlaneSnapshot(
  paths: BgControlPlanePaths,
): Promise<BgControlPlaneSnapshot> {
  try {
    const content = await readFile(paths.snapshotPath, "utf8");
    return (
      parseBgControlPlaneSnapshotValue(JSON.parse(content)) ??
      createEmptyBgControlPlaneSnapshot(paths.worktree)
    );
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return createEmptyBgControlPlaneSnapshot(paths.worktree);
    }

    throw error;
  }
}

export async function writeBgControlPlaneSnapshot(
  paths: BgControlPlanePaths,
  snapshot: BgControlPlaneSnapshot,
): Promise<void> {
  await ensureBgControlPlaneLayout(paths);
  await writeAtomicJson(paths.snapshotPath, snapshot);
}

export async function readBgControlPlaneLog(
  paths: BgControlPlanePaths,
  taskId: string,
): Promise<string> {
  try {
    return await readFile(path.join(paths.logsDir, `${taskId}.log`), "utf8");
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return "";
    }

    throw error;
  }
}

export async function writeBgControlPlaneLog(
  paths: BgControlPlanePaths,
  taskId: string,
  content: string,
): Promise<void> {
  await ensureBgControlPlaneLayout(paths);
  await writeAtomicText(path.join(paths.logsDir, `${taskId}.log`), content);
}

export async function removeBgControlPlaneLog(
  paths: BgControlPlanePaths,
  taskId: string,
): Promise<void> {
  await rm(path.join(paths.logsDir, `${taskId}.log`), { force: true });
}

export async function pruneBgControlPlaneLogs(
  paths: BgControlPlanePaths,
  activeTaskIds: readonly string[],
): Promise<void> {
  await ensureBgControlPlaneLayout(paths);
  const keep = new Set(activeTaskIds.map((id) => `${id}.log`));
  const files = await readdir(paths.logsDir, { withFileTypes: true });
  await Promise.all(
    files
      .filter((entry) => entry.isFile() && !keep.has(entry.name))
      .map((entry) => rm(path.join(paths.logsDir, entry.name), { force: true })),
  );
}

export function toBgTaskSnapshot(task: Task, logLineCount: number): BgTaskSnapshot {
  const pid = optionValue(task.pid);
  const exitCode = optionValue(task.exitCode);
  const parentSessionId = optionValue(task.parentSessionId);
  const startedAt = optionValue(task.timestamps.startedAt);
  const exitedAt = optionValue(task.timestamps.exitedAt);

  return {
    id: task.id,
    name: task.name,
    command: task.command,
    args: [...task.args],
    workdir: task.workdir,
    tags: [...task.tags],
    status: task.status,
    ...(pid !== undefined ? { pid } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
    restartCount: task.restartCount,
    ...(parentSessionId ? { parentSessionId } : {}),
    notifyOnExit: task.notifyOnExit,
    createdAt: task.timestamps.createdAt.toISOString(),
    updatedAt: task.timestamps.updatedAt.toISOString(),
    ...(startedAt ? { startedAt: startedAt.toISOString() } : {}),
    ...(exitedAt ? { exitedAt: exitedAt.toISOString() } : {}),
    lastStatusChangeAt: task.timestamps.lastStatusChangeAt.toISOString(),
    logLineCount,
  };
}

export function sortBgTaskSnapshots(tasks: readonly BgTaskSnapshot[]): readonly BgTaskSnapshot[] {
  return [...tasks].sort((left, right) => {
    const activeDelta =
      Number(isActiveBgTaskStatus(right.status)) - Number(isActiveBgTaskStatus(left.status));
    if (activeDelta !== 0) {
      return activeDelta;
    }

    return Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
  });
}

export function buildBgControlPlaneSnapshot(
  worktree: string,
  tasks: readonly BgTaskSnapshot[],
  evictedTaskIds: readonly string[],
): BgControlPlaneSnapshot {
  const sorted = sortBgTaskSnapshots(tasks);
  return {
    version: 1,
    worktree,
    updatedAt: new Date().toISOString(),
    activeCount: sorted.filter((task) => isActiveBgTaskStatus(task.status)).length,
    evictedTaskIds: [...evictedTaskIds],
    tasks: sorted,
  };
}

export function createBgControlPlaneActionRequest(
  input: BgControlPlaneActionRequestInput,
): BgControlPlaneActionRequest {
  if (input.action === "spawn") {
    return {
	      id: `bgcp_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`,
	      createdAt: new Date().toISOString(),
	      ownerSessionId: input.ownerSessionId,
	      sessionCode: input.sessionCode,
	      action: input.action,
	      input: input.input,
	    };
  }

  return {
	    id: `bgcp_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`,
	    createdAt: new Date().toISOString(),
	    ownerSessionId: input.ownerSessionId,
	    sessionCode: input.sessionCode,
	    action: input.action,
	    taskId: input.taskId,
	  };
}

export async function submitBgControlPlaneAction(
  paths: BgControlPlanePaths,
  request: BgControlPlaneActionRequest,
): Promise<void> {
  await ensureBgControlPlaneLayout(paths);
  await writeAtomicJson(
    path.join(paths.actionsDir, `${request.createdAt}-${request.id}.json`),
    request,
  );
}

export async function listBgControlPlaneActionFiles(
  paths: BgControlPlanePaths,
): Promise<readonly string[]> {
  await ensureBgControlPlaneLayout(paths);
  const files = await readdir(paths.actionsDir);
  return files.filter((file) => file.endsWith(".json")).sort();
}

export async function claimBgControlPlaneAction(
  paths: BgControlPlanePaths,
  fileName: string,
): Promise<BgControlPlaneActionRequest | undefined> {
  const sourcePath = path.join(paths.actionsDir, fileName);
  const claimedPath = path.join(paths.actionsDir, `${fileName}.processing`);

  try {
    await rename(sourcePath, claimedPath);
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return undefined;
    }

    throw error;
  }

  try {
    const content = await readFile(claimedPath, "utf8");
    return parseBgControlPlaneActionRequestValue(JSON.parse(content));
  } finally {
    await rm(claimedPath, { force: true });
  }
}

export async function writeBgControlPlaneActionResponse(
  paths: BgControlPlanePaths,
  response: BgControlPlaneActionResponse,
): Promise<void> {
  await ensureBgControlPlaneLayout(paths);
  await writeAtomicJson(path.join(paths.responsesDir, `${response.id}.json`), response);
}

export async function waitForBgControlPlaneActionResponse(
  paths: BgControlPlanePaths,
  id: string,
  timeoutMs = 15_000,
  pollMs = 100,
): Promise<BgControlPlaneActionResponse> {
  const responsePath = path.join(paths.responsesDir, `${id}.json`);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() <= deadline) {
    try {
      const content = await readFile(responsePath, "utf8");
      const parsed = parseBgControlPlaneActionResponseValue(JSON.parse(content));
      if (!parsed) {
        throw new Error(`Invalid background control-plane response payload for ${id}.`);
      }
      await rm(responsePath, { force: true });
      return parsed;
    } catch (error) {
      if (!hasErrnoCode(error, "ENOENT")) {
        throw error;
      }
    }

    await Bun.sleep(pollMs);
  }

  throw new Error(`Timed out waiting for background control-plane action ${id}.`);
}

export async function pruneBgControlPlaneResponses(
  paths: BgControlPlanePaths,
  maxAgeMs = 60_000,
): Promise<void> {
  await ensureBgControlPlaneLayout(paths);
  const cutoff = Date.now() - maxAgeMs;
  const files = await readdir(paths.responsesDir, { withFileTypes: true });
  await Promise.all(
    files
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map(async (entry) => {
        const fullPath = path.join(paths.responsesDir, entry.name);
        const stat = await Bun.file(fullPath).stat();
        if (stat.mtime && stat.mtime.getTime() < cutoff) {
          await rm(fullPath, { force: true });
        }
      }),
  );
}

export async function readBgControlPlaneLogs(
  paths: BgControlPlanePaths,
  taskId: string,
  options?: BgControlPlaneLogReadOptions,
): Promise<BgControlPlaneLogReadResult> {
  const order = options?.order ?? "asc";
  const offset = Math.max(0, options?.offset ?? 0);
  const limit = options?.limit !== undefined ? Math.max(0, options.limit) : undefined;
  const raw = await readBgControlPlaneLog(paths, taskId);
  const allLines = splitLogLines(raw);
  const filtered = options?.pattern
    ? allLines.filter((line) => {
        options.pattern!.lastIndex = 0;
        return options.pattern!.test(line.text);
      })
    : allLines;
  const page =
    order === "desc"
      ? paginateDescending(filtered, offset, limit)
      : paginateAscending(filtered, offset, limit);

  return {
    lines: page.items,
    totalLines: allLines.length,
    filteredLines: filtered.length,
    offset: page.offset,
    hasMore: page.hasMore,
    order,
  };
}
