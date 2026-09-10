import { describe, expect, it } from "vitest";
import { isVoiceCommand, voiceIpcMessage, parseVoiceEvent } from "../src/voice.js";

describe("voice", () => {
  it("recognizes voice commands", () => {
    expect(isVoiceCommand("!play https://x")).toMatchObject({ cmd: "play", url: "https://x" });
    expect(isVoiceCommand("!volume 150")).toMatchObject({ cmd: "volume", args: "150" });
    expect(isVoiceCommand("!vstatus")).toMatchObject({ cmd: "status" });
    expect(isVoiceCommand("hello")).toBeNull();
  });
  it("encodes IPC request / parses events", () => {
    expect(voiceIpcMessage({ cmd: "play", chat: -100, url: "x" })).toBe(
      '{"cmd":"play","chat":-100,"url":"x"}\n',
    );
    expect(parseVoiceEvent('{"event":"state","playing":true}')).toMatchObject({ event: "state" });
    expect(parseVoiceEvent("garbage")).toBeNull();
  });
});