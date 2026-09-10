// src/lock.ts
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface LeaderData {
  pid: number;
  capability: string;
  epoch: number;
  processIdentity: { name: string; startedAt: number };
  createdAt: number;
}
export interface LockHandle { path: string; data: LeaderData }
export interface ClaimResult { leader: boolean; lock?: LeaderData }

/** Identity of the running process: /proc name + starttime (Linux), fallback "unknown". */
export function selfIdentity(): { name: string; startedAt: number } {
  return procStat(process.pid) ?? { name: "unknown", startedAt: 0 };
}

function procInfo(pid: number): { name: string; startedAt: number } | null {
  return procStat(pid);
}

function procStat(pid: number): { name: string; startedAt: number } | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const name = stat.slice(stat.indexOf("(") + 1, stat.lastIndexOf(")"));
    const startedAt = Number(stat.slice(stat.lastIndexOf(")") + 2).trim().split(" ")[19]) || 0;
    return { name, startedAt };
  } catch {
    return null;
  }
}

export function processInfo(pid: number): { alive: boolean; name: string; startedAt: number } {
  const info = procInfo(pid);
  if (info) return { alive: true, ...info };
  try {
    process.kill(pid, 0);
    return { alive: true, name: "unknown", startedAt: 0 };
  } catch {
    return { alive: false, name: "", startedAt: 0 };
  }
}

export function readLock(path: string): LeaderData | null {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<LeaderData>;
    if (typeof raw.pid !== "number" || typeof raw.capability !== "string") return null;
    return {
      pid: raw.pid,
      capability: raw.capability,
      epoch: Number(raw.epoch ?? 0),
      processIdentity: raw.processIdentity ?? { name: "unknown", startedAt: 0 },
      createdAt: Number(raw.createdAt ?? 0),
    };
  } catch {
    return null;
  }
}

export function claimLock(
  path: string,
  opts: { capability: string },
  identity: { name: string; startedAt: number } = selfIdentity(),
): { leader: boolean; lock?: LeaderData } {
  const existing = readLock(path);
  if (existing) {
    const info = processInfo(existing.pid);
    const identityMatches =
      existing.processIdentity.name === info.name && existing.processIdentity.startedAt === info.startedAt;
    const alive = info.alive && identityMatches;
    if (alive) return { leader: false, lock: existing };
    // stale → reclaim below
  }
  const data: LeaderData = {
    pid: process.pid,
    capability: opts.capability,
    epoch: Date.now(),
    processIdentity: identity,
    createdAt: Date.now(),
  };
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp.${process.pid}`;
  writeFileSync(tmpPath, JSON.stringify(data));
  try { unlinkSync(path); } catch { /* ENOENT ok */ }
  renameSync(tmpPath, path); // atomic replace
  return { leader: true, lock: data };
}

export function releaseLock(path: string, handle: LockHandle | { lock?: LeaderData }): void {
  const data = handle.data ?? handle.lock;
  if (!data) return;
  const current = readLock(path);
  if (current && current.capability === data.capability && current.pid === data.pid) {
    try { unlinkSync(path); } catch { /* ok */ }
  }
}