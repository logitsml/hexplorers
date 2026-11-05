// Settings, Controls: what each mouse button's drag does, and the keys, each one changed by
// pressing it (game/bindings.ts). The same choices hold on the 3D island and the 2D map.

import { useEffect, useState } from 'react';
import type { Settings } from '../game/store';
import { BIND_ACTIONS, DEFAULT_MOUSE, FIXED_KEYS, bind, keyLabel, keysOf, type BindAction, type DragJob, type MouseBinds } from '../game/bindings';
import { LineIcon } from './LineIcons';
import { Morph } from './Morph';

const BUTTONS: [keyof MouseBinds, string][] = [
  ['left', 'Left button'],
  ['middle', 'Middle button'],
  ['right', 'Right button'],
];

const GROUPS: ['turn' | 'view', string][] = [
  ['turn', 'Your turn'],
  ['view', 'The view'],
];

export function ControlsSettings({ settings, upd }: { settings: Settings; upd: (p: Partial<Settings>) => void }) {
  // The action waiting for its new key, and what was said about the last key pressed.
  const [listening, setListening] = useState<BindAction | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (!listening) return;
    // Taken before anything else hears it (the game's shortcuts, the dialog's Escape).
    const k = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.code === 'Escape') return setListening(null);
      if (e.code === 'Backspace' || e.code === 'Delete') {
        upd({ keys: { ...settings.keys, [listening]: '' } });
        setNote(null);
        return setListening(null);
      }
      if (FIXED_KEYS.has(e.code) || !e.code) {
        setNote(`${keyLabel(e.code) || e.key} keeps its own job: choose another key`);
        return;
      }
      const before = BIND_ACTIONS.find((b) => b.id !== listening && keysOf(b.id, settings.keys).includes(e.code));
      upd({ keys: bind(settings.keys, listening, e.code) });
      setNote(before ? `${keyLabel(e.code)} no longer does “${before.label.toLowerCase()}”` : null);
      setListening(null);
    };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, [listening, settings.keys, upd]);

  const mouse = (b: keyof MouseBinds, job: DragJob) => upd({ mouse: { ...settings.mouse, [b]: job } });
  const changed = Object.keys(settings.keys).length > 0 || BUTTONS.some(([b]) => settings.mouse[b] !== DEFAULT_MOUSE[b]);

  return (
    <>
      <div className="field" role="group" aria-label="Dragging with the mouse">
        <span className="field-label">
          <span className="field-name">
            <LineIcon name="mouse" size={18} />
            Dragging with the mouse
          </span>
        </span>
        <div className="bind-list">
          {BUTTONS.map(([b, name]) => (
            <div className="bind-row" key={b}>
              <span className="bind-name">{name}</span>
              <div className="seg">
                {(
                  [
                    ['pan', 'Moves the map'],
                    ['turn', 'Turns the view'],
                  ] as [DragJob, string][]
                ).map(([job, l]) => (
                  <button key={job} type="button" className={settings.mouse[b] === job ? 'on' : ''} aria-pressed={settings.mouse[b] === job} onClick={() => mouse(b, job)}>
                    {l}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
        <p className="setting-note">The same on the 3D island and the 2D map, where the view doesn’t turn. The wheel zooms; a right click with no drag puts a piece back.</p>
      </div>
      {GROUPS.map(([g, title]) => (
        <div className="field" role="group" aria-label={title} key={g}>
          <span className="field-label">
            <span className="field-name">
              <LineIcon name="keyboard" size={18} />
              {title}
            </span>
          </span>
          <div className="bind-list">
            {BIND_ACTIONS.filter((b) => b.group === g).map((b) => {
              const keys = keysOf(b.id, settings.keys);
              const on = listening === b.id;
              return (
                <div className="bind-row" key={b.id}>
                  <span className="bind-name">{b.label}</span>
                  <button
                    type="button"
                    className={`bind-key${on ? ' listening' : ''}`}
                    aria-label={on ? `${b.label}: press a key, Escape to keep it, Backspace for none` : `${b.label}: ${keys.length ? keys.map(keyLabel).join(' or ') : 'no key'}. Change it`}
                    onClick={() => (setNote(null), setListening(on ? null : b.id))}
                  >
                    <Morph>{on ? 'Press a key…' : keys.length ? keyLabel(keys[0]) : 'None'}</Morph>
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      ))}
      <p className="setting-note" aria-live="polite">
        {note ?? (listening ? 'Press the new key. Escape keeps the old one, Backspace leaves it with none.' : 'Escape, the arrows, 0, 5 to 9, ? and Ctrl+Z keep their jobs.')}
      </p>
      <button type="button" className="btn ghost bare bind-reset" disabled={!changed} onClick={() => (setNote(null), upd({ keys: {}, mouse: { ...DEFAULT_MOUSE } }))}>
        <LineIcon name="refresh" size={18} />
        Reset the controls
      </button>
    </>
  );
}
