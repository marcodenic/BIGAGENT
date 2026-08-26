import { fileURLToPath } from "node:url";

type JsonObject = Record<string, unknown>;

function text(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function object(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function parseJson(value: string): JsonObject {
  try {
    return object(JSON.parse(value));
  } catch {
    return {};
  }
}

export function splitCompleteJsonLines(value: string) {
  const lines = value.split("\n");
  const trailing = lines.pop() ?? "";
  if (!trailing.trim()) return { lines, remainder: "" };
  try {
    JSON.parse(trailing);
    // Codex can leave the newest JSONL record at EOF without a final newline.
    // A syntactically complete object is already an event and must not wait for
    // another write, especially when that event is task_complete.
    lines.push(trailing);
    return { lines, remainder: "" };
  } catch {
    return { lines, remainder: trailing };
  }
}

function itemTextContent(value: unknown) {
  if (!Array.isArray(value)) return "";
  return value.map(object).map((part) => text(part.text)).filter(Boolean).join("\n");
}

function commandText(value: unknown) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  const parts = value.map((part) => text(part)).filter(Boolean);
  if (parts.length >= 3 && /(?:^|\/)\w*sh$/.test(parts[0]) && parts[1] === "-lc") return parts.slice(2).join(" ");
  return parts.join(" ");
}

function filePath(value: unknown) {
  const path = text(value);
  if (!path.startsWith("file://")) return path;
  try {
    return fileURLToPath(path);
  } catch {
    return "";
  }
}

function decodedString(source: string, key: string) {
  const match = source.match(new RegExp(`"${key}"\\s*:\\s*("(?:\\\\.|[^"\\\\])*")`));
  if (!match) return "";
  try {
    return text(JSON.parse(match[1]));
  } catch {
    return "";
  }
}

function nestedToolName(source: string, fallback: string) {
  const names = [...source.matchAll(/tools\.([A-Za-z0-9_]+)/g)].map((match) => match[1]);
  return names.at(-1) || fallback;
}

export function normalizeCodexToolCall(value: unknown) {
  const call = object(value);
  const source = text(call.input);
  // A completed custom-tool-call is already terminal even when Codex has not
  // yet emitted its separate output record. Treating it as in progress makes
  // a finished command permanently look live in the fallback feed.
  const status = text(call.status, "inProgress");
  const cwd = filePath(decodedString(source, "workdir"));
  const tool = nestedToolName(source, text(call.name, "tool"));
  if (tool === "exec_command") {
    return { itemType: "commandExecution", item: { command: decodedString(source, "cmd") || "Running command", status, cwd } };
  }
  if (tool === "apply_patch") {
    const paths = [...source.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((match) => match[1].trim());
    return { itemType: "fileChange", item: { changes: paths.map((path) => ({ path })), status } };
  }
  if (tool === "view_image") {
    return { itemType: "imageView", item: { path: filePath(decodedString(source, "path")) } };
  }
  if (tool === "web__run") {
    return { itemType: "webSearch", item: { query: "Searching official sources" } };
  }
  return { itemType: "dynamicToolCall", item: { tool, arguments: {}, status } };
}

export function normalizeCodexRolloutItem(value: unknown) {
  const item = object(value);
  const rawType = text(item.type);
  const itemType = rawType ? `${rawType[0].toLowerCase()}${rawType.slice(1)}` : "";
  if (itemType === "reasoning") return { itemType, item: { summary: item.summary_text ?? item.summary ?? [] } };
  if (itemType === "agentMessage") return { itemType, item: { text: text(item.text) || itemTextContent(item.content) } };
  if (itemType === "commandExecution") return { itemType, item: { command: commandText(item.command), status: text(item.status), cwd: filePath(item.cwd) } };
  if (itemType === "fileChange") return { itemType, item: { changes: item.changes ?? [], status: item.status } };
  if (itemType === "mcpToolCall" || itemType === "dynamicToolCall") {
    return { itemType, item: {
      tool: text(item.tool, text(item.name)),
      namespace: text(item.namespace, text(item.server)),
      arguments: item.arguments ?? item.input ?? {},
      status: item.status,
    } };
  }
  if (itemType === "webSearch") return { itemType, item: { query: text(item.query) } };
  if (itemType === "imageView") return { itemType, item: { path: filePath(item.path) } };
  if (itemType === "imageGeneration") return { itemType, item: {} };
  if (/plan|todo/i.test(itemType)) return { itemType, item: { plan: item.plan, steps: item.steps, items: item.items } };
  if (itemType === "extension") {
    return { itemType: "dynamicToolCall", item: {
      tool: text(item.name, text(item.extension_name, "extension")),
      arguments: item.arguments ?? item.input ?? {},
      status: item.status,
    } };
  }
  return { itemType, item: {} };
}

type MutableLiveItem = {
  item_type: string;
  item_json: string;
  timestamp: number;
  transient?: boolean;
};

function liveItemIdentity(itemType: string, item: JsonObject) {
  if (itemType === "commandExecution") return text(item.command).trim();
  if (itemType === "fileChange") {
    const changes = Array.isArray(item.changes) ? item.changes.map(object).map((change) => text(change.path)).filter(Boolean) : [];
    return changes.join("\u0000");
  }
  if (itemType === "mcpToolCall" || itemType === "dynamicToolCall") {
    const tool = text(item.tool, text(item.name));
    return tool ? `${text(item.namespace, text(item.server))}\u0000${tool}` : "";
  }
  if (itemType === "imageView") return text(item.path);
  if (itemType === "webSearch") return text(item.query);
  return "";
}

/** Merge an item_completed payload into the row that announced the operation.
 * Completion records do not carry the custom tool call id, so use their public
 * operation identity and only fall back to type when there is one candidate.
 * The caller's original ordinal therefore remains stable for the whole item. */
export function reconcileCompletedRolloutItem(
  items: MutableLiveItem[],
  normalized: ReturnType<typeof normalizeCodexRolloutItem>,
  timestamp: number,
) {
  if (!normalized.itemType) return false;
  const candidates = items.filter((item) => item.transient && item.item_type === normalized.itemType);
  const completedIdentity = liveItemIdentity(normalized.itemType, object(normalized.item));
  const active = (completedIdentity
    ? candidates.find((candidate) => liveItemIdentity(candidate.item_type, parseJson(candidate.item_json)) === completedIdentity)
    : undefined) ?? (candidates.length === 1 ? candidates[0] : undefined);
  if (!active) return false;
  active.item_json = JSON.stringify(normalized.item);
  active.timestamp = timestamp;
  active.transient = false;
  return true;
}

export function reconcileCodexTurnLifecycle(
  status: string,
  startedAt: number,
  completedAt: number | null,
  agentLoopExitedAt?: number,
) {
  if (status !== "inProgress" || agentLoopExitedAt === undefined || agentLoopExitedAt < startedAt) {
    return { status, completedAt };
  }
  return { status: "completed", completedAt: agentLoopExitedAt };
}
