import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, join } from "node:path";

async function executable(path: string | undefined) {
  if (!path) return false;
  try {
    await access(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function findExecutable(name: string, candidates: Array<string | undefined> = []) {
  for (const candidate of candidates) if (await executable(candidate)) return candidate;
  const extensions = process.platform === "win32"
    ? (process.env.PATHEXT || ".EXE;.CMD;.BAT").split(";")
    : [""];
  for (const directory of (process.env.PATH || "").split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = join(directory, `${name}${extension.toLowerCase()}`);
      if (await executable(candidate)) return candidate;
    }
  }
  return undefined;
}

