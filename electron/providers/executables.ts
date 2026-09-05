import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

type Environment = Record<string, string | undefined>;
export function executableSearchDirectories(platform = process.platform, env: Environment = process.env, home = homedir()) {
  const path = platform === "win32" ? win32 : posix;
  const get = (name: string) => env[Object.keys(env).find(key => key.toLowerCase() === name.toLowerCase()) ?? name];
  const inherited = (get("PATH") || "").split(platform === "win32" ? ";" : ":").filter(Boolean);
  const common = [path.join(home, ".local", "bin"), path.join(home, ".bun", "bin"), path.join(home, ".cargo", "bin"), path.join(home, ".volta", "bin"), path.join(home, ".npm-global", "bin")];
  if (platform === "darwin") common.push("/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin");
  if (platform === "win32") {
    common.push(path.join(get("APPDATA") || path.join(home, "AppData", "Roaming"), "npm"));
    if (get("ProgramFiles")) common.push(path.join(get("ProgramFiles")!, "nodejs"));
  }
  return [...new Set([...inherited, ...common])];
}

export function executableVariants(path: string, platform = process.platform, pathExt = process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM") {
  if (platform !== "win32" || /\.(exe|com|cmd|bat)$/i.test(path)) return [path];
  // npm installs a POSIX shim beside its .cmd shim. Never pick that extensionless
  // file on Windows just because it exists.
  return pathExt.split(";").filter(Boolean).map(extension => `${path}${extension.toLowerCase()}`);
}

async function executable(path: string) {
  try {
    await access(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return (await stat(path)).isFile();
  } catch { return false; }
}

export async function findExecutable(name: string, candidates: Array<string | undefined> = []) {
  const path = process.platform === "win32" ? win32 : posix;
  const paths = [...candidates.filter((candidate): candidate is string => Boolean(candidate)),
    ...executableSearchDirectories().map(directory => path.join(directory, name))];
  for (const candidate of paths) {
    for (const variant of executableVariants(candidate)) if (await executable(variant)) return variant;
  }
  return undefined;
}
