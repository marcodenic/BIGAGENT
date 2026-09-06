import { afterEach, expect, it, vi } from "vitest";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
vi.mock("node:sqlite", async () => {
  const { createRequire } = await import("node:module");
  return createRequire(import.meta.url)("node:sqlite");
});
import { DatabaseSync } from "node:sqlite";
import { codexDesktopSessions, codexSourceSignature } from "./codex-sessions";
let directory = "";
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  vi.unstubAllEnvs();
  if (directory) rmSync(directory, { recursive: true, force: true });
});
function fixture() {
  directory = mkdtempSync(join(tmpdir(), "bigagent-monitor-"));
  vi.stubEnv("CODEX_HOME", directory);
  const state = new DatabaseSync(join(directory, "state_5.sqlite"));
  const logs = new DatabaseSync(join(directory, "logs_2.sqlite"));
  databases.push(state, logs);
  state.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE threads (id TEXT, rollout_path TEXT, updated_at_ms INTEGER, title TEXT, cwd TEXT, model_provider TEXT, model TEXT, reasoning_effort TEXT, agent_nickname TEXT, agent_role TEXT, archived INTEGER);
    CREATE TABLE thread_spawn_edges (child_thread_id TEXT, parent_thread_id TEXT);`);
  logs.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE logs (thread_id TEXT, ts INTEGER, ts_nanos INTEGER, target TEXT, feedback_log_body TEXT);`);
  const timestamp = new Date(Date.now() - 10_000).toISOString();
  const record = (payload: unknown) => JSON.stringify({ type: "event_msg", timestamp, payload }) + "\n";
  const add = (id: string) => {
    const path = join(directory, `${id}.jsonl`);
    state.prepare("INSERT INTO threads (id, rollout_path, updated_at_ms, title, cwd, model_provider, model, reasoning_effort, agent_nickname, agent_role, archived) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, path, Date.now(), id, `/project/${id}`, "test", "model", "medium", "Agent", "", 0);
    writeFileSync(path, record({ type: "task_started", turn_id: id }));
    return path;
  };
  const log = (thread: string, body: string | null, target = "codex_core::session::turn") => logs.prepare("INSERT INTO logs VALUES (?, ?, ?, ?, ?)").run(thread, Date.now() / 1000, 0, target, body);
  return { state, logs, add, log, record };
}
it("excludes internal approval reviewers before the recent-session limit while keeping delegated agents", () => {
  const { add, state, record } = fixture();
  add("parent");
  add("child");
  state.exec("ALTER TABLE threads ADD COLUMN agent_path TEXT");
  state.prepare("UPDATE threads SET agent_path = ?, agent_nickname = ?, agent_role = ? WHERE id = ?").run("/root/architecture_walk", "Archimedes", "explorer", "child");
  state.prepare("INSERT INTO thread_spawn_edges VALUES (?, ?)").run("child", "parent");
  state.prepare("UPDATE threads SET model = NULL WHERE id = ?").run("child");
  for (let index = 0; index < 25; index += 1) {
    const id = `review-${index}`;
    const path = add(id);
    state.prepare("UPDATE threads SET model = ?, updated_at_ms = ? WHERE id = ?").run("codex-auto-review", Date.now() + index + 1, id);
    if (index % 2 === 0) appendFileSync(path, record({ type: "task_complete", turn_id: id }));
  }
  const events = codexDesktopSessions();
  expect(events.map(event => (event.meta as any).threadId).sort()).toEqual(["child", "parent"]);
  expect(events.every(event => (event.meta as any).workstreamId === "parent")).toBe(true);
  expect(events.find(event => (event.meta as any).threadId === "child")?.meta).toMatchObject({ parentSessionId: "parent", sessionTitle: "parent", agentName: "Archimedes", agentRole: "explorer", agentPath: "/root/architecture_walk", agentTaskTitle: "child" });
});

it("reports user interruption as stopped with its original terminal time", () => {
  const { add, record } = fixture();
  const path = add("stopped");
  appendFileSync(path, record({ type: "task_interrupted", turn_id: "stopped" }));
  const event = codexDesktopSessions().find(event => (event.meta as any).threadId === "stopped")!;
  expect(event).toMatchObject({ status: "stopped", kind: "turn.end", label: "STOPPED", phase: "idle" });
  expect((event.meta as any).completedAtMs).toBeLessThan(Date.now());
});

it("reuses unchanged sessions but refreshes changed files and metadata", () => {
  const { add, state, record } = fixture();
  const firstPath = add("a1");
  const secondPath = add("b2");
  const first = codexDesktopSessions().find(event => (event.meta as any).threadId === "a1")!;
  expect(codexDesktopSessions().find(event => (event.meta as any).threadId === "a1")).toBe(first);
  appendFileSync(secondPath, record({ type: "task_complete", turn_id: "b2" }));
  const changed = codexDesktopSessions();
  expect(changed.find(event => (event.meta as any).threadId === "a1")).toBe(first);
  expect(changed.find(event => (event.meta as any).threadId === "b2")?.status).toBe("complete");
  state.prepare("UPDATE threads SET cwd = ? WHERE id = ?").run("/project/renamed", "a1");
  expect((codexDesktopSessions().find(event => (event.meta as any).threadId === "a1")?.meta as any).workstreamName).toBe("renamed");
  const signature = codexSourceSignature();
  writeFileSync(firstPath, record({ type: "task_started", turn_id: "c3" }));
  expect(codexSourceSignature()).not.toBe(signature);
  expect((codexDesktopSessions().find(event => (event.meta as any).threadId === "a1")?.meta as any).turnId).toBe("c3");
  state.prepare("UPDATE threads SET archived = 1 WHERE id = ?").run("a1");
  expect(codexDesktopSessions().some(event => (event.meta as any).threadId === "a1")).toBe(false);
});
it("reads appended lifecycle evidence and survives a log reset and checkpoint", () => {
  const { add, logs, log } = fixture();
  add("a1"); add("b2");
  expect(codexDesktopSessions().every(event => event.status !== "complete")).toBe(true);
  log("a1", null);
  expect(codexDesktopSessions().every(event => event.status !== "complete")).toBe(true);
  log("a1", "post sampling token usage turn_id=a1 needs_follow_up=false");
  expect(codexDesktopSessions().find(event => (event.meta as any).threadId === "a1")?.status).toBe("complete");
  log("b2", "Agent loop exited", "codex_core::session::handlers");
  expect(codexDesktopSessions().find(event => (event.meta as any).threadId === "b2")?.status).toBe("complete");
  logs.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  expect(codexDesktopSessions().every(event => event.status === "complete")).toBe(true);
  logs.exec("DELETE FROM logs");
  log("a1", "post sampling token usage turn_id=a1 needs_follow_up=false");
  const reset = codexDesktopSessions();
  expect(reset.find(event => (event.meta as any).threadId === "a1")?.status).toBe("complete");
  expect(reset.find(event => (event.meta as any).threadId === "b2")?.status).not.toBe("complete");
});


it("publishes worker snapshots only when content changes and detects completion", async () => {
  const { add, log } = fixture();
  add("a1");
  const { build } = await import("esbuild");
  const { Worker } = await import("node:worker_threads");
  const workerPath = join(directory, "monitor.cjs");
  await build({ entryPoints: ["electron/codex-monitor-worker.ts"], outfile: workerPath, bundle: true, platform: "node", format: "cjs" });
  const worker = new Worker(workerPath, { env: { ...process.env, CODEX_HOME: directory } });
  const messages: any[] = [];
  worker.on("message", message => messages.push(message));
  try {
    await vi.waitFor(() => expect(messages.some(message => message.type === "snapshot")).toBe(true));
    expect(messages[0].events[0].status).not.toBe("complete");
    worker.postMessage("refresh");
    await new Promise(resolve => setTimeout(resolve, 350));
    expect(messages).toHaveLength(1);
    log("a1", "post sampling token usage turn_id=a1 needs_follow_up=false");
    await vi.waitFor(() => expect(messages.some(message => message.events?.some((event: any) => event.status === "complete"))).toBe(true));
    expect(messages.every(message => message.type !== "error")).toBe(true);
  } finally { await worker.terminate(); }
});
