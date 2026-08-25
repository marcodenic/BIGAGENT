# BIG AGENT

An ambient, room-scale status display for autonomous coding agents. BIG AGENT is an Electron desktop application: stable workstream rows, enormous overall states, live per-agent activity, timers, and animated Grok Bot faces rendered by Chromium.

While agents are running, BIG AGENT asks the operating system to keep the display awake. The wake lock is released as soon as all agents complete or stop, and whenever the app exits.

It is intentionally not an IDE, terminal, or dashboard. The default display groups related sessions into workstreams and is designed to read from across a room; press `I` for the secondary inspection view.

## Run locally

Prerequisite: Node 22.12 or newer.

```bash
pnpm install
pnpm dev
```

Create a distributable platform package with `pnpm package`. Electron Builder produces an AppImage on Linux and uses the configured native installer target on macOS or Windows; build on each target platform for all three formats.

## Controls

`F` fullscreen · `Esc` exit fullscreen · `I` inspection · `?` shortcuts. Hover the footer for the privacy control. Privacy mode hides file names, commands, paths, and detailed labels. Grok Bot expressions change automatically with agent status.

## Connect an agent

BIG AGENT is agent-neutral. A main-process telemetry hub accepts official structured transports, keeps source provenance, deduplicates retransmissions, and projects activity into the compact versioned BIG AGENT protocol. Agent-specific parsing never occurs in React components.

When running beside Codex Desktop, the read-only local thread ledger remains available as a passive fallback. Official Codex App Server or `exec --json` events take priority for the same session. Each nested agent line shows its observable activity, tool, target, and detail. No manual session switching is required. Finished turns remain visible briefly, then age out automatically; amber and red states remain conspicuous without moving rows around.

With BIG AGENT running, send a simple event:

```bash
node scripts/big-agent.mjs emit '{"status":"thinking","label":"Tracing authentication flow"}'
node scripts/big-agent.mjs emit '{"status":"editing","files":["session.ts","auth.ts"]}'
node scripts/big-agent.mjs emit '{"status":"complete","label":"182 tests passing"}'
```

Or pipe JSONL:

```bash
your-agent --structured-events | node scripts/big-agent.mjs pipe
```

For a generic process, use:

```bash
node scripts/big-agent.mjs run -- pnpm test
```

That wrapper reports running, completion, and non-zero exits. A dedicated adapter can add richer semantic activity.

### Codex

Observe an `exec --json` run with:

```bash
node scripts/big-agent.mjs codex -- codex exec "your task"
```

Use BIG AGENT as a transparent App Server monitor when configuring a client:

```bash
node scripts/big-agent.mjs proxy codex-app-server -- codex app-server
```

### OpenTelemetry

Products with native OTLP support can send `http/json` directly to `http://127.0.0.1:19777`, or use the standard OpenTelemetry Collector for the usual protobuf and gRPC transports:

```bash
otelcol --config telemetry/otel-collector.yaml
```

Point the product at `http://127.0.0.1:4318` for OTLP/HTTP or `127.0.0.1:4317` for OTLP/gRPC. The included Collector configuration converts the standard signals to OTLP/JSON for BIG AGENT.

### Hooks, OpenCode, and ACP

Use this command as a lifecycle hook in supported products, replacing the provider name as appropriate:

```bash
node /absolute/path/to/BIGAGENT/scripts/big-agent.mjs hook claude
```

The hook bridge deliberately returns success even if BIG AGENT is closed, so monitoring cannot block an agent. OpenCode's global SSE feed is detected at `http://127.0.0.1:4096`; set `BIG_AGENT_OPENCODE_URL` before launching BIG AGENT when using another address. ACP agents can be observed transparently with:

```bash
node scripts/big-agent.mjs proxy acp -- your-agent --acp
```

Inspect live source health at `http://127.0.0.1:19777/health`.

## Architecture

```text
Official feed / OTLP / hook / ACP / SSE → telemetry hub → AgentEvent → reducer → React UI
```

The Electron main process owns source connections, normalization, the read-only Codex fallback, wake lock, image bridge, and local telemetry server. The renderer runs with Chromium sandboxing, context isolation, and no Node.js integration. The app operates locally: its server listens only on `127.0.0.1:19777`, and it has no account, cloud service, or repository upload path.

- [Protocol](docs/protocol.md)
- [Adapter guide](docs/adapters.md)
- [Design principles](docs/design.md)

## Tests

```bash
pnpm test
```

Tests cover protocol, hook, OTLP, ACP, OpenCode and Codex normalization; source deduplication; state transitions; Grok phase mapping; attention; completion; and errors.
 
