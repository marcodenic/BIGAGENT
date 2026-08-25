import { memo, useEffect, useState } from "react";
import type { AgentPhase, AgentStatus } from "../core/protocol";
import { AnimatedFace } from "./AnimatedFace";
import { MatrixFace } from "./MatrixFace";

type FaceVisualProps = {
  status: AgentStatus;
  phase?: AgentPhase;
  label: string;
  seed: number;
  personality: number;
  attention: boolean;
};

const requestedImplementation = new URLSearchParams(window.location.search).get("face");
const faceImplementation = requestedImplementation ?? import.meta.env.VITE_FACE_IMPLEMENTATION ?? "grok";

function LegacyMatrixFace(props: FaceVisualProps) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  return <MatrixFace {...props} now={now} />;
}

/** Temporary comparison switch: append ?face=matrix to keep the previous face. */
function FaceVisualComponent(props: FaceVisualProps) {
  if (faceImplementation === "matrix") return <LegacyMatrixFace {...props} />;
  return <AnimatedFace attention={props.attention} personality={props.personality} phase={props.phase} seed={props.seed} status={props.status} />;
}

export const FaceVisual = memo(FaceVisualComponent, (previous, next) => {
  if (faceImplementation === "matrix" && previous.label !== next.label) return false;
  return previous.status === next.status
    && previous.phase === next.phase
    && previous.seed === next.seed
    && previous.personality === next.personality
    && previous.attention === next.attention;
});
