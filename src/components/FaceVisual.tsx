import { memo, useEffect, useState } from "react";
import type { AgentPhase, AgentStatus } from "../core/protocol";
import { AnimatedFace } from "./AnimatedFace";
import { MatrixFace } from "./MatrixFace";
import type { AnimatedFaceColor, AnimatedFaceShape, AnimatedFaceState } from "./animatedFaceModel";

type FaceVisualProps = {
  status: AgentStatus;
  phase?: AgentPhase;
  label: string;
  seed: number;
  personality: number;
  attention: boolean;
  shape?: AnimatedFaceShape;
  color?: AnimatedFaceColor;
  expression?: AnimatedFaceState;
};

const requestedImplementation = new URLSearchParams(window.location.search).get("face");
const faceImplementation = requestedImplementation ?? import.meta.env.VITE_FACE_IMPLEMENTATION ?? "grok";

function LegacyMatrixFace(props: FaceVisualProps) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  const { shape: _shape, color: _color, expression: _expression, ...legacyProps } = props;
  return <MatrixFace {...legacyProps} now={now} />;
}

/** Temporary comparison switch: append ?face=matrix to keep the previous face. */
function FaceVisualComponent(props: FaceVisualProps) {
  if (faceImplementation === "matrix") return <LegacyMatrixFace {...props} />;
  return <AnimatedFace attention={props.attention} color={props.color} expression={props.expression} personality={props.personality} phase={props.phase} seed={props.seed} shape={props.shape} status={props.status} />;
}

export const FaceVisual = memo(FaceVisualComponent, (previous, next) => {
  if (faceImplementation === "matrix" && previous.label !== next.label) return false;
  return previous.status === next.status
    && previous.phase === next.phase
    && previous.seed === next.seed
    && previous.personality === next.personality
    && previous.attention === next.attention
    && previous.shape === next.shape
    && previous.color === next.color
    && previous.expression === next.expression;
});
