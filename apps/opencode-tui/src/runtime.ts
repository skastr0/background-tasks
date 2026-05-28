import crypto from "node:crypto";
import { Context, Effect, Layer, ManagedRuntime } from "effect";
import type { PluginOptions } from "@opencode-ai/plugin";
import type { TuiPluginApi, TuiPluginMeta } from "@opencode-ai/plugin/tui";
import {
  detectAgentCliAvailability,
  detectCli,
  extractAgentModelFromArgs,
  extractAgentPromptFromArgs,
  type BgAgentCliKind,
} from "@skastr0/background-tasks-core/agent-cli";
import {
  buildBgControlPlaneRegistrationMessage,
  createBgControlPlaneActionRequest,
  createBgControlPlanePaths,
  readBgControlPlaneLogs,
  readBgControlPlaneSnapshot,
  submitBgControlPlaneAction,
  waitForBgControlPlaneActionResponse,
  type BgControlPlaneLogReadOptions,
  type BgControlPlaneLogReadResult,
  type BgControlPlanePaths,
  type BgControlPlaneSnapshot,
  type BgControlPlaneSpawnRequest,
  type BgTaskSnapshot,
} from "@skastr0/background-tasks-core/control-plane";
import { promptWithSessionContext, type TuiSessionPromptClient } from "./session-prompt";

export interface BackgroundTasksTuiPluginOptions extends PluginOptions {
  readonly keybinds?: Record<string, unknown>;
}

export interface BackgroundTasksTuiApiStateHost {
  readonly state: TuiPluginApi["state"];
  readonly client: {
    readonly session: TuiSessionPromptClient["session"];
  };
}

export interface BackgroundTasksTuiFullApiHost {
  readonly state: TuiPluginApi["state"];
  readonly client: TuiPluginApi["client"];
}

export type BackgroundTasksTuiRuntimeInput =
  | BackgroundTasksTuiApiStateHost
  | BackgroundTasksTuiFullApiHost;

export interface TuiHostService {
  readonly api: BackgroundTasksTuiApiStateHost;
  readonly options: PluginOptions | undefined;
  readonly meta: TuiPluginMeta;
}

export interface CliAvailability {
  readonly claude: boolean;
  readonly codex: boolean;
  readonly gemini: boolean;
  readonly opencode: boolean;
}

export interface BridgeTaskFilter {
  readonly status?: "all" | "active" | "terminal";
  readonly tag?: "all" | "agent" | "process" | BgAgentCliKind;
  readonly session?: "all" | "mine";
  readonly sessionID?: string;
}

export interface BackgroundTasksTuiBridgeService {
  readonly getPaths: () => Promise<BgControlPlanePaths>;
  readonly getSnapshot: () => Promise<BgControlPlaneSnapshot>;
  readonly listTasks: (
    sessionID: string,
    filter?: BridgeTaskFilter,
  ) => Promise<readonly BgTaskSnapshot[]>;
  readonly getTask: (sessionID: string, id: string) => Promise<BgTaskSnapshot | undefined>;
  readonly getLogs: (
    sessionID: string,
    id: string,
    options?: BgControlPlaneLogReadOptions,
  ) => Promise<BgControlPlaneLogReadResult>;
  readonly spawnTask: (
    sessionID: string,
    input: BgControlPlaneSpawnRequest,
  ) => Promise<BgTaskSnapshot>;
  readonly killTask: (sessionID: string, id: string) => Promise<BgTaskSnapshot>;
  readonly restartTask: (sessionID: string, id: string) => Promise<BgTaskSnapshot>;
  readonly detectCli: (name: string) => Promise<boolean>;
  readonly detectAll: () => Promise<CliAvailability>;
}

export const TuiHost = Context.GenericTag<TuiHostService>("@bg-tasks-tui/TuiHost");
export const BackgroundTasksTuiBridge = Context.GenericTag<BackgroundTasksTuiBridgeService>(
  "@bg-tasks-tui/BackgroundTasksTuiBridge",
);

const isActiveStatus = (status: BgTaskSnapshot["status"]): boolean =>
  status === "starting" || status === "healthy" || status === "unhealthy" || status === "running";

const matchesFilter = (task: BgTaskSnapshot, filter?: BridgeTaskFilter): boolean => {
  if (!filter) {
    return true;
  }

  if (filter.status === "active" && !isActiveStatus(task.status)) {
    return false;
  }

  if (filter.status === "terminal" && isActiveStatus(task.status)) {
    return false;
  }

  if (filter.tag && filter.tag !== "all" && !task.tags.includes(filter.tag)) {
    return false;
  }

  if (filter.session === "mine" && filter.sessionID && task.parentSessionId !== filter.sessionID) {
    return false;
  }

  return true;
};

const inferTaskAgentKind = (task: BgTaskSnapshot): BgAgentCliKind | undefined => {
  if (task.tags.includes("claude")) {
    return "claude";
  }
  if (task.tags.includes("codex")) {
    return "codex";
  }
  if (task.tags.includes("gemini")) {
    return "gemini";
  }
  if (task.tags.includes("opencode")) {
    return "opencode";
  }

  return undefined;
};

const detectAllCliAvailability = (): CliAvailability => ({
  claude: detectAgentCliAvailability("claude"),
  codex: detectAgentCliAvailability("codex"),
  gemini: detectAgentCliAvailability("gemini"),
  opencode: detectAgentCliAvailability("opencode"),
});

export interface ComposeDraft {
  readonly mode: "agent" | "custom";
  readonly cli: BgAgentCliKind | "custom";
  readonly prompt: string;
  readonly command: string;
  readonly args: string;
  readonly workdir: string;
  readonly model: string;
  readonly tags: string;
  readonly notifyOnExit: boolean;
}

export const emptyComposeDraft = (workdir: string): ComposeDraft => ({
  mode: "agent",
  cli: "claude",
  prompt: "",
  command: "",
  args: "",
  workdir,
  model: "",
  tags: "",
  notifyOnExit: true,
});

export const composeDraftFromTask = (task: BgTaskSnapshot): ComposeDraft => {
  const cli = inferTaskAgentKind(task);
  if (cli) {
    return {
      mode: "agent",
      cli,
      prompt: extractAgentPromptFromArgs(cli, task.args) ?? "",
      command: "",
      args: "",
      workdir: task.workdir,
      model: extractAgentModelFromArgs(task.args) ?? "",
      tags: task.tags.filter((tag) => tag !== "agent" && tag !== cli).join(", "),
      notifyOnExit: task.notifyOnExit,
    };
  }

  return {
    mode: "custom",
    cli: "custom",
    prompt: "",
    command: task.command,
    args: task.args.join(" "),
    workdir: task.workdir,
    model: "",
    tags: task.tags.filter((tag) => tag !== "process").join(", "),
    notifyOnExit: task.notifyOnExit,
  };
};

export const parseTagsInput = (value: string): readonly string[] =>
  value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

export const parseArgsInput = (value: string): readonly string[] => {
  const trimmed = value.trim();
  if (!trimmed) {
    return [];
  }

  return (
    trimmed.match(/(?:"([^"]*)"|'([^']*)'|(\S+))/g)?.map((segment) => {
      const match = segment.match(/^(?:"([^"]*)"|'([^']*)'|(\S+))$/);
      return match?.[1] ?? match?.[2] ?? match?.[3] ?? segment;
    }) ?? []
  );
};

export const composeDraftToSpawnRequest = (
  draft: ComposeDraft,
  sessionID?: string,
): BgControlPlaneSpawnRequest => {
  const tags = parseTagsInput(draft.tags);

  if (draft.mode === "custom" || draft.cli === "custom") {
    return {
      mode: "custom",
      command: draft.command.trim(),
      args: parseArgsInput(draft.args),
      description: draft.command.trim() || "Custom background command",
      workdir: draft.workdir.trim(),
      ...(tags.length > 0 ? { tags } : {}),
      notifyOnExit: draft.notifyOnExit,
      ...(sessionID ? { parentSessionId: sessionID } : {}),
    };
  }

  return {
    mode: "agent",
    cli: draft.cli,
    prompt: draft.prompt.trim(),
    workdir: draft.workdir.trim(),
    ...(draft.model.trim() ? { model: draft.model.trim() } : {}),
    ...(tags.length > 0 ? { tags } : {}),
    notifyOnExit: draft.notifyOnExit,
    ...(sessionID ? { parentSessionId: sessionID } : {}),
  };
};

const createBridge = (host: TuiHostService): BackgroundTasksTuiBridgeService => {
  let cachedPaths: BgControlPlanePaths | undefined;
  let cliAvailability: CliAvailability | undefined;
  const sessionCodes = new Map<string, string>();

  const getPaths = async (): Promise<BgControlPlanePaths> => {
    if (cachedPaths) {
      return cachedPaths;
    }

    const stateDir = host.api.state.path.state;
    const worktree = host.api.state.path.worktree;
    cachedPaths = createBgControlPlanePaths(stateDir, worktree);
    return cachedPaths;
  };

  const getSnapshot = async (): Promise<BgControlPlaneSnapshot> => {
    const paths = await getPaths();
    return readBgControlPlaneSnapshot(paths);
  };

  const listTasks = async (
    sessionID: string,
    filter?: BridgeTaskFilter,
  ): Promise<readonly BgTaskSnapshot[]> => {
    const snapshot = await getSnapshot();
    return snapshot.tasks.filter(
      (task) => task.parentSessionId === sessionID && matchesFilter(task, filter),
    );
  };

  const getTask = async (sessionID: string, id: string): Promise<BgTaskSnapshot | undefined> => {
    const snapshot = await getSnapshot();
    return snapshot.tasks.find((task) => task.id === id && task.parentSessionId === sessionID);
  };

  const getLogs = async (
    sessionID: string,
    id: string,
    options?: BgControlPlaneLogReadOptions,
  ): Promise<BgControlPlaneLogReadResult> => {
    const task = await getTask(sessionID, id);
    if (!task) {
      throw new Error(`Task '${id}' is not owned by session '${sessionID}'.`);
    }
    const paths = await getPaths();
    return readBgControlPlaneLogs(paths, id, options);
  };

  const ensureSessionCode = async (sessionID: string): Promise<string> => {
    const existing = sessionCodes.get(sessionID);
    if (existing) {
      return existing;
    }

    const code = crypto.randomUUID().replace(/-/g, "");
    await Effect.runPromise(
      promptWithSessionContext(host.api.client, sessionID, {
        noReply: true,
        parts: [
          {
            type: "text",
            text: buildBgControlPlaneRegistrationMessage(code),
            synthetic: true,
          },
        ],
      }),
    );
    sessionCodes.set(sessionID, code);
    return code;
  };

  const runAction = async (
    sessionID: string,
    action:
      | { readonly action: "spawn"; readonly input: BgControlPlaneSpawnRequest }
      | { readonly action: "kill" | "restart"; readonly taskId: string },
  ): Promise<BgTaskSnapshot> => {
    const paths = await getPaths();
    const sessionCode = await ensureSessionCode(sessionID);
    const request = createBgControlPlaneActionRequest({
      ownerSessionId: sessionID,
      sessionCode,
      ...action,
    });
    await submitBgControlPlaneAction(paths, request);
    const response = await waitForBgControlPlaneActionResponse(paths, request.id);
    if (!response.ok) {
      throw new Error(response.message);
    }
    if (!response.task) {
      throw new Error(`Action ${request.action} completed without a task payload.`);
    }
    return response.task;
  };

  return {
    getPaths,
    getSnapshot,
    listTasks,
    getTask,
    getLogs,
    spawnTask: (sessionID, input) => runAction(sessionID, { action: "spawn", input }),
    killTask: (sessionID, id) => runAction(sessionID, { action: "kill", taskId: id }),
    restartTask: (sessionID, id) => runAction(sessionID, { action: "restart", taskId: id }),
    detectCli: async (name) => detectCli(name),
    detectAll: async () => {
      cliAvailability ??= detectAllCliAvailability();
      return cliAvailability;
    },
  };
};

export function createBackgroundTasksTuiRuntime(
  api: BackgroundTasksTuiRuntimeInput,
  options: PluginOptions | undefined,
  meta: TuiPluginMeta,
) {
  const host: TuiHostService = {
    api: {
      state: api.state,
      client: {
        session: {
          messages: (input) => api.client.session.messages(input),
          prompt: (input) => api.client.session.prompt(input),
        },
      },
    },
    options,
    meta,
  };
  const bridge = createBridge(host);
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(Layer.succeed(TuiHost, host), Layer.succeed(BackgroundTasksTuiBridge, bridge)),
  );

  return {
    host,
    bridge,
    runtime,
  };
}
