import { normalizeSimpleEvent, type AgentEvent, type SimpleEvent } from "./protocol";

const script: Array<SimpleEvent & { wait: number }> = [
  { status: "command", label: "BUILDING", tool: "cargo build", detail: "Compiling desktop crate 42 of 96", target: "src-tauri", meta: { sessionId: "linux-01", threadId: "proper-linux", workstreamName: "PROPER LINUX", agentName: "Build agent" }, wait: 700 },
  { status: "testing", tool: "vitest", detail: "Running Fedora install smoke test", target: "installer", meta: { sessionId: "linux-02", threadId: "proper-linux", workstreamName: "PROPER LINUX", agentName: "Test agent" }, wait: 700 },
  { status: "thinking", detail: "Investigating packaging failure", meta: { sessionId: "linux-03", threadId: "proper-linux", workstreamName: "PROPER LINUX", agentName: "Review agent" }, wait: 700 },
  { status: "editing", label: "EDITING", tool: "apply_patch", detail: "Wiring events into session adapter", target: "src/adapters/codex.ts", meta: { sessionId: "big-agent-01", threadId: "big-agent", workstreamName: "BIG AGENT", agentName: "UI agent" }, wait: 700 },
  { status: "approval", tool: "browser", detail: "Permission required to open localhost", target: "localhost:1420", meta: { sessionId: "apollo-01", threadId: "apollo-web", workstreamName: "APOLLO WEB", agentName: "Browser agent" }, wait: 3_000 },
  { status: "testing", tool: "vitest", detail: "Running grouped-workstream tests", target: "24 tests", meta: { sessionId: "big-agent-01", threadId: "big-agent", workstreamName: "BIG AGENT", agentName: "UI agent" }, wait: 2_600 },
  { status: "complete", detail: "Desktop adapter complete", meta: { sessionId: "big-agent-01", threadId: "big-agent", workstreamName: "BIG AGENT", agentName: "UI agent" }, wait: 4_000 },
];
export function mockEvent(index: number): AgentEvent { const { wait: _wait, ...event } = script[index % script.length]; return normalizeSimpleEvent(event, `mock-${index}-${Date.now()}`); }
export function mockLength() { return script.length; }
export function mockDelay(index: number, speed: number) { return script[index % script.length].wait / speed; }
