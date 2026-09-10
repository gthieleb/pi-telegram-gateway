// src/chunk.ts
/** Split into Telegram-safe chunks. Lossless: join("") === trimmed input. */
export function splitMessage(text: string, limit = 4096): string[] {
  const t = text.trim();
  if (!t) return [];
  if (t.length <= limit) return [t];
  const parts: string[] = [];
  let rest = t;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    const para = window.lastIndexOf("\n\n");
    const line = window.lastIndexOf("\n");
    const cut = para > limit * 0.5 ? para + 2 : line > limit * 0.5 ? line + 1 : limit;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) parts.push(rest);
  return parts;
}