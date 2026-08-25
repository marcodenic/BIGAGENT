import type { AgentEvent, AgentPhase, AgentStatus } from "./protocol";

export interface DisplayState {
  status: AgentStatus; label: string; detail: string; files: string[]; plan: string[]; recent: AgentEvent[];
  startedAt: number | null; stateSince: number; endedAt: number | null; attention: boolean; error: string | null;
  sessionName: string; project: string; branch: string; command: string; tool: string; target: string; phase: AgentPhase; usage?: AgentEvent["usage"];
}
export const initialState: DisplayState = { status: "idle", label: "READY", detail: "Waiting for an agent", files: [], plan: [], recent: [], startedAt: null, stateSince: Date.now(), endedAt: null, attention: false, error: null, sessionName: "ambient session", project: "BIG AGENT", branch: "main", command: "", tool: "", target: "", phase: "idle" };
const labels: Record<AgentStatus, string> = { idle: "READY", thinking: "THINKING", searching: "SEARCHING", working: "WORKING", command: "RUNNING", editing: "EDITING", testing: "RUNNING TESTS", waiting: "NEEDS YOU", approval: "NEEDS YOU", complete: "DONE", error: "SOMETHING BROKE" };
const active = new Set<AgentStatus>(["thinking", "searching", "working", "command", "editing", "testing", "waiting", "approval"]);
export function reduceEvent(state: DisplayState, event: AgentEvent, now = Date.now()): DisplayState {
  if (state.recent.some((x) => x.id === event.id)) return state;
  const next: DisplayState = { ...state, recent: [event, ...state.recent].slice(0, 80), usage: event.usage ?? state.usage };
  let status = event.status ?? state.status;
  if (event.kind === "complete") status = "complete";
  if (event.kind === "error" || event.exitCode && event.exitCode !== 0) status = "error";
  if (event.kind === "approval.requested") status = "approval";
  if (event.kind === "input.requested") status = "waiting";
  if (event.kind === "session.start" || event.kind === "turn.start") next.startedAt ??= now;
  if (event.kind === "session.end" || event.kind === "turn.end") next.endedAt = now;
  if (event.kind === "plan" && event.plan) next.plan = event.plan;
  if (event.files?.length) next.files = event.files;
  if (event.command !== undefined) next.command = event.command;
  if (event.tool !== undefined) next.tool = event.tool;
  if (event.target !== undefined) next.target = event.target;
  if (event.phase !== undefined) next.phase = event.phase;
  if (status !== state.status) next.stateSince = now;
  next.status = status;
  if (status === "error") next.phase = "failed";
  else if (status === "complete" && event.phase === undefined) next.phase = "completing";
  // A protocol producer may omit explicit session boundaries; the first active status still starts a useful timer.
  if (active.has(status)) { next.startedAt ??= now; next.endedAt = null; }
  next.label = event.label?.toUpperCase() || (status === "editing" && event.files?.length ? `EDITING ${event.files.length} FILES` : labels[status]);
  next.detail = event.detail || event.command || (event.files?.length ? event.files.join("\n") : event.label || state.detail);
  next.attention = status === "waiting" || status === "approval" || status === "error";
  next.error = status === "error" ? (event.detail || event.label || "An agent process exited unexpectedly") : null;
  if (!active.has(status) && status !== "idle") next.endedAt ??= now;
  return next;
}
export function elapsedMs(state: DisplayState, now = Date.now()) { return state.startedAt ? (state.endedAt ?? now) - state.startedAt : 0; }
export function formatElapsed(ms: number) { const s = Math.max(0, Math.floor(ms / 1000)); return `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor(s % 3600 / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`; }
