import { normalizeSimpleEvent, type AgentEvent, type SimpleEvent } from "./protocol";

const script: Array<SimpleEvent & { wait: number }> = [
  { status: "idle", label: "READY", detail: "Waiting for an agent", wait: 1200 },
  { status: "thinking", detail: "Tracing the authentication flow", wait: 2200 },
  { status: "searching", detail: "Finding every place session state is mutated", wait: 2000 },
  { status: "editing", files: ["session.ts", "auth.ts", "refresh.ts", "auth.test.ts"], wait: 2300 },
  { status: "command", command: "pnpm test --filter auth", wait: 2800 },
  { status: "testing", detail: "Running integration tests", wait: 2400 },
  { status: "error", detail: "Tests exited with code 1", wait: 2300 },
  { status: "thinking", detail: "Investigating an intermittent race condition", wait: 2400 },
  { status: "editing", files: ["refresh.ts", "auth.test.ts"], wait: 2200 },
  { status: "approval", detail: "Permission required to update generated fixtures", wait: 2500 },
  { status: "testing", detail: "Running focused regression tests", wait: 2600 },
  { status: "complete", detail: "Fixed refresh-token race\nAdded 4 tests\n182 tests passing", wait: 4000 }
];
export function mockEvent(index: number): AgentEvent { const { wait: _wait, ...event } = script[index % script.length]; return normalizeSimpleEvent(event, `mock-${index}-${Date.now()}`); }
export function mockLength() { return script.length; }
export function mockDelay(index: number, speed: number) { return script[index % script.length].wait / speed; }
