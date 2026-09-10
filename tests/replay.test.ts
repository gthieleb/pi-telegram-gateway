import { describe, expect, it } from "vitest";
import { renderSessionHistory, readSessionMessages } from "../src/replay.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function writeTempSession(lines: object[]): string {
  const dir = mkdtempSync(join(tmpdir(), "replay-"));
  const file = join(dir, "session.jsonl");
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return file;
}

const entry = (role: string, content: object | string) => ({
  type: "message",
  message: { role, content },
});

describe("readSessionMessages", () => {
  it("extracts user/assistant turns, skips tool noise and non-message entries", () => {
    const file = writeTempSession([
      { type: "session_info", name: "My session" },
      { type: "message", message: { role: "user", content: "Hi, refactor auth" } },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "Sure." }] } },
      { type: "message", message: { role: "toolResult", content: [{ type: "text", text: "noise" }] } },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "Done." }, { type: "toolCall", name: "edit" }] } },
      { type: "custom_entry", data: 1 },
    ]);
    const msgs = readSessionMessages(file);
    expect(msgs).toEqual([
      { role: "user", text: "Hi, refactor auth" },
      { role: "assistant", text: "Sure." },
      { role: "assistant", text: "Done." },
    ]);
  });

  it("returns empty for missing file", () => {
    expect(readSessionMessages("/definitely/missing.jsonl")).toEqual([]);
  });
});

describe("renderSessionHistory", () => {
  it("renders role-prefixed text", () => {
    const out = renderSessionHistory([
      { role: "user", text: "q" },
      { role: "assistant", text: "a" },
    ]);
    expect(out).toBe("**You:** q\n\n**Pi:** a");
  });

  it("limits to recent N messages", () => {
    const msgs = Array.from({ length: 20 }, (_, i) => ({ role: "user", text: `m${i}` }));
    const out = renderSessionHistory(msgs, 5);
    expect(out).toContain("… (15 ältere Nachrichten ausgelassen)");
    expect(out).toContain("**You:** m19");
  });
});