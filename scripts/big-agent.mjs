#!/usr/bin/env node
/** Local helper for the open BIG AGENT protocol. No repository contents leave localhost. */
import { spawn } from "node:child_process";
const endpoint = process.env.BIG_AGENT_URL || "http://127.0.0.1:19777/event";
const send = async (value) => {
  const event = value.version ? value : { version: 1, id: crypto.randomUUID(), timestamp: new Date().toISOString(), kind: value.status === "complete" ? "complete" : value.status === "error" ? "error" : "activity", ...value };
  const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(event) });
  if (!response.ok) throw new Error(`BIG AGENT protocol returned ${response.status}`);
};
const [, , verb, ...rest] = process.argv;
if (verb === "emit") { const input = rest.join(" "); try { await send(JSON.parse(input)); } catch (error) { console.error(`big-agent emit: ${error.message}`); process.exitCode = 1; } }
else if (verb === "pipe") { let buffer = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", (chunk) => buffer += chunk); process.stdin.on("end", async () => { for (const line of buffer.split("\n").filter(Boolean)) { try { await send(JSON.parse(line)); } catch (error) { console.error(`Skipping protocol line: ${error.message}`); } } }); }
else if (verb === "run" && rest[0] === "--" && rest[1]) { const [command, ...args] = rest.slice(1); await send({ status: "command", command: [command, ...args].join(" "), label: "RUNNING" }); const child = spawn(command, args, { stdio: "inherit" }); child.on("error", async (error) => { await send({ status: "error", detail: error.message }); process.exitCode = 1; }); child.on("exit", async (code) => { await send(code === 0 ? { status: "complete", detail: "Process completed" } : { status: "error", detail: `Process exited with code ${code}`, exitCode: code }); process.exitCode = code ?? 1; }); }
else if (verb === "codex" && rest[0] === "--" && rest[1]) { const [command, ...args] = rest.slice(1); const child = spawn(command, [...args, "--json"], { stdio: ["inherit", "pipe", "inherit"] }); let buffer = ""; child.stdout.setEncoding("utf8"); child.stdout.on("data", async (chunk) => { buffer += chunk; const lines = buffer.split("\n"); buffer = lines.pop() ?? ""; for (const line of lines.filter(Boolean)) { try { await send(JSON.parse(line)); } catch { /* preserve the Codex process if one malformed line appears */ } } }); child.on("exit", (code) => { process.exitCode = code ?? 1; }); }
else { console.error("Usage: big-agent emit '{\"status\":\"thinking\"}' | big-agent pipe | big-agent run -- <command> [args] | big-agent codex -- codex exec <prompt>"); process.exitCode = 2; }
