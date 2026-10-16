type Event = { meta?: unknown; status?: unknown; kind?: unknown };

function turnKey(event: Event) {
  const meta = event.meta as Record<string, unknown> | undefined;
  const thread = meta?.threadId ?? meta?.sessionId;
  return typeof thread === "string" && typeof meta?.turnId === "string"
    ? `${thread}:${meta.turnId}` : undefined;
}

// A live server owns only the turns it actually reports. A separate desktop
// server can be running other turns, including newer turns of the same task.
export function uncoveredCodexEvents<T extends Event>(local: T[], live: Event[]) {
  const covered = new Set(live.map(turnKey).filter((key) => key !== undefined));
  return local.filter((event) => {
    const key = turnKey(event);
    // A persisted terminal record is authoritative even when the server
    // previously reported this turn. Its final notification may have been lost.
    if (event.status === "complete" || event.status === "stopped" || event.kind === "turn.end" || event.kind === "session.end") return true;
    return key === undefined || !covered.has(key);
  });
}
