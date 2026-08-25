import { contextBridge, ipcRenderer } from "electron";

function subscribe(channel: "big-agent:sessions" | "big-agent:event" | "big-agent:sources", listener: (payload: unknown) => void) {
  const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => listener(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld("bigAgentDesktop", Object.freeze({
  platform: "electron" as const,
  getSessions: () => ipcRenderer.invoke("big-agent:get-sessions"),
  getSnapshot: () => ipcRenderer.invoke("big-agent:get-snapshot"),
  imagePreview: (path: string) => ipcRenderer.invoke("big-agent:image-preview", path),
  runProcess: (command: string, args: string[]) => ipcRenderer.invoke("big-agent:run-process", command, args),
  setScreenAwake: (active: boolean) => ipcRenderer.invoke("big-agent:set-screen-awake", active),
  toggleFullscreen: () => ipcRenderer.invoke("big-agent:toggle-fullscreen"),
  exitFullscreen: () => ipcRenderer.invoke("big-agent:exit-fullscreen"),
  onSessions: (listener: (payload: unknown) => void) => subscribe("big-agent:sessions", listener),
  onEvent: (listener: (payload: unknown) => void) => subscribe("big-agent:event", listener),
  onSources: (listener: (payload: unknown) => void) => subscribe("big-agent:sources", listener),
}));
