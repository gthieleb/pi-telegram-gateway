import { describe, expect, it } from "vitest";
import { extractReplyText } from "../src/reply.js";

describe("extractReplyText", () => {
  it("concatenates assistant text blocks after snapshot", () => {
    const msgs = [
      { role: "user", content: [{ type: "text", text: "q" }] },
      { role: "assistant", content: [{ type: "text", text: "part1 " }, { type: "text", text: "part2" }] },
      { role: "toolResult", content: [{ type: "text", text: "noise" }] },
      { role: "assistant", content: [{ type: "text", text: " final" }] },
    ];
    expect(extractReplyText(msgs as never[])).toBe("part1 part2 final");
  });
  it("handles string content and returns empty for none", () => {
    expect(extractReplyText([{ role: "assistant", content: "plain" }] as never[])).toBe("plain");
    expect(extractReplyText([])).toBe("");
  });
});