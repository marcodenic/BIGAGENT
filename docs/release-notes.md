# BIG AGENT 0.1.21 preview

- Fix Claude messages disappearing after tool results when message hooks carry a separate turn ID. Claude hooks now consistently use the shared prompt ID, preserving the current message and timer until a genuine new request.
- Assemble streamed message batches in order, handle duplicate delivery, and retain text when the final batch is empty. This also supports complete messages sent by non-interactive Claude runs.
- Add regression coverage for the documented hook payloads, long tool sequences, and new-request resets.

## Mac download

Choose **mac-arm64.dmg** for Apple Silicon (M1 or newer), or **mac-x64.dmg** for Intel. Quit BIG AGENT, open the DMG, and replace the app in Applications.

This preview remains unsigned and not notarised. If macOS blocks it, follow the [unsigned Mac preview instructions](https://github.com/marcodenic/BIGAGENT#opening-the-unsigned-mac-preview).

Native tests and packaged-app startup checks, including monitor-worker startup, must pass on all four platforms before publication. SHA256SUMS contains checksums for every installer.
