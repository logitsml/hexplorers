// The game's keys and mouse buttons, and the player's own choices for them (Settings, Controls).
// Keys are kept by their place on the keyboard (KeyboardEvent.code), as the camera's always were,
// so a binding means the same key on any layout. A few stay fixed: Escape, the arrows (which pick
// spots while placing), Ctrl/⌘+Z, ?, the hurry key and 0 and 5 to 9 (see app/keys.ts).

export type BindAction =
  | 'roll'
  | 'endTurn'
  | 'road'
  | 'house'
  | 'town'
  | 'card'
  | 'trade'
  | 'supply'
  | 'flat'
  | 'pause'
  | 'mute'
  | 'panUp'
  | 'panDown'
  | 'panLeft'
  | 'panRight'
  | 'turnLeft'
  | 'turnRight'
  | 'tiltUp'
  | 'tiltDown'
  | 'zoomIn'
  | 'zoomOut'
  | 'home';

export interface BindSpec {
  id: BindAction;
  label: string;
  group: 'turn' | 'view';
  /** The keys it has unless the player chose another (the first is the one shown). */
  keys: readonly string[];
}

export const BIND_ACTIONS: readonly BindSpec[] = [
  { id: 'roll', label: 'Roll the dice', group: 'turn', keys: ['Space'] },
  { id: 'endTurn', label: 'End the turn', group: 'turn', keys: ['Enter', 'NumpadEnter'] },
  { id: 'road', label: 'Build a road', group: 'turn', keys: ['Digit1', 'Numpad1'] },
  { id: 'house', label: 'Build a house', group: 'turn', keys: ['Digit2', 'Numpad2'] },
  { id: 'town', label: 'Build a town', group: 'turn', keys: ['Digit3', 'Numpad3'] },
  { id: 'card', label: 'Buy a card', group: 'turn', keys: ['Digit4', 'Numpad4'] },
  { id: 'trade', label: 'Trade with players', group: 'turn', keys: ['KeyT'] },
  { id: 'supply', label: 'Trade with the supply', group: 'turn', keys: ['KeyB'] },
  { id: 'pause', label: 'Pause (solo games)', group: 'turn', keys: ['KeyP'] },
  { id: 'mute', label: 'Mute', group: 'turn', keys: ['KeyM'] },
  { id: 'flat', label: '3D island or 2D map', group: 'view', keys: ['KeyV'] },
  { id: 'panUp', label: 'Move the view up', group: 'view', keys: ['KeyW'] },
  { id: 'panLeft', label: 'Move the view left', group: 'view', keys: ['KeyA'] },
  { id: 'panDown', label: 'Move the view down', group: 'view', keys: ['KeyS'] },
  { id: 'panRight', label: 'Move the view right', group: 'view', keys: ['KeyD'] },
  { id: 'zoomIn', label: 'Zoom in', group: 'view', keys: ['Equal', 'NumpadAdd'] },
  { id: 'zoomOut', label: 'Zoom out', group: 'view', keys: ['Minus', 'NumpadSubtract'] },
  { id: 'turnLeft', label: 'Turn the view left (3D)', group: 'view', keys: ['KeyQ'] },
  { id: 'turnRight', label: 'Turn the view right (3D)', group: 'view', keys: ['KeyE'] },
  { id: 'tiltUp', label: 'Tilt towards the horizon (3D)', group: 'view', keys: ['KeyR'] },
  { id: 'tiltDown', label: 'Tilt overhead (3D)', group: 'view', keys: ['KeyF'] },
  { id: 'home', label: 'Reset the view', group: 'view', keys: ['KeyH'] },
];

/** Keys that keep their own job and can't be bound (see the file's head). */
export const FIXED_KEYS = new Set([
  'Escape',
  'Tab',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Period',
  'Slash',
  'Digit0',
  'Numpad0',
  ...[5, 6, 7, 8, 9].flatMap((n) => [`Digit${n}`, `Numpad${n}`]),
  'MetaLeft',
  'MetaRight',
  'ControlLeft',
  'ControlRight',
  'AltLeft',
  'AltRight',
  'ShiftLeft',
  'ShiftRight',
]);

/** The player's choices: one key an action (or '' for none), only where it differs from the default. */
export type KeyBinds = Partial<Record<BindAction, string>>;

/** What a mouse button's drag does on the board: move the map, or turn and tilt the view (3D only). */
export type DragJob = 'pan' | 'turn';
export interface MouseBinds {
  left: DragJob;
  middle: DragJob;
  right: DragJob;
}
export const DEFAULT_MOUSE: Readonly<MouseBinds> = { left: 'pan', middle: 'pan', right: 'turn' };

const SPEC = new Map(BIND_ACTIONS.map((b) => [b.id, b]));

/** The keys an action answers to under `binds`. */
export function keysOf(id: BindAction, binds: KeyBinds): readonly string[] {
  const own = binds[id];
  if (own === undefined) return SPEC.get(id)?.keys ?? [];
  return own ? [own] : [];
}

/** The action a key means under `binds`, if any. */
export function actionOf(code: string, binds: KeyBinds): BindAction | null {
  for (const b of BIND_ACTIONS) if (keysOf(b.id, binds).includes(code)) return b.id;
  return null;
}

/**
 * `binds` with `code` given to `id`. Whichever action had it before gives it up (left with no key
 * of its own, or its remaining default), so no key means two things.
 */
export function bind(binds: KeyBinds, id: BindAction, code: string): KeyBinds {
  const next: KeyBinds = { ...binds };
  for (const b of BIND_ACTIONS) {
    if (b.id === id) continue;
    const had = keysOf(b.id, next);
    if (had.includes(code)) {
      const rest = had.filter((k) => k !== code);
      next[b.id] = rest[0] ?? '';
    }
  }
  // (Back on its own default: nothing to remember.)
  if (SPEC.get(id)?.keys[0] === code) delete next[id];
  else next[id] = code;
  return next;
}

/** How a key is written: its printed name, as most keyboards show it. */
export function keyLabel(code: string): string {
  if (!code) return 'None';
  const m = /^(?:Key|Digit)(.)$/.exec(code);
  if (m) return m[1];
  const pad = /^Numpad(.+)$/.exec(code);
  if (pad) return `Num ${NAMES[pad[1]] ?? pad[1]}`;
  return NAMES[code] ?? code;
}

const NAMES: Record<string, string> = {
  Space: 'Space',
  Enter: 'Enter',
  Backspace: 'Backspace',
  Equal: '=',
  Minus: '-',
  Add: '+',
  Subtract: '-',
  Multiply: '*',
  Divide: '/',
  Decimal: '.',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Backquote: '`',
  IntlBackslash: '\\',
  CapsLock: 'Caps Lock',
  Delete: 'Delete',
  Insert: 'Insert',
  Home: 'Home',
  End: 'End',
  PageUp: 'Page Up',
  PageDown: 'Page Down',
};

const CODE = /^[A-Za-z0-9]{1,24}$/;

/** Stored choices, checked key by key (an unknown action or a fixed key is dropped). */
export function sanitizeKeys(raw: unknown): KeyBinds {
  if (!raw || typeof raw !== 'object') return {};
  const out: KeyBinds = {};
  for (const [id, code] of Object.entries(raw as Record<string, unknown>)) {
    if (!SPEC.has(id as BindAction) || typeof code !== 'string') continue;
    if (code !== '' && (!CODE.test(code) || FIXED_KEYS.has(code))) continue;
    out[id as BindAction] = code;
  }
  return out;
}

export function sanitizeMouse(raw: unknown): MouseBinds {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const job = (v: unknown, d: DragJob): DragJob => (v === 'pan' || v === 'turn' ? v : d);
  return { left: job(r.left, DEFAULT_MOUSE.left), middle: job(r.middle, DEFAULT_MOUSE.middle), right: job(r.right, DEFAULT_MOUSE.right) };
}

/** A mouse button's drag job (0 left, 1 middle, 2 right; others none). */
export function dragJob(button: number, mouse: MouseBinds): DragJob | null {
  return button === 0 ? mouse.left : button === 1 ? mouse.middle : button === 2 ? mouse.right : null;
}
