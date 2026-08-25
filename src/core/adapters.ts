import { isAgentEvent, normalizeSimpleEvent, type AgentEvent, type SimpleEvent } from "./protocol";

/** Adapter boundary: UI consumes only these normalized events. */
export interface AgentAdapter { name: string; ingest(raw: unknown): AgentEvent | null; }
export const genericJsonlAdapter: AgentAdapter = { name: "generic-jsonl", ingest(raw) { if (isAgentEvent(raw)) return raw; if (raw && typeof raw === "object" && "status" in raw) return normalizeSimpleEvent(raw as SimpleEvent); return null; } };
/** Maps public Codex structured activity fields. It deliberately ignores reasoning content. */
export const codexAdapter: AgentAdapter = { name: "codex", ingest(raw) {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>; if (isAgentEvent(r)) return r;
  // Codex CLI's documented `exec --json` transport wraps observable activity in `item`.
  const item = r.item && typeof r.item === "object" ? r.item as Record<string, unknown> : r;
  const type = String(item.type || r.type || r.event || "");
  const text = [item.summary, item.text, item.message, r.summary, r.message].find((x): x is string => typeof x === "string");
  const command = typeof item.command === "string" ? item.command : typeof r.command === "string" ? r.command : undefined;
  if (type === "thread.started" || type === "turn.started") return { version: 1, id: crypto.randomUUID(), timestamp: new Date().toISOString(), kind: type === "thread.started" ? "session.start" : "turn.start", status: "thinking", detail: "Starting Codex" };
  if (type === "turn.completed") return normalizeSimpleEvent({ status: "complete", detail: text || "Codex completed" });
  if (type.includes("reasoning")) return normalizeSimpleEvent({ status: "thinking", detail: text || "Thinking" });
  if (type.includes("command_execution") || type.includes("command")) return normalizeSimpleEvent({ status: command?.match(/\b(test|vitest|jest|pytest|cargo test|go test)\b/) ? "testing" : "command", label: command?.match(/\b(test|vitest|jest|pytest|cargo test|go test)\b/) ? "RUNNING TESTS" : "RUNNING", command, tool: command?.trim().split(/\s+/)[0]?.split("/").pop(), detail: text, exitCode: typeof item.exit_code === "number" ? item.exit_code : undefined });
  if (type.includes("file_change") || type.includes("file") || type.includes("patch")) { const changes = Array.isArray(item.changes) ? item.changes : []; const files = changes.map((x) => x && typeof x === "object" && "path" in x ? String((x as Record<string, unknown>).path) : "").filter(Boolean); return normalizeSimpleEvent({ status: "editing", files, tool: "apply_patch", target: files[0], detail: text }); }
  if (type.includes("plan")) return { version: 1, id: crypto.randomUUID(), timestamp: new Date().toISOString(), kind: "plan", status: "thinking", detail: text, plan: Array.isArray(item.plan) ? item.plan.map(String) : undefined };
  if (type.includes("web_search")) return normalizeSimpleEvent({ status: "searching", tool: "web", detail: text || "Searching the web" });
  if (type.includes("tool")) { const tool = typeof item.tool === "string" ? item.tool : typeof r.tool === "string" ? r.tool : "tool"; return normalizeSimpleEvent({ status: tool.includes("patch") ? "editing" : "command", tool, detail: text || `Using ${tool}` }); }
  if (type.includes("error") || type.includes("failed")) return normalizeSimpleEvent({ status: "error", detail: text || "Codex reported an error" });
  if (type.includes("agent_message")) return normalizeSimpleEvent({ status: "working", detail: text || "Working" });
  return text ? normalizeSimpleEvent({ status: "thinking", detail: text }) : null;
} };
