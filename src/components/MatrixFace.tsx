import type { AgentStatus } from "../core/protocol";

// The face is deliberately drawn from a very small visual vocabulary. At room
// distance, two readable eyes and one readable mouth beat a detailed portrait.
const COLUMNS = 32;
const ROWS = 20;
type Level = 0 | 1 | 2 | 3;
type Frame = Map<number, Level>;

function dot(frame: Frame, x: number, y: number, level: Level = 2) {
  if (x >= 0 && x < COLUMNS && y >= 0 && y < ROWS) frame.set(y * COLUMNS + x, level);
}

function dots(frame: Frame, points: ReadonlyArray<readonly [number, number]>, level: Level = 2) {
  points.forEach(([x, y]) => dot(frame, x, y, level));
}

function block(frame: Frame, x: number, y: number, width = 2, height = 2, level: Level = 2) {
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) dot(frame, x + column, y + row, level);
  }
}

function horizontal(frame: Frame, x: number, y: number, length: number, level: Level = 2) {
  for (let column = 0; column < length; column += 1) dot(frame, x + column, y, level);
}

type EyeStyle = "normal" | "wide" | "narrow" | "sleepy" | "cross" | "wink";

function eye(frame: Frame, centre: number, style: EyeStyle, gaze = 0, accent = false) {
  if (style === "normal") {
    block(frame, centre - 1 + gaze, 6, 3, 3, accent ? 3 : 2);
    return;
  }
  if (style === "wide") {
    dots(frame, [
      [centre - 1, 5], [centre, 5], [centre + 1, 5],
      [centre - 2, 6], [centre + 2, 6],
      [centre - 2, 7], [centre + 2, 7],
      [centre - 1, 8], [centre, 8], [centre + 1, 8],
    ]);
    dot(frame, centre + gaze, 7, accent ? 3 : 2);
    return;
  }
  if (style === "narrow") {
    horizontal(frame, centre - 2, 7, 5);
    dot(frame, centre + gaze, 8, accent ? 3 : 2);
    return;
  }
  if (style === "sleepy") {
    dots(frame, [[centre - 2, 6], [centre - 1, 7], [centre, 8], [centre + 1, 7], [centre + 2, 6]], 1);
    return;
  }
  if (style === "cross") {
    dots(frame, [
      [centre - 2, 5], [centre - 1, 6], [centre, 7], [centre + 1, 8], [centre + 2, 9],
      [centre + 2, 5], [centre + 1, 6], [centre - 1, 8], [centre - 2, 9],
    ]);
    return;
  }
  horizontal(frame, centre - 2, 7, 5);
}

type MouthStyle = "smile" | "smirk" | "flat" | "frown" | "nervous" | "open" | "small";

function mouth(frame: Frame, style: MouthStyle) {
  if (style === "smile") {
    dots(frame, [
      [10, 13], [11, 14], [12, 15],
      [13, 16], [14, 16], [15, 16], [16, 16], [17, 16], [18, 16],
      [19, 15], [20, 14], [21, 13],
    ]);
    return;
  }
  if (style === "smirk") {
    horizontal(frame, 12, 15, 8);
    dots(frame, [[20, 14], [21, 13]]);
    return;
  }
  if (style === "frown") {
    dots(frame, [
      [10, 16], [11, 15], [12, 14],
      [13, 13], [14, 13], [15, 13], [16, 13], [17, 13], [18, 13],
      [19, 14], [20, 15], [21, 16],
    ]);
    return;
  }
  if (style === "nervous") {
    dots(frame, [
      [11, 14], [12, 13], [13, 14], [14, 15], [15, 14],
      [16, 13], [17, 14], [18, 15], [19, 14], [20, 13],
    ]);
    return;
  }
  if (style === "open") {
    horizontal(frame, 13, 13, 6);
    horizontal(frame, 13, 17, 6);
    block(frame, 12, 14, 1, 3);
    block(frame, 19, 14, 1, 3);
    return;
  }
  if (style === "small") {
    horizontal(frame, 14, 15, 4);
    return;
  }
  horizontal(frame, 11, 15, 10);
}

function brows(frame: Frame, style: "curious" | "focused" | "worried") {
  if (style === "curious") {
    horizontal(frame, 6, 3, 5, 1);
    dots(frame, [[21, 4], [22, 3], [23, 3], [24, 3]], 1);
  } else if (style === "focused") {
    dots(frame, [[6, 3], [7, 3], [8, 4], [9, 4]], 1);
    dots(frame, [[22, 4], [23, 4], [24, 3], [25, 3]], 1);
  } else {
    dots(frame, [[6, 4], [7, 3], [8, 3], [9, 3]], 1);
    dots(frame, [[22, 3], [23, 3], [24, 3], [25, 4]], 1);
  }
}

function pair(frame: Frame, left: EyeStyle, right: EyeStyle, gaze = 0, accent = false) {
  eye(frame, 9, left, gaze, accent);
  eye(frame, 23, right, gaze, accent);
}

function frameFor(status: AgentStatus, label: string, step: number, personality: number): Frame {
  const frame: Frame = new Map();
  const gaze = ((step + personality) % 3) - 1;
  const blink = (step + personality * 2) % (8 + personality % 4) === 0;
  const inspecting = /INSPECT|SEARCH|VIEW/.test(label.toUpperCase());

  if (status === "complete") {
    pair(frame, "narrow", personality % 2 ? "wink" : "narrow");
    mouth(frame, personality % 2 ? "smirk" : "smile");
    horizontal(frame, 21, 14, 6, 1);
    dot(frame, 27, 14, 3);
    if (step % 4 > 0) dot(frame, 28, 11 - step % 3, 1);
    if (step % 4 > 2) dot(frame, 27, 8, 1);
    return frame;
  }

  if (status === "error") {
    pair(frame, "cross", "cross");
    mouth(frame, step % 3 === 0 ? "open" : "frown");
    return frame;
  }

  if (status === "approval") {
    brows(frame, "curious");
    pair(frame, "wide", "wide", 0, true);
    mouth(frame, step % 2 ? "open" : "small");
    dot(frame, 29, 4 + step % 2, 3);
    return frame;
  }

  if (status === "waiting") {
    pair(frame, blink ? "wink" : "sleepy", blink ? "wink" : "sleepy");
    mouth(frame, personality % 2 ? "small" : "frown");
    return frame;
  }

  if (status === "testing") {
    const relieved = step % 7 >= 5;
    if (!relieved) brows(frame, "worried");
    pair(frame, relieved ? "normal" : "wide", relieved ? "normal" : "wide", relieved ? gaze : 0, !relieved);
    mouth(frame, relieved ? "smile" : "nervous");
    return frame;
  }

  if (status === "editing") {
    brows(frame, "focused");
    pair(frame, blink ? "wink" : "narrow", blink ? "wink" : "narrow", gaze);
    mouth(frame, personality % 2 ? "smirk" : "flat");
    return frame;
  }

  if (status === "searching" || inspecting) {
    pair(frame, "wide", blink ? "wink" : "normal", gaze, true);
    mouth(frame, "small");
    dot(frame, 4 + step % 3, 4 - step % 2, 3);
    return frame;
  }

  if (status === "command") {
    pair(frame, blink ? "wink" : "narrow", blink ? "wink" : "narrow", gaze);
    mouth(frame, step % 3 ? "flat" : "smirk");
    return frame;
  }

  if (status === "thinking") {
    brows(frame, "curious");
    eye(frame, 9, blink ? "wink" : "normal", gaze);
    eye(frame, 23, blink ? "wink" : "wide", -gaze, step % 5 === 0);
    mouth(frame, step % 4 === 0 ? "smirk" : "small");
    return frame;
  }

  if (status === "working") {
    brows(frame, "focused");
    pair(frame, blink ? "wink" : "normal", blink ? "wink" : "normal", gaze);
    mouth(frame, step % 5 === 0 ? "small" : "flat");
    return frame;
  }

  pair(frame, blink ? "wink" : "normal", blink ? "wink" : "normal", gaze);
  mouth(frame, personality % 2 ? "smile" : "flat");
  return frame;
}

export function MatrixFace({ status, label, now, seed, personality, attention }: {
  status: AgentStatus;
  label: string;
  now: number;
  seed: number;
  personality: number;
  attention: boolean;
}) {
  const cadence = attention ? 680 + seed % 220 : 900 + seed % 420;
  const step = Math.floor((now + seed % 13_000) / cadence);
  const frame = frameFor(status, label, step, personality);

  return <svg className={`matrix-face matrix-status-${status}`} viewBox={`0 0 ${COLUMNS * 10} ${ROWS * 10}`} aria-hidden="true" focusable="false">
    <g className="matrix-lights">
      {Array.from({ length: COLUMNS * ROWS }, (_, index) => {
        const level = frame.get(index) ?? 0;
        const x = index % COLUMNS;
        const y = Math.floor(index / COLUMNS);
        return <rect key={index} x={x * 10 + 2.25} y={y * 10 + 2.25} width="5.5" height="5.5" rx="1.2" className={`matrix-light level-${level}`} />;
      })}
    </g>
  </svg>;
}
