import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { TelemetryHub } from "./hub";
import type { TelemetryEnvelope, TelemetryFormat } from "./normalizers";

const MAX_BODY_BYTES = 16 * 1024 * 1024;

function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(value));
}

async function readJson(request: IncomingMessage) {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunkValue of request) {
    const chunk = Buffer.isBuffer(chunkValue) ? chunkValue : Buffer.from(chunkValue);
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("request body is too large");
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks).toString("utf8");
  return body ? JSON.parse(body) as unknown : {};
}

function sourceName(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

function sourceFormat(product: string): TelemetryFormat {
  if (product === "codex-app-server") return "codex-app-server";
  if (product === "codex-json") return "codex-json";
  if (product === "acp") return "acp";
  if (product === "opencode") return "opencode";
  return "protocol";
}

function ingestMany(hub: TelemetryHub, envelope: Omit<TelemetryEnvelope, "payload">, payload: unknown) {
  const values = Array.isArray(payload) ? payload : [payload];
  return values.flatMap((value) => hub.ingest({ ...envelope, payload: value }));
}

export function createTelemetryServer(hub: TelemetryHub) {
  return createServer(async (request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (request.method === "GET" && (url.pathname === "/health" || url.pathname === "/sources")) {
      json(response, 200, { status: "ok", sources: hub.health() });
      return;
    }
    if (request.method !== "POST") {
      json(response, 404, { status: "not found" });
      return;
    }
    if (request.headers["content-type"]?.includes("application/x-protobuf")) {
      json(response, 415, {
        status: "unsupported encoding",
        detail: "Send OTLP using http/json, or place the OpenTelemetry Collector in front of BIG AGENT for OTLP protobuf/gRPC.",
      });
      return;
    }
    try {
      const payload = await readJson(request);
      let envelope: Omit<TelemetryEnvelope, "payload"> | null = null;
      if (url.pathname === "/event") {
        envelope = { source: sourceName(request.headers["x-big-agent-source"] as string || "protocol"), product: "generic", transport: "http-json", format: "protocol" };
      } else if (url.pathname.startsWith("/hooks/")) {
        const product = sourceName(decodeURIComponent(url.pathname.slice("/hooks/".length)));
        envelope = { source: `${product}-hooks`, product, transport: "lifecycle-hooks", format: "hook" };
      } else if (url.pathname.startsWith("/sources/")) {
        const product = sourceName(decodeURIComponent(url.pathname.slice("/sources/".length)));
        envelope = {
          source: product,
          product: product === "codex-json" ? "codex" : product === "codex-app-server" ? "codex" : product,
          transport: product === "acp" ? "acp-json-rpc" : product === "codex-app-server" ? "json-rpc" : "structured-json",
          format: sourceFormat(product),
          direction: request.headers["x-big-agent-direction"] === "client-to-agent" ? "client-to-agent" : "agent-to-client",
        };
      } else if (url.pathname === "/v1/traces" || url.pathname === "/v1/logs" || url.pathname === "/v1/metrics") {
        const signal = url.pathname.slice("/v1/".length) as "traces" | "logs" | "metrics";
        const product = sourceName(request.headers["x-big-agent-product"] as string || "opentelemetry");
        envelope = { source: `${product}-otlp`, product, transport: "otlp-http-json", format: `otlp-${signal}` };
      }
      if (!envelope) {
        json(response, 404, { status: "not found" });
        return;
      }
      const events = ingestMany(hub, envelope, payload);
      const isOtlp = url.pathname.startsWith("/v1/");
      json(response, isOtlp ? 200 : 202, isOtlp ? {} : { status: "accepted", events: events.length, continue: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      json(response, message.includes("too large") ? 413 : 400, { status: "invalid request", detail: message });
    }
  });
}

export function listenTelemetryServer(server: Server, port = Number(process.env.BIG_AGENT_PORT || 19777)) {
  server.listen(port, "127.0.0.1");
}
