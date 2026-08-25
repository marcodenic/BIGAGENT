import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

type JsonObject = Record<string, unknown>;
type RolloutContext = { parentThread: string; cwd: string; modelProvider: string };
type ThreadDisplayMeta = {
  workstreamId: string;
  workstreamName: string;
  taskName: string;
  agentName: string;
  modelProvider: string;
  model: string;
  reasoningEffort: string;
};

type TurnRow = {
  thread_id: string;
  turn_id: string;
  status: string;
  latest: number;
  started_at: number;
  completed_at: number | null;
};

type ItemRow = { item_type: string; item_json: string; updated_at_ordinal: number };

const rolloutContexts = new Map<string, RolloutContext | null>();

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

function codexHome() {
  return process.env.CODEX_HOME || join(homedir(), ".codex");
}

function historyDatabasePath() {
  return join(codexHome(), "thread_history_1.sqlite");
}

function stateDatabasePath() {
  return join(codexHome(), "state_5.sqlite");
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
  const history = historyDatabasePath();
  const state = stateDatabasePath();
  return [history, `${history}-wal`, state, `${state}-wal`, join(codexHome(), "session_index.jsonl")]
    .map(sourceStamp)
    .join("|");
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

function findRolloutFile(directory: string, thread: string): string | null {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      const found = findRolloutFile(path, thread);
      if (found) return found;
    } else if (extname(entry.name) === ".jsonl" && entry.name.includes(thread)) {
      return path;
    }
  }
  return null;
}

function readFirstLine(path: string) {
  const descriptor = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const count = readSync(descriptor, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, count).toString("utf8").split("\n", 1)[0] || "";
  } finally {
    closeSync(descriptor);
  }
}

function rolloutContext(thread: string) {
  if (rolloutContexts.has(thread)) return rolloutContexts.get(thread) ?? null;
  try {
    const path = findRolloutFile(join(codexHome(), "sessions"), thread);
    if (!path) throw new Error("rollout unavailable");
    const value = parseJson(readFirstLine(path));
    if (value.type !== "session_meta") throw new Error("rollout has no session metadata");
    const payload = object(value.payload);
    const context = {
      parentThread: text(payload.session_id, text(payload.id, thread)),
      cwd: text(payload.cwd),
      modelProvider: text(payload.model_provider, "unknown"),
    };
    rolloutContexts.set(thread, context);
    return context;
  } catch {
    rolloutContexts.set(thread, null);
    return null;
  }
}

function fallbackThreadName(database: DatabaseSync, thread: string) {
  const row = queryOne<{ item_json: string }>(
    database,
    "SELECT item_json FROM thread_items WHERE thread_id = ? AND item_type = 'userMessage' ORDER BY rollout_ordinal LIMIT 1",
    thread,
  );
  const item = row ? parseJson(row.item_json) : {};
  const content = Array.isArray(item.content) ? item.content : [];
  const firstText = content.map(object).map((part) => text(part.text)).find(Boolean);
  const fallback = `Codex ${thread.slice(0, 8)}`;
  const words = (firstText || fallback).split(/\s+/).filter((word) => !word.startsWith("/")).slice(0, 5);
  return words.length ? words.join(" ") : fallback;
}

function compactToolName(command: string) {
  return (command.trim().split(/\s+/, 1)[0] || "tool").split("/").pop() || "tool";
}

function threadDisplayMeta(
  stateDatabase: DatabaseSync | null,
  historyDatabase: DatabaseSync,
  names: Map<string, string>,
  thread: string,
): ThreadDisplayMeta {
  let workstreamId = thread;
  if (stateDatabase) {
    for (let depth = 0; depth < 12; depth += 1) {
      const edge = queryOne<{ parent_thread_id: string }>(
        stateDatabase,
        "SELECT parent_thread_id FROM thread_spawn_edges WHERE child_thread_id = ?",
        workstreamId,
      );
      if (!edge?.parent_thread_id) break;
      workstreamId = edge.parent_thread_id;
    }
  }

  const rollout = rolloutContext(thread);
  if (workstreamId === thread && rollout?.parentThread && rollout.parentThread !== thread) {
    workstreamId = rollout.parentThread;
  }

  const root = stateDatabase ? queryOne<{
    title: string;
    cwd: string;
    model_provider: string;
    model: string | null;
    reasoning_effort: string | null;
  }>(stateDatabase, "SELECT title, cwd, model_provider, model, reasoning_effort FROM threads WHERE id = ?", workstreamId) : undefined;
  const agent = stateDatabase ? queryOne<{
    agent_nickname: string | null;
    agent_role: string | null;
    model_provider: string;
    model: string | null;
    reasoning_effort: string | null;
  }>(stateDatabase, "SELECT agent_nickname, agent_role, model_provider, model, reasoning_effort FROM threads WHERE id = ?", thread) : undefined;

  const taskName = root?.title || names.get(workstreamId) || fallbackThreadName(historyDatabase, workstreamId);
  const workstreamName = basename(root?.cwd || rollout?.cwd || "") || taskName;
  return {
    workstreamId,
    workstreamName,
    taskName,
    agentName: agent?.agent_nickname || agent?.agent_role || "Codex agent",
    modelProvider: agent?.model_provider || root?.model_provider || rollout?.modelProvider || "unknown",
    model: agent?.model || root?.model || "unknown model",
    reasoningEffort: agent?.reasoning_effort || root?.reasoning_effort || "",
  };
}

function previousActivityDetail(database: DatabaseSync, thread: string, turn: string) {
  const row = queryOne<{ item_type: string; item_json: string }>(database,
    "SELECT item_type, item_json FROM thread_items WHERE thread_id = ? AND turn_id = ? AND item_type NOT IN ('reasoning', 'userMessage') ORDER BY updated_at_ordinal DESC LIMIT 1",
    thread, turn);
  if (!row) return undefined;
  const item = parseJson(row.item_json);
  if (row.item_type === "agentMessage") return text(item.text) || undefined;
  if (row.item_type === "commandExecution") return text(item.command) || undefined;
  if (row.item_type === "fileChange") {
    const first = Array.isArray(item.changes) ? object(item.changes[0]) : {};
    return text(first.path) ? `Updated ${text(first.path)}` : undefined;
  }
  if (row.item_type === "mcpToolCall" || row.item_type === "dynamicToolCall") {
    const tool = text(item.tool);
    return tool ? `Used ${(tool.split("__").pop() || tool).replaceAll("_", " ")}` : undefined;
  }
  if (row.item_type === "webSearch") return text(item.query) ? `Searched for ${text(item.query)}` : undefined;
  if (row.item_type === "imageGeneration") return "Created a design image";
  if (row.item_type === "imageView") return "Inspected an image";
  return undefined;
}

function lastAgentMessage(database: DatabaseSync, thread: string, turn: string) {
  const row = queryOne<{ item_json: string }>(database,
    "SELECT item_json FROM thread_items WHERE thread_id = ? AND turn_id = ? AND item_type = 'agentMessage' ORDER BY updated_at_ordinal DESC LIMIT 1",
    thread, turn);
  return row ? text(parseJson(row.item_json).text) || undefined : undefined;
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
    detail = summary || fallbackDetail || "Planning the next step";
  } else if (itemType === "commandExecution") {
    const value = text(item.command, "Running command");
    const testing = ["test", "vitest", "jest", "pytest", "cargo test", "go test"].some((word) => value.includes(word));
    const building = [" build", "compile", "pnpm build", "cargo build"].some((word) => value.includes(word));
    const finished = item.status === "completed";
    status = finished ? "working" : testing ? "testing" : "command";
    phase = finished ? "receiving" : testing ? "testing" : "executing";
    label = finished ? "RESULT RECEIVED" : testing ? "RUNNING TESTS" : building ? "BUILDING" : "RUNNING";
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
  const database = openReadOnly(historyDatabasePath());
  try {
    const active = queryOne<{ thread_id: string; turn_id: string }>(database,
      "SELECT t.thread_id, t.turn_id FROM thread_turns t WHERE t.status = 'inProgress' ORDER BY COALESCE((SELECT MAX(i.created_at_ms) FROM thread_items i WHERE i.thread_id = t.thread_id AND i.turn_id = t.turn_id), t.started_at * 1000) DESC LIMIT 1");
    if (!active) throw new Error("No active Codex desktop task");
    return {
      version: 1,
      id: `codex-desktop-snapshot-${active.turn_id}-${Date.now()}`,
      timestamp: "",
      kind: "turn.start",
      status: "thinking",
      label: "THINKING",
      detail: "Following active Codex desktop task",
    };
  } finally {
    database.close();
  }
}

export function codexDesktopSessions() {
  if (!existsSync(historyDatabasePath())) return [];
  const historyDatabase = openReadOnly(historyDatabasePath());
  const stateDatabase = tryOpenReadOnly(stateDatabasePath());
  try {
    const names = threadNames();
    const turns = queryAll<TurnRow>(historyDatabase, `
      WITH eligible AS (
        SELECT t.*, ROW_NUMBER() OVER (
          PARTITION BY t.thread_id
          ORDER BY COALESCE(t.started_at, 0) DESC, t.rollout_ordinal DESC
        ) AS recency_rank
        FROM thread_turns t
        WHERE t.status IN ('inProgress', 'completed', 'interrupted')
      )
      SELECT t.thread_id, t.turn_id, t.status,
        COALESCE(MAX(i.updated_at_ordinal), 0) AS latest,
        COALESCE(t.started_at, unixepoch()) AS started_at,
        t.completed_at
      FROM eligible t
      LEFT JOIN thread_items i ON i.thread_id = t.thread_id AND i.turn_id = t.turn_id
      WHERE t.recency_rank = 1
      GROUP BY t.thread_id, t.turn_id
      ORDER BY COALESCE(MAX(i.created_at_ms), t.started_at * 1000) DESC
      LIMIT 24
    `);
    const events: JsonObject[] = [];
    for (const turn of turns) {
      const display = threadDisplayMeta(stateDatabase, historyDatabase, names, turn.thread_id);
      const fallbackDetail = previousActivityDetail(historyDatabase, turn.thread_id, turn.turn_id);
      const lastMessage = lastAgentMessage(historyDatabase, turn.thread_id, turn.turn_id);
      const records = queryAll<ItemRow>(historyDatabase,
        "SELECT item_type, item_json, updated_at_ordinal FROM thread_items WHERE thread_id = ? AND turn_id = ? ORDER BY updated_at_ordinal DESC LIMIT 5",
        turn.thread_id, turn.turn_id);
      const latestImage = queryOne<ItemRow>(historyDatabase,
        "SELECT item_type, item_json, updated_at_ordinal FROM thread_items WHERE thread_id = ? AND turn_id = ? AND item_type = 'imageView' ORDER BY updated_at_ordinal DESC LIMIT 1",
        turn.thread_id, turn.turn_id);
      if (latestImage && !records.some((record) => record.updated_at_ordinal === latestImage.updated_at_ordinal)) records.push(latestImage);
      const latestPlan = queryOne<ItemRow>(historyDatabase,
        "SELECT item_type, item_json, updated_at_ordinal FROM thread_items WHERE thread_id = ? AND turn_id = ? AND (lower(item_type) LIKE '%plan%' OR lower(item_type) LIKE '%todo%') ORDER BY updated_at_ordinal DESC LIMIT 1",
        turn.thread_id, turn.turn_id);
      if (latestPlan && !records.some((record) => record.updated_at_ordinal === latestPlan.updated_at_ordinal)) records.push(latestPlan);
      const narrativeRecords = queryAll<ItemRow>(historyDatabase, `
        WITH ranked AS (
          SELECT item_type, item_json, updated_at_ordinal,
            ROW_NUMBER() OVER (PARTITION BY item_type ORDER BY updated_at_ordinal DESC) rank
          FROM thread_items
          WHERE thread_id = ? AND turn_id = ? AND (
            item_type = 'agentMessage' OR
            (item_type = 'reasoning' AND json_array_length(json_extract(item_json, '$.summary')) > 0)
          )
        )
        SELECT item_type, item_json, updated_at_ordinal FROM ranked WHERE rank = 1
      `, turn.thread_id, turn.turn_id);
      for (const narrative of narrativeRecords) {
        if (!records.some((record) => record.updated_at_ordinal === narrative.updated_at_ordinal)) records.push(narrative);
      }
      records.sort((left, right) => left.updated_at_ordinal - right.updated_at_ordinal);
      if (!records.length) {
        events.push(recordEvent(turn.thread_id, turn.turn_id, turn.status, "", "{}", turn.latest, display, turn.started_at, turn.completed_at, fallbackDetail, lastMessage));
        continue;
      }
      records.forEach((record, index) => {
        events.push(recordEvent(
          turn.thread_id,
          turn.turn_id,
          index === records.length - 1 ? turn.status : "inProgress",
          record.item_type,
          record.item_json,
          record.updated_at_ordinal,
          display,
          turn.started_at,
          turn.completed_at,
          fallbackDetail,
          lastMessage,
        ));
      });
    }
    return events;
  } finally {
    stateDatabase?.close();
    historyDatabase.close();
  }
}
