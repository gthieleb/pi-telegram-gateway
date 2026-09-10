// src/keyboard.ts
export interface InlineButton {
  text: string;
  callback_data?: string;
}
export interface InlineKeyboardMarkup {
  inline_keyboard: InlineButton[][];
}

export interface SessionOption {
  label: string;
  file: string;
}

/** One row of buttons per option (Telegram renders rows stacked vertically). */
function rows(buttons: InlineButton[]): InlineKeyboardMarkup {
  return { inline_keyboard: buttons.map((b) => [b]) };
}

/** Session picker: one row per session, cancel button at the end. */
export function sessionsKeyboard(menuId: string, sessions: SessionOption[]): InlineKeyboardMarkup {
  const rows = sessions.map((s, i) => [{ text: s.label, callback_data: `gw:att:${menuId}:${i}` }]);
  rows.push([{ text: "✖ Abbrechen", callback_data: `gw:att:${menuId}:cancel` }]);
  return { inline_keyboard: rows };
}

/** Replay choice after attaching: recent / full / none. */
export function attachReplayKeyboard(menuId: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: "▫ Letzte 10", callback_data: `gw:rep:${menuId}:recent` },
        { text: "▫ Vollständig", callback_data: `gw:rep:${menuId}:full` },
        { text: "▫ Nur neue", callback_data: `gw:rep:${menuId}:none` },
      ],
    ],
  };
}

/** Agent question: options as rows, free-text escape + timeout hint. */
export function askUserKeyboard(menuId: string, options: string[]): InlineKeyboardMarkup {
  const buttons: InlineButton[] = options.map((o, i) => ({
    text: o,
    callback_data: `gw:ans:${menuId}:${i}`,
  }));
  buttons.push({ text: "✏️ selbst tippen", callback_data: `gw:ans:${menuId}:text` });
  buttons.push({ text: "⏭ überspringen", callback_data: `gw:ans:${menuId}:skip` });
  return { inline_keyboard: buttons.map((b) => [b]) };
}