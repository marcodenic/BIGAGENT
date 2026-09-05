import { afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ idle: 0, locked: false, start: vi.fn(() => 7), stop: vi.fn(), timeout: vi.fn(async () => 300) }));
vi.mock("electron", () => ({
  powerMonitor: { on: vi.fn(), removeListener: vi.fn(), isOnBatteryPower: () => false, getSystemIdleTime: () => mocks.idle, getSystemIdleState: () => mocks.locked ? "locked" : "idle" },
  powerSaveBlocker: { start: mocks.start, stop: mocks.stop },
}));
vi.mock("./idle-timeout", () => ({ systemIdleTimeout: mocks.timeout, readSystemCommand: async () => "" }));
import { IdleDisplay } from "./idle-display";
import type { BrowserWindow } from "electron";
function setup() {
  vi.useFakeTimers(); mocks.idle = 0; mocks.locked = false; vi.clearAllMocks(); mocks.timeout.mockReset().mockResolvedValue(300);
  let fullscreen = false;
  const window = { isDestroyed: () => false, isFullScreen: () => fullscreen, isAlwaysOnTop: () => false, isMinimized: () => false, isVisible: () => true,
    setFullScreen: vi.fn((value: boolean) => { fullscreen = value; }), setAlwaysOnTop: vi.fn(), minimize: vi.fn(), hide: vi.fn(), restore: vi.fn(), show: vi.fn(), focus: vi.fn() };
  const controller = new IdleDisplay(() => window as unknown as BrowserWindow);
  return { window, controller };
}
afterEach(() => vi.useRealTimers());
describe("automatic idle display", () => {
  it("presents at the idle threshold and releases display sleep when work finishes", async () => {
    const { window, controller } = setup();
    await Promise.resolve();
    controller.setActive(true);
    expect(mocks.start).toHaveBeenCalledOnce();
    mocks.idle = 299; vi.advanceTimersByTime(1000); expect(window.show).not.toHaveBeenCalled();
    mocks.idle = 300; vi.advanceTimersByTime(1000); expect(window.setFullScreen).toHaveBeenCalledWith(true);
    controller.setActive(false); expect(mocks.stop).toHaveBeenCalledWith(7); expect(window.setFullScreen).toHaveBeenLastCalledWith(false);
    controller.stop();
  });
  it("restores on user return and respects dismissal until the next idle period", async () => {
    const { window, controller } = setup(); await Promise.resolve(); controller.setActive(true);
    mocks.idle = 301; vi.advanceTimersByTime(1000); controller.dismiss();
    vi.advanceTimersByTime(2000); expect(window.show).toHaveBeenCalledTimes(1);
    mocks.idle = 0; vi.advanceTimersByTime(1000);
    mocks.idle = 301; vi.advanceTimersByTime(1000); expect(window.show).toHaveBeenCalledTimes(2);
    mocks.idle = 0; vi.advanceTimersByTime(1000); expect(window.setFullScreen).toHaveBeenLastCalledWith(false);
    controller.stop();
  });
  it("exits automatic fullscreen on toggle and remains dismissed", async () => {
    const { window, controller } = setup(); await Promise.resolve();
    controller.setActive(true); mocks.idle = 301; vi.advanceTimersByTime(1000);
    expect(window.isFullScreen()).toBe(true);
    controller.toggleFullscreen(window as unknown as BrowserWindow);
    expect(window.isFullScreen()).toBe(false);
    vi.advanceTimersByTime(1000); expect(window.isFullScreen()).toBe(false);
    controller.stop();
  });

  it.each([600, Infinity])("waits for the actual timeout (%s) before presenting", async (timeout) => {
    const { window, controller } = setup();
    // Start a second controller with a pending initial settings read.
    controller.stop();
    let resolve!: (value: number) => void;
    mocks.timeout.mockImplementationOnce(() => new Promise<number>(done => { resolve = done; }));
    const pending = new IdleDisplay(() => window as unknown as BrowserWindow);
    mocks.idle = 350; pending.setActive(true); vi.advanceTimersByTime(1000);
    expect(window.show).not.toHaveBeenCalled();
    resolve(timeout); await Promise.resolve(); vi.advanceTimersByTime(1000);
    expect(window.show).not.toHaveBeenCalled();
    if (Number.isFinite(timeout)) {
      mocks.idle = timeout; vi.advanceTimersByTime(1000);
      expect(window.isFullScreen()).toBe(true);
    }
    pending.stop();
  });

  it("does not present or keep the display awake while locked or inactive", () => {
    const { window, controller } = setup(); mocks.idle = 400; vi.advanceTimersByTime(1000);
    expect(window.show).not.toHaveBeenCalled();
    mocks.locked = true; controller.setActive(true); expect(mocks.start).not.toHaveBeenCalled(); expect(window.show).not.toHaveBeenCalled();
    controller.stop();
  });
});
