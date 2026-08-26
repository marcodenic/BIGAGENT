import { describe, expect, it } from "vitest";
import { observableProviders, providerStatusPresentation, visibleProviderMessage, type ProviderHealth } from "./providerPresentation";

function provider(state: ProviderHealth["state"], label = "CODEX"): ProviderHealth {
  return {
    id: label === "CLAUDE" ? "claude" : "codex",
    label,
    transport: "TEST",
    state,
    configured: true,
    connected: state === "ready" || state === "needs-restart",
    listening: true,
    activeSessions: 0,
    detail: "Test provider",
    actions: [],
  };
}

describe("provider discovery presentation", () => {
  it("does not call a socket-only Codex connection observable", () => {
    expect(observableProviders([provider("needs-restart")])).toEqual([]);
    expect(providerStatusPresentation("needs-restart")).toEqual({ label: "RESTART REQUIRED", tone: "attention" });
    expect(visibleProviderMessage([provider("needs-restart")])).toBe("We can’t see any agents. We support any of the agents above.");
  });

  it("summarizes fully observable providers", () => {
    const providers = [provider("ready"), provider("ready", "CLAUDE")];
    expect(observableProviders(providers)).toHaveLength(2);
    expect(visibleProviderMessage(providers)).toBe("We can see Codex and Claude.");
  });

  it("labels each provider state explicitly", () => {
    expect(providerStatusPresentation("ready").label).toBe("CONNECTED");
    expect(providerStatusPresentation("needs-setup").label).toBe("SETUP REQUIRED");
    expect(providerStatusPresentation("unavailable").label).toBe("NOT DETECTED");
    expect(providerStatusPresentation("error").label).toBe("CONNECTION ERROR");
  });
});
