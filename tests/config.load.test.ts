import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfigFrom } from "../src/config.js";

describe("loadConfigFrom", () => {
  it("returns null when file missing", () => {
    expect(loadConfigFrom(join(tmpdir(), "definitely-missing-gw.json"))).toBeNull();
  });

  it("loads and normalizes", () => {
    const dir = mkdtempSync(join(tmpdir(), "gw-"));
    const file = join(dir, "config.json");
    writeFileSync(file, JSON.stringify({ version: 1, botToken: "t", allowedUsers: [5] }));
    const cfg = loadConfigFrom(file)!;
    expect(cfg.botToken).toBe("t");
    expect(cfg.maxLanes).toBe(8);
  });

  it("throws on invalid json with file path", () => {
    const dir = mkdtempSync(join(tmpdir(), "gw-"));
    const file = join(dir, "config.json");
    writeFileSync(file, "{nope");
    expect(() => loadConfigFrom(file)).toThrow(/config\.json/);
  });
});