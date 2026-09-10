import { describe, expect, it, vi } from "vitest";
import { CallbackRegistry } from "../src/callbacks.js";

describe("CallbackRegistry", () => {
  it("register returns short id; resolve returns value once", () => {
    const reg = new CallbackRegistry<string>();
    const id = reg.register("menu-a", 60_000);
    expect(id).toMatch(/^[0-9a-f]{6}$/);
    expect(reg.resolve(id)).toBe("menu-a");
  });

  it("resolve retrieves the registered value and removes it (single use)", () => {
    const reg = new CallbackRegistry<string>();
    const id = reg.register("value-x", 60_000);
    expect(reg.resolve(id)).toBe("value-x");
    expect(reg.resolve(id)).toBeUndefined();
  });

  it("sweep drops expired entries", () => {
    let t = 0;
    const reg = new CallbackRegistry<string>({ now: () => t });
    const id = reg.register("old", 1000);
    t = 500;
    reg.sweep();
    expect(reg.resolve(id)).toBe("old");
    const id2 = reg.register("newer", 1000);
    t = 2500;
    reg.sweep();
    expect(reg.resolve(id2)).toBeUndefined();
  });

  it("ids are unique across registrations", () => {
    const reg = new CallbackRegistry<string>();
    const ids = new Set(Array.from({ length: 50 }, () => reg.register("v", 60_000)));
    expect(ids.size).toBe(50);
  });
});