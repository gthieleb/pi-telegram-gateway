import { describe, expect, it, vi } from "vitest";
import { laneKey, Router } from "../src/router.js";
import type { LikeLane } from "../src/router.js";

function fakeLane() {
  return { prompt: vi.fn(async () => {}), abort: vi.fn(async () => {}), dispose: vi.fn(), busy: false };
}

function makeRouter(opts: { maxLanes?: number; now?: () => number } = {}) {
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

  it("disposeAll disposes every lane", async () => {
    const { router } = makeRouter();
    await router.dispatch("1:1", "a");
    await router.dispatch("2:2", "b");
    router.disposeAll();
    expect(router.size).toBe(0);
  });
});