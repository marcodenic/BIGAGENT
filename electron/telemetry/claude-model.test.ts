import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { enrichClaudeModel } from "./claude-model";
import { TelemetryHub } from "./hub";

let root: string;
let path: string;
const record = (model: string, sessionId = "session") => JSON.stringify({ type: "assistant", sessionId, message: { model, content: "private message" } });
const hook = () => ({ session_id: "session", transcript_path: path, hook_event_name: "PreToolUse", tool_name: "Bash" });
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "claude-model-"));
  await mkdir(join(root, "projects", "project"), { recursive: true });
  path = join(root, "projects", "project", "session.jsonl");
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it("recovers the latest model without session-start and preserves activity", async () => {
  await writeFile(path, [record("claude-sonnet-4-6"), record("claude-opus-4-6"), record("<synthetic>"), record("wrong", "another"), '{"partial":'].join("\n"));
  const enriched = await enrichClaudeModel(hook(), root);
  expect(enriched).toEqual({ ...hook(), model: "claude-opus-4-6" });
  const hub = new TelemetryHub();
  const [event] = hub.ingest({ source: "claude-hooks", product: "claude", transport: "lifecycle-hooks", format: "hook", payload: enriched });
  expect(event.meta?.model).toBe("claude-opus-4-6");
  expect(event.status).toBe("command");
  expect(JSON.stringify(event)).not.toContain("private message");
  await writeFile(path, record("claude-sonnet-4-6"));
  expect(await enrichClaudeModel(hook(), root)).toMatchObject({ model: "claude-sonnet-4-6" });
});

it("prefers an explicitly reported model", async () => {
  await writeFile(path, record("old-model"));
  const input = { ...hook(), model: "new-model" };
  expect(await enrichClaudeModel(input, root)).toBe(input);
});

it("tolerates missing files and bounded tails with partial records", async () => {
  expect(await enrichClaudeModel(hook(), root)).toEqual(hook());
  await writeFile(path, 'x'.repeat(300_000) + '\n' + record("claude-opus-4-6") + '\n');
  expect(await enrichClaudeModel(hook(), root)).toMatchObject({ model: "claude-opus-4-6" });
});

it("rejects paths outside Claude projects, including symlinks", async () => {
  const outside = join(root, "session.jsonl");
  await writeFile(outside, record("secret"));
  const input = { ...hook(), transcript_path: outside };
  expect(await enrichClaudeModel(input, root)).toEqual(input);
  if (process.platform === "win32") return; // File symlinks require elevated privileges on Windows.
  await symlink(outside, path);
  expect(await enrichClaudeModel(hook(), root)).toEqual(hook());
});

it("does not assign another session's model and handles batches", async () => {
  await writeFile(path, record("wrong", "another"));
  expect(await enrichClaudeModel([hook(), null], root)).toEqual([hook(), null]);
});

it("recovers a completed subagent's own model instead of the parent's", async () => {
  await writeFile(path, record("parent-model"));
  const childDir = join(root, "projects", "project", "session", "subagents");
  await mkdir(childDir, { recursive: true });
  const childPath = join(childDir, "agent-child.jsonl");
  await writeFile(childPath, record("child-model"));
  const input = { ...hook(), hook_event_name: "SubagentStop", agent_id: "child", agent_transcript_path: childPath };
  const enriched = await enrichClaudeModel(input, root);
  expect(enriched).toMatchObject({ model: "child-model" });
  const [event] = new TelemetryHub().ingest({ source: "claude-hooks", product: "claude", transport: "lifecycle-hooks", format: "hook", payload: enriched });
  expect(event.meta).toMatchObject({ sessionId: "child", parentSessionId: "session", model: "child-model" });
  expect(event.status).toBe("complete");
  const { agent_transcript_path: _, ...withoutPath } = input;
  expect(await enrichClaudeModel(withoutPath, root)).toMatchObject({ model: "child-model" });
});

it("never borrows a parent model when the subagent transcript is missing", async () => {
  await writeFile(path, record("parent-model"));
  const input = { ...hook(), hook_event_name: "SubagentStart", agent_id: "child" };
  expect(await enrichClaudeModel(input, root)).toEqual(input);
});

it("recovers explicitly recorded effort alongside the subagent model", async () => {
  const childDir = join(root, "projects", "project", "session", "subagents");
  await mkdir(childDir, { recursive: true });
  await writeFile(join(childDir, "agent-child.jsonl"), JSON.stringify({ type: "assistant", sessionId: "session", agentId: "child", message: { model: "claude-opus-4-6", output_config: { effort: "high" } } }));
  const enriched = await enrichClaudeModel({ ...hook(), hook_event_name: "SubagentStop", agent_id: "child" }, root);
  expect(enriched).toMatchObject({ model: "claude-opus-4-6", reasoning_effort: "high" });
});
