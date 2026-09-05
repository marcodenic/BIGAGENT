# Desktop platform support

BIG AGENT uses the same Electron/React interface on all platforms. CI is configured to test and package Linux x64, Windows x64, macOS Intel (x64), and macOS Apple Silicon (arm64) on native runners.

## Installers

| Platform | Release files | Install |
| --- | --- | --- |
| Linux x64 | `BIG-AGENT-<version>-linux-x86_64.AppImage` | Make executable and open |
| Windows x64 | `BIG-AGENT-<version>-win-x64.exe` | Run the installer; installs for the current user by default |
| macOS Intel | `BIG-AGENT-<version>-mac-x64.dmg` and `.zip` | Move BIG AGENT to Applications |
| macOS Apple Silicon | `BIG-AGENT-<version>-mac-arm64.dmg` and `.zip` | Move BIG AGENT to Applications |

Installer filenames include the architecture to prevent collisions. Releases include one SHA256SUMS file covering every installer. Building support does not establish native compatibility: Windows and Mac builds remain preview targets until their native CI and manual checks pass.

## Development and packaging

Install Node.js 24+ and the pnpm version declared in package.json, then run:

```text
pnpm install --frozen-lockfile
pnpm test
pnpm package:dir
pnpm smoke
```

On a headless Linux CI runner, use `xvfb-run -a pnpm smoke`. Smoke testing launches the packaged executable with isolated temporary application data, confirms the renderer and preload IPC work, and executes the installed hook bridge using Electron's bundled Node runtime. It does not start provider integrations or alter their configuration.

Use `pnpm package --x64 --publish never` for Linux, Windows, or Intel Mac installers on that operating system. Use `pnpm package --arm64 --publish never` on Apple Silicon. macOS disk images and native Windows validation require their respective operating systems.

Run `node scripts/checksums.mjs release` to hash the installers in a clean release directory. The script ignores unpacked app directories and build metadata.

## CI and releases

CI runs tests, packages the application, and smoke-tests it on four native runners. The Desktop release workflow performs those checks, produces installers, and uploads downloadable workflow artifacts. It can be run manually without publishing a GitHub release.

A `v*` tag creates a **draft** GitHub release only after every platform job succeeds. Review the artifacts and platform checks before publishing the draft. No tag, release, or remote build is created merely by editing these workflows.

The default alpha workflow does not configure signing credentials. macOS and Windows may show security warnings for downloaded unsigned builds. A public distribution should add Apple Developer ID signing and notarization, and Windows signing, before promoting these platforms from preview. Credentials must be supplied through protected CI secrets; they are not included in this repository. Follow [electron-builder's signing documentation](https://www.electron.build/code-signing.html).

## Agent discovery and hooks

- Existing PATH entries and explicit provider executable overrides take precedence. Common user install directories are also searched, including Homebrew on macOS and npm's AppData directory on Windows.
- Windows CLI discovery prefers `.exe`, `.cmd`, `.bat`, and `.com` files and ignores adjacent extensionless npm shell shims. Launching uses cross-spawn to preserve arguments and paths containing spaces.
- Windows observation hooks use an encoded PowerShell command with UTF-8 input/output. Executable paths are quoted, the receiver remains local, and hook failure returns success so observation cannot interrupt an agent.
- The installed bridge is bundled and uses Electron's Node runtime; end users do not need Node or npm for these hooks.
- macOS includes native application, edit, view, and window menus, including standard quit and clipboard shortcuts.
- Codex local session observation works independently of its Desktop launcher. Shared-daemon launcher setup remains Linux-specific. Windows users needing the standalone Codex CLI must install it themselves and choose RECHECK; BIG AGENT does not run the Unix installer on Windows.
- Windows installations observe native Windows providers. Providers inside WSL use a separate filesystem and environment; automatic WSL discovery and networking are not implemented.
- Fullscreen activation, screen locking, and display sleep follow native window-manager rules and require manual checks on each OS.

## Native release checks

Before promoting a platform, verify installation and launch on a clean machine; provider discovery/setup/removal; paths with spaces and non-ASCII characters; live activity, approval, failure, and completion; recap identity and PNG export; fullscreen, sleep, lock, and user-return behaviour; and upgrade/uninstall without losing unrelated provider settings. On Mac, also verify Dock reopen and Cmd+Q. On Windows, verify npm-installed CLI launch and PowerShell hooks.
