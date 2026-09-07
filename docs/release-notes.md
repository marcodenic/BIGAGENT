# BIG AGENT 0.1.11 preview

- Fixed idle Claude registry sessions incorrectly appearing as THINKING with a continuously running timer. Idle sessions stay off the active board, and resumed work starts a fresh timer.
- Completion audio waits two seconds and cancels if work resumes, preventing a chime during brief pauses between turns. Muting or hiding the recap also cancels pending audio.
- Clarified support for local Claude Desktop Code sessions and Claude Code CLI sessions, including CLI sessions launched by another agent. Use SET UP CLAUDE before testing; regular Chat, Cowork, and cloud/remote sessions are not covered.

## Mac download

Choose **mac-arm64.dmg** for Apple Silicon (M1 or newer), or **mac-x64.dmg** for Intel. Quit BIG AGENT, open the DMG, and replace the app in Applications.

This preview remains unsigned and not notarised. If macOS blocks it, follow the [unsigned Mac preview instructions](https://github.com/marcodenic/BIGAGENT#opening-the-unsigned-mac-preview).

Native tests and packaged-app startup checks, including monitor-worker startup, must pass on all four platforms before publication. SHA256SUMS contains checksums for every installer.
