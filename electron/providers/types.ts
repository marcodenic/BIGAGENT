export type ProviderId = "codex" | "claude" | "grok" | "cursor" | "gemini" | "copilot" | "windsurf" | "opencode";
export type ProviderState = "connecting" | "ready" | "needs-restart" | "needs-setup" | "unavailable" | "error";

export interface ProviderAction {
  id: "setup" | "retry" | "launch" | "remove";
  label: string;
}

export interface ProviderHealth {
  id: ProviderId;
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
}

export type ProviderHealthListener = (health: ProviderHealth) => void;
