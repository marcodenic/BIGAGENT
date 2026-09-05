import { BrowserWindow, powerMonitor, powerSaveBlocker } from "electron";
import { readSystemCommand, systemIdleTimeout } from "./idle-timeout";

/** Owns only the window changes and power assertion made by automatic presentation. */
export class IdleDisplay {
  private active = false;
  private locked = false;
  private suspended = false;
  private linuxLocked = false;
  private sampling = false;
  private stopped = false;
  private wakeId: number | null = null;
  private timeout: number | null = null;
  private settingsRevision = 0;
  private dismissed = false;
  private previousIdle = 0;
  private saved: { window: BrowserWindow; fullscreen: boolean; top: boolean; minimized: boolean; visible: boolean } | null = null;
  private timer: NodeJS.Timeout;
  private settingsTimer: NodeJS.Timeout;
  constructor(private window: () => BrowserWindow | null) {
    this.timer = setInterval(() => { void this.sampleLock(); this.tick(); }, 1000);
    this.settingsTimer = setInterval(() => void this.refresh(), 60_000);
    this.timer.unref(); this.settingsTimer.unref();
    powerMonitor.on("lock-screen", this.lock);
    powerMonitor.on("unlock-screen", this.unlock);
    powerMonitor.on("suspend", this.suspend);
    powerMonitor.on("resume", this.resume);
    powerMonitor.on("on-ac", this.refresh);
    powerMonitor.on("on-battery", this.refresh);
    void this.refresh();
    void this.sampleLock();
  }
  private async sampleLock() {
    if (process.platform !== "linux" || this.sampling || this.stopped) return;
    this.sampling = true;
    try {
      const result = await readSystemCommand("gdbus", ["call", "--session", "--dest", "org.freedesktop.ScreenSaver", "--object-path", "/ScreenSaver", "--method", "org.freedesktop.ScreenSaver.GetActive"]);
      if (!this.stopped && /\b(true|false)\b/.test(result)) {
        this.linuxLocked = result.includes("true");
        this.tick();
      }
    } finally { this.sampling = false; }
  }
  private refresh = async () => {
    const revision = ++this.settingsRevision;
    const timeout = await systemIdleTimeout(powerMonitor.isOnBatteryPower());
    if (this.stopped || revision !== this.settingsRevision) return;
    this.timeout = timeout;
    this.tick();
  };
  private lock = () => { this.locked = true; this.tick(); };
  private unlock = () => { this.locked = false; this.dismissed = true; this.tick(); };
  private suspend = () => { this.suspended = true; this.tick(); };
  private resume = () => { this.suspended = false; this.dismissed = true; void this.refresh(); };
  setActive(active: boolean) { this.active = active; this.tick(); }
  dismiss() { this.dismissed = true; this.restore(); }
  toggleFullscreen(window: BrowserWindow) {
    // Capture the user's requested state before restoring automatic presentation.
    const fullscreen = !window.isFullScreen();
    this.dismiss();
    window.setFullScreen(fullscreen);
  }
  private restore() {
    const saved = this.saved; this.saved = null;
    if (!saved || saved.window.isDestroyed()) return;
    saved.window.setFullScreen(saved.fullscreen);
    saved.window.setAlwaysOnTop(saved.top);
    if (saved.minimized) saved.window.minimize();
    else if (!saved.visible) saved.window.hide();
  }
  private tick() {
    const window = this.window();
    const idle = powerMonitor.getSystemIdleTime();
    const returned = idle < this.previousIdle || idle < 1;
    this.previousIdle = idle;
    if (returned) { this.dismissed = false; this.restore(); }
    const allowed = this.active && !!window && !window.isDestroyed() && !this.locked && !this.linuxLocked && !this.suspended
      && powerMonitor.getSystemIdleState(1) !== "locked";
    if (allowed && this.wakeId === null) this.wakeId = powerSaveBlocker.start("prevent-display-sleep");
    if (!allowed) {
      if (this.wakeId !== null) powerSaveBlocker.stop(this.wakeId);
      this.wakeId = null; this.restore(); return;
    }
    if (!this.saved && !this.dismissed && !returned && this.timeout !== null && idle >= this.timeout) {
      this.saved = { window: window!, fullscreen: window!.isFullScreen(), top: window!.isAlwaysOnTop(), minimized: window!.isMinimized(), visible: window!.isVisible() };
      if (window!.isMinimized()) window!.restore();
      window!.show(); window!.setAlwaysOnTop(true); window!.setFullScreen(true); window!.focus();
    }
  }
  stop() {
    this.stopped = true;
    clearInterval(this.timer); clearInterval(this.settingsTimer);
    this.active = false; this.tick();
    powerMonitor.removeListener("lock-screen", this.lock); powerMonitor.removeListener("unlock-screen", this.unlock);
    powerMonitor.removeListener("suspend", this.suspend); powerMonitor.removeListener("resume", this.resume);
    powerMonitor.removeListener("on-ac", this.refresh); powerMonitor.removeListener("on-battery", this.refresh);
  }
}
