import { memo, useEffect, useId, useMemo, useRef, useState, type ComponentType, type CSSProperties } from "react";
import type { AgentPhase, AgentStatus } from "../core/protocol";
import { OfficialGrokBotRenderer } from "../vendor/grok-bot-0.18/renderer";
import {
  OFFICIAL_GROK_COLORS,
  animatedStateForStatus,
  personalityColor,
  personalityShape,
  type AnimatedFaceColor,
  type AnimatedFaceShape,
  type AnimatedFaceState,
} from "./animatedFaceModel";

const ShippedGrokBotRenderer = OfficialGrokBotRenderer as ComponentType<{
  id: string;
  className: string;
  state: AnimatedFaceState;
  shape: AnimatedFaceShape;
  inkGradient: { from: string; to: string; angle: number };
  paused: boolean;
}>;

function AnimatedFaceComponent({ status, phase, seed, personality, attention, size, shape, color, expression }: {
  status: AgentStatus;
  phase?: AgentPhase;
  seed: number;
  personality: number;
  attention: boolean;
  size?: number | string;
  shape?: AnimatedFaceShape;
  color?: AnimatedFaceColor;
  expression?: AnimatedFaceState;
}) {
  const reactId = useId().replace(/:/g, "");
  const container = useRef<HTMLSpanElement>(null);
  const [paused, setPaused] = useState(() => document.hidden);
  const state = expression ?? animatedStateForStatus(status, attention, phase);
  const selectedShape = shape ?? personalityShape(personality);
  const selectedColor = color ?? personalityColor(personality);
  const palette = OFFICIAL_GROK_COLORS[selectedColor];
  const style = useMemo(() => ({
    "--fg": palette.flat,
    "--bg": "#0b0c0a",
    ...(size == null ? {} : { width: size, height: size }),
  } as CSSProperties), [palette.flat, size]);
  const inkGradient = useMemo(() => ({ from: palette.from, to: palette.to, angle: 135 }), [palette.from, palette.to]);

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    let visible = true;
    const update = () => setPaused(document.hidden || !visible);
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      update();
    }, { threshold: 0.01 });
    observer.observe(element);
    document.addEventListener("visibilitychange", update);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", update);
    };
  }, []);

  return <span
    ref={container}
    aria-hidden="true"
    className={`matrix-face animated-face official-grok-face official-grok-face-${state}`}
    data-face-engine="official-grok-bot-0.18"
    data-face-state={state}
    data-face-seed={seed}
    style={style}
  >
    <ShippedGrokBotRenderer
      id={`big-agent-grok-${reactId}`}
      className="official-grok-renderer"
      state={state}
      shape={selectedShape}
      inkGradient={inkGradient}
      paused={paused}
    />
  </span>;
}

export const AnimatedFace = memo(AnimatedFaceComponent);
