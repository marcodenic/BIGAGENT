export type DesktopApi = {
  platform: "electron";
  getSessions(): Promise<unknown[]>;
  getSnapshot(): Promise<unknown>;
  getProviders(): Promise<unknown>;
  providerAction(provider: "codex" | "claude" | "grok" | "cursor" | "gemini" | "copilot" | "windsurf" | "opencode", action: "setup" | "retry" | "launch" | "remove"): Promise<unknown>;
  imagePreview(path: string): Promise<string>;
  setScreenAwake(active: boolean): Promise<void>;
  toggleFullscreen(): Promise<void>;
  exitFullscreen(): Promise<void>;
  onSessions(listener: (payload: unknown) => void): () => void;
  onEvent(listener: (payload: unknown) => void): () => void;
  onSources(listener: (payload: unknown) => void): () => void;
  onProviders(listener: (payload: unknown) => void): () => void;
};

export function desktopApi() {
  return window.bigAgentDesktop;
}

export async function toggleAppFullscreen() {
  const desktop = desktopApi();
  if (desktop) return desktop.toggleFullscreen();
  if (document.fullscreenElement) await document.exitFullscreen();
  else await document.documentElement.requestFullscreen();
}

export async function exitAppFullscreen() {
  const desktop = desktopApi();
  if (desktop) return desktop.exitFullscreen();
  if (document.fullscreenElement) await document.exitFullscreen();
}
