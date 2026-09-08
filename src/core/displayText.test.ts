import { expect, it } from "vitest";
import { displayText } from "./displayText";

it("removes realtime directives while preserving the message and Markdown cleanup", () => {
  expect(displayText('::codex-realtime-inline{} The **new repositories** are ready.', 'Working')).toBe('The new repositories are ready.');
  expect(displayText('First ::codex-realtime-inline{} second', 'Working')).toBe('First second');
  expect(displayText('::codex-realtime-inline{}', 'Working')).toBe('Working');
  expect(displayText('Keep {these braces} and ::other{}', 'Working')).toBe('Keep {these braces} and ::other{}');
});
