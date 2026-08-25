import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { FaceVisual } from "./components/FaceVisual";
import { codexAdapter, genericJsonlAdapter } from "./core/adapters";
import { formatElapsed } from "./core/reducer";
import type { AgentEvent, AgentStatus } from "./core/protocol";
import openaiIcon from "@lobehub/icons-static-svg/icons/openai.svg";
import claudeIcon from "@lobehub/icons-static-svg/icons/claude.svg";
import geminiIcon from "@lobehub/icons-static-svg/icons/gemini.svg";
import qwenIcon from "@lobehub/icons-static-svg/icons/qwen.svg";
import metaIcon from "@lobehub/icons-static-svg/icons/meta.svg";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import {
  applySessionEvent,
  groupWorkstreams,
  isActiveStatus,
  replaceSessionSource,
  type AgentSession,
  type Workstream,
} from "./core/workstreams";
import "./styles.css";

function faceHash(value: string) {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function personalitiesForWorkstreams(workstreams: Workstream[]) {
  const assigned = new Map<string, number>();
  const visible = new Set<number>();
  for (const workstream of workstreams) {
    const hash = faceHash(workstream.id);
    const start = hash % 8;
    let personality = start;
    for (let step = 0; step < 8; step += 1) {
      const candidate = (start + step) % 8;
      if (!visible.has(candidate)) {
        personality = candidate;
        break;
      }
    }
    visible.add(personality);
    assigned.set(workstream.id, personality);
  }
  return assigned;
}

const activityLabels: Record<AgentStatus, string> = {
  idle: "IDLE", thinking: "THINKING", searching: "SEARCHING", working: "WORKING", command: "TOOL",
  editing: "EDITING", testing: "TESTING", waiting: "WAITING", approval: "APPROVAL", complete: "DONE", error: "ERROR",
};

function useClock() {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

function useDeadlineClock(deadline: number) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const current = Date.now();
    setNow(current);
    if (deadline <= current) return;
    const timer = window.setInterval(() => {
      const next = Date.now();
      setNow(next);
      if (next >= deadline) window.clearInterval(timer);
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [deadline]);
  return now;
}

function useViewport() {
  const [viewport, setViewport] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }));
  useEffect(() => {
    const update = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  return viewport;
}

function isTauri() {
  return "__TAURI_INTERNALS__" in window;
}

async function toggleAppFullscreen() {
  if (isTauri()) {
    const appWindow = getCurrentWindow();
    await appWindow.setFullscreen(!(await appWindow.isFullscreen()));
    return;
  }
  if (document.fullscreenElement) await document.exitFullscreen();
  else await document.documentElement.requestFullscreen();
}

function compactText(value: string, fallback: string) {
  const text = value.replace(/\s+/g, " ").trim();
  return text || fallback;
}

function displayText(value: string, fallback: string) {
  const text = value
    .replace(/^\s{0,3}#{1,6}\s+/g, "")
    .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^\s*[-*+]\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
  return text || fallback;
}

function commandName(command: string) {
  const executable = command.trim().split(/\s+/)[0] ?? "";
  return executable.split("/").pop() ?? executable;
}

function workstreamElapsed(workstream: Workstream, now: number) {
  if (workstream.startedAt === null) return 0;
  return Math.max(0, (workstream.endedAt ?? now) - workstream.startedAt);
}

function agentElapsed(agent: AgentSession, now: number) {
  if (agent.state.startedAt === null) return 0;
  return Math.max(0, (agent.state.endedAt ?? now) - agent.state.startedAt);
}

function relativeTime(timestamp: number, now: number) {
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1_000));
  if (seconds < 60) return `${seconds}S AGO`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}M AGO`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}H AGO`;
  return `${Math.floor(hours / 24)}D AGO`;
}

function plural(count: number, one: string, many = `${one}S`) {
  return `${count} ${count === 1 ? one : many}`;
}

function providerIcon(provider: string, model: string) {
  const identity = `${provider} ${model}`.toLowerCase();
  if (identity.includes("anthropic") || identity.includes("claude")) return { src: claudeIcon, name: "Claude" };
  if (identity.includes("openai") || identity.includes("gpt") || identity.includes("o1") || identity.includes("o3")) return { src: openaiIcon, name: "OpenAI" };
  if (identity.includes("google") || identity.includes("gemini")) return { src: geminiIcon, name: "Google Gemini" };
  if (identity.includes("qwen") || identity.includes("alibaba")) return { src: qwenIcon, name: "Qwen" };
  if (identity.includes("meta") || identity.includes("llama")) return { src: metaIcon, name: "Meta" };
  return null;
}

function displayModel(model: string) {
  return model.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function ModelIdentity({ agents }: { agents: AgentSession[] }) {
  const configurations = [...new Map(agents.map((agent) => {
    const key = `${agent.modelProvider}\u0000${agent.model}\u0000${agent.effort}`;
    return [key, agent] as const;
  })).values()];
  const primary = configurations[0];
  if (!primary || primary.model === "unknown model") return <span className="model-identity model-unknown"><span className="provider-icons"><i>◇</i></span><small>MODEL UNKNOWN</small></span>;
  const label = `${displayModel(primary.model)}${primary.effort ? ` · ${primary.effort.toUpperCase()}` : ""}`;
  const full = configurations.map((agent) => `${displayModel(agent.model)}${agent.effort ? ` · ${agent.effort.toUpperCase()}` : ""}`).join(" + ");
  return <span className="model-identity" title={full}>
    <span className="provider-icons">{configurations.slice(0, 3).map((agent) => {
      const icon = providerIcon(agent.modelProvider, agent.model);
      return <i key={`${agent.modelProvider}-${agent.model}-${agent.effort}`} aria-label={icon?.name ?? agent.modelProvider}>{icon ? <img src={icon.src} alt="" /> : "◇"}</i>;
    })}</span>
    <small>{label}{configurations.length > 1 ? ` +${configurations.length - 1}` : ""}</small>
  </span>;
}

function activitySteps(agent: AgentSession, privacy: boolean, limit: number) {
  const seen = new Set<string>();
  return agent.state.recent.flatMap((event) => {
    const status = event.status ?? "working";
    if (event.meta?.activityClass === "telemetry" && status === "thinking" && !event.tool && !event.command) return [];
    const label = event.label?.toUpperCase() || activityLabels[status];
    const tool = event.tool || (event.command ? commandName(event.command) : "");
    const rawDetail = event.detail || event.command || (event.files?.length ? `Updating ${event.files.slice(0, 2).join(", ")}` : "Working");
    const detail = privacy ? "Agent activity in progress" : displayText(rawDetail, "Working");
    const target = privacy ? "" : event.target || "";
    const key = `${label}\u0000${tool}\u0000${detail}\u0000${target}`;
    if (seen.has(key)) return [];
    seen.add(key);
    const narrative = event.meta?.activityClass === "narrative";
    const declaredKind = event.meta?.narrativeKind;
    const narrativeKind = declaredKind === "reasoning" || event.kind === "reasoning.summary"
      ? "reasoning"
      : declaredKind === "message" || narrative
        ? "message"
        : null;
    return [{ id: event.id, status, label, tool, detail, target, narrativeKind }];
  }).slice(0, limit);
}

function latestImagePath(agent: AgentSession) {
  return agent.state.recent.find((event) => event.tool === "view_image" && typeof event.target === "string")?.target ?? "";
}

function AgentPreview({ path, privacy }: { path: string; privacy: boolean }) {
  const [source, setSource] = useState("");
  const [aspectRatio, setAspectRatio] = useState("16 / 9");
  useEffect(() => {
    let disposed = false;
    setSource("");
    setAspectRatio("16 / 9");
    if (!path || privacy || !isTauri()) return;
    invoke<string>("image_preview", { path }).then((value) => { if (!disposed) setSource(value); }).catch(() => undefined);
    return () => { disposed = true; };
  }, [path, privacy]);
  if (!source) return null;
  const name = path.split(/[\\/]/).pop() || "Visual context";
  return <figure className="agent-preview">
    <div className="agent-preview-media" style={{ aspectRatio }}>
      <img src={source} alt={`Latest image inspected: ${name}`} onLoad={(event) => {
        const image = event.currentTarget;
        if (image.naturalWidth && image.naturalHeight) setAspectRatio(`${image.naturalWidth} / ${image.naturalHeight}`);
      }} onError={() => setSource("")} />
    </div>
    <figcaption><span>VIEWING</span><b>{name}</b></figcaption>
  </figure>;
}

function AgentLine({ agent, index, privacy, trailLimit }: { agent: AgentSession; index: number; privacy: boolean; trailLimit: number }) {
  const available = activitySteps(agent, privacy, 80);
  const reasoning = available.find((step) => step.narrativeKind === "reasoning");
  const message = available.find((step) => step.narrativeKind === "message");
  const focus = reasoning ?? message ?? available[0];
  const commentary = message?.id !== focus?.id ? message : undefined;
  const telemetry = available
    .filter((step) => step.narrativeKind === null && step.id !== focus?.id)
    .slice(0, Math.min(3, Math.max(1, trailLimit)));
  return <li className={`agent-line status-${agent.state.status}`}>
    {focus && <div className={`agent-focus status-${focus.status}`}>
      <i className="agent-pulse" aria-hidden="true" />
      <span className="agent-number">{String(index + 1).padStart(2, "0")}</span>
      <span>{focus.detail}</span>
    </div>}
    {commentary && <div className="agent-commentary"><i aria-hidden="true">·</i><span>{commentary.detail}</span></div>}
    {telemetry.map((step, depth) => <div key={step.id} className={`agent-step telemetry-step telemetry-depth-${depth} ${step.tool ? "has-tool" : "no-tool"} status-${step.status}`}>
      <i className="history-mark" aria-hidden="true">·</i>
      <span className="agent-number" />
      <strong>{step.label}</strong>
      {step.tool && <span className="agent-tool">· {step.tool}</span>}
      <span className="agent-detail">{step.detail}</span>
      {step.target && <span className="agent-target">{step.target}</span>}
    </div>)}
  </li>;
}

function WorkstreamElapsed({ workstream }: { workstream: Workstream }) {
  const now = useClock();
  return <time>{formatElapsed(workstreamElapsed(workstream, now))}</time>;
}

function RelativeTimestamp({ timestamp }: { timestamp: number }) {
  const now = useClock();
  return <time>{relativeTime(timestamp, now)}</time>;
}

function CompletedHeaderSummary({ agents }: { agents: AgentSession[] }) {
  const now = useClock();
  const last = Math.max(...agents.map((agent) => agent.state.endedAt ?? agent.updatedAt));
  return <>{plural(agents.length, "AGENT")} COMPLETED · LAST {relativeTime(last, now)}</>;
}

function WorkstreamRow({ workstream, personality, privacy, agentLimit, trailLimit }: { workstream: Workstream; personality: number; privacy: boolean; agentLimit: number; trailLimit: number }) {
  const visibleAgents = workstream.agents.slice(0, agentLimit);
  const extra = workstream.agents.length - visibleAgents.length;
  const previewPath = workstream.agents.map(latestImagePath).find(Boolean) ?? "";
  return <article className={`workstream status-${workstream.status} ${workstream.attention ? "needs-attention" : ""}`}>
    <div className="workstream-identity">
      <div className="project-heading"><h2>{workstream.name}</h2><span>×{workstream.agents.length}</span></div>
      <div className="identity-meta">
        <div className="workstream-dots" aria-label={`${workstream.agents.length} agents`}>
          {workstream.agents.slice(0, 6).map((agent) => <i key={agent.id} className={`state-dot status-${agent.state.status}`} />)}
        </div>
        <ModelIdentity agents={workstream.agents} />
      </div>
    </div>
    <FaceVisual status={workstream.status} label={workstream.label} seed={faceHash(workstream.id)} personality={personality} attention={workstream.attention} />
    <div className="workstream-activity">
      <h1>{workstream.label}</h1>
      <ol>{visibleAgents.map((agent, index) => <AgentLine key={agent.id} agent={agent} index={index} privacy={privacy} trailLimit={trailLimit} />)}</ol>
      {extra > 0 && <p className="extra-agents">+ {extra} MORE AGENTS</p>}
    </div>
    <div className="workstream-visual"><WorkstreamElapsed workstream={workstream} /><AgentPreview path={previewPath} privacy={privacy} /></div>
  </article>;
}

function CompletionSummary({ agents, privacy }: { agents: AgentSession[]; privacy: boolean }) {
  const visible = [...agents].sort((a, b) => (b.state.endedAt ?? b.updatedAt) - (a.state.endedAt ?? a.updatedAt)).slice(0, 6);
  const totalRuntime = agents.reduce((total, agent) => total + agentElapsed(agent, agent.state.endedAt ?? agent.updatedAt), 0);
  return <section className="completion-summary" aria-live="polite">
    <div className="completion-hero">
      <div><small>AGENT DEPARTURES</small><h1>ALL DONE</h1><p>{plural(agents.length, "AGENT")} · {formatElapsed(totalRuntime)} COMBINED</p></div>
      <div className="completion-face"><FaceVisual status="complete" label="DONE" seed={faceHash(agents.map((agent) => agent.id).join("|"))} personality={agents.length % 8} attention={false} /></div>
    </div>
    <ol>{visible.map((agent) => <li key={agent.id}>
      <div className="completion-title"><div><h2>{agent.workstreamName}</h2><span>{agent.agentName}</span></div><ModelIdentity agents={[agent]} /></div>
      <p>{privacy ? "Completed agent activity" : compactText(agent.lastMessage || agent.state.detail, "Agent completed its work")}</p>
      <div className="completion-meta"><span>RUNTIME {formatElapsed(agentElapsed(agent, agent.state.endedAt ?? agent.updatedAt))}</span><RelativeTimestamp timestamp={agent.state.endedAt ?? agent.updatedAt} /></div>
    </li>)}</ol>
  </section>;
}

function App() {
  const [sessions, setSessions] = useState<Record<string, AgentSession>>({});
  const [inspection, setInspection] = useState(false);
  const [help, setHelp] = useState(false);
  const [privacy, setPrivacy] = useState(false);
  const [syncError, setSyncError] = useState("");
  const viewport = useViewport();
  const workstreams = useMemo(() => groupWorkstreams(sessions, Date.now(), Number.POSITIVE_INFINITY), [sessions]);
  const activeAgents = workstreams.flatMap((workstream) => workstream.agents).filter((agent) => isActiveStatus(agent.state.status));
  const isLiveAgent = (agent: AgentSession) => isActiveStatus(agent.state.status);
  const liveWorkstreams = workstreams.filter((workstream) => workstream.agents.some(isLiveAgent));
  const liveAgents = workstreams.flatMap((workstream) => workstream.agents).filter(isLiveAgent);
  const attentionCount = liveAgents.filter((agent) => agent.state.attention).length;
  const completedAgents = workstreams.flatMap((workstream) => workstream.agents).filter((agent) => agent.state.status === "complete");
  const recentDeadline = Math.max(0, ...workstreams
    .filter((workstream) => workstream.status === "complete")
    .map((workstream) => (workstream.endedAt ?? workstream.updatedAt) + 20_000));
  const recentNow = useDeadlineClock(recentDeadline);
  const recentlyDone = workstreams.filter((workstream) => workstream.status === "complete" && recentNow - (workstream.endedAt ?? workstream.updatedAt) <= 20_000).length;
  const boardWorkstreams = liveWorkstreams.length ? workstreams.flatMap((workstream) => {
    const live = workstream.agents.filter(isLiveAgent);
    if (live.length) return [{ ...workstream, agents: live }];
    return workstream.status === "complete" && recentNow - (workstream.endedAt ?? workstream.updatedAt) <= 20_000 ? [workstream] : [];
  }) : [];
  const rowBudget = (viewport.height - Math.max(76, viewport.height * .14)) / Math.max(1, boardWorkstreams.length);
  const trailLimit = rowBudget >= 300 ? 5 : rowBudget >= 235 ? 4 : rowBudget >= 175 ? 3 : rowBudget >= 125 ? 2 : 1;
  const agentLimit = viewport.width < 700 ? 1 : rowBudget >= 300 ? 4 : rowBudget >= 220 ? 3 : rowBudget >= 155 ? 2 : 1;

  const apply = (event: AgentEvent, source = "protocol") => setSessions((old) => applySessionEvent(old, event, Date.now(), source));

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let stopSnapshots: (() => void) | undefined;
    let stopProtocol: (() => void) | undefined;
    const replaceSnapshot = (payloads: unknown[]) => {
      if (disposed || !Array.isArray(payloads)) return;
      const events = payloads.map((payload) => genericJsonlAdapter.ingest(payload)).filter((event): event is AgentEvent => event !== null);
      setSessions((old) => replaceSessionSource(old, "codex-desktop", events));
      setSyncError("");
    };
    const connect = async () => {
      try {
        stopSnapshots = await listen<unknown[]>("big-agent:sessions", (message) => replaceSnapshot(message.payload));
        stopProtocol = await listen<unknown>("big-agent:event", (message) => {
          const event = genericJsonlAdapter.ingest(message.payload) ?? codexAdapter.ingest(message.payload);
          if (event) apply(event, "protocol");
        });
        const payloads = await invoke<unknown[]>("codex_desktop_sessions");
        replaceSnapshot(payloads);
      } catch (error) {
        if (!disposed) setSyncError(error instanceof Error ? error.message : String(error));
      }
    };
    connect();
    return () => {
      disposed = true;
      stopSnapshots?.();
      stopProtocol?.();
    };
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    invoke("set_screen_awake", { active: liveAgents.length > 0 }).catch(() => undefined);
  }, [liveAgents.length]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === "f") toggleAppFullscreen().catch(() => undefined);
      if (event.key === "Escape") { invoke("exit_fullscreen").catch(() => document.exitFullscreen?.()); setHelp(false); }
      if (event.key.toLowerCase() === "i") setInspection((value) => !value);
      if (event.key === "?") setHelp((value) => !value);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const beginDrag = (event: React.MouseEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).closest("button, select")) return;
    if (isTauri()) getCurrentWindow().startDragging().catch(() => undefined);
  };

  const summary = liveWorkstreams.length > 0
    ? `${plural(liveWorkstreams.length, "WORKSTREAM")} · ${plural(liveAgents.length, "AGENT")}${attentionCount ? ` · ${attentionCount} NEEDS YOU` : ""}${recentlyDone ? ` · ${recentlyDone} RECENTLY DONE` : ""}`
    : completedAgents.length > 0
      ? <CompletedHeaderSummary agents={completedAgents} />
      : "WAITING FOR AN AGENT";
  const workstreamPersonalities = personalitiesForWorkstreams(boardWorkstreams);

  return <main className={`app board-count-${Math.min(Math.max(boardWorkstreams.length, 1), 5)} ${rowBudget < 190 ? "layout-compact" : ""} ${viewport.width < 700 ? "layout-narrow" : ""} ${viewport.width / viewport.height < .78 ? "layout-portrait" : ""} ${attentionCount ? "has-attention" : ""}`}>
    <header data-tauri-drag-region onMouseDown={beginDrag}>
      <div className="brand" data-tauri-drag-region><span className="brand-face">-_</span><b>BIG AGENT</b></div>
      <div className="summary" data-tauri-drag-region>{summary}</div>
      <div className="header-actions">
        <button className="fullscreen-toggle" onClick={() => toggleAppFullscreen().catch(() => undefined)} aria-label="Toggle fullscreen" title="Toggle fullscreen (F)">⛶</button>
        <button onClick={() => setInspection((value) => !value)} aria-label="Toggle inspection">{inspection ? "AMBIENT" : "INSPECT"}</button>
      </div>
    </header>

    {boardWorkstreams.length > 0
      ? <section className="workstream-board" aria-live="polite">{boardWorkstreams.map((workstream) => <WorkstreamRow key={workstream.id} workstream={workstream} personality={workstreamPersonalities.get(workstream.id) ?? 0} privacy={privacy} agentLimit={agentLimit} trailLimit={trailLimit} />)}</section>
      : completedAgents.length > 0
        ? <CompletionSummary agents={completedAgents} privacy={privacy} />
      : <section className="empty-state" aria-live="polite"><i className="idle-dot" /><h1>READY</h1><p>Waiting for an agent</p><div className="empty-face"><FaceVisual status="idle" label="READY" seed={41} personality={3} attention={false} /></div></section>}

    <footer>
      <span className={syncError ? "sync-error" : ""} title={syncError}>{syncError ? `FEED: ${syncError}` : boardWorkstreams.length ? "LIVE WORKSTREAMS" : completedAgents.length ? "COMPLETED WORK" : "AMBIENT MODE"}</span>
      <div className="controls">
        <button onClick={() => setPrivacy((value) => !value)}>{privacy ? "PRIVATE" : "OPEN"}</button>
      </div>
    </footer>

    {inspection && <aside className="inspection">
      <div><h2>ACTIVITY</h2><p className="quiet">{plural(workstreams.length, "WORKSTREAM")} · {plural(activeAgents.length, "ACTIVE AGENT")}</p></div>
      {workstreams.map((workstream) => <section key={workstream.id}><h3>{workstream.name}</h3>{workstream.agents.map((agent) => <article key={agent.id}><b>{agent.state.label}</b><span>{privacy ? "Activity hidden" : agent.state.detail || agent.state.command || agent.state.status}</span></article>)}</section>)}
      {workstreams.length === 0 && <p className="quiet">No live activity.</p>}
    </aside>}

    {help && <div className="help" role="dialog"><button onClick={() => setHelp(false)}>×</button><h2>SHORTCUTS</h2><p><kbd>F</kbd> fullscreen <kbd>Esc</kbd> exit</p><p><kbd>I</kbd> inspection</p><p><kbd>?</kbd> this guide</p></div>}
  </main>;
}

createRoot(document.getElementById("root")!).render(<App />);
