# BIG AGENT protocol

BIG AGENT accepts local JSON events at `POST http://127.0.0.1:19777/event`. The service is bound only to loopback. It also ships a helper: `node scripts/big-agent.mjs emit '{"status":"thinking","label":"Tracing auth"}'`.

For streams, use `node scripts/big-agent.mjs pipe < events.jsonl`. Each line is a JSON object. A concise event is enough:

```json
{"status":"editing","label":"Updating session handling","files":["session.ts","auth.ts"]}
```

The complete versioned form is:

```json
{"version":1,"id":"evt-12","timestamp":"2026-08-25T12:00:00Z","kind":"command.start","status":"command","command":"pnpm test --filter auth"}
```

`id`, `timestamp`, `kind`, and `version` are required in the complete form. IDs are deduplicated. Supported statuses are `idle`, `thinking`, `searching`, `working`, `command`, `editing`, `testing`, `waiting`, `approval`, `complete`, and `error`.

Supported kinds: `session.start`, `session.end`, `turn.start`, `turn.end`, `activity`, `reasoning.summary`, `plan`, `command.start`, `command.end`, `files.changed`, `test.result`, `approval.requested`, `input.requested`, `error`, `complete`, and `usage`. `reasoning.summary` means a short summary the agent chose to expose; BIG AGENT neither requests nor presents private chain-of-thought.

Optional fields are `label`, `detail`, `files`, `command`, `tool`, `target`, `exitCode`, `plan`, `usage`, and `meta`. Workstream-aware producers should set `meta.sessionId`, `meta.workstreamId`, `meta.workstreamName`, and optionally `meta.agentName`. Sessions sharing a `workstreamId` render together. Malformed JSON is rejected with HTTP 400.
