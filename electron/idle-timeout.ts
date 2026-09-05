import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
export async function readSystemCommand(command: string, args: string[]) {
  try { return (await exec(command, args, { timeout: 2000, windowsHide: true })).stdout; }
  catch { return ""; }
}
export function earliestTimeout(values: Array<number | undefined>, fallback = 300) {
  const known = values.filter((value): value is number => value !== undefined && Number.isFinite(value) && value >= 0);
  const enabled = known.filter((value) => value > 0);
  return enabled.length ? Math.min(...enabled) : known.length ? Infinity : fallback;
}
function number(text: string) {
  const match = text.trim().match(/^(?:uint32\s+)?(\d+)$/);
  return match ? Number(match[1]) : undefined;
}
export async function systemIdleTimeout(onBattery: boolean): Promise<number> {
  const override = process.env.BIG_AGENT_IDLE_SECONDS;
  if (override !== undefined && number(override) !== undefined) return earliestTimeout([number(override)]);
  if (process.platform === "darwin") {
    const [power, saver] = await Promise.all([
      readSystemCommand("pmset", ["-g", "custom"]), readSystemCommand("defaults", ["-currentHost", "read", "com.apple.screensaver", "idleTime"]),
    ]);
    const section = power.split(onBattery ? "Battery Power:" : "AC Power:")[1]?.split(/\n\S/)[0];
    const minutes = section?.match(/displaysleep\s+(\d+)/)?.[1];
    return earliestTimeout([minutes === undefined ? undefined : Number(minutes) * 60, number(saver)]);
  }
  if (process.platform === "win32") {
    const [power, saver] = await Promise.all([
      readSystemCommand("powercfg", ["/query", "SCHEME_CURRENT", "SUB_VIDEO", "VIDEOIDLE"]),
      readSystemCommand("reg", ["query", "HKCU\\Control Panel\\Desktop"]),
    ]);
    const indexes = [...power.matchAll(/0x([0-9a-f]+)/gi)].map((match) => parseInt(match[1], 16));
    const enabled = saver.match(/ScreenSaveActive\s+REG_SZ\s+(\d+)/)?.[1];
    const seconds = saver.match(/ScreenSaveTimeOut\s+REG_SZ\s+(\d+)/)?.[1];
    return earliestTimeout([indexes.slice(-2)[onBattery ? 1 : 0], enabled === "0" ? 0 : seconds ? Number(seconds) : undefined]);
  }
  if ((process.env.XDG_CURRENT_DESKTOP ?? "").toLowerCase().includes("kde")) {
    const profileResult = await readSystemCommand("gdbus", ["call", "--session", "--dest", "org.kde.Solid.PowerManagement", "--object-path", "/org/kde/Solid/PowerManagement", "--method", "org.kde.Solid.PowerManagement.currentProfile"]);
    const profile = profileResult.match(/'(AC|Battery|LowBattery)'/)?.[1] ?? (onBattery ? "Battery" : "AC");
    const config = (key: string) => readSystemCommand("kreadconfig6", ["--file", "powerdevilrc", "--group", profile, "--group", "Display", "--key", key]);
    const [enabled, seconds] = await Promise.all([config("TurnOffDisplayWhenIdle"), config("TurnOffDisplayIdleTimeoutSec")]);
    // Plasma omits unchanged values from powerdevilrc. Use its desktop
    // profile defaults only when the running service confirmed the profile.
    // https://invent.kde.org/plasma/powerdevil/-/blob/master/daemon/powerdevilsettingsdefaults.cpp
    const defaultSeconds = profileResult.includes("'" + profile + "'")
      ? profile === "AC" ? 600 : profile === "Battery" ? 300 : 120
      : undefined;
    return earliestTimeout([enabled.trim() === "false" ? 0 : number(seconds) ?? defaultSeconds]);
  }
  // GNOME/Cinnamon expose seconds; X11 exposes both screensaver and DPMS timers.
  const desktop = (process.env.XDG_CURRENT_DESKTOP ?? "").toLowerCase();
  if (/gnome|unity|cinnamon/.test(desktop)) {
    const schema = desktop.includes("cinnamon") ? "org.cinnamon.desktop.session" : "org.gnome.desktop.session";
    const value = number(await readSystemCommand("gsettings", ["get", schema, "idle-delay"]));
    if (value !== undefined) return earliestTimeout([value]);
  }
  if (process.env.XDG_SESSION_TYPE !== "wayland") {
    const output = await readSystemCommand("xset", ["q"]);
    const saver = output.match(/timeout:\s+(\d+)/)?.[1];
    const dpms = output.includes("DPMS is Enabled") ? [...output.matchAll(/(?:Standby|Suspend|Off):\s+(\d+)/g)].map((match) => Number(match[1])) : [];
    return earliestTimeout([saver === undefined ? undefined : Number(saver), ...dpms]);
  }
  return 300;
}
