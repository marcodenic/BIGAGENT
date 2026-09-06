# BIG AGENT 0.1.8 preview

- Subagents now appear as selectable baby bots inside their parent task. Larger boards keep each family together instead of splitting children into separate session tiles.
- Baby bots share their parent's shape, use stable colours based on declared roles, and show their nickname, readable assignment, model, and reasoning effort.
- Internal Codex approval reviewers no longer appear as extra working or completed agents.
- Single-task layouts scale characters, activity text, and spacing to the available screen area. Team entries adapt to smaller windows and crowded boards, with scrolling and expansion for additional detail.
- A compact status and control dock replaces the full-width header and footer. Connections, fullscreen, inspection, privacy, and detailed feed status remain accessible.
- Save image now opens a native save dialog for the anonymous completion PNG and confirms the saved path or cancellation.

## Mac download

Choose **mac-arm64.dmg** for Apple Silicon (M1 or newer), or **mac-x64.dmg** for Intel. Quit BIG AGENT, open the DMG, and replace the app in Applications.

This preview remains unsigned and not notarised. If macOS blocks it, follow the [unsigned Mac preview instructions](https://github.com/marcodenic/BIGAGENT#opening-the-unsigned-mac-preview).

Native tests and packaged-app startup checks, including monitor-worker startup, must pass on all four platforms before publication. SHA256SUMS contains checksums for every installer.
