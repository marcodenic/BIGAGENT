# BIG AGENT

An ambient, room-scale departures board for autonomous coding agents. BIG AGENT groups live sessions into stable workstreams, shows useful narrative activity instead of raw token streams, and makes completion, failure and requests for input visible from across the room.

![BIG AGENT showing three live coding workstreams in different lifecycle states](docs/images/demo-workstreams.webp)

> **Public alpha:** Linux x86-64 is the currently tested distribution. macOS and Windows builds are not yet validated.

## Try it

Download the latest AppImage from [GitHub Releases](https://github.com/marcodenic/BIGAGENT/releases), make it executable, and open it:

```bash
chmod +x "BIG AGENT-0.1.0.AppImage"
./"BIG AGENT-0.1.0.AppImage"
```

Alpha builds are currently unsigned. Verify the download against the accompanying `SHA256SUMS` file.

The first-run **FIND MY AGENTS** screen detects supported providers. Nothing is added to another application's configuration until you click its setup button; every configured provider also offers **REMOVE INTEGRATION**.

![Provider discovery and setup](docs/images/provider-discovery.webp)

## Supported providers

| Provider | Observation source |
| --- | --- |
| Codex | Local session files + App Server daemon |
| Claude Code | HTTP hooks + agent registry |
| Grok Build | HTTP lifecycle hooks |
| Cursor | Thought + lifecycle hooks |
| Gemini CLI | Lifecycle hooks + OpenTelemetry |
| GitHub Copilot CLI | Lifecycle hooks |
| Windsurf / Devin Desktop | Cascade lifecycle hooks |
| OpenCode | Global plugin + SSE |

Hosted Grok Bot and hosted Copilot jobs are not claimed as local integrations because they do not expose an equivalent localhost event feed.

Codex session files are monitored automatically, including Desktop versions that use a private App Server. No Codex restart or startup order is required. Live App Server events take priority for the same turn; unrelated desktop tasks remain visible. Set `BIG_AGENT_CODEX_FALLBACK=0` to disable session-file monitoring.

## Privacy and control

- Activity remains on the machine and in memory; BIG AGENT has no account or cloud upload path.
- The telemetry receiver binds only to `127.0.0.1:19777`, accepts JSON only, limits request size, and rejects non-local browser origins.
- Observation hooks are fail-open and cannot approve, deny or steer an agent.
- Existing provider settings and unrelated hooks are preserved.
- Privacy mode hides paths, commands, filenames and detailed labels.

See [PRIVACY.md](PRIVACY.md) for the exact local files used by optional integrations.

## Controls

`F` fullscreen · `Esc` exit fullscreen · `I` inspection · `?` shortcuts. Open **AGENTS** to add, verify or remove provider integrations.

## Develop

Requires Node.js 22.12+ and pnpm.

```bash
pnpm install
pnpm dev
pnpm test
pnpm package
```

`pnpm package` creates the native package for the host platform; the public alpha release workflow currently publishes the Linux AppImage and SHA-256 checksum.

Generic JSON events, JSONL streams, OpenTelemetry and ACP are also supported. Start with the [adapter guide](docs/adapters.md), [lifecycle contract](docs/lifecycle.md) or [protocol](docs/protocol.md).

## Licence

[MIT](LICENSE) — use it, remix it and ship your own version.
