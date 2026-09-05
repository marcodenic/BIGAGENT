#!/usr/bin/env node
/** Local telemetry bridge. No repository contents leave localhost. */
import { spawn } from "node:child_process";

const configuredUrl = process.env.BIG_AGENT_URL || `http://127.0.0.1:${process.env.BIG_AGENT_PORT || 19777}/event`;
const serverUrl = new URL(configuredUrl);
serverUrl.pathname = serverUrl.pathname === "/event" ? "" : serverUrl.pathname.replace(/\/$/, "");

async function post(path, value, headers = {}, timeoutMs) {
  const endpoint = new URL(serverUrl);
  endpoint.pathname = `${serverUrl.pathname.replace(/\/$/, "")}${path}`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(value),
    signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
  });
  if (!response.ok) throw new Error(`BIG AGENT returned ${response.status}: ${await response.text()}`);
}

function hookOutput(value, provider) {
  // Gemini requires hook stdout, when present, to be one JSON object. An empty
  // object is explicitly non-controlling and keeps this bridge observational.
  if (provider === "gemini") return "{}\n";
  if (provider !== "codex") return "";
  const eventName = String(value?.hook_event_name ?? value?.hookEventName ?? "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "");
  // Stop hooks require JSON output. PreToolUse and PermissionRequest reject
  // the shared `continue` field, so successful observation must stay silent
  // for every other event.
  return eventName === "stop" || eventName === "subagentstop" ? '{"continue":true}\n' : "";
}

async function send(value) {
  const event = value.version ? value : {
    version: 1,
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    kind: value.status === "complete" ? "complete" : value.status === "error" ? "error" : "activity",
    ...value,
  };
  await post("/event", event);
}

function eachJsonLine(stream, listener) {
  stream.setEncoding("utf8");
  let buffer = "";
  stream.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines.filter(Boolean)) {
      try { listener(JSON.parse(line)); } catch { /* Preserve the wrapped process when output is not JSON. */ }
    }
  });
  stream.on("end", () => {
    if (!buffer.trim()) return;
    try { listener(JSON.parse(buffer)); } catch { /* Ignore a final non-JSON fragment. */ }
  });
}

function proxyStructured(source, command, args) {
  const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
  eachJsonLine(child.stdout, (value) => {
    void post(`/sources/${encodeURIComponent(source)}`, value, { "x-big-agent-direction": "agent-to-client" }).catch(() => undefined);
  });
  // Preserve the exact agent protocol stream while observing it.
  child.stdout.on("data", (chunk) => process.stdout.write(chunk));
  child.stderr.pipe(process.stderr);
  process.stdin.on("data", (chunk) => child.stdin.write(chunk));
  eachJsonLine(process.stdin, (value) => {
    void post(`/sources/${encodeURIComponent(source)}`, value, { "x-big-agent-direction": "client-to-agent" }).catch(() => undefined);
  });
  process.stdin.on("end", () => child.stdin.end());
  child.on("error", (error) => {
    console.error(`Unable to launch ${command}: ${error.message}`);
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 1;
  });
}

const [, , verb, ...rest] = process.argv;

if (verb === "emit") {
  const input = rest.join(" ");
  try { await send(JSON.parse(input)); }
  catch (error) { console.error(`big-agent emit: ${error.message}`); process.exitCode = 1; }
} else if (verb === "pipe") {
  eachJsonLine(process.stdin, (value) => void send(value).catch((error) => console.error(`Skipping protocol line: ${error.message}`)));
} else if (verb === "hook" && rest[0]) {
  const provider = rest[0].toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", async () => {
    let payload = {};
    try {
      payload = input.trim() ? JSON.parse(input) : {};
      await post(`/hooks/${encodeURIComponent(provider)}`, payload, {}, 1_000);
    } catch (error) {
      // Monitoring must never block the host agent's lifecycle.
      console.error(`BIG AGENT hook unavailable: ${error.message}`);
    }
    process.stdout.write(hookOutput(payload, provider));
  });
} else if (verb === "run" && rest[0] === "--" && rest[1]) {
  const [command, ...args] = rest.slice(1);
  const runId = crypto.randomUUID();
  const meta = { sessionId: `process:${runId}`, runId, workstreamId: `process:${runId}`, agentName: "Process" };
  await send({ status: "command", phase: "executing", command: [command, ...args].join(" "), label: "RUNNING", meta });
  const child = spawn(command, args, { stdio: "inherit" });
  child.on("error", async (error) => { await send({ status: "error", phase: "failed", detail: error.message, meta }); process.exitCode = 1; });
  child.on("exit", async (code) => {
    await send(code === 0
      ? { status: "complete", phase: "completing", detail: "Process completed", meta }
      : { status: "error", phase: "failed", detail: `Process exited with code ${code}`, exitCode: code, meta });
    process.exitCode = code ?? 1;
  });
} else if (verb === "codex" && rest[0] === "--" && rest[1]) {
  const [command, ...args] = rest.slice(1);
  const child = spawn(command, [...args, "--json"], { stdio: ["inherit", "pipe", "inherit"] });
  eachJsonLine(child.stdout, (value) => void post("/sources/codex-json", value).catch(() => undefined));
  child.stdout.pipe(process.stdout);
  child.on("exit", (code) => { process.exitCode = code ?? 1; });
} else if (verb === "proxy" && ["acp", "codex-app-server"].includes(rest[0]) && rest[1] === "--" && rest[2]) {
  const [source, , command, ...args] = rest;
  proxyStructured(source, command, args);
} else {
  console.error([
    "Usage:",
    "  big-agent emit '{\"status\":\"thinking\"}'",
    "  big-agent pipe < events.jsonl",
    "  big-agent hook <codex|claude|cursor|gemini|copilot|grok|cline|windsurf>",
    "  big-agent run -- <command> [args]",
    "  big-agent codex -- codex exec <prompt>",
    "  big-agent proxy codex-app-server -- codex app-server",
    "  big-agent proxy acp -- <agent> --acp",
  ].join("\n"));
  process.exitCode = 2;
}
