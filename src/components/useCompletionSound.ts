import { useEffect, useRef, useState } from "react";
import chimeUrl from "../assets/audio/completion-chime.ogg";
import { createCompletionSoundGate } from "../core/completionSound";
import type { RunRecap } from "../core/runRecap";

const preferenceKey = "big-agent.completion-sound.v1";

export function useCompletionSound(status: RunRecap["status"] | undefined, visible: boolean) {
  const [enabled, setEnabled] = useState(() => {
    try { return localStorage.getItem(preferenceKey) !== "off"; } catch { return true; }
  });
  const [error, setError] = useState("");
  const audio = useRef<HTMLAudioElement>();
  const gate = useRef(createCompletionSoundGate());

  function stop() {
    if (audio.current) { audio.current.pause(); audio.current.currentTime = 0; }
  }

  async function preview() {
    const player = audio.current ??= new Audio(chimeUrl);
    player.volume = 0.5;
    player.pause();
    player.currentTime = 0;
    setError("");
    try { await player.play(); } catch { setError("Sound could not play. Try Preview chime."); }
  }

  function toggle() {
    const next = !enabled;
    setEnabled(next);
    if (!next) stop();
    try { localStorage.setItem(preferenceKey, next ? "on" : "off"); } catch { /* Keep the in-memory preference. */ }
  }

  useEffect(() => {
    if (gate.current(status, enabled, visible)) void preview();
    if (status !== "complete") stop();
  }, [status, enabled, visible]);

  useEffect(() => () => { audio.current?.pause(); }, []);

  return { enabled, toggle, preview, error };
}
