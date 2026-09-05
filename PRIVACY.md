# Privacy

BIG AGENT is a local display. It has no user account, analytics service, cloud relay or repository upload path. Live events are normalised in memory and are not written to a BIG AGENT activity database.

The local telemetry receiver listens only on `127.0.0.1:19777`. It accepts JSON from local command-line tools and configured hooks, rejects non-local browser origins, and limits each request to 4 MB. Any local process running as the same operating-system user should still be treated as trusted.

Codex monitoring reads the local `~/.codex/state_5.sqlite`, `logs_2.sqlite`, `session_index.jsonl`, and the session rollout files referenced by the state database. `CODEX_HOME` overrides this directory. These files are opened read-only and monitored automatically; set `BIG_AGENT_CODEX_FALLBACK=0` to disable this monitoring.

Provider configuration changes are opt-in. Depending on what you enable, BIG AGENT may add clearly identifiable entries to:

- `~/.local/share/applications/chatgpt.desktop`
- `~/.claude/settings.json`
- `~/.grok/hooks/big-agent.json`
- `~/.cursor/hooks.json`
- `~/.gemini/settings.json`
- `~/.copilot/hooks/big-agent.json`
- `~/.codeium/windsurf/hooks.json`
- `~/.config/opencode/plugins/big-agent.js`

Use **AGENTS → REMOVE INTEGRATION** to remove BIG AGENT's entries. Unrelated settings and hooks are retained. Privacy mode affects what is displayed; it does not change what the local provider sends.
