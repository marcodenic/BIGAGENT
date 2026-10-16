import { describe, expect, it, vi } from "vitest";
import { CodexAppServerProvider, sharedCodexDesktopEntry, unixSocketPeerInodes, unsharedCodexDesktopEntry } from "./codex-app-server";

import { TelemetryHub } from "../telemetry/hub";

describe("Codex shared App Server desktop setup", () => {
  it("adds the daemon environment without discarding desktop metadata", () => {
    const original = "[Desktop Entry]\nName=ChatGPT\nExec=chatgpt %U\nIcon=chatgpt\n";
    const configured = sharedCodexDesktopEntry(original);
    expect(configured).toContain("Exec=/usr/bin/env CODEX_APP_SERVER_USE_LOCAL_DAEMON=1 chatgpt %U");
    expect(configured).toContain("Icon=chatgpt");
    expect(configured).toContain("X-BIGAGENT-Shared-App-Server=true");
    expect(sharedCodexDesktopEntry(configured)).toBe(configured);
    expect(unsharedCodexDesktopEntry(configured)).toBe(original);
  });

  it("recognizes the desktop peer attached to the shared daemon socket", () => {
    const socket = "/home/code/.codex/app-server-control/app-server-control.sock";
    const output = [
      `u_str ESTAB 0 0 ${socket} 3592040 * 3624255 users:((\"codex\",pid=100,fd=14))`,
      "u_str ESTAB 0 0 * 3624255 * 3592040 users:((\"electron\",pid=200,fd=81))",
      `u_str ESTAB 0 0 ${socket} 3637334 * 3638515 users:((\"codex\",pid=100,fd=15))`,
      "u_str ESTAB 0 0 * 3638515 * 3637334 users:((\"ChatGPT\",pid=300,fd=178))",
    ].join("\n");

    expect([...unixSocketPeerInodes(output, socket)]).toEqual(["3624255", "3638515"]);
  });
});

 describe("Codex local session monitoring", () => {
  it("is ready without a shared server or standalone CLI and never asks for restart", () => {
    const provider = new CodexAppServerProvider(new TelemetryHub(), () => {});
    provider.noteLocalFeed(true, 2);
    expect(provider.health()).toMatchObject({ state: "ready", transport: "LOCAL SESSION FILES", activeSessions: 2 });
    expect(provider.health().actions?.some((action) => /RESTART|INSTALL/.test(action.label))).toBe(false);
    provider.noteLocalFeed(true, 0);
    expect(provider.health()).toMatchObject({ state: "ready", activeSessions: 0 });
    provider.noteLocalFeed(false, 0);
    expect(provider.health().state).not.toBe("ready");
  });
});

// Exercise the provider's reconnect/reconciliation state machine without
// connecting to, resuming, or changing a user's real Codex sessions.
type ProviderHarness = {
  connected: boolean;
  subscribed: Set<string>;
  threads: Map<string, Record<string, unknown>>;
  request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>>;
  refreshDesktopState(): Promise<void>;
  reconcileLoadedThreads(): Promise<void>;
  observe(message: Record<string, unknown>): void;
  disconnect(): void;
};

it("resubscribes after disconnect, follows every page, and retires vanished children", async () => {
  const hub = new TelemetryHub();
  const provider = new CodexAppServerProvider(hub, () => {});
  const harness = provider as unknown as ProviderHarness;
  harness.connected = true;
  harness.subscribed.add("root");
  harness.subscribed.add("gone-child");
  harness.threads.set("root", { id: "root" });
  harness.threads.set("gone-child", { id: "gone-child", parentThreadId: "root" });
  harness.disconnect();
  expect(harness.subscribed.size).toBe(0);
  harness.connected = true;
  vi.spyOn(harness, "refreshDesktopState").mockResolvedValue();
  const request = vi.spyOn(harness, "request").mockImplementation(async (method, params) => {
    if (method === "thread/loaded/list") return params.cursor ? { data: ["page-two-child"], nextCursor: null } : { data: ["root"], nextCursor: "page-two" };
    return { thread: { id: params.threadId, parentThreadId: params.threadId === "root" ? null : "root", status: { type: "idle" } } };
  });
  await harness.reconcileLoadedThreads();
  expect(request).toHaveBeenCalledWith("thread/resume", { threadId: "root" });
  expect(request).toHaveBeenCalledWith("thread/resume", { threadId: "page-two-child" });
  expect(harness.subscribed).toEqual(new Set(["root", "page-two-child"]));
  expect(hub.eventsBySource()["codex-app-server"].at(-1)).toMatchObject({ status: "complete", meta: { sessionId: "gone-child", parentSessionId: "root" } });
  provider.stop();
});

it("retires vanished agents even if a different subscription fails", async () => {
  const provider = new CodexAppServerProvider(new TelemetryHub(), () => {});
  const harness = provider as unknown as ProviderHarness;
  harness.connected = true;
  harness.threads.set("gone", { id: "gone" });
  vi.spyOn(harness, "request").mockImplementation(async method => {
    if (method === "thread/loaded/list") return { data: ["broken"], nextCursor: null };
    throw new Error("Thread disappeared during subscribe");
  });
  await expect(harness.reconcileLoadedThreads()).rejects.toThrow("Thread disappeared");
  expect(harness.threads.has("gone")).toBe(false);
  provider.stop();
});

it("does not overlap loaded-thread polls", async () => {
  const provider = new CodexAppServerProvider(new TelemetryHub(), () => {});
  const harness = provider as unknown as ProviderHarness;
  harness.connected = true;
  let resolve!: (value: Record<string, unknown>) => void;
  const request = vi.spyOn(harness, "request").mockImplementation(() => new Promise(done => { resolve = done; }));
  vi.spyOn(harness, "refreshDesktopState").mockResolvedValue();
  const first = harness.reconcileLoadedThreads();
  await harness.reconcileLoadedThreads();
  expect(request).toHaveBeenCalledTimes(1);
  resolve({ data: [], nextCursor: null });
  await first;
  provider.stop();
});

it("repairs a missed child completion while the thread remains loaded", async () => {
  const hub = new TelemetryHub();
  const provider = new CodexAppServerProvider(hub, () => {});
  const harness = provider as unknown as ProviderHarness;
  harness.connected = true;
  harness.subscribed.add("child");
  harness.threads.set("child", { id: "child", parentThreadId: "root", status: { type: "active", activeFlags: [] } });
  vi.spyOn(harness, "refreshDesktopState").mockResolvedValue();
  const request = vi.spyOn(harness, "request").mockImplementation(async method => method === "thread/loaded/list"
    ? { data: ["child"], nextCursor: null }
    : { thread: { id: "child", status: { type: "idle" } } });
  await harness.reconcileLoadedThreads();
  expect(request).toHaveBeenCalledWith("thread/read", { threadId: "child", includeTurns: false });
  expect(hub.eventsBySource()["codex-app-server"].at(-1)).toMatchObject({ kind: "turn.end", meta: { sessionId: "child", parentSessionId: "root" } });
  request.mockClear();
  await harness.reconcileLoadedThreads();
  expect(request).not.toHaveBeenCalledWith("thread/read", expect.anything());
  provider.stop();
});

it("ignores a stale idle read when a new turn starts during reconciliation", async () => {
  const provider = new CodexAppServerProvider(new TelemetryHub(), () => {});
  const harness = provider as unknown as ProviderHarness;
  harness.connected = true;
  harness.subscribed.add("child");
  harness.threads.set("child", { id: "child", status: { type: "active", activeFlags: [] } });
  vi.spyOn(harness, "refreshDesktopState").mockResolvedValue();
  vi.spyOn(harness, "request").mockImplementation(async method => {
    if (method === "thread/loaded/list") return { data: ["child"], nextCursor: null };
    harness.observe({ method: "turn/started", params: { threadId: "child", turn: { id: "next", status: "inProgress" } } });
    return { thread: { id: "child", status: { type: "idle" } } };
  });
  await harness.reconcileLoadedThreads();
  expect(harness.threads.get("child")?.status).toMatchObject({ type: "active" });
  provider.stop();
});
