import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { normalizeCodexRolloutItem, normalizeCodexToolCall, reconcileCodexTurnLifecycle, reconcileCompletedRolloutItem, splitCompleteJsonLines } from "./codex-rollout";

describe("Codex desktop rollout telemetry", () => {
  it("consumes a complete final lifecycle record without waiting for a newline", () => {
    const complete = '{"type":"event_msg","payload":{"type":"task_complete","turn_id":"turn-1"}}';
    expect(splitCompleteJsonLines(complete)).toEqual({ lines: [complete], remainder: "" });

    const partial = '{"type":"event_msg","payload":{"type":"task_complete"';
    expect(splitCompleteJsonLines(partial)).toEqual({ lines: [], remainder: partial });
  });

  it("preserves the actual shell command instead of reducing it to bash", () => {
    expect(normalizeCodexRolloutItem({
      type: "CommandExecution",
      command: ["/bin/bash", "-lc", "pnpm test"],
      status: "completed",
    })).toEqual({
      itemType: "commandExecution",
      item: { command: "pnpm test", status: "completed", cwd: "" },
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
      path: pathToFileURL(join(tmpdir(), "agent-output.png")).href,
    })).toEqual({
      itemType: "imageView",
      item: { path: join(tmpdir(), "agent-output.png") },
    });
  });

  it("surfaces an in-flight code-mode command before its result arrives", () => {
    expect(normalizeCodexToolCall({
      name: "exec",
      input: 'const result = await tools.exec_command({"cmd":"pnpm build","yield_time_ms":30000});',
    })).toEqual({
      itemType: "commandExecution",
      item: { command: "pnpm build", status: "inProgress", cwd: "" },
    });
  });

  it("does not revive a command that Codex already marked completed", () => {
    expect(normalizeCodexToolCall({
      name: "exec",
      status: "completed",
      input: 'const result = await tools.exec_command({"cmd":"pnpm build"});',
    })).toEqual({
      itemType: "commandExecution",
      item: { command: "pnpm build", status: "completed", cwd: "" },
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

  it("keeps a command in its arrival position when it completes out of order", () => {
    const state = {
      items: [
        {
          item_type: "commandExecution",
          item_json: JSON.stringify({ command: "long-running-task", status: "inProgress" }),
          updated_at_ordinal: 10,
          timestamp: 1,
          callId: "call-a",
          transient: true,
        },
        {
          item_type: "commandExecution",
          item_json: JSON.stringify({ command: "quick-task", status: "inProgress" }),
          updated_at_ordinal: 11,
          timestamp: 2,
          callId: "call-b",
          transient: true,
        },
      ],
    };

    const merged = reconcileCompletedRolloutItem(state.items, normalizeCodexRolloutItem({
      type: "CommandExecution",
      command: ["/bin/bash", "-lc", "long-running-task"],
      status: "completed",
    }), 3);

    expect(merged).toBe(true);
    expect(state.items.map((item) => item.updated_at_ordinal)).toEqual([10, 11]);
    expect(state.items.map((item) => JSON.parse(item.item_json))).toEqual([
      { command: "long-running-task", status: "completed", cwd: "" },
      { command: "quick-task", status: "inProgress" },
    ]);
    expect(state.items[0]).toMatchObject({ callId: "call-a", transient: false });
    expect(state.items[1]).toMatchObject({ callId: "call-b", transient: true });
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
