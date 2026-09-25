import type { AnimatedFaceState } from "./animatedFaceModel";

export type FaceTimeline = {
  shown: AnimatedFaceState;
  since: number;
  latest: AnimatedFaceState;
  pending: AnimatedFaceState | null;
};

// These are one visible cycle of the shipped renderer's short motions. Its
// ambient states loop indefinitely, so they get a short minimum dwell instead.
export function faceDwellMs(state: AnimatedFaceState) {
  switch (state) {
    case "writing": return 2500; // pencil stroke and return
    case "progress": return 2500;
    case "spawning": return 2000;
    case "sending": return 1500;
    case "receiving": return 1700;
    default: return 1400;
  }
}

const specificActions = new Set<AnimatedFaceState>([
  "writing", "progress", "spawning", "sending", "receiving", "searching",
  "radar", "uploading", "notifying", "loading", "celebrate", "dictating",
  "waking", "bouncing", "powering-down",
]);

export function faceTimelineReceive(timeline: FaceTimeline, latest: AnimatedFaceState, now: number, urgent = false): FaceTimeline {
  if (urgent) return { shown: latest, since: now, latest, pending: null };
  const pending = latest !== timeline.shown && specificActions.has(latest) ? latest : timeline.pending;
  return faceTimelineAdvance({ ...timeline, latest, pending }, now);
}

export function faceTimelineAdvance(timeline: FaceTimeline, now: number): FaceTimeline {
  if (now - timeline.since < faceDwellMs(timeline.shown)) return timeline;
  const next = timeline.pending ?? timeline.latest;
  if (next === timeline.shown) return { ...timeline, pending: null };
  return { ...timeline, shown: next, since: now, pending: null };
}

export function faceTimelineWaitMs(timeline: FaceTimeline, now: number) {
  if (!timeline.pending && timeline.latest === timeline.shown) return null;
  return Math.max(0, faceDwellMs(timeline.shown) - (now - timeline.since));
}
