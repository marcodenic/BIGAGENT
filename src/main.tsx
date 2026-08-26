import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { FaceVisual } from "./components/FaceVisual";
import { codexAdapter, genericJsonlAdapter } from "./core/adapters";
import { desktopApi, exitAppFullscreen, toggleAppFullscreen } from "./desktop";
import { formatElapsed } from "./core/reducer";
import type { AgentEvent, AgentStatus } from "./core/protocol";
import {
  observableProviders,
  providerStatusPresentation,
  visibleProviderMessage,
  type ProviderAction,
  type ProviderHealth,
} from "./core/providerPresentation";
import openaiIcon from "@lobehub/icons-static-svg/icons/openai.svg?raw";
import claudeIcon from "@lobehub/icons-static-svg/icons/claude.svg?raw";
import geminiIcon from "@lobehub/icons-static-svg/icons/gemini.svg?raw";
import qwenIcon from "@lobehub/icons-static-svg/icons/qwen.svg?raw";
import metaIcon from "@lobehub/icons-static-svg/icons/meta.svg?raw";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import {
  applySessionEvent,
  groupWorkstreams,
  projectWorkstreamPresentation,
  replaceSessionSnapshot,
  type AgentSession,
  type Workstream,
} from "./core/workstreams";
import "./styles.css";

const PROVIDER_ONBOARDING_KEY = "big-agent.provider-onboarding.v1";

function providerOnboardingComplete() {
  try { return window.localStorage.getItem(PROVIDER_ONBOARDING_KEY) === "complete"; } catch { return false; }
}

function rememberProviderOnboarding() {
  try { window.localStorage.setItem(PROVIDER_ONBOARDING_KEY, "complete"); } catch { /* The next launch will show discovery again. */ }
}

function providerHealthList(value: unknown): ProviderHealth[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is ProviderHealth => {
    if (!item || typeof item !== "object") return false;
    const candidate = item as Partial<ProviderHealth>;
    return (candidate.id === "codex" || candidate.id === "claude") && typeof candidate.detail === "string" && Array.isArray(candidate.actions);
  });
}

function faceHash(value: string) {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
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

function useViewport() {
  const [viewport, setViewport] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }));
  useEffect(() => {
    const update = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  return viewport;
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
  if (identity.includes("anthropic") || identity.includes("claude")) return { src: claudeIcon, name: "Claude", brand: "claude" };
  if (identity.includes("openai") || identity.includes("gpt") || identity.includes("o1") || identity.includes("o3")) return { src: openaiIcon, name: "OpenAI", brand: "openai" };
  if (identity.includes("google") || identity.includes("gemini")) return { src: geminiIcon, name: "Google Gemini", brand: "gemini" };
  if (identity.includes("qwen") || identity.includes("alibaba")) return { src: qwenIcon, name: "Qwen", brand: "qwen" };
  if (identity.includes("meta") || identity.includes("llama")) return { src: metaIcon, name: "Meta", brand: "meta" };
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
      return <i key={`${agent.modelProvider}-${agent.model}-${agent.effort}`} className={icon ? `provider-icon provider-${icon.brand}` : "provider-icon"} aria-label={icon?.name ?? agent.modelProvider}>
        {icon ? <span className="provider-logo" dangerouslySetInnerHTML={{ __html: icon.src }} /> : "◇"}
      </i>;
    })}</span>
    <small>{label}{configurations.length > 1 ? ` +${configurations.length - 1}` : ""}</small>
  </span>;
}

function activitySteps(agent: AgentSession, privacy: boolean, limit: number) {
  return agent.state.recent.flatMap((event, eventIndex) => {
    const status = event.status ?? "working";
    if (eventIndex > 0 && event.meta?.activityClass === "telemetry" && status === "thinking" && !event.tool && !event.command) return [];
    const label = event.label?.toUpperCase() || activityLabels[status];
    const tool = event.tool || (event.command ? commandName(event.command) : "");
    const rawDetail = event.detail || event.command || (event.files?.length ? `Updating ${event.files.slice(0, 2).join(", ")}` : "Working");
    const detail = privacy ? "Agent activity in progress" : displayText(rawDetail, "Working");
    const target = privacy ? "" : event.target || "";
    const narrative = event.meta?.activityClass === "narrative";
    const declaredKind = event.meta?.narrativeKind;
    const narrativeKind = declaredKind === "reasoning" || event.kind === "reasoning.summary"
      ? "reasoning"
      : event.kind === "plan"
        ? "plan"
      : declaredKind === "message" || narrative
        ? "message"
        : null;
    return [{ id: event.id, status, phase: event.phase, label, tool, detail, target, narrativeKind }];
  }).slice(0, limit);
}

type ActivityStep = ReturnType<typeof activitySteps>[number];
type RenderedActivity = {
  step: ActivityStep;
  exiting: boolean;
  depth: number;
  exitTop?: number;
};

const ACTIVITY_EXIT_MS = 300;

function headlineDetail(step: ActivityStep) {
  if (step.narrativeKind) return step.detail;
  if (step.phase === "receiving" || step.label === "RESULT RECEIVED") return "Processing a result";
  if (step.status === "testing") return "Running the test suite";
  if (step.status === "editing") return step.target ? `Updating ${step.target.split(/[\\/]/).pop()}` : "Updating the implementation";
  if (step.status === "searching") return step.target ? `Inspecting ${step.target.split(/[\\/]/).pop()}` : "Inspecting the current state";
  if (step.phase === "delegating") return "Coordinating another agent";
  // Command bodies belong in the compact telemetry trail. Promoting them to
  // the room-scale headline makes observation plumbing look like reasoning,
  // particularly for providers that have not emitted narrative text yet.
  if (step.status === "command" || step.phase === "executing") return "Executing the current step";
  return step.detail;
}

function RollingActivity({ steps }: { steps: ActivityStep[] }) {
  const signature = steps.map((step) => [step.id, step.status, step.phase, step.label, step.tool, step.detail, step.target].join("\u0000")).join("\u0001");
  const [rendered, setRendered] = useState<RenderedActivity[]>(() => steps.map((step, depth) => ({ step, exiting: false, depth })));
  const previousVisualTops = useRef(new Map<string, number>());
  const animations = useRef(new Map<string, Animation>());
  const exitTimers = useRef(new Map<string, number>());
  const previousSignature = useRef(signature);
  const animateNextLayout = useRef(true);
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (previousSignature.current === signature) return;
    previousSignature.current = signature;

    // Snapshot each row's *visual* position before cancelling an in-flight
    // animation. Feed updates can arrive faster than the transition duration,
    // so using the previous layout target makes rows jump or reverse direction.
    const root = container.current;
    const rootTop = root?.getBoundingClientRect().top ?? 0;
    const visualTops = new Map<string, number>();
    const relativeTops = new Map<string, number>();
    for (const element of [...(root?.querySelectorAll<HTMLElement>("[data-activity-id]:not(.is-exiting)") ?? [])]) {
      const id = element.dataset.activityId;
      if (!id) continue;
      const top = element.getBoundingClientRect().top;
      visualTops.set(id, top);
      relativeTops.set(id, top - rootTop);
    }
    previousVisualTops.current = visualTops;
    for (const animation of animations.current.values()) animation.cancel();
    animations.current.clear();

    const currentIds = new Set(steps.map((step) => step.id));
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    for (const item of rendered) {
      const id = item.step.id;
      if (currentIds.has(id)) {
        const timer = exitTimers.current.get(id);
        if (timer !== undefined) window.clearTimeout(timer);
        exitTimers.current.delete(id);
      } else if (!item.exiting && !reduceMotion && !exitTimers.current.has(id)) {
        const timer = window.setTimeout(() => {
          exitTimers.current.delete(id);
          setRendered((current) => current.filter((candidate) => candidate.step.id !== id || !candidate.exiting));
        }, ACTIVITY_EXIT_MS);
        exitTimers.current.set(id, timer);
      }
    }

    animateNextLayout.current = true;
    setRendered((current) => {
      const active = steps.map((step, depth) => ({ step, exiting: false, depth }));
      if (reduceMotion) return active;
      const outgoing = current
        .filter((item) => !currentIds.has(item.step.id))
        .map((item) => item.exiting ? item : {
          ...item,
          exiting: true,
          exitTop: relativeTops.get(item.step.id) ?? item.exitTop ?? 0,
        });
      return [...active, ...outgoing];
    });
  }, [signature]);

  useLayoutEffect(() => {
    // Removing an expired absolute-positioned exit row does not change layout.
    // Re-running FLIP then would replay a nearly finished movement and create a
    // visible hitch every 300ms.
    if (!animateNextLayout.current) return;
    animateNextLayout.current = false;
    const elements = [...(container.current?.querySelectorAll<HTMLElement>("[data-activity-id]") ?? [])];
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    for (const element of elements) {
      const id = element.dataset.activityId;
      if (!id || element.classList.contains("is-exiting")) continue;
      const top = element.getBoundingClientRect().top;
      if (reduceMotion) continue;
      const previousTop = previousVisualTops.current.get(id);
      let animation: Animation | undefined;
      if (previousTop === undefined) {
        animation = element.animate([
          { opacity: 0, transform: "translateY(-10px) scale(.985)" },
          { opacity: Number.parseFloat(getComputedStyle(element).opacity), transform: "none" },
        ], { duration: 300, easing: "cubic-bezier(.2,.8,.2,1)" });
      } else if (Math.abs(previousTop - top) > 1) {
        animation = element.animate([
          { transform: `translateY(${previousTop - top}px)` },
          { transform: "none" },
        ], { duration: 360, easing: "cubic-bezier(.2,.8,.2,1)" });
      }
      if (animation) {
        animations.current.set(id, animation);
        animation.onfinish = () => {
          if (animations.current.get(id) === animation) animations.current.delete(id);
        };
      }
    }
  }, [rendered]);

  useEffect(() => () => {
    for (const timer of exitTimers.current.values()) window.clearTimeout(timer);
    for (const animation of animations.current.values()) animation.cancel();
    exitTimers.current.clear();
    animations.current.clear();
  }, []);

  return <div ref={container} className="rolling-activity" aria-label="Recent agent activity">
    {rendered.map(({ step, exiting, depth, exitTop }) => <div
      key={step.id}
      data-activity-id={step.id}
      className={`agent-step telemetry-step telemetry-depth-${Math.min(depth, 4)} ${step.tool ? "has-tool" : "no-tool"} status-${step.status} ${exiting ? "is-exiting" : ""}`}
      style={exiting ? { top: exitTop } : undefined}
    >
      <i className="history-mark" aria-hidden="true">·</i>
      <span className="agent-number" />
      <strong>{step.label}</strong>
      {step.tool && <span className="agent-tool">· {step.tool}</span>}
      <span className="agent-detail">{step.detail}</span>
      {step.target && <span className="agent-target">{step.target}</span>}
    </div>)}
  </div>;
}

function planStepState(step: string, index: number) {
  if (/^\s*(?:\[x\]|✓|done\b|complete\b)/i.test(step)) return "complete";
  if (/^\s*(?:\[-\]|\[~\]|in progress\b|working\b)/i.test(step)) return "current";
  return index === 0 ? "current" : "upcoming";
}

function planStepText(step: string) {
  return displayText(step.replace(/^\s*(?:\[[xX ~-]\]|✓|done\s*[:.-]?|complete\s*[:.-]?|in progress\s*[:.-]?)\s*/i, ""), "Plan step");
}

function AgentPlan({ plan, privacy }: { plan: string[]; privacy: boolean }) {
  if (!plan.length) return null;
  const steps = plan.slice(0, 3);
  return <section className="agent-plan" aria-label="Current plan">
    <ol>{steps.map((step, index) => {
      const state = planStepState(step, index);
      return <li key={`${step}-${index}`} data-state={state}>
        <i aria-hidden="true">{state === "complete" ? "✓" : index + 1}</i>
        <span>{privacy ? "Plan step hidden" : planStepText(step)}</span>
      </li>;
    })}</ol>
  </section>;
}

function FittedStateLabel({ label }: { label: string }) {
  const heading = useRef<HTMLHeadingElement>(null);
  const copy = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const frame = heading.current;
    const text = copy.current;
    if (!frame || !text) return;
    const fit = () => {
      text.style.setProperty("--state-label-scale", "1");
      const available = frame.clientWidth;
      const required = text.scrollWidth;
      const scale = available > 0 && required > available ? Math.max(.58, available / required) : 1;
      text.style.setProperty("--state-label-scale", String(scale));
    };
    const observer = new ResizeObserver(fit);
    observer.observe(frame);
    fit();
    void document.fonts?.ready.then(fit);
    return () => observer.disconnect();
  }, [label]);
  return <h1 ref={heading} className="state-label"><span ref={copy}>{label}</span></h1>;
}

function ContentFittedActivity({ children }: { children: React.ReactNode }) {
  const activity = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = activity.current;
    if (!element) return;
    let frame = 0;
    const overflows = () => {
      const bounds = element.getBoundingClientRect();
      return [...element.children].some((child) => {
        const content = child.getBoundingClientRect();
        return content.top < bounds.top - 1 || content.bottom > bounds.bottom + 1;
      });
    };
    const fit = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        for (const density of ["roomy", "compact", "tight"]) {
          element.dataset.fit = density;
          if (!overflows()) break;
        }
      });
    };
    const resize = new ResizeObserver(fit);
    const mutation = new MutationObserver(fit);
    resize.observe(element);
    mutation.observe(element, { childList: true, characterData: true, subtree: true });
    fit();
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      mutation.disconnect();
    };
  }, []);
  return <div ref={activity} className="workstream-activity" data-fit="roomy">{children}</div>;
}

function latestImagePath(agent: AgentSession) {
  return agent.state.recent.find((event) => event.tool === "view_image" && typeof event.target === "string")?.target ?? "";
}

function AgentPreview({ path, privacy }: { path: string; privacy: boolean }) {
  const [source, setSource] = useState("");
  const [aspectRatio, setAspectRatio] = useState("16 / 9");
  useEffect(() => {
    const desktop = desktopApi();
    let disposed = false;
    setSource("");
    setAspectRatio("16 / 9");
    if (!path || privacy || !desktop) return;
    desktop.imagePreview(path).then((value) => { if (!disposed) setSource(value); }).catch(() => undefined);
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
  // Public narrative owns the room-scale line. Tool commands remain available
  // in the compact rolling history, where operational detail belongs.
  const focus = available.find((step) => step.narrativeKind !== null) ?? available[0];
  const telemetry = available.filter((step) => step.narrativeKind === null).slice(0, Math.max(3, trailLimit));
  return <li className={`agent-line status-${agent.state.status}`}>
    {focus && <div className={`agent-focus status-${focus.status}`}>
      <i className="agent-pulse" aria-hidden="true" />
      <span className="agent-number">{String(index + 1).padStart(2, "0")}</span>
      <span className="agent-focus-copy">{headlineDetail(focus)}</span>
    </div>}
    <AgentPlan plan={agent.state.plan} privacy={privacy} />
    <RollingActivity steps={telemetry} />
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
  const agentNames = [...new Set(workstream.agents.map((agent) => agent.agentName))];
  const agentLabel = `${agentNames[0] ?? "AGENT"}${agentNames.length > 1 ? ` +${agentNames.length - 1}` : ""}`;
  return <article className={`workstream status-${workstream.status} ${workstream.agents.length === 1 ? "single-agent" : ""} ${workstream.attention ? "needs-attention" : ""}`}>
    <div className="workstream-identity">
      <div className="project-heading"><h2>{workstream.name}</h2><span>×{workstream.agents.length}</span></div>
      <div className="identity-meta">
        <div className="workstream-dots" aria-label={`${workstream.agents.length} agents`}>
          {workstream.agents.slice(0, 6).map((agent) => <i key={agent.id} className={`state-dot status-${agent.state.status}`} />)}
        </div>
        <span className="agent-names" title={agentNames.join(" + ")}>{agentLabel}</span>
        <ModelIdentity agents={workstream.agents} />
      </div>
    </div>
    <FaceVisual status={workstream.status} phase={workstream.phase} label={workstream.label} seed={faceHash(workstream.id)} personality={personality} attention={workstream.attention} />
    <ContentFittedActivity>
      <FittedStateLabel label={workstream.label} />
      <ol>{visibleAgents.map((agent, index) => <AgentLine key={agent.id} agent={agent} index={index} privacy={privacy} trailLimit={trailLimit} />)}</ol>
      {extra > 0 && <p className="extra-agents">+ {extra} MORE AGENTS</p>}
    </ContentFittedActivity>
    <div className="workstream-visual"><WorkstreamElapsed workstream={workstream} /><AgentPreview path={previewPath} privacy={privacy} /></div>
  </article>;
}

function CompletionSummary({ agents, privacy }: { agents: AgentSession[]; privacy: boolean }) {
  const visible = [...agents].sort((a, b) => (b.state.endedAt ?? b.updatedAt) - (a.state.endedAt ?? a.updatedAt)).slice(0, 6);
  const totalRuntime = agents.reduce((total, agent) => total + agentElapsed(agent, agent.state.endedAt ?? agent.updatedAt), 0);
  return <section className="completion-summary" aria-live="polite">
    <div className="completion-hero">
      <div><small>AGENT DEPARTURES</small><h1>ALL DONE</h1><p>{plural(agents.length, "AGENT")} · {formatElapsed(totalRuntime)} COMBINED</p></div>
      <div className="completion-face"><FaceVisual status="complete" phase="completing" label="DONE" seed={faceHash(agents.map((agent) => agent.id).join("|"))} personality={faceHash(agents.map((agent) => agent.id).join("|"))} attention={false} /></div>
    </div>
    <ol>{visible.map((agent) => <li key={agent.id}>
      <div className="completion-title"><div><h2>{agent.workstreamName}</h2><span>{agent.agentName}</span></div><ModelIdentity agents={[agent]} /></div>
      <p>{privacy ? "Completed agent activity" : compactText(agent.lastMessage || agent.state.detail, "Agent completed its work")}</p>
      <div className="completion-meta"><span>RUNTIME {formatElapsed(agentElapsed(agent, agent.state.endedAt ?? agent.updatedAt))}</span><RelativeTimestamp timestamp={agent.state.endedAt ?? agent.updatedAt} /></div>
    </li>)}</ol>
  </section>;
}

function ProviderDiscovery({ providers, busy, onboarding, onAction, onContinue }: {
  providers: ProviderHealth[];
  busy: string;
  onboarding: boolean;
  onAction: (provider: ProviderHealth["id"], action: ProviderAction["id"]) => void;
  onContinue: () => void;
}) {
  const visible = observableProviders(providers);
  const discovering = providers.length === 0;
  const found = visible.length > 0;
  return <section className="empty-state provider-ready-state" aria-live="polite">
    <i className={`idle-dot ${found ? "is-live" : ""}`} />
    <h1>FIND MY AGENTS</h1>
    <p className="provider-intro">Checking supported agent connections on this machine</p>
    <div className="provider-readiness" aria-label="Agent provider telemetry status">
      {providers.map((provider) => {
        const status = providerStatusPresentation(provider.state);
        return <article key={provider.id} className={`provider-health state-${provider.state}`}>
          <div className="provider-health-heading">
            <span className={`provider-health-logo provider-${provider.id}`} dangerouslySetInnerHTML={{ __html: provider.id === "codex" ? openaiIcon : claudeIcon }} />
            <div><b>{provider.label}</b><small>{provider.transport}</small></div>
            <span className={`provider-status-chip tone-${status.tone}`}><i aria-hidden="true" />{status.label}</span>
          </div>
          <p>{provider.detail}</p>
          {provider.actions.length > 0 && <div className="provider-actions">{provider.actions.map((action) => {
            const key = `${provider.id}:${action.id}`;
            return <button key={action.id} disabled={busy === key} onClick={() => onAction(provider.id, action.id)}>{busy === key ? "WORKING…" : action.label}</button>;
          })}</div>}
        </article>;
      })}
      {providers.length === 0 && <article className="provider-health state-connecting"><div className="provider-health-heading"><div><b>DISCOVERING PROVIDERS</b><small>LOCAL TELEMETRY</small></div><span className="provider-status-chip tone-neutral"><i aria-hidden="true" />CONNECTING</span></div><p>Checking Codex App Server and Claude hooks</p></article>}
    </div>
    <div className={`provider-discovery-result ${found ? "has-agents" : discovering ? "is-discovering" : "has-no-agents"}`}>
      <div className="empty-face provider-ready-face"><FaceVisual
        status={found ? "complete" : "idle"}
        phase={found ? "completing" : "idle"}
        label={found ? "FOUND" : discovering ? "SEARCHING" : "NO AGENTS"}
        seed={found ? 29 : 17}
        personality={found ? 1 : 7}
        attention={false}
        shape={found ? "blob" : discovering ? "egg" : "wedge"}
        color={found ? "green" : discovering ? "gray" : "red"}
        expression={found ? "celebrate" : discovering ? "radar" : "confused"}
      /></div>
      <p>{discovering ? "Looking for supported agents…" : visibleProviderMessage(providers)}</p>
    </div>
    <button className="provider-continue" onClick={onContinue}>{onboarding ? "CONTINUE TO BIGAGENT" : "DONE"}</button>
  </section>;
}

function OperationalReady() {
  return <section className="empty-state operational-ready" aria-live="polite">
    <i className="idle-dot" />
    <h1>READY</h1>
    <p>Waiting for an agent</p>
    <div className="empty-face"><FaceVisual status="idle" phase="idle" label="READY" seed={41} personality={3} attention={false} shape="egg" color="blue" expression="idle" /></div>
  </section>;
}

function App() {
  const [sessions, setSessions] = useState<Record<string, AgentSession>>({});
  const [inspection, setInspection] = useState(false);
  const [help, setHelp] = useState(false);
  const [privacy, setPrivacy] = useState(false);
  const [syncError, setSyncError] = useState("");
  const [providers, setProviders] = useState<ProviderHealth[]>([]);
  const [providerBusy, setProviderBusy] = useState("");
  const [providerOnboardingDone, setProviderOnboardingDone] = useState(providerOnboardingComplete);
  const [providerSetupOpen, setProviderSetupOpen] = useState(() => !providerOnboardingComplete());
  const now = useClock();
  const viewport = useViewport();
  const workstreams = useMemo(() => groupWorkstreams(sessions, now), [sessions, now]);
  const {
    activeAgents,
    liveWorkstreams,
    liveAgents,
    attentionCount,
    completedRootAgents,
    recentlyDone,
    boardWorkstreams,
  } = useMemo(() => projectWorkstreamPresentation(workstreams, now), [workstreams, now]);
  const boardAgents = boardWorkstreams.flatMap((workstream) => workstream.agents);
  const useAgentTiles = boardAgents.length > 5;
  const displayWorkstreams = useAgentTiles
    ? boardWorkstreams.flatMap((workstream) => workstream.agents.map((agent) => ({ ...workstream, id: `${workstream.id}:${agent.id}`, agents: [agent] }))).slice(0, 9)
    : boardWorkstreams;
  const rowBudget = (viewport.height - Math.max(76, viewport.height * .14)) / Math.max(1, useAgentTiles ? Math.ceil(displayWorkstreams.length / 3) : displayWorkstreams.length);
  const trailLimit = rowBudget >= 300 ? 5 : rowBudget >= 235 ? 4 : rowBudget >= 175 ? 3 : rowBudget >= 125 ? 2 : 1;
  const agentLimit = viewport.width < 700 ? 1 : rowBudget >= 300 ? 4 : rowBudget >= 220 ? 3 : rowBudget >= 155 ? 2 : 1;

  const apply = (event: AgentEvent, source = "protocol") => setSessions((old) => applySessionEvent(old, event, Date.now(), source));

  useEffect(() => {
    const desktop = desktopApi();
    if (!desktop) return;
    let disposed = false;
    let stopSnapshots: (() => void) | undefined;
    let stopProtocol: (() => void) | undefined;
    const sourceFor = (event: AgentEvent, fallback: string) => typeof event.meta?.source === "string" && event.meta.source ? event.meta.source : fallback;
    const replaceSnapshot = (payloads: unknown, fallbackSource = "codex-desktop-fallback", authoritativeSources?: string[]) => {
      if (disposed || !Array.isArray(payloads)) return;
      const events = payloads.map((payload) => genericJsonlAdapter.ingest(payload)).filter((event): event is AgentEvent => event !== null).map((event) => {
        const source = sourceFor(event, fallbackSource);
        return { ...event, meta: { ...event.meta, source } };
      });
      const sources = authoritativeSources ?? [...new Set(events.map((event) => sourceFor(event, fallbackSource)))];
      setSessions((old) => replaceSessionSnapshot(old, events, sources));
      setSyncError("");
    };
    const connect = async () => {
      try {
        stopSnapshots = desktop.onSessions((payloads) => replaceSnapshot(payloads, "codex-desktop-fallback", ["codex-desktop-fallback"]));
        stopProtocol = desktop.onEvent((payload) => {
          const event = genericJsonlAdapter.ingest(payload) ?? codexAdapter.ingest(payload);
          if (event) apply(event, sourceFor(event, "protocol"));
        });
        const payloads = await desktop.getSessions();
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
    const desktop = desktopApi();
    if (!desktop) return;
    let disposed = false;
    const update = (payload: unknown) => { if (!disposed) setProviders(providerHealthList(payload)); };
    const stop = desktop.onProviders(update);
    desktop.getProviders().then(update).catch((error) => {
      if (!disposed) setSyncError(error instanceof Error ? error.message : String(error));
    });
    return () => { disposed = true; stop(); };
  }, []);

  const providerAction = (provider: ProviderHealth["id"], action: ProviderAction["id"]) => {
    const desktop = desktopApi();
    if (!desktop) return;
    const key = `${provider}:${action}`;
    setProviderBusy(key);
    setSyncError("");
    desktop.providerAction(provider, action).then((payload) => setProviders(providerHealthList(payload))).catch((error) => {
      setSyncError(error instanceof Error ? error.message : String(error));
    }).finally(() => setProviderBusy(""));
  };

  const finishProviderSetup = () => {
    rememberProviderOnboarding();
    setProviderOnboardingDone(true);
    setProviderSetupOpen(false);
  };

  useEffect(() => {
    const desktop = desktopApi();
    if (!desktop) return;
    desktop.setScreenAwake(liveAgents.length > 0).catch(() => undefined);
  }, [liveAgents.length]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === "f") toggleAppFullscreen().catch(() => undefined);
      if (event.key === "Escape") { exitAppFullscreen().catch(() => undefined); setHelp(false); setProviderSetupOpen(false); }
      if (event.key.toLowerCase() === "i") setInspection((value) => !value);
      if (event.key === "?") setHelp((value) => !value);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const summary = liveWorkstreams.length > 0
    ? `${plural(liveWorkstreams.length, "WORKSTREAM")} · ${plural(liveAgents.length, "AGENT")}${attentionCount ? ` · ${attentionCount} NEEDS YOU` : ""}${recentlyDone ? ` · ${recentlyDone} RECENTLY DONE` : ""}`
    : boardWorkstreams.length > 0
      ? attentionCount
        ? `${plural(boardWorkstreams.length, "WORKSTREAM")} · ${attentionCount} NEEDS YOU`
        : `${plural(boardWorkstreams.length, "WORKSTREAM")} · ${recentlyDone} RECENTLY DONE`
    : completedRootAgents.length > 0
      ? <CompletedHeaderSummary agents={completedRootAgents} />
      : "WAITING FOR AN AGENT";

  return <main className={`app board-count-${Math.min(Math.max(displayWorkstreams.length, 1), 9)} ${useAgentTiles ? "agent-tile-board" : ""} ${rowBudget < 190 ? "layout-compact" : ""} ${viewport.width < 700 ? "layout-narrow" : ""} ${viewport.width / viewport.height < .78 ? "layout-portrait" : ""} ${attentionCount ? "has-attention" : ""}`}>
    <header>
      <div className="brand"><span className="brand-face">-_</span><b>BIG AGENT</b></div>
      <div className="summary">{providerSetupOpen ? "AGENT CONNECTIONS" : summary}</div>
      <div className="header-actions">
        <button className={`agents-toggle ${providerSetupOpen ? "is-active" : ""}`} onClick={() => { setInspection(false); setProviderSetupOpen((value) => !value); }} aria-label="Manage agent connections">{providerSetupOpen ? "BACK" : "AGENTS"}</button>
        <button className="fullscreen-toggle" onClick={() => toggleAppFullscreen().catch(() => undefined)} aria-label="Toggle fullscreen" title="Toggle fullscreen (F)">⛶</button>
        <button onClick={() => { setProviderSetupOpen(false); setInspection((value) => !value); }} aria-label="Toggle inspection">{inspection ? "AMBIENT" : "INSPECT"}</button>
      </div>
    </header>

    {providerSetupOpen
      ? <ProviderDiscovery providers={providers} busy={providerBusy} onboarding={!providerOnboardingDone} onAction={providerAction} onContinue={finishProviderSetup} />
      : displayWorkstreams.length > 0
      ? <section className="workstream-board" aria-live="polite">{displayWorkstreams.map((workstream) => <WorkstreamRow key={workstream.id} workstream={workstream} personality={faceHash(workstream.id)} privacy={privacy} agentLimit={agentLimit} trailLimit={trailLimit} />)}</section>
      : completedRootAgents.length > 0
        ? <CompletionSummary agents={completedRootAgents} privacy={privacy} />
        : <OperationalReady />}

    <footer>
      <span className={syncError ? "sync-error" : ""} title={syncError}>{syncError ? `FEED: ${syncError}` : providerSetupOpen ? "PROVIDER DISCOVERY" : displayWorkstreams.length ? "LIVE WORKSTREAMS" : completedRootAgents.length ? "COMPLETED WORK" : "AMBIENT MODE"}</span>
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
