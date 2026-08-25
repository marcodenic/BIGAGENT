import { describe, expect, it } from "vitest";
import { TelemetryHub } from "./hub";
import { normalizeTelemetry, type TelemetryEnvelope } from "./normalizers";

function envelope(format: TelemetryEnvelope["format"], payload: unknown, source = "test") : TelemetryEnvelope {
  return { source, product: "test-agent", transport: format, format, payload, receivedAt: 1_000 };
}

describe("telemetry normalization", () => {
  it("maps compatible lifecycle hooks without retaining prompt contents", () => {
    const [event] = normalizeTelemetry(envelope("hook", {
      hook_event_name: "SubagentStart",
      session_id: "session-1",
      prompt: "private prompt text",
    }, "claude-hooks"));
    expect(event.phase).toBe("delegating");
    expect(event.meta?.sessionId).toBe("session-1");
    expect(JSON.stringify(event)).not.toContain("private prompt text");
  });

  it("maps OTLP GenAI log attributes into a tool activity", () => {
    const [event] = normalizeTelemetry(envelope("otlp-logs", {
      resourceLogs: [{
        resource: { attributes: [{ key: "service.name", value: { stringValue: "claude-code" } }] },
        scopeLogs: [{ logRecords: [{
          timeUnixNano: "1000000000",
          body: { stringValue: "tool.execute" },
          attributes: [
            { key: "session.id", value: { stringValue: "session-2" } },
            { key: "gen_ai.tool.name", value: { stringValue: "Edit" } },
          ],
        }] }],
      }],
    }, "collector-otlp"));
    expect(event.status).toBe("editing");
    expect(event.phase).toBe("editing");
    expect(event.meta?.product).toBe("claude-code");
  });

  it("maps ACP session updates and OpenCode SSE events", () => {
    const [acp] = normalizeTelemetry(envelope("acp", {
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "acp-1", update: { sessionUpdate: "agent_message_chunk" } },
    }, "acp"));
    const [opencode] = normalizeTelemetry(envelope("opencode", {
      type: "permission.asked",
      properties: { sessionID: "open-1" },
    }, "opencode-sse"));
    expect(acp.phase).toBe("responding");
    expect(opencode.status).toBe("approval");
  });

  it("deduplicates retransmitted events and reports source health", () => {
    const hub = new TelemetryHub();
    const input = envelope("protocol", {
      version: 1,
      id: "same-event",
      timestamp: "2026-08-25T12:00:00Z",
      kind: "activity",
      status: "thinking",
    }, "protocol");
    expect(hub.ingest(input)).toHaveLength(1);
    expect(hub.ingest(input)).toHaveLength(0);
    expect(hub.health()[0]).toMatchObject({ id: "protocol", state: "live", eventCount: 1 });
  });
});
