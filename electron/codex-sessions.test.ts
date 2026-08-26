import { describe, expect, it } from "vitest";
import { normalizeCodexRolloutItem, normalizeCodexToolCall, reconcileCodexTurnLifecycle } from "./codex-rollout";

describe("Codex desktop rollout telemetry", () => {
  it("preserves the actual shell command instead of reducing it to bash", () => {
    expect(normalizeCodexRolloutItem({
      type: "CommandExecution",
      command: ["/bin/bash", "-lc", "pnpm test"],
      status: "completed",
    })).toEqual({
      itemType: "commandExecution",
      item: { command: "pnpm test", status: "completed" },
    });
  });

  it("maps public reasoning summaries and agent messages", () => {
    expect(normalizeCodexRolloutItem({
      type: "Reasoning",
      summary_text: ["Inspecting the live telemetry source"],
    })).toEqual({
      itemType: "reasoning",
      item: { summary: ["Inspecting the live telemetry source"] },
    });
    expect(normalizeCodexRolloutItem({
      type: "AgentMessage",
      content: [{ type: "Text", text: "The live feed is connected." }],
    })).toEqual({
      itemType: "agentMessage",
      item: { text: "The live feed is connected." },
    });
  });

  it("converts rollout file URLs into previewable local paths", () => {
    expect(normalizeCodexRolloutItem({
      type: "ImageView",
      path: "file:///tmp/agent-output.png",
    })).toEqual({
      itemType: "imageView",
      item: { path: "/tmp/agent-output.png" },
    });
  });

  it("surfaces an in-flight code-mode command before its result arrives", () => {
    expect(normalizeCodexToolCall({
      name: "exec",
      input: 'const result = await tools.exec_command({"cmd":"pnpm build","yield_time_ms":30000});',
    })).toEqual({
      itemType: "commandExecution",
      item: { command: "pnpm build", status: "inProgress" },
    });
  });

  it("identifies nested tools instead of displaying the generic exec wrapper", () => {
    expect(normalizeCodexToolCall({
      name: "exec",
      input: "const result = await tools.apply_patch(patch);",
    })).toEqual({
      itemType: "fileChange",
      item: { changes: [], status: "inProgress" },
    });
  });

  it("closes an orphaned turn when its Codex agent loop has exited", () => {
    expect(reconcileCodexTurnLifecycle("inProgress", 100, null, 125)).toEqual({
      status: "completed",
      completedAt: 125,
    });
    expect(reconcileCodexTurnLifecycle("inProgress", 200, null, 125)).toEqual({
      status: "inProgress",
      completedAt: null,
    });
  });
});
