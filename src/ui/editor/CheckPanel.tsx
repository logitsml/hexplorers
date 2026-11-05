// Will it play? The editor's check of the map for the players, the points and the expansions it's
// meant for: a panel beside the board on a wide screen, a sheet from the bottom on a phone. Its
// verdict also rides in the top bar as a chip that opens it.

import { AnimatePresence, motion } from 'motion/react';
import { useDeferredValue, useMemo } from 'react';
import { createGame, withBoard, type ModuleId } from '../../engine';
import { checkCustomMap, isRandom, type CustomMap, type MapCheck } from '../../engine/maps/custom';
import { RESOURCES } from '../../engine/types';
import { EXPANSIONS, expansionsOf, modulesFor as modulesOfExpansions, targetFor, type Expansion } from '../../engine/presets';
import { CARD_ICON, CARD_NAMES, asset } from '../../game/names';
import { sfx } from '../../audio/sfx';
import { CloseIcon, LineIcon, type LineIconName } from '../LineIcons';
import { Morph } from '../Morph';
import type { Tool } from './model';
import { useEditor, type Category } from './store';

const press = () => (sfx.unlock(), sfx.play('click'));

/** The check for the editor's settings: the map, the players, the points (null: the suggested) and the expansions. */
interface Verdict {
  check: MapCheck;
  /** The points checked against: the chosen, or the map's suggested with the expansions' own. */
  points: number;
  suggested: number;
  players: 3 | 4;
  modules: ModuleId[];
}

/** The points the expansions add beyond the base game's (rule 9), on a map of `islands`. */
const extraFor = (modules: readonly ModuleId[], islands: number) => {
  const ex = expansionsOf(modules);
  return targetFor(ex, islands > 1 && ex.includes('sea') ? 'archipelago' : 'classic') - 10;
};

export function useVerdict(players: 3 | 4, points: number | null): Verdict {
  const live = useEditor((s) => s.map);
  const modules = useEditor((s) => s.modules);
  // (Checked a beat behind the painting, so a long stroke never waits on it.)
  const map = useDeferredValue(live);
  return useMemo(() => {
    const first = checkCustomMap(map, { players, victoryPoints: 10, modules });
    const extra = extraFor(modules, first.figures?.islands ?? 1);
    const suggested = (first.figures?.suggested ?? 10) + extra;
    const target = points ?? suggested;
    // (Dealt as a new game on it would be.)
    const tryGame = (seed: number) => void createGame(Array.from({ length: players }, (_, i) => ({ name: `P${i}`, color: '', isBot: true })), withBoard(players, { map: 'custom', custom: map, modules, seed }));
    const check = checkCustomMap(map, { players, victoryPoints: target, modules, extra, tryGame });
    return { check, points: target, suggested, players, modules };
  }, [map, players, points, modules.join()]);
}

const TONE_ICON: Record<'ok' | 'warn' | 'bad', LineIconName> = { ok: 'check', warn: 'info', bad: 'flag' };

/** The verdict in a few words, for the top bar's chip: its icon and words say it as well as its colour. */
export function StatusChip({ verdict, open, onClick }: { verdict: Verdict; open: boolean; onClick: () => void }) {
  const { check, points } = verdict;
  const bad = check.errors.length;
  const tone = bad ? 'bad' : check.warnings.length ? 'warn' : 'ok';
  const label = bad ? `${bad} problem${bad > 1 ? 's' : ''}` : `Ready · ${points} pts`;
  return (
    <button className={`ed-status ${tone}`} onClick={onClick} aria-expanded={open} aria-label={`${label}: ${open ? 'hide' : 'show'} the check`}>
      <LineIcon name={TONE_ICON[tone]} size={16} />
      <Morph duration={360}>{label}</Morph>
    </button>
  );
}

/**
 * Where a problem is put right: the category (and the tool) that fixes it, matched on the check's
 * words (engine/maps/custom.ts). Nothing matched: the problem's own words say what to do.
 */
const FIXES: { test: RegExp; category: Category; tool?: Tool; label: string }[] = [
  { test: /reached by ship/i, category: 'sea', label: 'Fill gaps with sea' },
  { test: /hexes; it holds at most|hexes from its middle/i, category: 'map', label: 'Canvas' },
  { test: /no land|land hexes; the island/i, category: 'land', label: 'Paint land' },
  { test: /fog/i, category: 'sea', tool: { kind: 'fog' }, label: 'Fog tools' },
  { test: /robber/i, category: 'land', tool: { kind: 'robber' }, label: 'Place the robber' },
  { test: /number/i, category: 'numbers', label: 'Numbers' },
  { test: /harbour/i, category: 'harbours', label: 'Harbours' },
  { test: /bag/i, category: 'map', label: 'The bag' },
  { test: /river|swamp/i, category: 'features', tool: { kind: 'river' }, label: 'Rivers' },
  { test: /corsair/i, category: 'features', tool: { kind: 'corsair' }, label: 'The corsair' },
  { test: /home island/i, category: 'sea', tool: { kind: 'home' }, label: 'Home islands' },
  { test: /fishing/i, category: 'features', tool: { kind: 'ground' }, label: 'Fishing grounds' },
  { test: /open sea|need open sea/i, category: 'sea', label: 'Isles & fog' },
];

/** A problem's way to its fix: opens the category, with the tool in hand where one does it. */
function FixLink({ text }: { text: string }) {
  const fix = FIXES.find((f) => f.test.test(text));
  if (!fix) return null;
  const go = () => {
    press();
    useEditor.getState().set({ category: fix.category, ...(fix.tool && { tool: fix.tool, drawing: null }) });
    // (A phone's sheet covers the dock: it steps aside for the fix.)
    if (matchMedia('(max-width: 760px)').matches) useEditor.getState().set({ checkOpen: false });
  };
  return (
    <button className="ed-fix" onClick={go}>
      {fix.label}
      <LineIcon name="arrowRight" size={14} />
    </button>
  );
}

const ISSUE: Record<'bad' | 'warn' | 'note', { icon: LineIconName; said: string }> = {
  bad: { icon: 'flag', said: 'To fix:' },
  warn: { icon: 'info', said: 'Worth a look:' },
  note: { icon: 'compass', said: 'Note:' },
};

function Issue({ kind, text }: { kind: 'bad' | 'warn' | 'note'; text: string }) {
  return (
    <motion.li className={kind} initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }}>
      <LineIcon name={ISSUE[kind].icon} size={16} />
      <span>
        <span className="sr-only">{ISSUE[kind].said} </span>
        {text}
        {kind !== 'note' && <FixLink text={text} />}
      </span>
    </motion.li>
  );
}

export function CheckPanel({ verdict, players, setPlayers, points, setPoints, onClose }: { verdict: Verdict; players: 3 | 4; setPlayers: (n: 3 | 4) => void; points: number | null; setPoints: (n: number | null) => void; onClose: () => void }) {
  const { check, suggested } = verdict;
  const target = verdict.points;
  const map = useEditor((s) => s.map);
  const modules = useEditor((s) => s.modules);
  const chosen = expansionsOf(modules);
  const toggle = (e: Expansion) => {
    press();
    const next = chosen.includes(e) ? chosen.filter((x) => x !== e) : [...chosen, e];
    useEditor.getState().set({ modules: modulesOfExpansions(next) });
  };
  const f = check.figures;
  const bad = check.errors.length;
  return (
    <aside className="ed-check parchment" aria-labelledby="ed-check-title">
      <header>
        <h3 id="ed-check-title">Will it play?</h3>
        <button className="ed-sheet-close tip" data-tip="Close" onClick={onClose} aria-label="Close the check">
          <CloseIcon size={16} />
        </button>
      </header>
      <section className="ed-sect" aria-live="polite">
        <p className={`ed-verdict ${bad ? 'bad' : 'ok'}`}>
          <LineIcon name={bad ? 'flag' : 'check'} size={18} />
          {/* (Short enough for one line: a morph doesn't wrap.) */}
          <Morph>{bad ? `${bad === 1 ? 'One thing' : `${bad} things`} to fix first` : `Ready to play to ${target} points`}</Morph>
        </p>
        {(bad > 0 || check.warnings.length > 0 || check.notes.length > 0) && (
          <ul className="ed-issues">
            <AnimatePresence initial={false}>
              {check.errors.map((e) => (
                <Issue key={`e${e}`} kind="bad" text={e} />
              ))}
              {check.warnings.map((w) => (
                <Issue key={`w${w}`} kind="warn" text={w} />
              ))}
              {check.notes.map((n) => (
                <Issue key={`n${n}`} kind="note" text={n} />
              ))}
            </AnimatePresence>
          </ul>
        )}
      </section>
      <section className="ed-sect" aria-labelledby="ed-check-game">
        <h4 id="ed-check-game">The game it’s checked for</h4>
        <div className="ed-line">
          <span id="ed-check-players">Players</span>
          <div className="seg" role="group" aria-labelledby="ed-check-players">
            {([3, 4] as const).map((n) => (
              <button key={n} className={players === n ? 'on' : ''} aria-pressed={players === n} aria-label={`${n} players`} onClick={() => (press(), setPlayers(n))}>
                {n}
              </button>
            ))}
          </div>
        </div>
        <div className="ed-line">
          <span id="ed-check-points">Points to win</span>
          <div className="ed-points">
            {points !== null && points !== suggested && (
              <button className="ed-link" onClick={() => (press(), setPoints(null))}>
                Suggested: {suggested}
              </button>
            )}
            <div className="stepper" role="group" aria-labelledby="ed-check-points">
              <button aria-label="Fewer points" disabled={target <= 3} onClick={() => (press(), setPoints(Math.max(3, target - 1)))}>
                <LineIcon name="minus" size={16} />
              </button>
              <b aria-live="polite">
                <Morph>{target}</Morph>
              </b>
              <button aria-label="More points" disabled={target >= 30} onClick={() => (press(), setPoints(Math.min(30, target + 1)))}>
                <LineIcon name="plus" size={16} />
              </button>
            </div>
          </div>
        </div>
        <div className="ed-with" role="group" aria-labelledby="ed-check-with">
          <span id="ed-check-with">Expansions</span>
          <div className="ed-with-chips">
            {EXPANSIONS.map((e) => (
              <button key={e.id} className={chosen.includes(e.id) ? 'on' : ''} aria-pressed={chosen.includes(e.id)} onClick={() => toggle(e.id)} title={e.blurb}>
                {chosen.includes(e.id) && <LineIcon name="check" size={14} />}
                {e.name}
              </button>
            ))}
          </div>
        </div>
      </section>
      {f && (
        <section className="ed-sect" aria-labelledby="ed-check-island">
          <h4 id="ed-check-island">The island</h4>
          <dl className="ed-figures">
            <div>
              <dt>Building sites</dt>
              <dd>
                <Morph>{f.sites}</Morph>
              </dd>
            </div>
            <div>
              <dt>Each player’s share</dt>
              <dd>
                <Morph>{`${f.share} sites · ${f.sharePoints} pts`}</Morph>
              </dd>
            </div>
            <div>
              <dt>Most one player could make</dt>
              <dd>
                <Morph>{`${f.most} pts`}</Morph>
              </dd>
            </div>
            {f.islands > 1 && (
              <div>
                <dt>Islands</dt>
                <dd>
                  <Morph>{f.islands}</Morph>
                </dd>
              </div>
            )}
            {isRandom(map) && (
              <div>
                <dt>Deals checked</dt>
                <dd>{f.deals}</dd>
              </div>
            )}
          </dl>
          <Production dots={f.dots} averaged={f.deals > 1} />
        </section>
      )}
    </aside>
  );
}

/** Each resource's production, in dots, as bars. */
function Production({ dots, averaged }: { dots: Record<string, number>; averaged: boolean }) {
  const most = Math.max(1, ...Object.values(dots));
  return (
    <div className="ed-prod" role="group" aria-label={averaged ? 'Production by resource, the average of the deals' : 'Production by resource'}>
      {RESOURCES.map((r) => (
        <div key={r} className="ed-prod-row" title={`${CARD_NAMES[r]}: ${dots[r]} dots${averaged ? ' on average' : ''}`}>
          <img src={asset(CARD_ICON[r])} alt={CARD_NAMES[r]} width={18} height={18} />
          <span className="ed-bar">
            <motion.i animate={{ width: `${(dots[r] / most) * 100}%` }} transition={{ type: 'spring', duration: 0.5, bounce: 0.2 }} />
          </span>
          <b>{dots[r]}</b>
        </div>
      ))}
    </div>
  );
}

export type { CustomMap };
