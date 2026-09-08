import { open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";

const TAIL_BYTES = 256 * 1024;

/** Recover only model metadata; never forward transcript messages to telemetry. */
export async function enrichClaudeModel(payload: unknown, configRoot = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude")): Promise<unknown> {
  if (Array.isArray(payload)) return Promise.all(payload.map(value => enrichClaudeModel(value, configRoot)));
  if (!payload || typeof payload !== "object") return payload;
  const entry = payload as Record<string, unknown>;
  const reportedModel = typeof entry.model === "string" && entry.model.trim() ? entry.model.trim() : undefined;
  const session = entry.session_id;
  const agent = entry.agent_id;
  const isSubagent = typeof agent === "string" && agent.length > 0;
  const parentPath = entry.transcript_path;
  if (isSubagent && !/^[a-zA-Z0-9_-]+$/.test(agent)) return payload;
  const path = isSubagent
    ? entry.agent_transcript_path ?? (typeof parentPath === "string" && typeof session === "string"
      && basename(parentPath) === `${session}.jsonl`
      ? join(dirname(parentPath), session, "subagents", `agent-${agent}.jsonl`) : undefined)
    : parentPath;
  // Hook paths are input, not permission to read arbitrary local files.
  if (typeof session !== "string" || typeof path !== "string" || !isAbsolute(path)
    || basename(path) !== (isSubagent ? `agent-${agent}.jsonl` : `${session}.jsonl`)) return payload;
  try {
    const [root, resolved] = await Promise.all([realpath(join(configRoot, "projects")), realpath(path)]);
    const inside = relative(root, resolved);
    if (!inside || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return payload;
    const file = await open(resolved, "r");
    try {
      const stat = await file.stat();
      if (!stat.isFile()) return payload;
      const start = Math.max(0, stat.size - TAIL_BYTES);
      const buffer = Buffer.alloc(Math.min(stat.size, TAIL_BYTES));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
      const lines = buffer.subarray(0, bytesRead).toString("utf8").split("\n");
      if (start) lines.shift(); // The first record may have been cut in half.
      for (const line of lines.reverse()) {
        try {
          const record = JSON.parse(line);
          const model = record?.message?.model;
          if (record?.type === "assistant" && record.sessionId === session
            && (!isSubagent || record.agentId === undefined || record.agentId === agent)
            && typeof model === "string" && model.trim() && model !== "<synthetic>") {
            const effort = [entry.reasoning_effort, entry.reasoningEffort, entry.effort,
              record.reasoningEffort, record.reasoning_effort, record.effort,
              record.message?.output_config?.effort].find(value => typeof value === "string" && value.trim());
            // Do not attach metadata from an older model to an explicitly reported new one.
            if (reportedModel && reportedModel !== model.trim()) return payload;
            return { ...entry, model: reportedModel ?? model.trim(), ...(effort ? { reasoning_effort: effort.trim() } : {}) };
          }
        } catch { /* Ignore partial or malformed records while Claude writes. */ }
      }
    } finally {
      await file.close();
    }
  } catch { /* Missing or inaccessible transcripts must not interrupt activity. */ }
  return payload;
}
