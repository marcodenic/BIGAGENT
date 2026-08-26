import { fileURLToPath } from "node:url";

type JsonObject = Record<string, unknown>;

function text(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function object(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
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
  const tool = nestedToolName(source, text(call.name, "tool"));
  if (tool === "exec_command") {
    return { itemType: "commandExecution", item: { command: decodedString(source, "cmd") || "Running command", status: "inProgress" } };
  }
  if (tool === "apply_patch") {
    const paths = [...source.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((match) => match[1].trim());
    return { itemType: "fileChange", item: { changes: paths.map((path) => ({ path })), status: "inProgress" } };
  }
  if (tool === "view_image") {
    return { itemType: "imageView", item: { path: filePath(decodedString(source, "path")) } };
  }
  if (tool === "web__run") {
    return { itemType: "webSearch", item: { query: "Searching official sources" } };
  }
  return { itemType: "dynamicToolCall", item: { tool, arguments: {}, status: "inProgress" } };
}

export function normalizeCodexRolloutItem(value: unknown) {
  const item = object(value);
  const rawType = text(item.type);
  const itemType = rawType ? `${rawType[0].toLowerCase()}${rawType.slice(1)}` : "";
  if (itemType === "reasoning") return { itemType, item: { summary: item.summary_text ?? item.summary ?? [] } };
  if (itemType === "agentMessage") return { itemType, item: { text: text(item.text) || itemTextContent(item.content) } };
  if (itemType === "commandExecution") return { itemType, item: { command: commandText(item.command), status: text(item.status) } };
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
