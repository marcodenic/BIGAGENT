import { expect, it } from "vitest";
import { subagentAssignment, subagentColor } from "./subagentPresentation";

it("uses declared roles and never infers a role from an assignment", () => {
  expect(subagentColor({ id: "a", agentRole: "explorer" })).toBe("cyan");
  expect(subagentColor({ id: "a", agentRole: "worker" })).toBe("violet");
  expect(subagentColor({ id: "a", agentRole: "reviewer" })).toBe("yellow");
  expect(subagentColor({ id: "a", agentRole: "default" })).toBe("blue");
  expect(subagentColor({ id: "a", agentRole: "custom" })).toBe(subagentColor({ id: "b", agentRole: "custom" }));
  expect(subagentColor({ id: "a" })).toBe(subagentColor({ id: "a", agentRole: "" }));
});
it("separates the readable assignment from the agent nickname and declared role", () => {
  expect(subagentAssignment({ agentPath: "/root/architecture_walk", agentTaskTitle: "Long prompt" })).toBe("Architecture walk");
  expect(subagentAssignment({ agentTaskTitle: "Check contrast" })).toBe("Check contrast");
  expect(subagentAssignment({ agentRole: "explorer" })).toBe("explorer");
  expect(subagentAssignment({})).toBe("");
});
