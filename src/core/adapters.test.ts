import { describe, expect, it } from "vitest";
import { codexAdapter, genericJsonlAdapter } from "./adapters";
describe("adapters", () => {
  it("normalizes simple protocol events", () => expect(genericJsonlAdapter.ingest({ status: "testing", label: "Test suite" })?.status).toBe("testing"));
  it("rejects malformed events", () => expect(genericJsonlAdapter.ingest("hello")).toBeNull());
  it("maps observable Codex test activity", () => expect(codexAdapter.ingest({ type: "command.started", command: "pnpm test" })?.status).toBe("testing"));
});
