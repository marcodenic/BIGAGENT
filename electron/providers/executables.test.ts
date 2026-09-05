import { describe, expect, it } from "vitest";
import { executableSearchDirectories, executableVariants, findExecutable } from "./executables";

describe("desktop executable discovery", () => {
  it("includes Homebrew and user installs when Finder supplies a minimal PATH", () => {
    expect(executableSearchDirectories("darwin", { PATH: "/usr/bin:/bin" }, "/Users/person")).toEqual(expect.arrayContaining([
      "/opt/homebrew/bin", "/usr/local/bin", "/Users/person/.local/bin", "/Users/person/.bun/bin",
    ]));
  });
  it("honours Windows Path casing and includes npm's user installation directory", () => {
    const paths = executableSearchDirectories("win32", { Path: "C:\\Tools;C:\\Windows\\System32", APPDATA: "C:\\Users\\A B\\AppData\\Roaming" }, "C:\\Users\\A B");
    expect(paths.slice(0, 2)).toEqual(["C:\\Tools", "C:\\Windows\\System32"]);
    expect(paths).toContain("C:\\Users\\A B\\AppData\\Roaming\\npm");
  });
  it("chooses Windows executable extensions instead of npm's adjacent POSIX shim", () => {
    expect(executableVariants("C:\\Tools\\codex", "win32", ".EXE;.CMD")).toEqual(["C:\\Tools\\codex.exe", "C:\\Tools\\codex.cmd"]);
    expect(executableVariants("C:\\Tools\\codex.CMD", "win32")).toEqual(["C:\\Tools\\codex.CMD"]);
    expect(executableVariants("/usr/local/bin/codex", "darwin")).toEqual(["/usr/local/bin/codex"]);
  });
  it("finds a real native executable and rejects directories", async () => {
    expect(await findExecutable("does-not-exist-big-agent", [process.execPath])).toBe(process.execPath);
    expect(await findExecutable("does-not-exist-big-agent", [process.cwd()])).toBeUndefined();
  });
});
