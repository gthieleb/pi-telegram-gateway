import { describe, expect, it } from "vitest";
import { shouldDispatch, mentionsBot, parseCommand } from "../src/gate.js";
import type { GatewayConfig } from "../src/config.js";

const cfg = (over: Partial<GatewayConfig> = {}): GatewayConfig => ({
  version: 1, botToken: "t", botUsername: "PiLemmaBot", allowedUsers: [42],
  requireMention: false, cwd: "/tmp", idleTimeoutMinutes: 5, maxLanes: 4, mode: "auto", ...over,
});
const msg = (over = {}) => ({
  message_id: 1, date: 0,
  from: { id: 42, is_bot: false, username: "owner" },
  chat: { id: -100, type: "supergroup", is_forum: true },
  text: "hello", ...over,
});

describe("shouldDispatch", () => {
  it("allows allowed user in free-response mode", () => {
    expect(shouldDispatch(msg() as never, cfg(), "PiLemmaBot")).toBe(true);
  });
  it("rejects unknown users always", () => {
    expect(shouldDispatch(msg({ from: { id: 7, is_bot: false } }) as never, cfg(), "PiLemmaBot")).toBe(false);
  });
  it("rejects bots (including other bots)", () => {
    expect(shouldDispatch(msg({ from: { id: 42, is_bot: true } }) as never, cfg(), "PiLemmaBot")).toBe(false);
  });
  it("requireMention: no mention in group → false; mention → true", () => {
    const c = cfg({ requireMention: true });
    expect(shouldDispatch(msg() as never, c, "PiLemmaBot")).toBe(false);
    expect(shouldDispatch(msg({ text: "@PiLemmaBot hi" }) as never, c, "PiLemmaBot")).toBe(true);
  });
  it("requireMention: reply to bot message passes", () => {
    const c = cfg({ requireMention: true });
    expect(shouldDispatch(msg({ reply_to_message: { from: { id: 123, is_bot: true } } }) as never, c, "PiLemmaBot")).toBe(true);
  });
  it("requireMention: DM never requires mention", () => {
    const c = cfg({ requireMention: true });
    expect(shouldDispatch(msg({ chat: { id: 42, type: "private" } }) as never, c, "PiLemmaBot")).toBe(true);
  });
  it("ignores non-text messages (no text/caption)", () => {
    expect(shouldDispatch(msg({ text: undefined }) as never, cfg(), "PiLemmaBot")).toBe(false);
  });
  it("ignores @mention of a different bot", () => {
    const c = cfg({ requireMention: true });
    expect(shouldDispatch(msg({ text: "@OtherBot hi" }) as never, c, "PiLemmaBot")).toBe(false);
  });
});

describe("mentionsBot", () => {
  it("matches case-insensitively, not as substring", () => {
    expect(mentionsBot("hey @pilemmabot", "PiLemmaBot")).toBe(true);
    expect(mentionsBot("@PiLemmaBots hi", "PiLemmaBot")).toBe(false);
  });
});

describe("parseCommand", () => {
  it("parses /cmd, /cmd@bot and args", () => {
    expect(parseCommand("/new")).toEqual({ name: "new", args: "" });
    expect(parseCommand("/status@PiLemmaBot now")).toEqual({ name: "status", args: "now" });
    expect(parseCommand("just text")).toBeNull();
  });
});