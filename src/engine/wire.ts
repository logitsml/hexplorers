// The view that goes on the wire, and the patches between views. A seat's WireView is its
// redactState with what a client never needs taken out: the take-back snapshot (only who may take
// back), and other viewers' tracker rows (copies of the public row). inflateView puts it back
// into the GameState shape the presenter and UI read. Patches are a compact JSON patch:
// [path, value] sets, [path] deletes, [[...path, 'length'], n] shortens an array.
//
// Views of one game share what doesn't change from state to state (the board, the options), so
// diffView passes over those at once; and applyPatch copies only what a patch touches, so a
// client's views share the rest too. Treat views as values: neither function changes its input.

import type { GameState, PlayerId } from './types';
import { clonePlain } from './reducer';
import { redactState } from './view';
import { trackedKinds } from './tracker';
import type { Viewer } from './visibility';

export type { Viewer } from './visibility';

/** GameState as sent: `undo` slimmed to who may take back, `tracker` to this viewer's rows. */
export type WireView = Omit<GameState, 'undo' | 'tracker'> & {
  undo: { player: PlayerId } | null;
  tracker?: { own: number[]; pub: number[] };
};

export type PatchOp = [path: (string | number)[], value?: unknown];

/** Tracker values travel rounded to this many decimals (expected counts; sure counts are whole). */
const TRACKER_DECIMALS = 3;
const SCALE = 10 ** TRACKER_DECIMALS;
const round = (x: number) => Math.round(x * SCALE) / SCALE;

/** What `viewer` is sent of `state` (see redactState for what that hides). */
export function wireView(state: GameState, viewer: Viewer): WireView {
  // (The take-back chain stays on the server: it is never redacted only to be cut off.)
  const r = redactState(state.undo ? { ...state, undo: null } : state, viewer);
  const out = r as unknown as WireView;
  out.undo = state.undo ? { player: state.undo.player } : null;
  const t = r.tracker;
  if (t) {
    const n = state.players.length;
    const row = n * 2 * trackedKinds(state).length;
    if (t.length === (n + 1) * row) {
      const own = viewer === null ? [] : t.slice(viewer * row, (viewer + 1) * row).map(round);
      const pub = t.slice(n * row).map(round);
      out.tracker = { own, pub };
    } else delete out.tracker;
  }
  return out;
}

/**
 * The GameState a client works from. `undo.before` is never needed on a client (a take-back is
 * the server's to make), so it is this view without its own `undo`: enough for `state.undo?.player`
 * checks, and nothing circular.
 */
export function inflateView(w: WireView, viewer: Viewer): GameState {
  const s = clonePlain(w) as unknown as GameState;
  if (w.tracker) {
    const n = w.players.length;
    const { own, pub } = w.tracker;
    const out: number[] = [];
    for (let v = 0; v < n; v++) out.push(...(v === viewer && own.length ? own : pub));
    out.push(...pub);
    s.tracker = out;
  } else delete s.tracker;
  s.undo = w.undo ? { player: w.undo.player, before: { ...s, undo: null } } : null;
  return s;
}

const kind = (v: unknown) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

/** The patch from view `a` to view `b`: applyPatch(a, diffView(a, b)) is `b`, after a JSON round trip too. */
export function diffView(a: WireView, b: WireView): PatchOp[] {
  const out: PatchOp[] = [];
  diff(a, b, [], out);
  return out;
}

function diff(a: unknown, b: unknown, path: (string | number)[], out: PatchOp[]): void {
  // (The same object: views of one game share the board and the options, so this is most of them.)
  if (a === b) return;
  const ta = kind(a);
  const tb = kind(b);
  if (ta !== tb || (ta !== 'object' && ta !== 'array')) {
    if (ta === 'number' && tb === 'number' && Object.is(a, b)) return;
    out.push([path.slice(), b]);
    return;
  }
  const start = out.length;
  if (ta === 'array') {
    const x = a as unknown[];
    const y = b as unknown[];
    const n = Math.min(x.length, y.length);
    for (let i = 0; i < n; i++) {
      if (x[i] === y[i]) continue;
      path.push(i);
      diff(x[i], y[i], path, out);
      path.pop();
    }
    for (let i = n; i < y.length; i++) out.push([[...path, i], y[i]]);
    if (y.length < x.length) out.push([[...path, 'length'], y.length]);
  } else {
    const x = a as Record<string, unknown>;
    const y = b as Record<string, unknown>;
    for (const k of Object.keys(y)) {
      const yk = y[k];
      const xk = x[k];
      if (yk === undefined) {
        if (xk !== undefined) out.push([[...path, k]]);
      } else if (xk === undefined) out.push([[...path, k], yk]);
      else if (xk !== yk) {
        path.push(k);
        diff(xk, yk, path, out);
        path.pop();
      }
    }
    for (const k of Object.keys(x)) if (!(k in y) && x[k] !== undefined) out.push([[...path, k]]);
  }
  // Replace the whole value when that is shorter than its patch.
  if (out.length - start > 1) {
    const patch = JSON.stringify(out.slice(start)).length;
    if (jsonShorter(b, patch - 8)) {
      out.length = start;
      out.push([path.slice(), b]);
    }
  }
}

/** Whether `v` as JSON is shorter than `cap` characters (near enough: worked out only as far as it takes). */
function jsonShorter(v: unknown, cap: number): boolean {
  let left = cap;
  const walk = (x: unknown): boolean => {
    if (x === null || x === undefined) left -= 4;
    else if (typeof x === 'number') left -= x === Math.trunc(x) && Math.abs(x) < 1e6 ? String(x).length : 12;
    else if (typeof x === 'boolean') left -= 5;
    else if (typeof x === 'string') left -= x.length + 2;
    else if (Array.isArray(x)) {
      left -= 1 + x.length;
      for (const e of x) if (!walk(e)) return false;
    } else if (typeof x === 'object') {
      const o = x as Record<string, unknown>;
      left -= 1;
      for (const k of Object.keys(o)) {
        if (o[k] === undefined) continue;
        left -= k.length + 4;
        if (!walk(o[k])) return false;
      }
    }
    return left > 0;
  };
  return walk(v);
}

/**
 * `w` with `ops` applied: a new view, with only what the patch touches copied (the rest is shared
 * with `w`, which is left as it was).
 */
export function applyPatch(w: WireView, ops: PatchOp[]): WireView {
  let root: unknown = w;
  // (The containers this patch has copied already, so may change in place.)
  const mine = new Set<object>();
  const copy = <T extends object>(o: T): T => {
    const c = (Array.isArray(o) ? o.slice() : { ...o }) as T;
    mine.add(c);
    return c;
  };
  for (const [path, ...rest] of ops) {
    if (path.length === 0) {
      root = clonePlain(rest[0]);
      continue;
    }
    if (root === null || typeof root !== 'object') throw new Error('applyPatch: the view is not an object.');
    if (!mine.has(root)) root = copy(root as object);
    let o = root as Record<string | number, unknown>;
    for (let i = 0; i < path.length - 1; i++) {
      let child = o[path[i]];
      if (child === null || typeof child !== 'object') throw new Error(`applyPatch: nothing at ${path.slice(0, i + 1).join('.')}.`);
      if (!mine.has(child)) o[path[i]] = child = copy(child);
      o = child as Record<string | number, unknown>;
    }
    const k = path[path.length - 1];
    if (rest.length === 0) delete o[k];
    else if (k === 'length' && Array.isArray(o)) (o as unknown[]).length = rest[0] as number;
    else o[k] = clonePlain(rest[0]);
  }
  return root as WireView;
}

/** JSON with sorted keys and no undefined members: the same text on every side. */
export function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? 'null' : canonical(x))).join(',')}]`;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
}

/** A 53-bit hash (cyrb53) of the canonical view, as 14 hex digits. */
export function viewHash(w: WireView): string {
  const str = canonical(w);
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}
