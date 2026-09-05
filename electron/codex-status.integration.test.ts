import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Vite 5 predates node:sqlite; load the native module through Node for this fixture.
vi.mock("node:sqlite", async () => {
  const { createRequire } = await import("node:module");
  return createRequire(import.meta.url)("node:sqlite");
});
import { DatabaseSync } from "node:sqlite";
import { codexDesktopSessions } from "./codex-sessions";
let directory = "";
afterEach(() => { vi.unstubAllEnvs(); if (directory) rmSync(directory, { recursive: true, force: true }); });
it("tracks fallback tests, tool completion, and text-free reasoning through real snapshots", () => {
  directory = mkdtempSync(join(tmpdir(), "bigagent-status-"));
  vi.stubEnv("CODEX_HOME", directory);
  const rollout = join(directory, "rollout.jsonl");
  const db = new DatabaseSync(join(directory, "state_5.sqlite"));
  db.exec(`CREATE TABLE threads (id TEXT, rollout_path TEXT, updated_at_ms INTEGER, title TEXT, cwd TEXT, model_provider TEXT, model TEXT, reasoning_effort TEXT, agent_nickname TEXT, agent_role TEXT, archived INTEGER);
    CREATE TABLE thread_spawn_edges (child_thread_id TEXT, parent_thread_id TEXT);`);
  db.prepare("INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("thread", rollout, Date.now(), "Status fixture", "/tmp/project", "test", "model", "medium", "Agent", "", 0);
  db.close();
  const write = (type: string, payload: unknown) => appendFileSync(rollout, JSON.stringify({type, timestamp: new Date().toISOString(), payload}) + "\n");
  const current = () => codexDesktopSessions().at(-1);
  write("event_msg", { type: "task_started", turn_id: "turn" });
  write("response_item", { type: "custom_tool_call", call_id: "cmd", name: "exec", input: 'await tools.exec_command({"cmd":"pnpm test"})' });
  expect(current()).toMatchObject({ status: "testing", label: "RUNNING TESTS" });
  write("response_item", { type: "custom_tool_call_output", call_id: "cmd", output: "passed" });
  expect(current()).toMatchObject({ status: "working" });
  write("response_item", { type: "reasoning", encrypted_content: "must-not-appear" });
  expect(current()).toMatchObject({ status: "thinking", label: "THINKING", detail: "Planning the next step" });
  expect(JSON.stringify(codexDesktopSessions())).not.toContain("must-not-appear");
  write("event_msg", { type: "item_started", turn_id: "turn", item: { type: "CommandExecution", command: "cat test.test.ts", status: "inProgress" } });
  expect(current()).toMatchObject({ status: "command", label: "RUNNING" });
  write("event_msg", { type: "item_completed", turn_id: "turn", item: { type: "CommandExecution", command: "cat test.test.ts" } });
  expect(current()).toMatchObject({ status: "working" });
  write("event_msg", { type: "item_started", turn_id: "turn", item: { type: "Reasoning", summary: [] } });
  expect(current()).toMatchObject({ status: "thinking" });
});
