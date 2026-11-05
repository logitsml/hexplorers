// Which shortcut a key press means (the game's keys and the map editor's).

/**
 * The shortcut a key press means, in lower case. Mostly the character typed, but by the key's
 * place where that isn't one of ours: the number row (AZERTY types &é"' there without Shift), and
 * the letters on a layout without Latin ones (Cyrillic, Greek), as the camera's keys already go.
 */
export function shortcutKey(e: Pick<KeyboardEvent, 'key' | 'code'>): string {
  const digit = /^(?:Digit|Numpad)([0-9])$/.exec(e.code);
  if (digit) return digit[1];
  const key = e.key.toLowerCase();
  const letter = /^Key([A-Z])$/.exec(e.code);
  if (letter && key.length === 1 && !/[ -~]/.test(key)) return letter[1].toLowerCase();
  return key;
}
