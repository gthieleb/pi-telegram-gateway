import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claimLock, readLock, releaseLock } from "../src/lock.js";

const tmp = () => mkdtempSync(join(tmpdir(), "lock-"));

describe("leader lock", () => {
  it("claims when empty and persists metadata", () => {
    const file = join(tmp(), "leader.json");
    const res = claimLock(file, { capability: "cap-a" });
    expect(res.leader).toBe(true);
    const onDisk = JSON.parse(readFileSync(file, "utf8"));
    expect(onDisk.pid).toBe(process.pid);
    expect(onDisk.capability).toBe("cap-a");
  });

  it("second claimer loses while leader alive (same identity)", () => {
    const file = join(tmp(), "leader.json");
    const a = claimLock(file, { capability: "cap-a" });
    expect(a.leader).toBe(true);
    const b = claimLock(file, { capability: "cap-b" });
    expect(b.leader).toBe(false);
    expect(b.lock?.pid).toBe(process.pid);
  });

  it("reclaims stale lock of dead pid", () => {
    const file = join(tmp(), "leader.json");
    writeFileSync(file, JSON.stringify({
      pid: 999999999, capability: "old", epoch: 1,
      processIdentity: { name: "pi", startedAt: 1 }, createdAt: 0,
    }));
    const res = claimLock(file, { capability: "cap-b" });
    expect(res.leader).toBe(true);
  });

  it("reclaims when pid was reused by an unrelated process (identity mismatch)", () => {
    const file = join(tmp(), "leader.json");
    // real pid, but recorded identity belongs to a different process → stale
    writeFileSync(file, JSON.stringify({
      pid: process.pid, capability: "old", epoch: 1,
      processIdentity: { name: "definitely-not-pi", startedAt: 1 }, createdAt: 0,
    }));
    expect(claimLock(file, { capability: "cap-c" }).leader).toBe(true);
  });

  it("readLock parses garbage as null; releaseLock removes own lock only", () => {
    const file = join(tmp(), "leader.json");
    writeFileSync(file, "garbage");
    expect(readLock(file)).toBeNull();
    const res = claimLock(file, { capability: "cap-d" });
    releaseLock(file, res);
    expect(readLock(file)).toBeNull();
  });
});