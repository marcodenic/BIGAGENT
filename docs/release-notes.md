# BIG AGENT 0.1.19 preview

- Fix the left sidebar shifting when “Planning the next step” appears or disappears. Its space remains reserved, including when the text wraps in narrow layouts, so the timer, character area, and status stay in place.
- Hide the inactive planning text visually and from screen readers.

## Mac download

Choose **mac-arm64.dmg** for Apple Silicon (M1 or newer), or **mac-x64.dmg** for Intel. Quit BIG AGENT, open the DMG, and replace the app in Applications.

This preview remains unsigned and not notarised. If macOS blocks it, follow the [unsigned Mac preview instructions](https://github.com/marcodenic/BIGAGENT#opening-the-unsigned-mac-preview).

Native tests and packaged-app startup checks, including monitor-worker startup, must pass on all four platforms before publication. SHA256SUMS contains checksums for every installer.
