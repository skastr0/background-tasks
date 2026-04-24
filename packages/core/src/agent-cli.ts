import { CliUnavailable } from "./domain/errors.ts";
import type { SpawnInput } from "./domain/task.ts";

export const bgAgentCliKinds = ["claude", "codex", "gemini", "opencode"] as const;

export type BgAgentCliKind = (typeof bgAgentCliKinds)[number];

export interface BgAgentCliLaunchInput {
  readonly prompt: string;
  readonly workdir?: string;
  readonly model?: string;
  readonly notifyOnExit?: boolean;
  readonly extraArgs?: readonly string[];
  readonly tags?: readonly string[];
  readonly parentSessionId?: string;
}

interface AgentCliSpec {
  readonly kind: BgAgentCliKind;
  readonly binary: string;
  readonly title: string;
  readonly missingLabel: string;
  readonly installHint: string;
}

type CliResolver = (binary: string) => string | null | undefined;

const defaultCliResolver: CliResolver = (binary) => Bun.which(binary);

let cliResolver: CliResolver = defaultCliResolver;

const agentCliSpecs: Record<BgAgentCliKind, AgentCliSpec> = {
  claude: {
    kind: "claude",
    binary: "claude",
    title: "Claude Code",
    missingLabel: "Claude CLI",
    installHint: "npm install -g @anthropic-ai/claude-code",
  },
  codex: {
    kind: "codex",
    binary: "codex",
    title: "Codex CLI",
    missingLabel: "Codex CLI",
    installHint: "npm install -g @openai/codex",
  },
  gemini: {
    kind: "gemini",
    binary: "gemini",
    title: "Gemini CLI",
    missingLabel: "Gemini CLI",
    installHint: "npm install -g @google/gemini-cli",
  },
  opencode: {
    kind: "opencode",
    binary: "opencode",
    title: "OpenCode",
    missingLabel: "OpenCode CLI",
    installHint: "npm install -g opencode-ai",
  },
};

const summarizePrompt = (prompt: string): string => {
  const singleLine = prompt.replace(/\s+/g, " ").trim();
  if (singleLine.length <= 48) {
    return singleLine;
  }

  return `${singleLine.slice(0, 45)}...`;
};

const uniqueTags = (tags: readonly string[]): readonly string[] => Array.from(new Set(tags));

export function getBgAgentCliSpec(kind: BgAgentCliKind): AgentCliSpec {
  return agentCliSpecs[kind];
}

export function setBgAgentCliResolverForTesting(resolver?: CliResolver): void {
  cliResolver = resolver ?? defaultCliResolver;
}

export function detectCli(binary: string): boolean {
  return Boolean(cliResolver(binary));
}

export function detectAgentCliAvailability(kind: BgAgentCliKind): boolean {
  return detectCli(getBgAgentCliSpec(kind).binary);
}

export function assertAgentCliAvailable(kind: BgAgentCliKind): void {
  const spec = getBgAgentCliSpec(kind);
  if (detectAgentCliAvailability(kind)) {
    return;
  }

  throw new CliUnavailable({
    cli: spec.missingLabel,
    installHint: spec.installHint,
  });
}

export function buildAgentCliSpawnInput(
  kind: BgAgentCliKind,
  input: BgAgentCliLaunchInput,
): SpawnInput {
  const spec = getBgAgentCliSpec(kind);
  const prompt = input.prompt.trim();
  const extraArgs = [...(input.extraArgs ?? [])];
  const args = (() => {
    switch (kind) {
      case "claude":
        return [
          "--print",
          ...extraArgs,
          ...(input.model?.trim() ? ["--model", input.model.trim()] : []),
          "-p",
          prompt,
        ];
      case "codex":
        return [
          ...extraArgs,
          ...(input.model?.trim() ? ["--model", input.model.trim()] : []),
          "-q",
          prompt,
        ];
      case "gemini":
        return [
          ...extraArgs,
          ...(input.model?.trim() ? ["--model", input.model.trim()] : []),
          "-p",
          prompt,
        ];
      case "opencode":
        return [
          "run",
          ...extraArgs,
          ...(input.model?.trim() ? ["--model", input.model.trim()] : []),
          "-p",
          prompt,
        ];
    }
  })();

  return {
    name: `${spec.title}: ${summarizePrompt(prompt) || "background task"}`,
    command: spec.binary,
    args,
    useShell: false,
    ...(input.workdir?.trim() ? { workdir: input.workdir.trim() } : {}),
    tags: uniqueTags(["agent", kind, ...(input.tags ?? [])]),
    ...(input.parentSessionId?.trim() ? { parentSessionId: input.parentSessionId.trim() } : {}),
    notifyOnExit: input.notifyOnExit ?? true,
  };
}

export function extractAgentPromptFromArgs(
  kind: BgAgentCliKind,
  args: readonly string[],
): string | undefined {
  const promptFlag = kind === "codex" ? "-q" : "-p";
  const promptIndex = args.findIndex((value) => value === promptFlag);
  if (promptIndex === -1) {
    return undefined;
  }

  return args[promptIndex + 1]?.trim() || undefined;
}

export function extractAgentModelFromArgs(args: readonly string[]): string | undefined {
  const modelIndex = args.findIndex((value) => value === "--model");
  if (modelIndex === -1) {
    return undefined;
  }

  return args[modelIndex + 1]?.trim() || undefined;
}
