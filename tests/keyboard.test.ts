import { describe, expect, it } from "vitest";
import { askUserKeyboard, attachReplayKeyboard, sessionsKeyboard } from "../src/keyboard.js";

describe("keyboard builders", () => {
  it("sessionsKeyboard lists sessions with short callback ids", () => {
    const kb = sessionsKeyboard("m1", [
      { label: "Refactor auth · 5 msg · 2h", file: "/s/1.jsonl" },
      { label: "Gateway · 12 msg", file: "/s/2.jsonl" },
    ]);
    expect(kb.inline_keyboard).toHaveLength(3); // 2 items + cancel
    expect(kb.inline_keyboard[0][0].text).toBe("Refactor auth · 5 msg · 2h");
    expect(kb.inline_keyboard[2][0].callback_data).toBe("gw:att:m1:cancel");
  });

  it("callback_data stays within the 64 byte limit", () => {
    const kb = sessionsKeyboard("abc123", [
      { label: "very long label indeed · 999 msg · yesterday", file: "/a/very/long/path/session-file.jsonl" },
    ]);
    const cb = kb.inline_keyboard[0][0].callback_data!;
    expect(cb.length).toBeLessThanOrEqual(64);
    expect(cb).toBe("gw:att:abc123:0");
  });

  it("askUserKeyboard renders options + free-text escape", () => {
    const kb = askUserKeyboard("m2", ["Ja", "Nein"]);
    const labels = kb.inline_keyboard.flat().map((b) => b.text);
    expect(labels).toEqual(["Ja", "Nein", "✏️ selbst tippen", "⏭ überspringen"]);
    expect(kb.inline_keyboard[0][0].callback_data).toBe("gw:ans:m2:0");
  });

  it("attachReplayKeyboard offers recent/full/none", () => {
    const kb = attachReplayKeyboard("m3");
    const cbs = kb.inline_keyboard.flat().map((b) => b.callback_data);
    expect(cbs).toEqual(["gw:rep:m3:recent", "gw:rep:m3:full", "gw:rep:m3:none"]);
  });
});