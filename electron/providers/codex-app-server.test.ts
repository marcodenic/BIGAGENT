import { describe, expect, it } from "vitest";
import { sharedCodexDesktopEntry } from "./codex-app-server";

describe("Codex shared App Server desktop setup", () => {
  it("adds the daemon environment without discarding desktop metadata", () => {
    const original = "[Desktop Entry]\nName=ChatGPT\nExec=chatgpt %U\nIcon=chatgpt\n";
    const configured = sharedCodexDesktopEntry(original);
    expect(configured).toContain("Exec=/usr/bin/env CODEX_APP_SERVER_USE_LOCAL_DAEMON=1 chatgpt %U");
    expect(configured).toContain("Icon=chatgpt");
    expect(configured).toContain("X-BIGAGENT-Shared-App-Server=true");
    expect(sharedCodexDesktopEntry(configured)).toBe(configured);
  });
});

