import { describe, expect, it } from "vitest";
import { sharedCodexDesktopEntry, unixSocketPeerInodes, unsharedCodexDesktopEntry } from "./codex-app-server";

describe("Codex shared App Server desktop setup", () => {
  it("adds the daemon environment without discarding desktop metadata", () => {
    const original = "[Desktop Entry]\nName=ChatGPT\nExec=chatgpt %U\nIcon=chatgpt\n";
    const configured = sharedCodexDesktopEntry(original);
    expect(configured).toContain("Exec=/usr/bin/env CODEX_APP_SERVER_USE_LOCAL_DAEMON=1 chatgpt %U");
    expect(configured).toContain("Icon=chatgpt");
    expect(configured).toContain("X-BIGAGENT-Shared-App-Server=true");
    expect(sharedCodexDesktopEntry(configured)).toBe(configured);
    expect(unsharedCodexDesktopEntry(configured)).toBe(original);
  });

  it("recognizes the desktop peer attached to the shared daemon socket", () => {
    const socket = "/home/code/.codex/app-server-control/app-server-control.sock";
    const output = [
      `u_str ESTAB 0 0 ${socket} 3592040 * 3624255 users:((\"codex\",pid=100,fd=14))`,
      "u_str ESTAB 0 0 * 3624255 * 3592040 users:((\"electron\",pid=200,fd=81))",
      `u_str ESTAB 0 0 ${socket} 3637334 * 3638515 users:((\"codex\",pid=100,fd=15))`,
      "u_str ESTAB 0 0 * 3638515 * 3637334 users:((\"ChatGPT\",pid=300,fd=178))",
    ].join("\n");

    expect([...unixSocketPeerInodes(output, socket)]).toEqual(["3624255", "3638515"]);
  });
});
