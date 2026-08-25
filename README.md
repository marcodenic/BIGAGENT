# BIG AGENT

An ambient, room-scale status display for autonomous coding agents. BIG AGENT is a native Tauri desktop application: stable workstream rows, enormous overall states, live per-agent activity, timers, permanent status dots, and tiny optional ASCII companions.

While agents are running, BIG AGENT asks the operating system to keep the display awake. The wake lock is released as soon as all agents complete or stop, and whenever the app exits.

It is intentionally not an IDE, terminal, or dashboard. The default display groups related sessions into workstreams and is designed to read from across a room; press `I` for the secondary inspection view.

## Run locally

Prerequisites: Node 20+, Rust, and the [Tauri system prerequisites](https://v2.tauri.app/start/prerequisites/).

```bash
pnpm install
pnpm tauri dev
```

Create distributable platform packages with `pnpm tauri build`. Tauri's bundler produces the appropriate installers for the host platform; build separately on macOS, Windows, and Linux for all three targets.

## Controls

`F` fullscreen · `Esc` exit fullscreen · `I` inspection · `A` always on top · `?` shortcuts. Hover the footer for the privacy control. Privacy mode hides file names, commands, paths, and detailed labels. ASCII faces change automatically with agent status.

## Connect an agent

BIG AGENT is agent-neutral. Adapters translate structured agent activity into the versioned BIG AGENT protocol, then the deterministic reducer creates UI state. Agent-specific parsing never occurs in React components.

When running beside Codex desktop, BIG AGENT reads the app's local structured thread ledger and groups turns from the same task into one stable workstream. Each nested agent line shows its observable activity, tool, target, and detail. No manual session switching is required. Finished turns remain visible briefly, then age out automatically; amber and red states remain conspicuous without moving rows around.

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

Use Codex's public structured activity stream—not rendered terminal text—and map events through `src/core/adapters.ts`'s `codexAdapter`. It supports public summaries, plans, commands, edits, failures, completions, and timing without exposing private chain-of-thought. Forward its normalized JSON to the local protocol endpoint or the `pipe` helper.

## Architecture

```text
Agent → adapter → normalized AgentEvent → reducer → DisplayState → React UI
```

The app operates locally. Its protocol server listens only on `127.0.0.1:19777`; it has no account, cloud service, or repository upload path.

- [Protocol](docs/protocol.md)
- [Adapter guide](docs/adapters.md)
- [Design principles](docs/design.md)

## Tests

```bash
pnpm test
```

Tests cover protocol normalization, malformed input, state transitions, attention states, elapsed-time freezing, completion, errors, and duplicate events.
 
