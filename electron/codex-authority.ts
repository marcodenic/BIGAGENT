import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const bridgePattern = /(?:^|[\\/\s])big-agent\.mjs\s+hook\s+codex(?:\s|$)/i;

export function isBigAgentCodexHookCommand(value: unknown) {
  return typeof value === "string" && bridgePattern.test(value);
}

export function containsBigAgentCodexHook(value: unknown): boolean {
  if (typeof value === "string") return bridgePattern.test(value);
  if (Array.isArray(value)) return value.some(containsBigAgentCodexHook);
  if (!value || typeof value !== "object") return false;
  return Object.values(value as Record<string, unknown>).some(containsBigAgentCodexHook);
}

export function removeBigAgentCodexHooks(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { value, removed: 0 };
  const root = { ...(value as Record<string, unknown>) };
  if (!root.hooks || typeof root.hooks !== "object" || Array.isArray(root.hooks)) return { value, removed: 0 };
  const hooks = root.hooks as Record<string, unknown>;
  const nextHooks: Record<string, unknown> = {};
  let removed = 0;

  for (const [event, entriesValue] of Object.entries(hooks)) {
    if (!Array.isArray(entriesValue)) {
      nextHooks[event] = entriesValue;
      continue;
    }
    const entries: unknown[] = [];
    for (const entryValue of entriesValue) {
      if (!entryValue || typeof entryValue !== "object" || Array.isArray(entryValue)) {
        entries.push(entryValue);
        continue;
      }
      const entry = entryValue as Record<string, unknown>;
      if (!Array.isArray(entry.hooks)) {
        entries.push(entryValue);
        continue;
      }
      const actions = entry.hooks.filter((action) => {
        const command = action && typeof action === "object" && !Array.isArray(action)
          ? (action as Record<string, unknown>).command
          : undefined;
        if (!isBigAgentCodexHookCommand(command)) return true;
        removed += 1;
        return false;
      });
      if (actions.length) entries.push({ ...entry, hooks: actions });
    }
    if (entries.length) nextHooks[event] = entries;
  }

  if (!removed) return { value, removed: 0 };
  root.hooks = nextHooks;
  return { value: root, removed };
}

export function codexHookBridgeConfigured(root = process.env.CODEX_HOME || join(homedir(), ".codex")) {
  try {
    if (containsBigAgentCodexHook(JSON.parse(readFileSync(join(root, "hooks.json"), "utf8")))) return true;
  } catch {
    // hooks.json is optional.
  }
  try {
    return containsBigAgentCodexHook(readFileSync(join(root, "config.toml"), "utf8"));
  } catch {
    return false;
  }
}
