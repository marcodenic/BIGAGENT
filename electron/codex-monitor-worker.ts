import { parentPort, workerData } from "node:worker_threads";
import { codexDesktopSessions, codexSessionStoreAvailable, codexSourceSignature } from "./codex-sessions";

if (!parentPort) throw new Error("Codex monitor requires a worker thread");
const port = parentPort;
if (workerData?.smoke) {
  port.postMessage({ type: "ready" });
} else {
  let signature = "";
  let serialized = "";
  let safetyRefreshAt = 0;
  let available: boolean | undefined;
  let failed = false;
  const refresh = (force = false) => {
    try {
      const nextSignature = codexSourceSignature();
      if (!force && nextSignature === signature && Date.now() < safetyRefreshAt) return;
      const events = codexDesktopSessions();
      const nextAvailable = codexSessionStoreAvailable();
      const nextSerialized = JSON.stringify(events);
      if (failed || nextSerialized !== serialized || nextAvailable !== available) {
        port.postMessage({ type: "snapshot", events, available: nextAvailable });
      }
      signature = nextSignature;
      serialized = nextSerialized;
      available = nextAvailable;
      failed = false;
      safetyRefreshAt = Date.now() + 15_000;
    } catch (error) {
      failed = true;
      port.postMessage({ type: "error", message: error instanceof Error ? error.message : String(error) });
    }
  };
  port.on("message", () => refresh(true));
  refresh(true);
  setInterval(refresh, 250);
}
