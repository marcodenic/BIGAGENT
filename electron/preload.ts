import { contextBridge, ipcRenderer } from "electron";

function subscribe(channel: "big-agent:sessions" | "big-agent:event" | "big-agent:sources" | "big-agent:providers", listener: (payload: unknown) => void) {
  const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => listener(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld("bigAgentDesktop", Object.freeze({
  platform: "electron" as const,
  getSessions: () => ipcRenderer.invoke("big-agent:get-sessions"),
  getSnapshot: () => ipcRenderer.invoke("big-agent:get-snapshot"),
  getProviders: () => ipcRenderer.invoke("big-agent:get-providers"),
  providerAction: (provider: "codex" | "claude" | "grok" | "cursor" | "gemini" | "copilot" | "windsurf" | "opencode", action: "setup" | "retry" | "launch" | "remove") => ipcRenderer.invoke("big-agent:provider-action", provider, action),
  saveRecapImage: (bytes: Uint8Array) => ipcRenderer.invoke("big-agent:save-recap-image", bytes),
  imagePreview: (path: string) => ipcRenderer.invoke("big-agent:image-preview", path),
  setScreenAwake: (active: boolean) => ipcRenderer.invoke("big-agent:set-screen-awake", active),
  toggleFullscreen: () => ipcRenderer.invoke("big-agent:toggle-fullscreen"),
  exitFullscreen: () => ipcRenderer.invoke("big-agent:exit-fullscreen"),
  onSessions: (listener: (payload: unknown) => void) => subscribe("big-agent:sessions", listener),
  onEvent: (listener: (payload: unknown) => void) => subscribe("big-agent:event", listener),
  onSources: (listener: (payload: unknown) => void) => subscribe("big-agent:sources", listener),
  onProviders: (listener: (payload: unknown) => void) => subscribe("big-agent:providers", listener),
}));
