import { useEffect, useRef, useState } from "react";
import type { AnimatedFaceState } from "./animatedFaceModel";
import { faceTimelineAdvance, faceTimelineReceive, faceTimelineWaitMs, type FaceTimeline } from "./faceTimeline";

export function useFaceTimeline(requested: AnimatedFaceState, urgent: boolean, paused: boolean) {
  const timeline = useRef<FaceTimeline>({ shown: requested, latest: requested, since: performance.now(), pending: null });
  const [shown, setShown] = useState(requested);

  useEffect(() => {
    if (paused) {
      timeline.current = { shown: requested, latest: requested, since: performance.now(), pending: null };
      setShown(requested);
      return;
    }
    timeline.current = faceTimelineReceive(timeline.current, requested, performance.now(), urgent);
    setShown(timeline.current.shown);
    let timer: number;
    const advance = () => {
      timeline.current = faceTimelineAdvance(timeline.current, performance.now());
      setShown(timeline.current.shown);
      const wait = faceTimelineWaitMs(timeline.current, performance.now());
      if (wait !== null) timer = window.setTimeout(advance, Math.max(1, wait));
    };
    const wait = faceTimelineWaitMs(timeline.current, performance.now());
    if (wait !== null) timer = window.setTimeout(advance, Math.max(1, wait));
    return () => window.clearTimeout(timer);
  }, [requested, urgent, paused]);

  return shown;
}
