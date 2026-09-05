import spawn from "cross-spawn";
import { findExecutable } from "./executables";

export async function launchDetached(binary: string, args: string[] = []) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(binary, args, { detached: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}

export async function launchInTerminal(binary: string) {
  if (process.platform === "darwin") return launchDetached("open", ["-a", "Terminal", binary]);
  if (process.platform === "win32") return launchDetached("cmd.exe", ["/d", "/c", "start", "", binary]);
  for (const [name, args] of [
    ["x-terminal-emulator", ["-e", binary]], ["gnome-terminal", ["--", binary]], ["konsole", ["-e", binary]],
  ] as Array<[string, string[]]>) {
    const terminal = await findExecutable(name);
    if (terminal) return launchDetached(terminal, args);
  }
  throw new Error("No supported terminal launcher was found");
}
