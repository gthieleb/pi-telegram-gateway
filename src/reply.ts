// src/reply.ts
interface BlockLike { type: string; text?: string }
interface MsgLike { role: string; content: string | BlockLike[] | undefined }

function textOf(m: MsgLike): string {
  if (typeof m.content === "string") return m.content;
  if (!Array.isArray(m.content)) return "";
  return m.content.filter((b) => b.type === "text" && typeof b.text === "string").map((b) => b.text).join("");
}

export function extractReplyText(messages: MsgLike[]): string {
  return messages.filter((m) => m.role === "assistant").map(textOf).join("").trim();
}