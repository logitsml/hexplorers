// The editor's library: saved maps to open, copy, export or delete; templates to start from; a
// file to import. A sheet over the editor (from the bottom on phones).

import { motion } from 'motion/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { blankMap, isRandom, type CustomMap } from '../../engine/maps/custom';
import { deleteMap, exportMap, importMap, listMaps, newMapId, storeMap, unreadableMaps, type StoredMap } from '../../game/customMaps';
import { CloseIcon, LineIcon } from '../LineIcons';
import { MapThumb } from './MapThumb';
import { useEditor } from './store';
import { TEMPLATES } from './templates';

/** Keeping a map in the library (the line set has none: a floppy's outline, in its weight). */
export const SaveIcon = ({ size = 16 }: { size?: number }) => (
  <svg className="line-icon" viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M6 3.5h10l4.5 4.5v11a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 19V5A1.5 1.5 0 0 1 6 3.5zM8.5 3.5V8h6V3.5M8 20.5v-6h8v6" />
  </svg>
);

const landOf = (m: CustomMap) => m.hexes.filter((h) => h.terrain !== 'sea').length;

export function Library({ onClose }: { onClose: () => void }) {
  const [maps, setMaps] = useState<StoredMap[]>(listMaps);
  const s = useEditor();
  const file = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);
  // (One deal of each template to show: the one started is made afresh.)
  const previews = useMemo(() => TEMPLATES.map((t) => t.make()), []);
  const refresh = () => setMaps(listMaps());
  // A dialog: the focus goes in (to the first card), stays in while Tab goes round, and returns to
  // what opened it when it closes.
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    box.current?.querySelector<HTMLElement>('.ed-card')?.focus({ preventScroll: true });
    return () => {
      if (before?.isConnected) before.focus({ preventScroll: true });
      // (Opened from the ⋯ menu, which has gone: to whichever of the bar's buttons is shown.)
      else [...document.querySelectorAll<HTMLElement>('.ed-top .btn, .ed-more')].find((b) => b.offsetParent !== null)?.focus({ preventScroll: true });
    };
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') return onClose();
      if (e.key !== 'Tab' || !box.current) return;
      const stops = [...box.current.querySelectorAll<HTMLElement>('button:not(:disabled)')];
      const [first, last] = [stops[0], stops[stops.length - 1]];
      if (e.shiftKey && document.activeElement === first) (e.preventDefault(), last.focus());
      else if (!e.shiftKey && document.activeElement === last) (e.preventDefault(), first.focus());
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const saveHere = () => {
    if (s.save()) refresh();
  };
  const leaveOk = () => !s.dirty || window.confirm('Leave this map without saving it?');
  const open = (m: StoredMap) => {
    if (!leaveOk()) return;
    s.open(m.id, m.map);
    onClose();
  };
  const start = (map: CustomMap) => {
    if (!leaveOk()) return false;
    s.fresh(map);
    onClose();
    return true;
  };
  const onFile = async (f: File | undefined) => {
    if (!f) return;
    const m = await importMap(f);
    if (typeof m === 'string') s.say(m, true);
    else if (start(m)) s.say(`Imported “${m.name}”: save it to keep it`);
  };
  return (
    <motion.div className="ed-library-back" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}>
      <motion.div
        ref={box}
        className="ed-library parchment"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ed-library-title"
        initial={{ y: 40, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: 40, opacity: 0 }}
        transition={{ type: 'spring', duration: 0.42, bounce: 0.18 }}
        onClick={(e) => e.stopPropagation()}
      >
        <header>
          <h2 id="ed-library-title">Maps</h2>
          <button className="btn ghost small" onClick={() => file.current?.click()}>
            <LineIcon name="upload" size={16} />
            Import…
          </button>
          <input ref={file} type="file" accept=".json,application/json" hidden onChange={(e) => {
              void onFile(e.target.files?.[0]);
              // (So the same file can be chosen again.)
              e.target.value = '';
            }} />
          <button className="btn ghost small" onClick={() => exportMap(s.map)}>
            <LineIcon name="download" size={16} />
            Export this map
          </button>
          <button className="ed-icon-btn ed-plain ed-close tip" data-tip="Close" onClick={onClose} aria-label="Close the maps">
            <CloseIcon size={18} />
          </button>
        </header>
        <h3>Start a new map</h3>
        <div className="ed-cards">
          <button className="ed-card" onClick={() => start(blankMap('New island', 3, 2))}>
            <MapThumb map={blankMap('', 3, 2)} />
            <b>Blank</b>
            <span>19 cells of grass to paint</span>
          </button>
          {TEMPLATES.map((t, i) => (
            <button key={t.id} className="ed-card" onClick={() => start({ ...t.make(), name: t.name })}>
              <MapThumb map={previews[i]} />
              <b>{t.name}</b>
              <span>{t.note}</span>
            </button>
          ))}
        </div>
        <h3>Your maps</h3>
        {unreadableMaps() > 0 && <p className="ed-note">{unreadableMaps() === 1 ? 'One saved map can’t be read by this version' : `${unreadableMaps()} saved maps can’t be read by this version`}. {unreadableMaps() === 1 ? 'It is' : 'They are'} still kept, not deleted.</p>}
        {maps.length === 0 ? (
          <div className="ed-empty">
            <p>Maps you save appear here, and on the set-up page under Island.</p>
            {(s.dirty || !s.kept) && (
              <button className="btn gold small" onClick={saveHere}>
                <SaveIcon size={16} />
                Save “{s.map.name.trim() || 'this map'}”
              </button>
            )}
          </div>
        ) : (
          <div className="ed-cards">
            {maps.map((m) => (
              <div key={m.id} className={`ed-card stored ${m.id === s.id ? 'current' : ''}`}>
                <button className="ed-card-open" onClick={() => open(m)}>
                  <MapThumb map={m.map} />
                  <b>{m.map.name}</b>
                  <span>
                    {landOf(m.map)} land hexes{isRandom(m.map) ? ' · dealt each game' : ''}
                  </span>
                </button>
                <div className="ed-card-actions">
                  <button className="ed-link" onClick={() => (storeMap(newMapId(), { ...m.map, name: `${m.map.name} (copy)`.slice(0, 40) }), refresh())} aria-label={`Copy “${m.map.name}”`}>
                    <LineIcon name="copy" size={14} />
                    Copy
                  </button>
                  <button className="ed-link" onClick={() => exportMap(m.map)} aria-label={`Export “${m.map.name}”`}>
                    <LineIcon name="download" size={14} />
                    Export
                  </button>
                  <button
                    className="ed-link bad"
                    aria-label={`Delete “${m.map.name}”`}
                    onClick={() => {
                      if (!window.confirm(`Delete “${m.map.name}”? Games already played on it keep their copy.`)) return;
                      deleteMap(m.id);
                      // (The map open in the editor, deleted: it's unsaved now.)
                      if (m.id === s.id) s.set({ kept: false });
                      refresh();
                    }}
                  >
                    <LineIcon name="trash" size={14} />
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </motion.div>
    </motion.div>
  );
}
