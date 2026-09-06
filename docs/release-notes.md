# BIG AGENT 0.1.6 preview

- Session monitoring now runs in a background worker, keeping synchronous database reads off the window's main thread.
- Lifecycle monitoring reads new log rows instead of repeatedly scanning the full history.
- Unchanged session data and metadata are reused; unchanged snapshots are not sent to the renderer.
- Agent rows and activity history avoid unnecessary renders on timer ticks.
- Cache invalidation handles metadata changes, archived sessions, log resets, and replaced rollout files.

Includes the transparent character icon, larger single-agent text, and separated random character colours from the previous preview.

## Mac download

Choose **mac-arm64.dmg** for Apple Silicon (M1 or newer), or **mac-x64.dmg** for Intel. Quit BIG AGENT, open the DMG, and replace the app in Applications.

This preview remains unsigned and not notarised. If macOS blocks it, follow the [unsigned Mac preview instructions](https://github.com/marcodenic/BIGAGENT#opening-the-unsigned-mac-preview).

Native tests and packaged-app startup checks, including monitor-worker startup, must pass on all four platforms before publication. SHA256SUMS contains checksums for every installer.
