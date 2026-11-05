// The maps drawn in the editor, kept in the browser (exploratory.maps). A game takes its map whole
// into its options (see engine/maps/custom.ts), so editing or deleting one here never touches a
// saved game or a replay.

import { normalize, parseCustomMap, type CustomMap } from '../engine/maps/custom';

const KEY = 'exploratory.maps';

export interface StoredMap {
  id: string;
  map: CustomMap;
  updatedAt: number;
}

/** How many kept maps the last listMaps couldn't read (they stay in storage, untouched, rather than being dropped). */
let unreadable = 0;
export const unreadableMaps = () => unreadable;

function readRaw(): unknown[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '[]') as unknown;
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

export function listMaps(): StoredMap[] {
  const out: StoredMap[] = [];
  let bad = 0;
  for (const x of readRaw()) {
    const map = parseCustomMap((x as StoredMap | null)?.map);
    if (map && typeof (x as StoredMap).id === 'string') out.push({ id: (x as StoredMap).id, map, updatedAt: Number((x as StoredMap).updatedAt) || 0 });
    else bad++;
  }
  unreadable = bad;
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

function write(maps: unknown[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(maps));
    window.dispatchEvent(new Event('exploratory-maps'));
    return true;
  } catch {
    return false;
  }
}

export const newMapId = () => `m${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

/**
 * Keep `map` under `id` (a new entry, or over the old one), recentred on its cells and written in
 * the format its size needs (see normalize). False when the browser refused it.
 */
export function storeMap(id: string, map: CustomMap): boolean {
  const kept = normalize(map);
  // (A map the reader would refuse on the way back isn't kept as if it were saved.)
  if (!parseCustomMap(JSON.parse(JSON.stringify(kept)))) return false;
  // (The others are carried over as stored, those this version can't read too.)
  const others = readRaw().filter((x) => (x as StoredMap | null)?.id !== id);
  return write([{ id, map: kept, updatedAt: Date.now() }, ...others]);
}

export function deleteMap(id: string) {
  write(readRaw().filter((x) => (x as StoredMap | null)?.id !== id));
}

export function getMap(id: string): StoredMap | null {
  return listMaps().find((m) => m.id === id) ?? null;
}

/** A map as a file to keep or share (recentred, as it is kept). */
export function exportMap(map: CustomMap) {
  const blob = new Blob([JSON.stringify(normalize(map), null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${map.name.replace(/[^\w\- ]+/g, '').trim() || 'map'}.exploratory-map.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** A map read back from a file, or the reason it isn't one. */
export async function importMap(file: File): Promise<CustomMap | string> {
  if (file.size > 200_000) return 'That file is too large to be a map';
  try {
    const map = parseCustomMap(JSON.parse(await file.text()));
    return map ?? 'That file isn’t a map from the editor';
  } catch {
    return 'That file isn’t a map from the editor';
  }
}
