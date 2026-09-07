import type { RunRecap } from "./runRecap";

/** Consume completion even while muted or hidden, so controls cannot replay it. */
export function createCompletionSoundGate() {
  let previous: RunRecap["status"] | undefined;
  return (status: RunRecap["status"] | undefined, enabled: boolean, visible: boolean) => {
    const finished = previous === "running" && status === "complete";
    previous = status;
    return finished && enabled && visible;
  };
}
