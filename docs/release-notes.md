# BIG AGENT 0.1.10 preview

- A three-note airport chime now plays once when all agents finish a run, with a lower pitch and gentle volume.
- A speaker button turns completion sound on or off and remembers the preference after restarting. Muting stops a playing chime immediately.
- Activity & status includes a Preview chime button. Reopening the done screen or enabling sound after completion does not replay the notification.
- The generic Codex activity fallback now reads “Waiting for agent…”.

## Mac download

Choose **mac-arm64.dmg** for Apple Silicon (M1 or newer), or **mac-x64.dmg** for Intel. Quit BIG AGENT, open the DMG, and replace the app in Applications.

This preview remains unsigned and not notarised. If macOS blocks it, follow the [unsigned Mac preview instructions](https://github.com/marcodenic/BIGAGENT#opening-the-unsigned-mac-preview).

Native tests and packaged-app startup checks, including monitor-worker startup, must pass on all four platforms before publication. SHA256SUMS contains checksums for every installer.
