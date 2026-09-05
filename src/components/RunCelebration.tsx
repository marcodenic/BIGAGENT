import { useEffect, useRef, useState } from "react";
import { faceHash } from "./animatedFaceModel";
import { FaceVisual } from "./FaceVisual";
import type { RunRecap } from "../core/runRecap";
import { formatElapsed } from "../core/reducer";

function CelebratingFace({ identity, index }: { identity: string; index: number }) {
  const [expression, setExpression] = useState<"happy" | "celebrate">("happy");
  useEffect(() => {
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (motion.matches) return;
    const start = window.setTimeout(() => setExpression("celebrate"), Math.min(index, 8) * 140);
    const end = window.setTimeout(() => setExpression("happy"), 4500 + Math.min(index, 8) * 140);
    const stop = () => { if (motion.matches) { window.clearTimeout(start); window.clearTimeout(end); setExpression("happy"); } };
    motion.addEventListener("change", stop);
    return () => { window.clearTimeout(start); window.clearTimeout(end); motion.removeEventListener("change", stop); };
  }, [index]);
  const personality = faceHash(identity);
  return <FaceVisual status="complete" phase="completing" label="DONE" seed={personality} personality={personality} attention={false} expression={expression} />;
}

/** Export only the anonymous recap artwork, never the app or its activity panel. */
async function saveImage(root: HTMLElement, count: number, elapsed: string) {
  const faces = [...root.querySelectorAll<SVGSVGElement>(".recap-character svg")];
  const columns = Math.min(4, faces.length);
  const rows = Math.ceil(faces.length / columns);
  const canvas = document.createElement("canvas");
  canvas.width = 1600; canvas.height = 460 + rows * 300;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Image export is unavailable");
  ctx.fillStyle = "#070806"; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.textAlign = "center"; ctx.fillStyle = "#70aa8c"; ctx.font = '500 110px "Geist Variable", sans-serif';
  ctx.fillText("ALL DONE", 800, 170);
  ctx.fillStyle = "#8b8e84"; ctx.font = '28px "Geist Mono Variable", monospace';
  ctx.fillText(`${count} ${count === 1 ? "AGENT" : "AGENTS"} · ${elapsed}`, 800, 240);
  for (const [index, svg] of faces.entries()) {
    const clone = svg.cloneNode(true) as SVGSVGElement;
    clone.setAttribute("width", "240"); clone.setAttribute("height", "240");
    clone.style.transform = "none";
    clone.style.width = "240px"; clone.style.height = "240px";
    clone.style.setProperty("--fg", getComputedStyle(svg).getPropertyValue("--fg"));
    clone.style.setProperty("--bg", "#0b0c0a");
    {
      const img = new Image();
      img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(clone))}`;
      await img.decode();
      const x = (1600 - columns * 320) / 2 + (index % columns) * 320;
      ctx.drawImage(img, x + 40, 290 + Math.floor(index / columns) * 300, 240, 240);
      const label = svg.closest(".recap-character")?.querySelector("small")?.textContent;
      if (label) { ctx.font = '22px "Geist Mono Variable", monospace'; ctx.fillText(label, x + 160, 565 + Math.floor(index / columns) * 300); }
    }
  }
  ctx.font = '22px "Geist Mono Variable", monospace'; ctx.fillText("BIG AGENT", 800, canvas.height - 45);
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error("Could not create image")), "image/png"));
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a"); link.href = url; link.download = "big-agent-run.png"; link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function RunCelebration({ recap }: { recap: RunRecap }) {
  const root = useRef<HTMLElement>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const agents = Object.values(recap.participants);
  const groups = new Map<string, number>();
  for (const agent of agents) groups.set(agent.workstreamId, (groups.get(agent.workstreamId) ?? 0) + 1);
  const elapsed = formatElapsed(Math.max(0, (recap.endedAt ?? recap.startedAt) - recap.startedAt));
  return <section ref={root} className="run-recap" aria-label="Completed run">
    <div className="recap-heading" aria-live="polite"><h1>ALL DONE</h1><p>{agents.length} {agents.length === 1 ? "AGENT" : "AGENTS"} <span>·</span> {elapsed}</p></div>
    <div className={`recap-cast ${groups.size > 4 ? "recap-cast-grid" : ""}`}>
      {[...groups].map(([identity, count], index) => <div className="recap-character" key={identity} role="img" aria-label={`${count} completed ${count === 1 ? "agent" : "agents"}`}>
        <CelebratingFace identity={identity} index={index} />
        {count > 1 && <small>×{count} AGENTS</small>}
      </div>)}
    </div>
    <p className="recap-ready">Waiting for your next run</p>
    <button className="recap-save" disabled={saving} onClick={async () => {
      if (!root.current) return;
      setSaving(true); setError("");
      try { await saveImage(root.current, agents.length, elapsed); }
      catch { setError("Could not save image. Please try again."); }
      finally { setSaving(false); }
    }}>{saving ? "SAVING…" : "SAVE IMAGE"}</button>
    {error && <p role="alert">{error}</p>}
  </section>;
}
