import { commandActivity } from "./command-activity";
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { StringDecoder } from "node:string_decoder";
import { normalizeCodexRolloutItem, normalizeCodexToolCall, reconcileCodexTurnLifecycle, reconcileCompletedRolloutItem, splitCompleteJsonLines } from "./codex-rollout";

type JsonObject = Record<string, unknown>;
type ThreadDisplayMeta = {
  workstreamId: string;
  workstreamName: string;
  taskName: string;
  agentName: string;
  modelProvider: string;
  model: string;
  reasoningEffort: string;
};

type ItemRow = { item_type: string; item_json: string; updated_at_ordinal: number };

type LiveRolloutItem = ItemRow & { timestamp: number; callId?: string; transient?: boolean };
type LiveRolloutState = {
  offset: number;
  decoder: StringDecoder;
  discardInitialLine: boolean;
  remainder: string;
  turnId: string;
  status: string;
  startedAt: number;
  completedAt: number | null;
  nextOrdinal: number;
  items: LiveRolloutItem[];
};

type StateThreadRow = {
  id: string;
  rollout_path: string;
  updated_at_ms: number;
  title: string;
  cwd: string;
  model_provider: string;
  model: string | null;
  reasoning_effort: string | null;
  agent_nickname: string | null;
  agent_role: string | null;
};

type AgentLoopExitRow = { thread_id: string; exited_at: number };
type CompletedTurnRow = { thread_id: string; ts: number; feedback_log_body: string };

const liveRollouts = new Map<string, LiveRolloutState>();
const INITIAL_ROLLOUT_TAIL_BYTES = 8 * 1024 * 1024;
const MAX_LIVE_ITEMS = 80;

function queryOne<T>(database: DatabaseSync, sql: string, ...params: SQLInputValue[]) {
  return database.prepare(sql).get(...params) as T | undefined;
}

function queryAll<T>(database: DatabaseSync, sql: string, ...params: SQLInputValue[]) {
  return database.prepare(sql).all(...params) as T[];
}

function text(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function object(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function planSteps(value: unknown) {
  if (!Array.isArray(value)) return undefined;
  const steps = value.map((entry) => {
    if (typeof entry === "string") return entry.trim();
    const item = object(entry);
    return text(item.content, text(item.step, text(item.title, text(item.description, text(item.text, text(item.label)))))).trim();
  }).filter(Boolean);
  return steps.length ? [...new Set(steps)].slice(0, 6) : undefined;
}

function parseJson(value: string): JsonObject {
  try {
    return object(JSON.parse(value));
  } catch {
    return {};
  }
}

function timestampSeconds(value: unknown, fallback = Date.now() / 1_000) {
  if (typeof value === "number" && Number.isFinite(value)) return value > 10_000_000_000 ? value / 1_000 : value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed / 1_000;
  }
  return fallback;
}

function emptyLiveRollout(offset = 0): LiveRolloutState {
  return {
    offset,
    decoder: new StringDecoder("utf8"),
    discardInitialLine: offset > 0,
    remainder: "",
    turnId: "",
    status: "inProgress",
    startedAt: Date.now() / 1_000,
    completedAt: null,
    nextOrdinal: offset,
    items: [],
  };
}

function pushLiveItem(
  state: LiveRolloutState,
  normalized: ReturnType<typeof normalizeCodexRolloutItem>,
  timestamp: number,
  callId?: string,
  transient = false,
) {
  if (!normalized.itemType) return;
  state.items.push({
    item_type: normalized.itemType,
    item_json: JSON.stringify(normalized.item),
    updated_at_ordinal: state.nextOrdinal,
    timestamp,
    callId,
    transient,
  });
  state.nextOrdinal += 1;
  if (state.items.length > MAX_LIVE_ITEMS) state.items.splice(0, state.items.length - MAX_LIVE_ITEMS);
}

function completeLiveCall(state: LiveRolloutState, callId: string, timestamp: number) {
  const active = state.items.find((item) => item.callId === callId && item.transient);
  if (!active) return;
  const item = parseJson(active.item_json);
  item.status = "completed";
  active.item_json = JSON.stringify(item);
  active.timestamp = timestamp;
  active.transient = false;
}

function updateLiveRollout(path: string) {
  let metadata;
  try {
    metadata = statSync(path);
  } catch {
    liveRollouts.delete(path);
    return null;
  }

  let state = liveRollouts.get(path);
  if (!state || metadata.size < state.offset) {
    const start = Math.max(0, metadata.size - INITIAL_ROLLOUT_TAIL_BYTES);
    state = emptyLiveRollout(start);
    liveRollouts.set(path, state);
  }
  if (metadata.size === state.offset) return state;

  const descriptor = openSync(path, "r");
  let chunk = "";
  try {
    const length = metadata.size - state.offset;
    const buffer = Buffer.alloc(length);
    const count = readSync(descriptor, buffer, 0, length, state.offset);
    chunk = state.decoder.write(buffer.subarray(0, count));
    state.offset += count;
  } finally {
    closeSync(descriptor);
  }

  let source = state.remainder + chunk;
  if (state.discardInitialLine) {
    const firstBreak = source.indexOf("\n");
    if (firstBreak < 0) {
      state.remainder = "";
      return state;
    }
    source = source.slice(firstBreak + 1);
    state.discardInitialLine = false;
  }
  const framed = splitCompleteJsonLines(source);
  const lines = framed.lines;
  state.remainder = framed.remainder;

  for (const line of lines) {
    const entry = parseJson(line);
    const payload = object(entry.payload);
    const timestamp = timestampSeconds(entry.timestamp);
    if (entry.type === "response_item") {
      const responseType = text(payload.type);
      const callId = text(payload.call_id, text(payload.callId));
      if (responseType === "custom_tool_call" && callId) {
        state.items = state.items.filter((item) => item.callId !== callId);
        const normalized = normalizeCodexToolCall(payload);
        pushLiveItem(state, normalized, timestamp, callId, text(normalized.item.status) !== "completed");
      } else if (responseType === "custom_tool_call_output" && callId) {
        completeLiveCall(state, callId, timestamp);
      } else if (responseType === "reasoning") {
        // Activity does not depend on access to reasoning text. Do not read
        // private/encrypted content from response items.
        pushLiveItem(state, { itemType: "reasoning", item: { summary: [] } }, timestamp);
      }
      continue;
    }
    if (entry.type !== "event_msg") continue;
    const eventType = text(payload.type);
    const turnId = text(payload.turn_id, text(payload.turnId));
    if (eventType === "task_started" && turnId) {
      state.turnId = turnId;
      state.status = "inProgress";
      state.startedAt = timestampSeconds(payload.started_at, timestamp);
      state.completedAt = null;
      state.items = [];
      continue;
    }
    if (eventType === "task_complete" && turnId && turnId === state.turnId) {
      state.status = "completed";
      state.completedAt = timestampSeconds(payload.completed_at, timestamp);
      continue;
    }
    if (/task_(?:aborted|interrupted)|turn_(?:aborted|interrupted)/.test(eventType) && turnId === state.turnId) {
      state.status = "interrupted";
      state.completedAt = timestamp;
      continue;
    }
    if (!["item_started", "item_completed"].includes(eventType) || !turnId) continue;
    if (turnId !== state.turnId) {
      state.turnId = turnId;
      state.status = "inProgress";
      state.startedAt = timestamp;
      state.completedAt = null;
      state.items = [];
    }
    const normalized = normalizeCodexRolloutItem(payload.item);
    if (eventType === "item_started") pushLiveItem(state, normalized, timestamp, undefined, true);
    else {
      if (["commandExecution", "fileChange", "dynamicToolCall", "mcpToolCall"].includes(normalized.itemType) && !normalized.item.status) normalized.item.status = "completed";
      if (!reconcileCompletedRolloutItem(state.items, normalized, timestamp)) pushLiveItem(state, normalized, timestamp);
    }
  }
  return state;
}

function codexHome() {
  return process.env.CODEX_HOME || join(homedir(), ".codex");
}

function logsDatabasePath() {
  return join(codexHome(), "logs_2.sqlite");
}

function agentLoopExitTimes() {
  const database = tryOpenReadOnly(logsDatabasePath());
  if (!database) return new Map<string, number>();
  try {
    const rows = queryAll<AgentLoopExitRow>(database, `
      SELECT thread_id, MAX(ts + (ts_nanos / 1000000000.0)) AS exited_at
      FROM logs
      WHERE thread_id IS NOT NULL
        AND target = 'codex_core::session::handlers'
        AND feedback_log_body LIKE '%Agent loop exited'
      GROUP BY thread_id
    `);
    return new Map(rows.map((row) => [row.thread_id, row.exited_at]));
  } finally {
    database.close();
  }
}

function completedTurnTimes() {
  const database = tryOpenReadOnly(logsDatabasePath());
  if (!database) return new Map<string, number>();
  try {
    const rows = queryAll<CompletedTurnRow>(database, `
      SELECT thread_id, ts, feedback_log_body
      FROM logs
      WHERE thread_id IS NOT NULL
        AND target = 'codex_core::session::turn'
        AND feedback_log_body LIKE '%post sampling token usage%'
        AND feedback_log_body LIKE '%needs_follow_up=false%'
      ORDER BY ts DESC
      LIMIT 1000
    `);
    const completed = new Map<string, number>();
    for (const row of rows) {
      const turnId = row.feedback_log_body.match(/\bturn_id=([0-9a-f-]+)/)?.[1];
      if (!turnId) continue;
      const key = `${row.thread_id}:${turnId}`;
      if (!completed.has(key)) completed.set(key, row.ts);
    }
    return completed;
  } finally {
    database.close();
  }
}

function stateDatabasePath() {
  return join(codexHome(), "state_5.sqlite");
}

export function codexSessionStoreAvailable() {
  return existsSync(stateDatabasePath());
}

function openReadOnly(path: string) {
  return new DatabaseSync(path, { readOnly: true });
}

function tryOpenReadOnly(path: string) {
  try {
    return openReadOnly(path);
  } catch {
    return null;
  }
}

function sourceStamp(path: string) {
  try {
    const metadata = statSync(path, { bigint: true });
    return `${metadata.size}:${metadata.mtimeNs}`;
  } catch {
    return "0:0";
  }
}

export function codexSourceSignature() {
  const state = stateDatabasePath();
  const logs = logsDatabasePath();
  const rolloutPaths = recentRolloutThreads().map((thread) => thread.rollout_path);
  return [state, `${state}-wal`, logs, `${logs}-wal`, join(codexHome(), "session_index.jsonl"), ...rolloutPaths]
    .map(sourceStamp)
    .join("|");
}

function recentRolloutThreads() {
  const database = tryOpenReadOnly(stateDatabasePath());
  if (!database) return [];
  try {
    return queryAll<StateThreadRow>(database, `
      SELECT id, rollout_path, updated_at_ms, title, cwd, model_provider, model,
        reasoning_effort, agent_nickname, agent_role
      FROM threads
      WHERE archived = 0 AND rollout_path IS NOT NULL AND rollout_path != ''
      ORDER BY updated_at_ms DESC
      LIMIT 24
    `);
  } catch {
    return [];
  } finally {
    database.close();
  }
}

function threadNames() {
  const names = new Map<string, string>();
  try {
    for (const line of readFileSync(join(codexHome(), "session_index.jsonl"), "utf8").split("\n")) {
      if (!line) continue;
      const value = parseJson(line);
      const id = text(value.id);
      const name = text(value.thread_name);
      if (id && name) names.set(id, name);
    }
  } catch {
    // Codex may not have written its optional session index yet.
  }
  return names;
}

function compactToolName(command: string) {
  return (command.trim().split(/\s+/, 1)[0] || "tool").split("/").pop() || "tool";
}

function threadDisplayMeta(
  stateDatabase: DatabaseSync,
  names: Map<string, string>,
  thread: StateThreadRow,
): ThreadDisplayMeta {
  let workstreamId = thread.id;
  for (let depth = 0; depth < 12; depth += 1) {
    const edge = queryOne<{ parent_thread_id: string }>(
      stateDatabase,
      "SELECT parent_thread_id FROM thread_spawn_edges WHERE child_thread_id = ?",
      workstreamId,
    );
    if (!edge?.parent_thread_id) break;
    workstreamId = edge.parent_thread_id;
  }

  const root = workstreamId === thread.id ? thread : queryOne<{
    title: string;
    cwd: string;
    model_provider: string;
    model: string | null;
    reasoning_effort: string | null;
  }>(stateDatabase, "SELECT title, cwd, model_provider, model, reasoning_effort FROM threads WHERE id = ?", workstreamId);

  const taskName = root?.title || names.get(workstreamId) || `Codex ${workstreamId.slice(0, 8)}`;
  const workstreamName = basename(root?.cwd || thread.cwd || "") || taskName;
  return {
    workstreamId,
    workstreamName,
    taskName,
    agentName: thread.agent_nickname || thread.agent_role || "Codex agent",
    modelProvider: thread.model_provider || root?.model_provider || "unknown",
    model: thread.model || root?.model || "unknown model",
    reasoningEffort: thread.reasoning_effort || root?.reasoning_effort || "",
  };
}

function liveRecordHasContent(record: LiveRolloutItem) {
  const item = parseJson(record.item_json);
  // BIG AGENT must never represent its own Electron dev/preview launcher as
  // an observed coding agent. Those commands intentionally stay alive and
  // otherwise become a permanent false workstream.
  const command = text(item.command);
  const cwd = text(item.cwd).replace(/\/$/, "");
  if (record.item_type === "commandExecution"
    && cwd.endsWith("/BIGAGENT")
    && /\bpnpm\s+(?:dev|start|preview)\b|electron-vite|node_modules\/electron|electron\/dist\/electron/.test(command)) {
    return false;
  }
  if (record.item_type === "reasoning") return true;
  if (record.item_type === "agentMessage") return Boolean(text(item.text).trim());
  if (record.item_type === "userMessage" || record.item_type === "contextCompaction") return false;
  return true;
}

function selectedLiveRecords(state: LiveRolloutState) {
  const useful = state.items.filter(liveRecordHasContent);
  const selected = useful.slice(-5);
  for (const type of ["agentMessage", "reasoning", "imageView"]) {
    const record = [...useful].reverse().find((candidate) => candidate.item_type === type);
    if (record && !selected.includes(record)) selected.push(record);
  }
  const plan = [...useful].reverse().find((candidate) => /plan|todo/i.test(candidate.item_type));
  if (plan && !selected.includes(plan)) selected.push(plan);
  return selected.sort((left, right) => left.updated_at_ordinal - right.updated_at_ordinal);
}

function liveFallbackDetail(state: LiveRolloutState) {
  for (const record of [...state.items].reverse()) {
    const item = parseJson(record.item_json);
    if (record.item_type === "agentMessage" && text(item.text)) return text(item.text);
    if (record.item_type === "commandExecution" && text(item.command)) return text(item.command);
    if (record.item_type === "fileChange") {
      const first = Array.isArray(item.changes) ? object(item.changes[0]) : {};
      if (text(first.path)) return `Updated ${text(first.path)}`;
    }
    if (record.item_type === "mcpToolCall" || record.item_type === "dynamicToolCall") {
      const tool = text(item.tool);
      if (tool) return `Used ${(tool.split("__").pop() || tool).replaceAll("_", " ")}`;
    }
  }
  return undefined;
}

function liveLastMessage(state: LiveRolloutState) {
  const record = [...state.items].reverse().find((candidate) => candidate.item_type === "agentMessage");
  return record ? text(parseJson(record.item_json).text) || undefined : undefined;
}

function recordEvent(
  thread: string,
  turn: string,
  turnStatus: string,
  itemType: string,
  itemJson: string,
  ordinal: number,
  display: ThreadDisplayMeta,
  startedAt: number,
  completedAt: number | null,
  fallbackDetail?: string,
  lastMessage?: string,
) {
  const item = parseJson(itemJson);
  let status = "thinking";
  let phase = "planning";
  let label = "THINKING";
  let detail = "Codex desktop task active";
  let files: string[] = [];
  let command: string | undefined;
  let tool: string | undefined;
  let target: string | undefined;
  let plan: string[] | undefined;

  if (/plan|todo/i.test(itemType)) {
    plan = planSteps(item.plan) ?? planSteps(item.steps) ?? planSteps(item.items);
    detail = plan?.[0] || "Updating the plan";
  } else if (itemType === "reasoning") {
    const summary = Array.isArray(item.summary) ? item.summary.map((value) => text(value)).find((value) => value.trim()) : "";
    detail = summary || "Planning the next step";
  } else if (itemType === "commandExecution") {
    const value = text(item.command, "Running command");
    const activity = commandActivity(value);
    const finished = ["completed", "failed", "declined"].includes(text(item.status));
    status = finished ? "working" : activity.status;
    phase = finished ? "receiving" : activity.phase;
    label = finished ? "RESULT RECEIVED" : activity.label;
    detail = value;
    command = value;
    tool = compactToolName(value);
  } else if (itemType === "fileChange") {
    status = "editing";
    phase = "editing";
    label = "EDITING";
    files = Array.isArray(item.changes) ? item.changes.map(object).map((change) => text(change.path)).filter(Boolean) : [];
    detail = files.length ? `Updating ${files.slice(0, 2).join(", ")}` : "Updating files";
    tool = "apply_patch";
    target = files[0];
  } else if (itemType === "webSearch") {
    status = "searching";
    phase = "searching";
    label = "SEARCHING";
    detail = text(item.query) ? `Searching for ${text(item.query)}` : "Searching the web";
    tool = "web";
  } else if (itemType === "mcpToolCall" || itemType === "dynamicToolCall") {
    const rawTool = text(item.tool, "tool");
    const namespace = text(item.namespace, text(item.server));
    const lower = rawTool.toLowerCase();
    const failed = item.status === "failed";
    tool = rawTool.split("__").pop() || rawTool;
    if (failed) {
      status = "working";
      phase = "retrying";
      label = "TOOL FAILED · RETRYING";
      detail = `${tool.replaceAll("_", " ")} failed; agent still running`;
    } else if (item.status === "completed") {
      status = "working";
      phase = "receiving";
      label = "RESULT RECEIVED";
      detail = `${tool.replaceAll("_", " ")} finished`;
    } else if (["spawn_agent", "create_agent", "delegate", "subagent"].some((word) => lower.includes(word))) {
      status = "working";
      phase = "delegating";
      label = "DELEGATING";
      detail = `Using ${tool.replaceAll("_", " ")}`;
    } else if (["apply_patch", "write", "edit"].some((word) => lower.includes(word))) {
      status = "editing";
      phase = "editing";
      label = "EDITING";
      detail = `Using ${tool.replaceAll("_", " ")}`;
    } else if (lower.includes("browser") || lower.includes("search") || namespace.includes("browser")) {
      status = "searching";
      phase = "searching";
      label = "SEARCHING";
      detail = `Using ${tool.replaceAll("_", " ")}`;
    } else if (lower.includes("imagegen") || lower.includes("image_gen")) {
      status = "working";
      phase = "executing";
      label = "GENERATING";
      detail = `Using ${tool.replaceAll("_", " ")}`;
    } else {
      status = "command";
      phase = "executing";
      label = "USING TOOL";
      detail = `Using ${tool.replaceAll("_", " ")}`;
    }
    const args = object(item.arguments);
    target = text(args.path, text(args.workdir, text(args.target))) || undefined;
  } else if (itemType === "imageGeneration") {
    status = "working";
    phase = "executing";
    label = "GENERATING";
    detail = "Creating a design image";
    tool = "imagegen";
  } else if (itemType === "imageView") {
    status = "searching";
    phase = "searching";
    label = "INSPECTING";
    target = text(item.path) || undefined;
    detail = target ? `Inspecting ${basename(target)}` : "Inspecting an image";
    tool = "view_image";
  } else if (itemType === "agentMessage") {
    status = "working";
    phase = "responding";
    label = "RESPONDING";
    detail = text(item.text, detail);
  } else if (itemType === "userMessage") {
    phase = "starting";
    detail = "New request received";
  }

  if (turnStatus === "completed") {
    status = "complete";
    phase = "completing";
    label = "DONE";
    if (detail === "Codex desktop task active") detail = "Codex task complete";
  } else if (turnStatus === "interrupted") {
    status = "error";
    phase = "failed";
    label = "STOPPED";
    detail = "Codex task was interrupted";
  }

  const summary = Array.isArray(item.summary) ? item.summary : [];
  const hasReasoningSummary = itemType === "reasoning" && summary.some((value) => text(value).trim());
  const activityClass = itemType === "agentMessage" || hasReasoningSummary
    ? "narrative"
    : itemType === "imageView" || itemType === "imageGeneration" ? "visual" : "telemetry";
  const kind = status === "complete" ? "complete" : status === "error" ? "error" : /plan|todo/i.test(itemType) ? "plan" : itemType === "reasoning" ? "reasoning.summary" : "activity";

  return {
    version: 1,
    id: `codex-session-${turn}-${ordinal}`,
    timestamp: "",
    kind,
    status,
    phase,
    label,
    detail,
    files,
    plan,
    command,
    tool,
    target,
    meta: {
      sessionId: thread,
      turnId: turn,
      threadId: thread,
      workstreamId: display.workstreamId,
      workstreamName: display.workstreamName,
      taskName: display.taskName,
      sessionName: display.agentName,
      agentName: display.agentName,
      modelProvider: display.modelProvider,
      model: display.model,
      reasoningEffort: display.reasoningEffort,
      activityClass,
      narrativeKind: hasReasoningSummary ? "reasoning" : itemType === "agentMessage" ? "message" : undefined,
      lastMessage,
      startedAtMs: startedAt * 1_000,
      completedAtMs: completedAt === null ? undefined : completedAt * 1_000,
    },
  };
}

export function codexDesktopSnapshot() {
  const active = [...codexDesktopSessions()].reverse()
    .find((event) => event.status !== "complete" && event.status !== "error");
  if (!active) throw new Error("No active Codex desktop task");
  return active;
}

export function codexDesktopSessions() {
  if (!existsSync(stateDatabasePath())) return [];
  const stateDatabase = openReadOnly(stateDatabasePath());
  try {
    const recentCutoffMs = Date.now() - 10 * 60_000;
    const loopExitTimes = agentLoopExitTimes();
    const turnCompletionTimes = completedTurnTimes();
    const names = threadNames();
    const rolloutThreads = queryAll<StateThreadRow>(stateDatabase, `
      SELECT id, rollout_path, updated_at_ms, title, cwd, model_provider, model,
        reasoning_effort, agent_nickname, agent_role
      FROM threads
      WHERE archived = 0 AND rollout_path IS NOT NULL AND rollout_path != ''
        AND updated_at_ms >= ?
      ORDER BY updated_at_ms DESC
      LIMIT 24
    `, recentCutoffMs);
    const events: JsonObject[] = [];
    for (const thread of rolloutThreads) {
      const live = updateLiveRollout(thread.rollout_path);
      if (!live?.turnId) continue;
      const lifecycle = reconcileCodexTurnLifecycle(
        live.status,
        live.startedAt,
        live.completedAt,
        Math.max(
          loopExitTimes.get(thread.id) ?? 0,
          turnCompletionTimes.get(`${thread.id}:${live.turnId}`) ?? 0,
        ) || undefined,
      );
      const display = threadDisplayMeta(stateDatabase, names, thread);
      const records = selectedLiveRecords(live);
      const fallbackDetail = liveFallbackDetail(live);
      const lastMessage = liveLastMessage(live);
      const liveEvents = records.length ? records.map((record, index) => recordEvent(
          thread.id,
          live.turnId,
          index === records.length - 1 ? lifecycle.status : "inProgress",
          record.item_type,
          record.item_json,
          record.updated_at_ordinal,
          display,
          live.startedAt,
          lifecycle.completedAt,
          fallbackDetail,
          lastMessage,
        )) : [recordEvent(
          thread.id,
          live.turnId,
          lifecycle.status,
          "",
          "{}",
          live.nextOrdinal,
          display,
          live.startedAt,
          lifecycle.completedAt,
          fallbackDetail,
          lastMessage,
        )];
      events.push(...liveEvents);
    }
    return events;
  } finally {
    stateDatabase.close();
  }
}
