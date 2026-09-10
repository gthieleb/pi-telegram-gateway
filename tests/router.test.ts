import { describe, expect, it, vi } from "vitest";
import { laneKey, Router } from "../src/router.js";
import type { LikeLane } from "../src/router.js";

function fakeLane(opts: { sessionFile?: string } = {}) {
  return {
    prompt: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
    dispose: vi.fn(),
    busy: false,
    sessionFile: () => opts.sessionFile,
  };
}

function makeRouter(opts: { maxLanes?: number; now?: () => number; bindings?: Map<string, string> } = {}) {
  let created = 0;
  const factory = vi.fn(async () => {
    created++;
    return fakeLane() as LikeLane;
  });
  const router = new Router({
    createLane: factory,
    idleTimeoutMs: 1000,
    maxLanes: opts.maxLanes ?? 2,
    now: opts.now ?? (() => Date.now()),
    loadBinding: opts.bindings ? (k) => opts.bindings!.get(k) : undefined,
    saveBinding: opts.bindings ? (k, f) => void opts.bindings!.set(k, f) : undefined,
    clearBinding: opts.bindings ? (k) => opts.bindings!.delete(k) : undefined,
  });
  return { router, factory, created: () => created };
}

describe("Router", () => {
  it("laneKey separates chat and thread", () => {
    expect(laneKey(1, 5)).toBe("1:5");
    expect(laneKey(1, undefined)).toBe("1:root");
    expect(laneKey(1, 5)).not.toBe(laneKey(1, 6));
  });

  it("reuses the same lane for the same key", async () => {
    const { router, created } = makeRouter();
    await router.dispatch("1:5", "a");
    await router.dispatch("1:5", "b");
    await router.dispatch("1:6", "c");
    expect(created()).toBe(2);
    router.disposeAll();
  });

  it("passes persisted session file into factory and saves binding after prompt", async () => {
    const bindings = new Map<string, string>([["1:5", "sessions/old.jsonl"]]);
    let created = 0;
    const factory = vi.fn(async (_key: string, resume?: string) => {
      created++;
      return fakeLane({ sessionFile: `sessions/new-${created}.jsonl` }) as LikeLane;
    });
    const router = new Router({
      createLane: factory,
      idleTimeoutMs: 1000,
      maxLanes: 4,
      loadBinding: (k) => bindings.get(k),
      saveBinding: (k, f) => bindings.set(k, f),
      clearBinding: (k) => bindings.delete(k),
    });
    await router.dispatch("1:5", "a");
    expect(factory).toHaveBeenCalledWith("1:5", "sessions/old.jsonl");
    expect(bindings.get("1:5")).toBe("sessions/new-1.jsonl");
    // lane without sessionFile must not clobber the binding
    const factoryNoFile = vi.fn(async () => fakeLane() as LikeLane);
    const r2 = new Router({
      createLane: factoryNoFile,
      idleTimeoutMs: 1000,
      maxLanes: 4,
      loadBinding: (k) => bindings.get(k),
      saveBinding: (k, f) => bindings.set(k, f),
      clearBinding: (k) => bindings.delete(k),
    });
    await r2.dispatch("2:2", "x");
    expect(bindings.get("2:2")).toBeUndefined();
    r2.disposeAll();
  });

  it("reset clears the binding as well", async () => {
    const bindings = new Map<string, string>([["1:5", "sessions/old.jsonl"]]);
    const router = new Router({
      createLane: async () => fakeLane() as LikeLane,
      idleTimeoutMs: 1000,
      maxLanes: 4,
      loadBinding: (k) => bindings.get(k),
      saveBinding: (k, f) => bindings.set(k, f),
      clearBinding: (k) => bindings.delete(k),
    });
    await router.dispatch("1:5", "a");
    router.reset("1:5");
    expect(bindings.has("1:5")).toBe(false);
    router.disposeAll();
  });

  it("attachSession binds the file, eagerly resumes and future dispatch resumes it", async () => {
    const bindings = new Map<string, string>();
    const resumes: string[] = [];
    const factory = vi.fn(async (key: string, resume?: string) => {
      if (resume) resumes.push(resume);
      return fakeLane({ sessionFile: `sessions/${key}.jsonl` }) as LikeLane;
    });
    const router = new Router({
      createLane: factory,
      idleTimeoutMs: 1000,
      maxLanes: 4,
      loadBinding: (k) => bindings.get(k),
      saveBinding: (k, f) => bindings.set(k, f),
      clearBinding: (k) => bindings.delete(k),
    });
    await router.attachSession("1:5", "sessions/att.jsonl");
    expect(bindings.get("1:5")).toBe("sessions/att.jsonl");
    expect(factory).toHaveBeenCalledWith("1:5", "sessions/att.jsonl"); // eager resume
    expect(resumes).toEqual(["sessions/att.jsonl"]);
    expect(router.has("1:5")).toBe(true);
    await router.dispatch("1:5", "next");
    expect(router.laneForTest("1:5")!.busy).toBe(false);
    router.disposeAll();
  });

  it("disposes idle lanes beyond timeout", async () => {
    let t = 0;
    const { router } = makeRouter({ now: () => t });
    await router.dispatch("1:1", "a");
    t = 500;
    router.sweepIdle();
    expect(router.size).toBe(1);
    t = 2000;
    router.sweepIdle();
    expect(router.size).toBe(0);
  });

  it("caps lanes: oldest non-busy is disposed when full", async () => {
    let t = 0;
    const { router } = makeRouter({ maxLanes: 2, now: () => t });
    await router.dispatch("1:1", "a");
    t = 10;
    await router.dispatch("1:2", "b");
    t = 20;
    await router.dispatch("1:3", "c");
    expect(router.has("1:1")).toBe(false);
    expect(router.has("1:2")).toBe(true);
    expect(router.has("1:3")).toBe(true);
    router.disposeAll();
  });

  it("reset disposes the lane and drops it", async () => {
    const { router, created } = makeRouter();
    await router.dispatch("1:5", "a");
    const lane = router.laneForTest("1:5");
    router.reset("1:5");
    expect(created()).toBe(1);
    expect(lane!.dispose).toHaveBeenCalled();
    expect(router.has("1:5")).toBe(false);
    await router.dispatch("1:5", "b");   // fresh lane
    expect(created()).toBe(2);
    router.disposeAll();
  });

  it("disposeAll disposes every lane", async () => {
    const { router } = makeRouter();
    await router.dispatch("1:1", "a");
    await router.dispatch("2:2", "b");
    router.disposeAll();
    expect(router.size).toBe(0);
  });
});