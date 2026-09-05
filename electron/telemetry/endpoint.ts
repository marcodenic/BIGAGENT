export function telemetryPort() {
  return Number(process.env.BIG_AGENT_PORT || 19777);
}

export function telemetryUrl(path: string) {
  return `http://127.0.0.1:${telemetryPort()}${path}`;
}

// Recognize our earlier local endpoints when a receiver changes ports.
export function isLocalTelemetryUrl(value: unknown, path: string) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname)
      && url.pathname === path && !url.search && !url.hash && !url.username && !url.password;
  } catch { return false; }
}
