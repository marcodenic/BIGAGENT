import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ClaudeProvider } from "./claude";
import { findExecutable } from "./executables";
import { TelemetryHub } from "../telemetry/hub";

vi.mock("./executables", () => ({ findExecutable: vi.fn() }));
let provider: ClaudeProvider | undefined;
let config: string | undefined;
afterEach(async () => {
  provider?.stop();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  if (config) await rm(config, { recursive: true, force: true });
});

it("starts a single polling loop when Recheck discovers Claude after startup", async () => {
  config = await mkdtemp(join(tmpdir(), "bigagent-claude-test-"));
  vi.stubEnv("CLAUDE_CONFIG_DIR", config);
  vi.useFakeTimers();
  vi.mocked(findExecutable).mockResolvedValue(undefined);
  provider = new ClaudeProvider(new TelemetryHub(), () => {});
  const reconcile = vi.spyOn(provider as unknown as { reconcile(): Promise<void> }, "reconcile").mockResolvedValue();
  await provider.start();
  await vi.advanceTimersByTimeAsync(3000);
  expect(reconcile).not.toHaveBeenCalled();

  vi.mocked(findExecutable).mockResolvedValue("/fake/claude");
  await provider.action("retry");
  expect(reconcile).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(3000);
  expect(reconcile).toHaveBeenCalledTimes(2);
  await provider.action("retry");
  expect(reconcile).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(3000);
  expect(reconcile).toHaveBeenCalledTimes(4);
  provider.stop();
  await vi.advanceTimersByTimeAsync(6000);
  expect(reconcile).toHaveBeenCalledTimes(4);
});
