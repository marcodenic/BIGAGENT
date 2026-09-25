import { describe, expect, it } from "vitest";
import { faceDwellMs, faceTimelineAdvance, faceTimelineReceive, faceTimelineWaitMs, type FaceTimeline } from "./faceTimeline";

describe("face motion timeline", () => {
  it("shows a brief edit for a complete pencil cycle before returning to thinking", () => {
    let timeline: FaceTimeline = { shown: "thinking", since: 0, latest: "thinking", pending: null };
    timeline = faceTimelineReceive(timeline, "writing", 100);
    timeline = faceTimelineReceive(timeline, "thinking", 200);
    expect(timeline.shown).toBe("thinking");
    timeline = faceTimelineAdvance(timeline, faceDwellMs("thinking"));
    expect(timeline.shown).toBe("writing");
    expect(faceTimelineWaitMs(timeline, 1400)).toBe(2500);
    timeline = faceTimelineAdvance(timeline, 3899);
    expect(timeline.shown).toBe("writing");
    timeline = faceTimelineAdvance(timeline, 3900);
    expect(timeline.shown).toBe("thinking");
  });

  it("keeps only the newest queued action and lets urgent states interrupt", () => {
    let timeline: FaceTimeline = { shown: "thinking", since: 0, latest: "thinking", pending: null };
    timeline = faceTimelineReceive(timeline, "searching", 100);
    timeline = faceTimelineReceive(timeline, "writing", 200);
    expect(faceTimelineAdvance(timeline, 1400).shown).toBe("writing");
    timeline = faceTimelineReceive(timeline, "writing", 1400);
    timeline = faceTimelineReceive(timeline, "alerting", 1500, true);
    expect(timeline).toMatchObject({ shown: "alerting", pending: null });
    expect(faceTimelineWaitMs(timeline, 1500)).toBeNull();
  });
});
