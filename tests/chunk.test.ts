import { describe, expect, it } from "vitest";
import { splitMessage } from "../src/chunk.js";

describe("splitMessage", () => {
  it("returns single chunk for short text", () => {
    expect(splitMessage("hi")).toEqual(["hi"]);
  });
  it("splits long text respecting paragraphs (lossless)", () => {
    const text = "a\n\n" + "b".repeat(4095) + "\n\nc";
    const parts = splitMessage(text);
    expect(parts[0].length).toBeLessThanOrEqual(4096);
    expect(parts.every((p) => p.length > 0)).toBe(true);
    expect(parts.join("")).toBe(text);
  });
  it("hard-cuts when no boundary exists", () => {
    const parts = splitMessage("x".repeat(9000));
    expect(parts.length).toBe(3);
    expect(parts.every((p) => p.length <= 4096)).toBe(true);
  });
  it("returns empty for empty text", () => {
    expect(splitMessage("")).toEqual([]);
  });
});