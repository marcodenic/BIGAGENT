# Agent integrations

Prefer these integration lanes, in order:

1. Native OTLP for products which expose OpenTelemetry.
2. ACP or an official JSON-RPC/structured stream when BIG AGENT can sit between the client and agent.
3. Official lifecycle hooks for independently running IDE and CLI sessions.
4. Product event streams such as OpenCode SSE.
5. Read-only databases/logs and generic JSONL only as explicit fallbacks.

The telemetry hub keeps the original source, product, transport and provider event name in `meta`, then translates observable activity into `AgentEvent`. It does not retain user prompt bodies or read transcript files. Narrative text is accepted only from fields the provider explicitly emits for observation, such as a reasoning summary, agent thought, final response, or planner response.

## Built-in providers

### Codex

BIG AGENT connects as a read-only client to the official local Codex App Server daemon over its Unix WebSocket. It initializes the protocol, polls `thread/loaded/list`, subscribes with `thread/resume`, and consumes thread, turn, item, reasoning-summary, message, approval, and input notifications. It observes server requests but never answers them.

Codex Desktop must use the same daemon for passive monitoring. On Linux the explicit **SET UP CODEX** action writes a per-user desktop entry with `CODEX_APP_SERVER_USE_LOCAL_DAEMON=1`; ordinary startup only inspects it. **REMOVE INTEGRATION** reverses BIG AGENT's desktop-entry changes. The ready screen identifies an already-running private instance and offers a one-time restart. The rollout/database reader is disabled unless `BIG_AGENT_CODEX_FALLBACK=1` is explicitly set. Historical BIG AGENT Codex command hooks are removed only after an App Server connection succeeds, while unrelated hooks are preserved.

### Claude Code

The explicit **SET UP CLAUDE** action installs official HTTP observation hooks for session, prompt, message, tool, permission, subagent, task, stop, and compaction events. Ordinary startup only inspects the configuration, and **REMOVE INTEGRATION** removes BIG AGENT's entries. Existing Claude settings and hook actions are preserved. The localhost receiver always returns an empty `204`, the documented neutral result, so BIG AGENT cannot affect Claude's behavior. `claude agents --json` supplies an authoritative active-session registry; `--all` is consulted to classify agents that leave the active list.

### Grok Build

BIG AGENT installs xAI's official HTTP hook handlers in `~/.grok/hooks/big-agent.json`. `UserPromptSubmit` marks activity; `Stop`, `StopFailure`, and `StopCancelled` cover turn outcomes; and the documented `idle_prompt` notification is installed as the idle backstop. Tool, subagent, compaction, and session events use the same feed. This integration applies to Grok Build. The hosted Grok Bot product is not advertised because it has no documented passive public event feed.

### Cursor

BIG AGENT merges official global hooks into `~/.cursor/hooks.json`. In addition to session, tool, stop, and subagent boundaries, `afterAgentThought` and `afterAgentResponse` provide provider-designated narrative text. Cursor reloads its hook file automatically.

### Gemini CLI

BIG AGENT merges official command hooks into `~/.gemini/settings.json`. `BeforeAgent` and `AfterAgent` provide turn boundaries and the final `prompt_response`; tool, notification, compaction, and session hooks fill out the lifecycle. Hook stdout is the documented neutral `{}` object. Gemini's native OTLP export can also target BIG AGENT's collector.

### GitHub Copilot CLI

BIG AGENT writes one official user hook file at `~/.copilot/hooks/big-agent.json` (or `$COPILOT_HOME/hooks/`). It uses the VS Code-compatible PascalCase event names so payloads arrive in the shared snake_case schema. The bridge is explicitly fail-open because Copilot treats command errors in `PreToolUse` as deny. Local CLI sessions are built in; Copilot cloud jobs need a remote relay because their sandbox cannot reach a user's localhost receiver.

### Windsurf / Devin Desktop

BIG AGENT merges official Cascade hooks into `~/.codeium/windsurf/hooks.json`. `post_cascade_response` contains markdown planner responses, while read, write, command, MCP, and prompt events provide activity. BIG AGENT extracts the latest planner response and deliberately does not configure `post_cascade_response_with_transcript`.

### OpenCode

BIG AGENT installs a global OpenCode event plugin at `~/.config/opencode/plugins/big-agent.js`. The plugin forwards the official event object to localhost without awaiting the request, so observation cannot delay the agent. The optional `/global/event` or `/event` SSE adapter remains available when OpenCode is running an addressable server; BIG AGENT does not assume that a normal in-process TUI owns port 4096.

All command-hook integrations invoke a stable bridge copied into BIG AGENT's per-user application-data directory. Setup and removal are explicit. Setup replaces only older BIG AGENT hook entries, including transient AppImage paths; removal deletes only BIG AGENT-managed entries. User hooks remain unchanged.

Adapters must keep session, turn, tool, and child-agent boundaries distinct. In particular, a turn-level stop or idle notification is not a session completion. See the [lifecycle contract](lifecycle.md).

## Local endpoints

The server binds only to `127.0.0.1:19777`, accepts JSON bodies up to 4 MB, and rejects non-local browser origins.

| Endpoint | Input |
|---|---|
| `POST /event` | BIG AGENT protocol or concise status event |
| `POST /hooks/:provider` | Cursor/Gemini/Copilot/Windsurf and compatible lifecycle-hook payload |
| `POST /v1/traces` | OTLP/JSON traces |
| `POST /v1/logs` | OTLP/JSON logs |
| `POST /v1/metrics` | OTLP/JSON metrics/source health |
| `POST /sources/codex-app-server` | Codex App Server JSON-RPC from an external proxy/adapter |
| `POST /sources/codex-json` | Codex `exec --json` |
| `POST /sources/opencode` | OpenCode plugin or server event object |
| `POST /sources/acp` | ACP JSON-RPC |
| `GET /health` | Source connection and event counters |

The server rejects binary OTLP with an actionable 415 response. Use the standard Collector configuration at `telemetry/otel-collector.yaml` to accept protobuf/gRPC instead of adding a second protocol implementation to BIG AGENT.

## Writing another adapter

An adapter translates an agent's public structured events to the normalized protocol. Keep it separate from the React UI; the UI only receives `AgentEvent` values and renders `DisplayState` generated by the reducer.

1. Read your agent's structured API or event stream. Do not scrape terminal rendering.
2. Map observable activity to an appropriate status and kind.
3. Send JSONL through `big-agent pipe`, or POST each event to the localhost endpoint.
4. Use stable IDs if events might be retransmitted.

The main-process normalizers in `electron/telemetry/normalizers.ts` cover compatible hooks, OTLP GenAI attributes, Codex, OpenCode and ACP. `genericJsonlAdapter` accepts full normalized events and the short `{ "status": "…" }` form.

For a CLI which has no structured output, wrap it: `node scripts/big-agent.mjs run -- pnpm test`. This displays command execution, completion, and a non-zero exit as an error. More precise activity should come from a purpose-built adapter.
