export type ErrorCode =
  | "NOT_OPTED_IN" | "NOT_A_REPO" | "NO_TASK" | "OUT_OF_ORDER" | "BAD_EVIDENCE"
  | "TASK_CLOSED" | "OWNER_ONLY" | "POLICY_INVALID" | "MAP_OFF" | "MAP_BROKEN"
  | "HELD" | "OVERLAP" | "DEPENDENCY";

export class EngineError extends Error {
  constructor(public code: ErrorCode, message: string) {
    super(message);
    this.name = "EngineError";
  }
}

export type TaskStatus = "planned" | "open" | "done" | "cancelled";
export type StepStatus = "pending" | "in_progress" | "done" | "skipped";
export type EvidenceKind = "command" | "commit" | "pr" | "review" | "note" | "merged";

export interface Actor { session_id: string; agent_id?: string }
export const actorId = (a: Actor): string => `${a.session_id}/${a.agent_id ?? "main"}`;

export interface Task {
  id: number; title: string; type: string; goal: string; done_check: string;
  status: TaskStatus; branch: string; cwd: string; base_sha: string; created_by: string; created_at: string;
  parent_id: number | null; task_group: string | null;
}
export interface Step {
  task_id: number; name: string; ordinal: number; status: StepStatus; done_at: string | null;
}
export interface Evidence {
  id: number; task_id: number; step: string; kind: EvidenceKind; ok: boolean;
  payload: Record<string, unknown>; recorded_by: string; recorded_at: string;
}

/** The evidence kind each step requires. Fixed by the engine; policy cannot change it. */
export const STEP_EVIDENCE: Record<string, EvidenceKind> = {
  plan: "note", explore: "note", report: "note", reproduce: "note", reuse_check: "note",
  implement: "commit", fix: "commit", test: "command", verify: "command", review: "review", pr: "pr", merge: "merged",
};
