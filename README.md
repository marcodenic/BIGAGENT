# BIG AGENT

An ambient, room-scale status display for autonomous coding agents. BIG AGENT is a native Tauri desktop application: one enormous sentence for the current activity, a timer, a permanent status dot, and a tiny optional ASCII companion.

It is intentionally not an IDE, terminal, or dashboard. The default display is designed to read from across a room; press `I` for the secondary inspection view.

## Run locally

Prerequisites: Node 20+, Rust, and the [Tauri system prerequisites](https://v2.tauri.app/start/prerequisites/).

```bash
pnpm install
pnpm tauri dev
```

Click **PLAY DEMO** to run the complete mock coding session (idle, thinking, searching, editing, commands, tests, failure, approval, recovery, completion). Open inspection with `I`; change demo speed there.

Create distributable platform packages with `pnpm tauri build`. Tauri's bundler produces the appropriate installers for the host platform; build separately on macOS, Windows, and Linux for all three targets.

## Controls

`F` fullscreen · `Esc` exit fullscreen · `I` inspection · `A` always on top · `?` shortcuts. Hover the footer for demo, privacy, and personality controls. The default **Subtle** face can be disabled or made Playful. Privacy mode hides file names, commands, paths, and detailed labels.

## Connect an agent

BIG AGENT is agent-neutral. Adapters translate structured agent activity into the versioned BIG AGENT protocol, then the deterministic reducer creates UI state. Agent-specific parsing never occurs in React components.

When running beside Codex desktop, BIG AGENT reads the app's local structured thread ledger and tracks every active turn independently. Use the numbered session switcher at the top of the display to move between simultaneous tasks; amber and red session dots remain visible when another task needs attention.

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
 
