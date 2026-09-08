export function displayText(value: string, fallback: string) {
  const text = value
    .replace(/::codex-realtime-inline\{[^}]*\}/g, "")
    .replace(/^\s{0,3}#{1,6}\s+/g, "")
    .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^\s*[-*+]\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
  return text || fallback;
}

