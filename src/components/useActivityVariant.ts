import { useEffect, useState } from "react";
import { activityVariant, activityVariantDelay, hasActivityVariants, type AnimatedFaceState } from "./animatedFaceModel";

/** Rotate on elapsed visible time, independent of incoming telemetry frequency. */
export function useActivityVariant(base: AnimatedFaceState, personality: number, paused: boolean, explicit: boolean) {
  const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const [rotation, setRotation] = useState({ base, personality, step: 0 });
  const step = rotation.base === base && rotation.personality === personality ? rotation.step : 0;
  const enabled = !explicit && !reducedMotion && hasActivityVariants(base);

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    setRotation({ base, personality, step: 0 });
  }, [base, personality, enabled]);

  useEffect(() => {
    if (!enabled || paused) return;
    const timer = window.setTimeout(() => {
      setRotation({ base, personality, step: step + 1 });
    }, activityVariantDelay(base, personality, step));
    return () => window.clearTimeout(timer);
  }, [base, personality, step, enabled, paused]);

  return enabled ? activityVariant(base, personality, step) : base;
}
