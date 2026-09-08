# BIG AGENT 0.1.12 preview

- Recover Claude model identity from local session transcripts when startup metadata is missing, including subagents’ own transcripts.
- Display explicitly reported effort from hook telemetry and matching transcript metadata.
- Remove Codex realtime inline markers from displayed messages and recaps.
- Transcript lookup stays local, bounded, and read-only; missing metadata never interrupts activity reporting.

## Mac download

Choose **mac-arm64.dmg** for Apple Silicon (M1 or newer), or **mac-x64.dmg** for Intel. Quit BIG AGENT, open the DMG, and replace the app in Applications.

This preview remains unsigned and not notarised. If macOS blocks it, follow the [unsigned Mac preview instructions](https://github.com/marcodenic/BIGAGENT#opening-the-unsigned-mac-preview).

Native tests and packaged-app startup checks, including monitor-worker startup, must pass on all four platforms before publication. SHA256SUMS contains checksums for every installer.
