# BIG AGENT 0.1.16 preview

- Reconcile stopped and completed Codex agents across live events, session files, and reconnects so stale activity does not leave them spinning.
- Recognise current Codex collaboration events and keep Claude subagent activity attached to the correct parent and child.
- Preserve elapsed times and event order when restoring session history, and keep active tasks and subagents ahead of completed ones.
- Keep crowded boards readable with scrolling instead of compressing every completed task onto the screen.
- Remove excessive spacing above command history and fit portrait activity panels within their rows so commands remain visible.

## Mac download

Choose **mac-arm64.dmg** for Apple Silicon (M1 or newer), or **mac-x64.dmg** for Intel. Quit BIG AGENT, open the DMG, and replace the app in Applications.

This preview remains unsigned and not notarised. If macOS blocks it, follow the [unsigned Mac preview instructions](https://github.com/marcodenic/BIGAGENT#opening-the-unsigned-mac-preview).

Native tests and packaged-app startup checks, including monitor-worker startup, must pass on all four platforms before publication. SHA256SUMS contains checksums for every installer.
