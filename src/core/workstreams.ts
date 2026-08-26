import type { AgentEvent, AgentPhase, AgentStatus } from "./protocol";
import { initialState, reduceEvent, type DisplayState } from "./reducer";

export interface AgentSession {
  id: string;
  runId: string;
  source: string;
  workstreamId: string;
  workstreamName: string;
  agentName: string;
  modelProvider: string;
  model: string;
  effort: string;
  lastMessage: string;
  state: DisplayState;
  updatedAt: number;
}

export interface Workstream {
  id: string;
  name: string;
  agents: AgentSession[];
  status: AgentStatus;
  phase: AgentPhase;
  label: string;
  attention: boolean;
  startedAt: number | null;
  endedAt: number | null;
  updatedAt: number;
}

const statusPriority: Record<AgentStatus, number> = {
  error: 110,
  approval: 100,
  waiting: 95,
  testing: 70,
  editing: 65,
  command: 60,
  searching: 55,
  thinking: 50,
  working: 45,
  idle: 10,
  complete: 0,
};

const activeStatuses = new Set<AgentStatus>([
  "thinking", "searching", "working", "command", "editing", "testing", "waiting", "approval",
]);

const genericLabels = new Set(["READY", "THINKING", "SEARCHING", "WORKING", "RUNNING", "EDITING", "RUNNING TESTS", "NEEDS YOU", "DONE", "SOMETHING BROKE"]);

function sourcePriority(source: string) {
  if (source === "codex-desktop-fallback" || source.includes("fallback")) return 10;
  if (source === "protocol" || source === "process") return 40;
  if (source.includes("hooks") || source.includes("otlp") || source.includes("sse")) return 70;
  if (source.includes("app-server") || source.includes("acp")) return 90;
  return 50;
}

function metaText(event: AgentEvent, key: string) {
  const value = event.meta?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function metaTime(event: AgentEvent, key: string) {
  const value = event.meta?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function applySessionEvent(
  sessions: Record<string, AgentSession>,
  event: AgentEvent,
  now = Date.now(),
  source = "protocol",
) {
  const sessionId = metaText(event, "sessionId") ?? `${source}:ambient`;
  const workstreamId = metaText(event, "workstreamId") ?? metaText(event, "threadId") ?? metaText(event, "project") ?? sessionId;
  const workstreamName = metaText(event, "workstreamName") ?? metaText(event, "project") ?? metaText(event, "sessionName") ?? "AMBIENT TASK";
  const agentName = metaText(event, "agentName") ?? metaText(event, "sessionName") ?? "AGENT";
  const modelProvider = metaText(event, "modelProvider") ?? "unknown";
  const model = metaText(event, "model") ?? "unknown model";
  const effort = metaText(event, "reasoningEffort") ?? "";
  const previous = sessions[sessionId];
  const explicitRunId = metaText(event, "turnId") ?? metaText(event, "runId");
  const beginsRun = event.kind === "session.start" || event.kind === "turn.start";
  const runId = explicitRunId ?? (beginsRun ? event.id : previous?.runId ?? sessionId);
  const sameRun = previous?.runId === runId;
  const lastMessage = metaText(event, "lastMessage") ?? (sameRun ? previous.lastMessage : "");
  const startedAt = metaTime(event, "startedAtMs");
  const completedAt = metaTime(event, "completedAtMs");
  const base: DisplayState = sameRun ? previous.state : {
    ...initialState,
    recent: [],
    files: [],
    plan: [],
    sessionName: agentName,
    project: workstreamName,
    startedAt: startedAt ?? null,
  };
  // An official live transport wins over a passive database/log fallback for
  // the same provider session. The fallback remains available when no proper
  // feed has been connected.
  if (previous && previous.runId === runId && sourcePriority(previous.source) > sourcePriority(source)) return sessions;
  const state = reduceEvent(base, event, now);
  if (startedAt !== undefined) state.startedAt = startedAt;
  if (completedAt !== undefined && !activeStatuses.has(state.status)) state.endedAt = completedAt;
  return {
    ...sessions,
    [sessionId]: { id: sessionId, runId, source, workstreamId, workstreamName, agentName, modelProvider, model, effort, lastMessage, state, updatedAt: now },
  };
}

export function replaceSessionSource(
  sessions: Record<string, AgentSession>,
  source: string,
  events: AgentEvent[],
  now = Date.now(),
) {
  const previous = Object.fromEntries(Object.entries(sessions).filter(([, session]) => session.source === source));
  // Snapshot status is authoritative. Rebuild source sessions in event order
  // so an older, newly discovered record cannot resurrect a terminal agent.
  let next = Object.fromEntries(Object.entries(sessions).filter(([, session]) => session.source !== source));
  for (const event of events) next = applySessionEvent(next, event, now, source);
  // Preserve older display history without allowing it to mutate rebuilt state.
  for (const [id, session] of Object.entries(next)) {
    if (session.source !== source || !previous[id] || previous[id].runId !== session.runId) continue;
    const seen = new Set<string>();
    session.state.recent = [...session.state.recent, ...previous[id].state.recent].filter((event) => !seen.has(event.id) && Boolean(seen.add(event.id))).slice(0, 80);
  }
  return next;
}

/** Replace an authoritative snapshot, including sources that currently emit no
 * events. Without the explicit source list, an empty feed leaves ghost agents
 * from the previous snapshot in memory forever. */
export function replaceSessionSnapshot(
  sessions: Record<string, AgentSession>,
  events: AgentEvent[],
  authoritativeSources: string[],
  now = Date.now(),
) {
  const grouped = new Map<string, AgentEvent[]>();
  for (const event of events) {
    const source = metaText(event, "source") ?? "protocol";
    grouped.set(source, [...(grouped.get(source) ?? []), event]);
  }
  let next = sessions;
  for (const source of new Set([...authoritativeSources, ...grouped.keys()])) {
    next = replaceSessionSource(next, source, grouped.get(source) ?? [], now);
  }
  return next;
}

export function groupWorkstreams(sessions: Record<string, AgentSession>, now = Date.now(), completedTtlMs = 20_000) {
  const visible = Object.values(sessions).filter((session) => {
    if (session.state.status !== "complete") return true;
    return now - (session.state.endedAt ?? session.updatedAt) <= completedTtlMs;
  });
  const grouped = new Map<string, AgentSession[]>();
  for (const session of visible) grouped.set(session.workstreamId, [...(grouped.get(session.workstreamId) ?? []), session]);
  const workstreams: Workstream[] = [];
  for (const [id, agents] of grouped) {
    agents.sort((a, b) => (a.state.startedAt ?? a.updatedAt) - (b.state.startedAt ?? b.updatedAt) || a.id.localeCompare(b.id));
    const lead = agents[0];
    const activeAgents = agents.filter((agent) => activeStatuses.has(agent.state.status));
    const attention = activeAgents.some((agent) => agent.state.attention);
    const rankedActive = [...activeAgents].sort((a, b) => statusPriority[b.state.status] - statusPriority[a.state.status] || b.updatedAt - a.updatedAt);
    const aggregate = attention ? activeAgents.find((agent) => agent.state.attention)! : rankedActive[0] ?? lead;
    const mixedActive = new Set(activeAgents.map((agent) => agent.state.status)).size > 1;
    const explicitLabel = activeAgents.find((agent) => !genericLabels.has(agent.state.label))?.state.label;
    workstreams.push({
      id,
      name: lead.workstreamName,
      agents,
      status: aggregate.state.status,
      phase: aggregate.state.phase,
      label: attention ? aggregate.state.label : explicitLabel ?? (mixedActive ? "WORKING" : aggregate.state.label),
      attention,
      startedAt: agents.reduce<number | null>((oldest, agent) => {
        if (agent.state.startedAt === null) return oldest;
        return oldest === null ? agent.state.startedAt : Math.min(oldest, agent.state.startedAt);
      }, null),
      endedAt: activeAgents.length ? null : Math.max(...agents.map((agent) => agent.state.endedAt ?? 0)),
      updatedAt: Math.max(...agents.map((agent) => agent.updatedAt), 0),
    });
  }
  return workstreams.sort((a, b) => (a.startedAt ?? a.updatedAt) - (b.startedAt ?? b.updatedAt) || a.id.localeCompare(b.id));
}

export function isActiveStatus(status: AgentStatus) {
  return activeStatuses.has(status);
}
