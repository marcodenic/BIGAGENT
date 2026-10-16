# BIG AGENT 0.1.17 preview

- Fix completed or stopped Codex subagents remaining active when the live feed takes over from local session monitoring. Completion records now have distinct IDs so they are not discarded as duplicate activity.
- Re-check the runtime status of active subscribed Codex threads, recovering missed completion notifications even when the finished thread remains loaded.
- Ignore stale status responses when a new turn starts during a check, preventing an old response from ending new work.

## Mac download

Choose **mac-arm64.dmg** for Apple Silicon (M1 or newer), or **mac-x64.dmg** for Intel. Quit BIG AGENT, open the DMG, and replace the app in Applications.

This preview remains unsigned and not notarised. If macOS blocks it, follow the [unsigned Mac preview instructions](https://github.com/marcodenic/BIGAGENT#opening-the-unsigned-mac-preview).

Native tests and packaged-app startup checks, including monitor-worker startup, must pass on all four platforms before publication. SHA256SUMS contains checksums for every installer.
