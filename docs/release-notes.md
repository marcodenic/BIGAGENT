# BIG AGENT 0.1.7 preview

- Thinking, searching, and general work each rotate through three character animations every 4–7 seconds, with staggered timing for each character.
- Animation rotation pauses offscreen and respects reduced-motion preferences. Specific actions and attention signals keep their clear expressions.
- User-stopped Codex sessions now show a neutral STOPPED state instead of an error, then disappear after 20 seconds.
- Stopped-session expiry uses the original stop time, so refreshing or restarting does not bring old stopped sessions back. Genuine errors remain visible.

## Mac download

Choose **mac-arm64.dmg** for Apple Silicon (M1 or newer), or **mac-x64.dmg** for Intel. Quit BIG AGENT, open the DMG, and replace the app in Applications.

This preview remains unsigned and not notarised. If macOS blocks it, follow the [unsigned Mac preview instructions](https://github.com/marcodenic/BIGAGENT#opening-the-unsigned-mac-preview).

Native tests and packaged-app startup checks, including monitor-worker startup, must pass on all four platforms before publication. SHA256SUMS contains checksums for every installer.
