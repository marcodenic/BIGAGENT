# Lifecycle contract

BIG AGENT treats session, turn, tool, and subagent boundaries as different things. Providers may use different names, but adapters must preserve these semantics before events reach the reducer.

| Provider event | Meaning | Display result |
|---|---|---|
| `SessionStart` / `thread/started` | A session became available | Store identity and metadata; remain idle until a turn starts |
| `UserPromptSubmit` / `turn/started` | A turn began | Show the agent as active |
| `PreToolUse` / `item/started` | An operation began | Show its actual command, tool, or file activity |
| `PostToolUse` / `item/completed` | An operation returned | Keep the turn active while showing the result |
| `PermissionRequest` | Work needs the user | Persist an attention state until later activity resolves it |
| `PreCompact`, `PostCompact`, or compact `SessionStart` | Context is being compacted | Keep the current turn active and show loading/retrying |
| `Stop` / successful `turn/completed` | The current turn stopped | Show that turn as `DONE` for 20 seconds; never claim the session ended |
| `SubagentStart` | A child agent began | Create a separate child session grouped under its root |
| `SubagentStop` | A child agent stopped | Show that child as `DONE` for 20 seconds |
| `SessionEnd` / `thread/closed` | The main session actually ended | Show root completion, then expire it after 20 seconds |
| Failure | Work failed | Keep the error visible until the session resumes or an authoritative snapshot removes it |

Provider-specific ambiguity must resolve toward continued work, not a false `DONE`. In particular, Grok Build's `stopHookActive` can describe either a continuation or the final stop when another stop gate is installed, so BIG AGENT keeps that signal active and also consumes xAI's `idle_prompt` backstop. Provider hooks which expose an unambiguous final-response callback may close the turn directly; session completion still requires a separate session-end signal.

## Source authority

Structured live sources own lifecycle state. The current precedence is App Server, then hooks/OTLP/SSE, then generic protocol/process events. The read-only Codex rollout fallback is disabled by default and can be enabled only with `BIG_AGENT_CODEX_FALLBACK=1`.

When explicitly enabled, the fallback may provide compatibility before a structured source connects, but it must not override or coexist with an authoritative Codex feed. An authoritative empty snapshot removes its old sessions. A successful App Server connection also migrates away BIG AGENT's historical Codex command-hook bridge so duplicate lifecycle events cannot survive the transport change.

## Required invariants

1. A turn ending is never promoted to a session ending.
2. A completed observed turn remains visible briefly instead of disappearing at the idle boundary.
3. Session availability alone is not active work.
4. Event IDs distinguish repeated turns, status transitions, compactions, and continued stop hooks.
5. Child identity and parent grouping survive sparse follow-up events.
6. Successful terminal rows expire after 20 seconds; errors do not silently expire.
7. Completed children remain visible beside active siblings and briefly after the parent becomes turn-idle.
8. Hook monitoring never changes, blocks, or fails the host operation. Hooks that do not accept shared output remain silent.
9. Renderer visibility, turn completion, session completion, and attention counts come from one shared projection.

These invariants are covered by normalizer, reducer, workstream, bridge, fallback, and end-to-end lifecycle tests.
