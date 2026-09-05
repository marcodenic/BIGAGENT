import { isActiveStatus, type AgentSession } from "./workstreams";

export interface RunRecap {
  participants: Record<string, AgentSession>;
  startedAt: number;
  endedAt: number | null;
  status: "running" | "complete" | "interrupted";
}

/** A display run is a burst of observed work, not the lifetime of a provider session.
 * Keep terminal participants independently of the live board's retention window.
 */
export function advanceRunRecap(previous: RunRecap | null, sessions: Record<string, AgentSession>, now: number): RunRecap | null {
  const active = Object.values(sessions).filter(agent => isActiveStatus(agent.state.status));
  let recap = previous;
  if (active.length && (!recap || recap.status !== "running")) {
    recap = { participants: {}, startedAt: now, endedAt: null, status: "running" };
  }
  if (!recap || recap.status !== "running") return recap;
  const participants = { ...recap.participants };
  for (const agent of Object.values(sessions)) {
    if (isActiveStatus(agent.state.status) || participants[agent.id]) participants[agent.id] = agent;
  }
  const agents = Object.values(participants);
  const allComplete = agents.length > 0 && agents.every(agent => agent.state.status === "complete");
  const startedAt = Math.min(recap.startedAt, ...agents.map(agent => agent.state.startedAt ?? recap.startedAt));
  const status = allComplete ? "complete" : active.length ? "running" : "interrupted";
  return { participants, startedAt, status, endedAt: allComplete ? Math.max(...agents.map(agent => agent.state.endedAt ?? agent.updatedAt)) : null };
}
