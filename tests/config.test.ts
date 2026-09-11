import { describe, expect, it } from "vitest";
import { normalizeConfig, validateRaw } from "../src/config.js";

describe("config", () => {
  it("applies defaults", () => {
    const cfg = normalizeConfig({ version: 1, botToken: "123:abc", allowedUsers: [1] });
    expect(cfg.requireMention).toBe(false);
    expect(cfg.idleTimeoutMinutes).toBe(30);
    expect(cfg.maxLanes).toBe(8);
    expect(cfg.cwd).toBeTypeOf("string");
    expect(cfg.mode).toBe("auto");
  });

  it("rejects missing token / users", () => {
    expect(() => validateRaw({ version: 1, allowedUsers: [1] })).toThrow(/botToken/);
    expect(() => normalizeConfig({ version: 1, botToken: "x", allowedUsers: [] })).toThrow(/allowedUsers/);
    expect(() => normalizeConfig({ version: 1, botToken: "x", allowedUsers: [1], maxLanes: 0 })).toThrow(/maxLanes/);
  });

  it("accepts full config", () => {
    const cfg = normalizeConfig({
      version: 1, botToken: "t", allowedUsers: [915681932], botUsername: "PiLemmaBot",
      requireMention: true, cwd: "/tmp", idleTimeoutMinutes: 5, maxLanes: 3,
    });
    expect(cfg.botUsername).toBe("PiLemmaBot");
    expect(cfg.requireMention).toBe(true);
  });

  it("defaults mode to auto; rejects unknown modes", () => {
    expect(normalizeConfig({ version: 1, botToken: "t", allowedUsers: [1] }).mode).toBe("auto");
    expect(normalizeConfig({ version: 1, botToken: "t", allowedUsers: [1], mode: "daemon" }).mode).toBe("daemon");
    expect(normalizeConfig({ version: 1, botToken: "t", allowedUsers: [1], mode: "extension" }).mode).toBe("extension");
    expect(() => normalizeConfig({ version: 1, botToken: "t", allowedUsers: [1], mode: "telepathy" as never })).toThrow(/mode/);
  });

  it("passes voice config through", () => {
    const cfg = normalizeConfig({ version: 1, botToken: "t", allowedUsers: [1], voice: { enabled: true, replies: "both" } });
    expect(cfg.voice?.enabled).toBe(true);
    expect(cfg.voice?.replies).toBe("both");
    expect(() => normalizeConfig({ version: 1, botToken: "t", allowedUsers: [1], voice: { enabled: "yes" as never } })).toThrow(/voice/);
  });
});