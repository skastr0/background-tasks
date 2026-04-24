import type { HealthProbe, RestartPolicy } from "./health-probe.ts";

export type TaskStatus =
  | "starting"
  | "healthy"
  | "unhealthy"
  | "running"
  | "exited"
  | "killed"
  | "failed";

export interface None {
  readonly _tag: "None";
}

export interface Some<T> {
  readonly _tag: "Some";
  readonly value: T;
}

export type Option<T> = None | Some<T>;

export const none: Option<never> = { _tag: "None" };

export function some<T>(value: T): Option<T> {
  return { _tag: "Some", value };
}

export interface TaskTimestamps {
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly startedAt: Option<Date>;
  readonly exitedAt: Option<Date>;
  readonly lastStatusChangeAt: Date;
}

export interface Task {
  readonly id: string;
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly workdir: string;
  readonly env: Readonly<Record<string, string>>;
  readonly tags: readonly string[];
  readonly status: TaskStatus;
  readonly pid: Option<number>;
  readonly exitCode: Option<number>;
  readonly timestamps: TaskTimestamps;
  readonly restartCount: number;
  readonly parentSessionId: Option<string>;
  readonly healthProbe: Option<HealthProbe>;
  readonly restartPolicy: Option<RestartPolicy>;
  readonly notifyOnExit: boolean;
}

export interface SpawnInput {
  readonly id?: string;
  readonly name: string;
  readonly command: string;
  readonly args?: readonly string[];
  readonly useShell?: boolean;
  readonly workdir?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly tags?: readonly string[];
  readonly parentSessionId?: string;
  readonly healthProbe?: HealthProbe;
  readonly restartPolicy?: RestartPolicy;
  readonly notifyOnExit?: boolean;
}

export type TaskEvent =
  | "health-probe-passed"
  | "health-probe-failed"
  | "process-confirmed-running"
  | "process-exited"
  | "process-killed"
  | "restart-requested";

type TransitionMap = Readonly<Record<TaskStatus, Partial<Record<TaskEvent, TaskStatus>>>>;

const transitions = {
  starting: {
    "health-probe-passed": "healthy",
    "process-confirmed-running": "running",
    "health-probe-failed": "unhealthy",
    "process-exited": "exited",
    "process-killed": "killed",
  },
  healthy: {
    "health-probe-failed": "unhealthy",
    "process-exited": "exited",
    "process-killed": "killed",
  },
  unhealthy: {
    "health-probe-passed": "healthy",
    "process-exited": "exited",
    "process-killed": "killed",
  },
  running: {
    "process-exited": "exited",
    "process-killed": "killed",
  },
  exited: {
    "restart-requested": "starting",
  },
  killed: {
    "restart-requested": "starting",
  },
  failed: {
    "restart-requested": "starting",
  },
} as const satisfies TransitionMap;

export function transitionStatus(current: TaskStatus, event: TaskEvent): TaskStatus {
  const availableTransitions = transitions[current] as Partial<Record<TaskEvent, TaskStatus>>;
  return availableTransitions[event] ?? current;
}
