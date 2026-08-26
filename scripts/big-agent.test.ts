import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const bridge = fileURLToPath(new URL("./big-agent.mjs", import.meta.url));
const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function runHook(payload: Record<string, unknown>) {
  let receivedPath = "";
  let receivedBody = "";
  const server = createServer((request, response) => {
    receivedPath = request.url ?? "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { receivedBody += chunk; });
    request.on("end", () => {
      response.writeHead(202, { "content-type": "application/json" });
      response.end('{"status":"accepted"}');
    });
  });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  const child = spawn(process.execPath, [bridge, "hook", "codex"], {
    env: { ...process.env, BIG_AGENT_URL: `http://127.0.0.1:${port}/event` },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdin.end(JSON.stringify(payload));
  const [code] = await once(child, "exit");
  return { code, stdout, stderr, receivedPath, receivedBody: JSON.parse(receivedBody) };
}

describe("Codex hook bridge", () => {
  it("stays silent for PreToolUse while still forwarding the event", async () => {
    const result = await runHook({ hook_event_name: "PreToolUse", tool_name: "Bash" });
    expect(result).toMatchObject({ code: 0, stdout: "", stderr: "", receivedPath: "/hooks/codex" });
    expect(result.receivedBody).toMatchObject({ hook_event_name: "PreToolUse", tool_name: "Bash" });
  });

  it("returns valid continuation JSON for Stop", async () => {
    const result = await runHook({ hook_event_name: "Stop", turn_id: "turn-1" });
    expect(JSON.parse(result.stdout)).toEqual({ continue: true });
    expect(result.stderr).toBe("");
  });
});
