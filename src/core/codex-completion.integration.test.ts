import { afterEach, expect, it, vi } from "vitest";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Vite 5 predates node:sqlite; load the native module through Node.
vi.mock("node:sqlite", async () => {
  const { createRequire } = await import("node:module");
  return createRequire(import.meta.url)("node:sqlite");
});
import { DatabaseSync } from "node:sqlite";
import { codexDesktopSessions } from "../../electron/codex-sessions";
import { applySessionEvent, replaceSessionSource } from "./workstreams";
import type { AgentEvent } from "./protocol";

let directory = "";
afterEach(() => { vi.unstubAllEnvs(); if (directory) rmSync(directory, { recursive: true, force: true }); });

it.each(["task_complete", "turn_aborted"])("accepts persisted %s after live transport takes ownership of a child", terminal => {
  directory = mkdtempSync(join(tmpdir(), "bigagent-child-completion-"));
  vi.stubEnv("CODEX_HOME", directory);
  const rollout = join(directory, "rollout.jsonl");
  const db = new DatabaseSync(join(directory, "state_5.sqlite"));
  try {
    db.exec(`CREATE TABLE threads (id TEXT, rollout_path TEXT, updated_at_ms INTEGER, title TEXT, cwd TEXT, model_provider TEXT, model TEXT, reasoning_effort TEXT, agent_nickname TEXT, agent_role TEXT, archived INTEGER);
      CREATE TABLE thread_spawn_edges (child_thread_id TEXT, parent_thread_id TEXT);`);
    db.prepare("INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("child", rollout, Date.now(), "Verify", "/tmp/project", "test", "model", "medium", "Sagan", "", 0);
    db.prepare("INSERT INTO thread_spawn_edges VALUES (?, ?)").run("child", "root");
  } finally { db.close(); }
  const write = (payload: unknown) => appendFileSync(rollout, JSON.stringify({ type: "event_msg", timestamp: new Date().toISOString(), payload }) + "\n");
  write({ type: "task_started", turn_id: "turn" });
  write({ type: "item_started", turn_id: "turn", item: { type: "Reasoning", summary: [] } });
  const observed = codexDesktopSessions().at(-1) as unknown as AgentEvent;
  let sessions = applySessionEvent({}, observed, Date.now(), "codex-desktop-fallback");
  sessions = applySessionEvent(sessions, { ...observed, id: "live-reasoning" }, Date.now(), "codex-app-server");
  write({ type: terminal, turn_id: "turn" });
  sessions = replaceSessionSource(sessions, "codex-desktop-fallback", codexDesktopSessions() as unknown as AgentEvent[]);
  expect(sessions.child).toMatchObject({ parentSessionId: "root", state: { status: terminal === "task_complete" ? "complete" : "stopped" } });
});
