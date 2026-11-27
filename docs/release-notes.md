# BIG AGENT 0.1.20 preview

- Fix Claude messages flashing and disappearing when a delayed agent registry update arrives after live activity. Background status checks now preserve the current message and timer.
- Keep genuine new requests and sessions observed only through the registry working as before, with regression tests for both paths.

## Mac download

Choose **mac-arm64.dmg** for Apple Silicon (M1 or newer), or **mac-x64.dmg** for Intel. Quit BIG AGENT, open the DMG, and replace the app in Applications.

This preview remains unsigned and not notarised. If macOS blocks it, follow the [unsigned Mac preview instructions](https://github.com/marcodenic/BIGAGENT#opening-the-unsigned-mac-preview).

Native tests and packaged-app startup checks, including monitor-worker startup, must pass on all four platforms before publication. SHA256SUMS contains checksums for every installer.
