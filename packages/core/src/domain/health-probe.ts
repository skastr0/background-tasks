export const defaultHealthProbeIntervalMs = 10_000;
export const defaultHealthProbeStartupTimeoutMs = 30_000;
export const defaultHealthProbeTimeoutMs = 5_000;

interface BaseHealthProbe {
  readonly intervalMs?: number;
  readonly startupTimeoutMs?: number;
}

export interface HttpHealthProbe extends BaseHealthProbe {
  readonly type: "http";
  readonly url: string;
  readonly expectedStatus?: number;
  readonly timeoutMs?: number;
}

export interface TcpHealthProbe extends BaseHealthProbe {
  readonly type: "tcp";
  readonly host: string;
  readonly port: number;
  readonly timeoutMs?: number;
}

export interface CommandHealthProbe extends BaseHealthProbe {
  readonly type: "command";
  readonly command: string;
  readonly expectedExitCode?: number;
  readonly timeoutMs?: number;
}

export type HealthProbe = HttpHealthProbe | TcpHealthProbe | CommandHealthProbe;

export interface HealthResult {
  readonly healthy: boolean;
  readonly responseTimeMs: number;
  readonly detail?: string;
}

export interface RestartPolicy {
  readonly onFailure: boolean;
  readonly maxRetries: number;
  readonly delayMs: number;
  readonly backoff: "constant" | "linear" | "exponential";
}

const normalizePositiveInt = (value: number | undefined, fallback: number, minimum = 1): number => {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(minimum, Math.floor(value));
};

export const getHealthProbeIntervalMs = (probe: BaseHealthProbe): number =>
  normalizePositiveInt(probe.intervalMs, defaultHealthProbeIntervalMs);

export const getHealthProbeStartupTimeoutMs = (probe: BaseHealthProbe): number =>
  normalizePositiveInt(probe.startupTimeoutMs, defaultHealthProbeStartupTimeoutMs, 0);

export const getHealthProbeTimeoutMs = (
  probe: HttpHealthProbe | TcpHealthProbe | CommandHealthProbe,
): number => normalizePositiveInt(probe.timeoutMs, defaultHealthProbeTimeoutMs);

export function calculateBackoffDelay(policy: RestartPolicy, attemptNumber: number): number {
  const baseDelay = Math.max(0, policy.delayMs);
  const attempt = Number.isFinite(attemptNumber) ? Math.max(1, Math.floor(attemptNumber)) : 1;

  switch (policy.backoff) {
    case "constant":
      return baseDelay;
    case "linear":
      return baseDelay * attempt;
    case "exponential":
      return baseDelay * 2 ** (attempt - 1);
  }
}
