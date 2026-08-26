import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { TelemetryHub } from "./hub";
import { createTelemetryServer, trustedTelemetryOrigin } from "./server";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function receiver() {
  const hub = new TelemetryHub();
  const server = createTelemetryServer(hub);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return { hub, url: `http://127.0.0.1:${port}` };
}

describe("local telemetry receiver hardening", () => {
  it("accepts command-line JSON without an Origin header", async () => {
    const { hub, url } = await receiver();
    const response = await fetch(`${url}/event`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "thinking", sessionId: "safe" }),
    });

    expect(response.status).toBe(202);
    expect(Object.values(hub.eventsBySource()).flat()).toHaveLength(1);
  });

  it("rejects web origins and non-JSON browser posts", async () => {
    const { hub, url } = await receiver();
    const foreign = await fetch(`${url}/event`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://example.com" },
      body: JSON.stringify({ status: "complete" }),
    });
    const plain = await fetch(`${url}/event`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ status: "complete" }),
    });

    expect(foreign.status).toBe(403);
    expect(plain.status).toBe(415);
    expect(Object.values(hub.eventsBySource()).flat()).toHaveLength(0);
  });

  it("recognizes only loopback HTTP origins", () => {
    expect(trustedTelemetryOrigin(undefined)).toBe(true);
    expect(trustedTelemetryOrigin("http://localhost:5173")).toBe(true);
    expect(trustedTelemetryOrigin("http://127.0.0.1:19777")).toBe(true);
    expect(trustedTelemetryOrigin("https://example.com")).toBe(false);
    expect(trustedTelemetryOrigin("null")).toBe(false);
  });
});
