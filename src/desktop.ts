export type DesktopApi = {
  platform: "electron";
  getSessions(): Promise<unknown[]>;
  getSnapshot(): Promise<unknown>;
  getProviders(): Promise<unknown>;
  providerAction(provider: "codex" | "claude", action: "setup" | "retry" | "launch"): Promise<unknown>;
  imagePreview(path: string): Promise<string>;
  runProcess(command: string, args: string[]): Promise<void>;
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
