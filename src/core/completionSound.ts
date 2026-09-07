import type { RunRecap } from "./runRecap";

export const COMPLETION_SOUND_DELAY_MS = 2_000;

/** Require two quiet seconds before announcing completion. */
export function createCompletionSoundScheduler() {
  const gate = createCompletionSoundGate();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  return {
    update(status: RunRecap["status"] | undefined, enabled: boolean, visible: boolean, play: () => void) {
      if (status !== "complete" || !enabled || !visible) cancel();
      if (gate(status, enabled, visible)) {
        cancel();
        timer = setTimeout(() => {
          timer = undefined;
          play();
        }, COMPLETION_SOUND_DELAY_MS);
      }
    },
    dispose: cancel,
  };
}

/** Consume completion even while muted or hidden, so controls cannot replay it. */
export function createCompletionSoundGate() {
  let previous: RunRecap["status"] | undefined;
  return (status: RunRecap["status"] | undefined, enabled: boolean, visible: boolean) => {
    const finished = previous === "running" && status === "complete";
    previous = status;
    return finished && enabled && visible;
  };
}
