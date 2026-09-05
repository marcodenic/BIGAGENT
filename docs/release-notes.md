# BIG AGENT 0.1.5 preview

- Random character colours now avoid nearby hues already assigned in the session, while keeping existing identities stable.
- New transparent character icon for macOS, Windows, and Linux.
- Larger white activity text when one agent is running, with more room to wrap.
- Larger text and spacing in the five activity-history rows underneath.
- Portrait layout adjustments to keep the character clear of the text.
- Mac installation workaround documented in the README.

## Mac download

Choose **mac-arm64.dmg** for Apple Silicon (M1 or newer), or **mac-x64.dmg** for Intel. Open the DMG and move BIG AGENT into Applications, replacing the old version after quitting it.

This preview is still unsigned and not notarised. If macOS reports that the app is damaged or cannot be opened, follow the [unsigned Mac preview instructions](https://github.com/marcodenic/BIGAGENT#opening-the-unsigned-mac-preview).

All four platforms must pass native automated tests and packaged-app startup checks before publication. SHA256SUMS contains checksums for every installer.
