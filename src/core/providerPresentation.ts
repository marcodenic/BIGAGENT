export type ProviderAction = { id: "setup" | "retry" | "launch"; label: string };
export type ProviderState = "connecting" | "ready" | "needs-restart" | "needs-setup" | "unavailable" | "error";

export type ProviderHealth = {
  id: "codex" | "claude";
  label: string;
  transport: string;
  state: ProviderState;
  configured: boolean;
  connected: boolean;
  listening: boolean;
  activeSessions: number;
  detail: string;
  lastEventAt?: string;
  actions: ProviderAction[];
};

export type ProviderStatusPresentation = {
  label: string;
  tone: "ready" | "attention" | "neutral" | "error";
};

export function providerStatusPresentation(state: ProviderState): ProviderStatusPresentation {
  switch (state) {
    case "ready": return { label: "CONNECTED", tone: "ready" };
    case "needs-restart": return { label: "RESTART REQUIRED", tone: "attention" };
    case "needs-setup": return { label: "SETUP REQUIRED", tone: "attention" };
    case "unavailable": return { label: "NOT DETECTED", tone: "neutral" };
    case "error": return { label: "CONNECTION ERROR", tone: "error" };
    default: return { label: "CONNECTING", tone: "neutral" };
  }
}

// A connected listener is not enough: the provider must be observable from
// client to BIG AGENT. For example, Codex remains needs-restart until Desktop
// joins the shared App Server even though that server socket is already live.
export function observableProviders(providers: ProviderHealth[]) {
  return providers.filter((provider) => provider.state === "ready");
}

export function visibleProviderMessage(providers: ProviderHealth[]) {
  const visible = observableProviders(providers);
  if (!visible.length) return "We can’t see any agents. We support any of the agents above.";
  const labels = visible.map((provider) => provider.label.charAt(0) + provider.label.slice(1).toLowerCase());
  if (labels.length === 1) return `We can see ${labels[0]}.`;
  return `We can see ${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}.`;
}
