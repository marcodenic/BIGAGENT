import { TelemetryHub } from "./hub";

function eventUrl(base: string) {
  const url = new URL(base);
  if (!/\/(?:global\/)?event$/.test(url.pathname) && !/\/api\/event$/.test(url.pathname)) url.pathname = `${url.pathname.replace(/\/$/, "")}/global/event`;
  return url;
}

async function consumeSse(response: Response, onData: (value: unknown) => void) {
  if (!response.ok || !response.body) throw new Error(`OpenCode event stream returned ${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.search(/\r?\n\r?\n/);
    while (boundary >= 0) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary).replace(/^\r?\n\r?\n/, "");
      const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart()).join("\n");
      if (data) {
        try { onData(JSON.parse(data)); } catch { /* Heartbeats and partial frames are not agent events. */ }
      }
      boundary = buffer.search(/\r?\n\r?\n/);
    }
  }
}

export function startOpenCodeSource(hub: TelemetryHub) {
  const configured = process.env.BIG_AGENT_OPENCODE_URL?.split(",").map((value) => value.trim()).filter(Boolean);
  const bases = configured?.length ? configured : ["http://127.0.0.1:4096"];
  const controllers = bases.map(() => new AbortController());
  bases.forEach((base, index) => {
    const source = `opencode-sse${bases.length > 1 ? `-${index + 1}` : ""}`;
    const url = eventUrl(base);
    const controller = controllers[index];
    let retryMs = 1_000;
    const connect = async () => {
      if (controller.signal.aborted) return;
      hub.markSource(source, "opencode", "sse", "connecting");
      try {
        const headers: Record<string, string> = { accept: "text/event-stream" };
        if (process.env.BIG_AGENT_OPENCODE_TOKEN) headers.authorization = `Bearer ${process.env.BIG_AGENT_OPENCODE_TOKEN}`;
        const response = await fetch(url, { headers, signal: controller.signal });
        hub.markSource(source, "opencode", "sse", "live");
        retryMs = 1_000;
        await consumeSse(response, (payload) => hub.ingest({ source, product: "opencode", transport: "sse", format: "opencode", payload }));
        if (!controller.signal.aborted) throw new Error("OpenCode event stream closed");
      } catch (error) {
        if (controller.signal.aborted) return;
        const message = error instanceof Error ? error.message : String(error);
        hub.markSource(source, "opencode", "sse", configured?.length ? "error" : "unavailable", message);
        const delay = retryMs;
        retryMs = Math.min(retryMs * 2, 30_000);
        setTimeout(connect, delay).unref();
      }
    };
    void connect();
  });
  return () => controllers.forEach((controller) => controller.abort());
}
