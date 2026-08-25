import type { AgentEvent } from "../../src/core/protocol";
import { normalizeTelemetry, type TelemetryEnvelope } from "./normalizers";

export type SourceState = "idle" | "connecting" | "live" | "error" | "unavailable";

export interface SourceHealth {
  id: string;
  product: string;
  transport: string;
  state: SourceState;
  eventCount: number;
  lastEventAt?: string;
  lastConnectedAt?: string;
  error?: string;
}

type EventListener = (event: AgentEvent) => void;
type HealthListener = (sources: SourceHealth[]) => void;

export class TelemetryHub {
  private readonly seen = new Map<string, number>();
  private readonly recentBySource = new Map<string, AgentEvent[]>();
  private readonly sources = new Map<string, SourceHealth>();
  private readonly eventListeners = new Set<EventListener>();
  private readonly healthListeners = new Set<HealthListener>();

  onEvent(listener: EventListener) {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onHealth(listener: HealthListener) {
    this.healthListeners.add(listener);
    return () => this.healthListeners.delete(listener);
  }

  markSource(id: string, product: string, transport: string, state: SourceState, error?: string, eventCount?: number) {
    const previous = this.sources.get(id);
    const next: SourceHealth = {
      id,
      product,
      transport,
      state,
      eventCount: eventCount ?? previous?.eventCount ?? 0,
      lastEventAt: previous?.lastEventAt,
      lastConnectedAt: state === "live" ? new Date().toISOString() : previous?.lastConnectedAt,
      error,
    };
    this.sources.set(id, next);
    this.emitHealth();
  }

  ingest(envelope: TelemetryEnvelope) {
    const events = normalizeTelemetry({ ...envelope, receivedAt: envelope.receivedAt ?? Date.now() });
    if (!this.sources.has(envelope.source)) this.markSource(envelope.source, envelope.product, envelope.transport, "live");
    const accepted: AgentEvent[] = [];
    for (const event of events) {
      const dedupeKey = `${envelope.source}:${event.id}`;
      if (this.seen.has(dedupeKey)) continue;
      this.seen.set(dedupeKey, Date.now());
      accepted.push(event);
      const recent = this.recentBySource.get(envelope.source) ?? [];
      recent.push(event);
      if (recent.length > 1_000) recent.splice(0, recent.length - 1_000);
      this.recentBySource.set(envelope.source, recent);
      for (const listener of this.eventListeners) listener(event);
    }
    if (accepted.length) {
      const previous = this.sources.get(envelope.source);
      this.sources.set(envelope.source, {
        id: envelope.source,
        product: envelope.product,
        transport: envelope.transport,
        state: "live",
        eventCount: (previous?.eventCount ?? 0) + accepted.length,
        lastConnectedAt: previous?.lastConnectedAt ?? new Date().toISOString(),
        lastEventAt: new Date().toISOString(),
      });
      this.pruneSeen();
      this.emitHealth();
    }
    return accepted;
  }

  eventsBySource() {
    return Object.fromEntries([...this.recentBySource].map(([source, events]) => [source, [...events]]));
  }

  health() {
    return [...this.sources.values()].sort((left, right) => left.id.localeCompare(right.id));
  }

  private emitHealth() {
    const snapshot = this.health();
    for (const listener of this.healthListeners) listener(snapshot);
  }

  private pruneSeen() {
    if (this.seen.size <= 8_000) return;
    const cutoff = Date.now() - 6 * 60 * 60 * 1_000;
    for (const [id, seenAt] of this.seen) {
      if (seenAt < cutoff || this.seen.size > 6_000) this.seen.delete(id);
    }
  }
}
