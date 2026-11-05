// The editor's tools: a row of categories and the palette of the one open. A rail down the left on
// a wide screen; a dock along the bottom on a phone, its palette's tools in at most two rows. The
// tool in hand is ringed, and the ring slides from one tool to the next.

import { AnimatePresence, LayoutGroup, motion } from 'motion/react';
import { Children, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { CUSTOM_NUMBERS, CUSTOM_TERRAINS, MAX_REACH, PORT_TYPES, bagOf, bagSize, classicBag, isRandom, type CellTerrain, type CustomMap, type CustomTerrain } from '../../engine/maps/custom';
import { PIPS } from '../../engine/constants';
import { Rng } from '../../engine/rng';
import { dealNumbers, fillTerrain, placeHarbours, scatterIslets, surroundWithSea } from '../../engine/maps/custom';
import { CARD_ICON, CARD_NAMES, TERRAIN_NAMES, asset } from '../../game/names';
import { sfx } from '../../audio/sfx';
import { FILL } from '../FlatBoard';
import { BountyGlyph, CastleGlyph, FlatDefs, OasisGlyph, OilWellGlyph, SwampGlyph } from '../flatArt';
import { CloseIcon, LineIcon, type LineIconName } from '../LineIcons';
import { Morph } from '../Morph';
import { canvasSize, crop, fillGaps, resize, type Tool } from './model';
import { useEditor, type Category } from './store';

const seed = () => Math.floor(Math.random() * 1e9);
const press = () => (sfx.unlock(), sfx.play('click'));

const CATEGORIES: { id: Category; label: string; icon: ReactNode }[] = [
  { id: 'land', label: 'Land', icon: <path d="M3 18 9 8l4 6 3-4 5 8z" /> },
  { id: 'numbers', label: 'Numbers', icon: <><circle cx="12" cy="12" r="8" /><path d="M10 9.5q2-2 4 0t-4 5h4.5" /></> },
  { id: 'harbours', label: 'Harbours', icon: <><path d="M12 4v15M7 9h10M5 14a7 6 0 0 0 14 0" /><circle cx="12" cy="4" r="1.5" /></> },
  { id: 'features', label: 'Expansions', icon: <><path d="M4 19h16M6 19V9l3 2V7l3 2V5l3 2v4l3-2v10" /></> },
  { id: 'sea', label: 'Isles & fog', icon: <><path d="M3 15q3-2 6 0t6 0 6 0M3 19q3-2 6 0t6 0 6 0" /><path d="M8 11q1-4 4-4t4 4" /></> },
  { id: 'map', label: 'Map', icon: <><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2" /></> },
];

const same = (a: Tool, b: Tool) => JSON.stringify(a) === JSON.stringify(b);

/** A tool's button: its picture over its name, ringed when in hand. */
function Chip({ tool, label, tip, children, small }: { tool: Tool; label: string; tip?: string; children: ReactNode; small?: string }) {
  const current = useEditor((s) => s.tool);
  const on = same(tool, current);
  return (
    <button className={`ed-chip-btn${on ? ' on' : ''}`} aria-pressed={on} title={tip ?? label} onClick={() => (press(), useEditor.getState().set({ tool, drawing: tool.kind === 'river' ? useEditor.getState().drawing : null }))}>
      {on && <motion.span layoutId="ed-tool-ring" className="ed-ring" transition={{ type: 'spring', duration: 0.35, bounce: 0.25 }} />}
      <span className="ed-pic">{children}</span>
      <span className="ed-label">
        <Morph duration={320}>{label}</Morph>
      </span>
      {small && <span className="ed-tag">{small}</span>}
    </button>
  );
}

/**
 * A row of tools. On a phone (see editor.css) it wraps, never scrolling sideways out of sight: up to
 * six in one row, more split evenly across two (ten as five and five).
 */
function Row({ children }: { children: ReactNode }) {
  const n = Children.toArray(children).length;
  return (
    <div className="ed-row" style={{ ['--per-row' as string]: n <= 6 ? n : Math.ceil(n / 2) }}>
      {children}
    </div>
  );
}

const Hex = ({ fill, children }: { fill: string; children?: ReactNode }) => (
  <svg viewBox="-1.1 -1.1 2.2 2.2" width="30" height="30" aria-hidden>
    <polygon points="0,-1 0.866,-0.5 0.866,0.5 0,1 -0.866,0.5 -0.866,-0.5" fill={fill} stroke="rgba(0,0,0,.22)" strokeWidth="0.07" />
    {children}
  </svg>
);

const Die = () => (
  <svg viewBox="0 0 24 24" width="28" height="28" aria-hidden>
    <rect x="4" y="4" width="16" height="16" rx="3.5" fill="#fbf4e2" stroke="#8a6c45" strokeWidth="1.4" transform="rotate(-10 12 12)" />
    {[[8.5, 8.5], [15.5, 15.5], [12, 12], [15.5, 8.5], [8.5, 15.5]].map(([x, y], i) => (
      <circle key={i} cx={x} cy={y} r="1.3" fill="#6b5233" transform="rotate(-10 12 12)" />
    ))}
  </svg>
);

/** A glyph from the flat map, drawn small. */
const Glyph = ({ children }: { children: ReactNode }) => (
  <svg viewBox="0 0 30 30" width="30" height="30" aria-hidden>
    {children}
  </svg>
);

/**
 * A palette with more below its edge (on a phone, the dock is short) fades out there until it's
 * scrolled to the end, so its last row is known to be there.
 */
function moreBelow(el: HTMLDivElement | null) {
  if (!el) return;
  const check = () => el.toggleAttribute('data-more', el.scrollHeight - el.scrollTop - el.clientHeight > 4);
  const ro = new ResizeObserver(check);
  ro.observe(el);
  for (const c of el.children) ro.observe(c);
  el.addEventListener('scroll', check, { passive: true });
  check();
  return () => {
    ro.disconnect();
    el.removeEventListener('scroll', check);
  };
}

export function Dock() {
  const category = useEditor((s) => s.category);
  const set = useEditor((s) => s.set);
  const tabs = useRef<HTMLDivElement>(null);
  // The tabs are one stop for Tab; the arrows (and Home and End) move between them, as tabs do.
  const onKey = (e: KeyboardEvent) => {
    const i = CATEGORIES.findIndex((c) => c.id === category);
    const n = CATEGORIES.length;
    const to = { ArrowRight: i + 1, ArrowDown: i + 1, ArrowLeft: i - 1, ArrowUp: i - 1, Home: 0, End: n - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    const next = CATEGORIES[(to + n) % n];
    press();
    set({ category: next.id });
    tabs.current?.querySelector<HTMLElement>(`#ed-tab-${next.id}`)?.focus();
  };
  return (
    <nav className="ed-dock parchment" aria-label="Tools">
      {/* (The gradients the expansion glyphs paint with, for the 3D view where the flat board isn't up.) */}
      <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden>
        <FlatDefs k={40} />
      </svg>
      <div ref={tabs} className="ed-cats" role="tablist" aria-label="Tool categories" onKeyDown={onKey}>
        {CATEGORIES.map((c) => (
          // (Named here too: a narrow phone, or one on its side, shows the icons alone.)
          <button key={c.id} id={`ed-tab-${c.id}`} role="tab" aria-selected={category === c.id} aria-controls="ed-palette" tabIndex={category === c.id ? 0 : -1} aria-label={c.label} className={category === c.id ? 'on' : ''} onClick={() => (press(), set({ category: c.id }))}>
            {category === c.id && <motion.span layoutId="ed-cat-pill" className="ed-cat-pill" transition={{ type: 'spring', duration: 0.35, bounce: 0.2 }} />}
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              {c.icon}
            </svg>
            <span>{c.label}</span>
          </button>
        ))}
      </div>
      <LayoutGroup>
        <AnimatePresence mode="wait" initial={false}>
          <motion.div key={category} ref={moreBelow} id="ed-palette" className="ed-palette" role="tabpanel" aria-labelledby={`ed-tab-${category}`} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.16 }}>
            {category === 'land' && <LandTools />}
            {category === 'numbers' && <NumberTools />}
            {category === 'harbours' && <HarbourTools />}
            {category === 'features' && <FeatureTools />}
            {category === 'sea' && <SeaTools />}
            {category === 'map' && <MapTools />}
          </motion.div>
        </AnimatePresence>
      </LayoutGroup>
    </nav>
  );
}

/** A labelled setting: its name over (on a phone, beside) its choices. */
function Field({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <div className="ed-field">
      <span id={id}>{label}</span>
      {children}
    </div>
  );
}

function Brush() {
  const brush = useEditor((s) => s.brush);
  return (
    <Field id="ed-brush" label="Brush">
      <div className="seg ed-mini" role="group" aria-labelledby="ed-brush">
        {([1, 7] as const).map((b) => (
          <button key={b} className={brush === b ? 'on' : ''} aria-pressed={brush === b} onClick={() => (press(), useEditor.getState().set({ brush: b }))} title={b === 1 ? 'Paint one hex at a time' : 'Paint a hex and its ring'}>
            {b === 1 ? 'Fine' : 'Broad'}
          </button>
        ))}
      </div>
    </Field>
  );
}

/** One edit to the whole map, dealt from a fresh seed (and undone as one step). */
const whole = (fn: (m: CustomMap, rng: Rng) => CustomMap) => {
  press();
  const st = useEditor.getState();
  st.edit((m) => fn(m, new Rng(seed())), st.map.hexes.map((h) => `${h.q},${h.r}`));
};

/** The edits to the whole map, below a category's tools: one press each, undone as one step. */
function Actions({ children }: { children: ReactNode }) {
  return (
    <div className="ed-actions" role="group" aria-labelledby="ed-actions-head">
      <span id="ed-actions-head" className="ed-sub">
        Whole map
      </span>
      {children}
    </div>
  );
}

/** One of those edits: a quiet button with its icon. */
function Act({ icon, tip, onClick, children }: { icon: LineIconName; tip?: string; onClick: () => void; children: ReactNode }) {
  return (
    <button className="btn ghost small ed-act" onClick={onClick} title={tip}>
      <LineIcon name={icon} size={16} />
      <span>{children}</span>
    </button>
  );
}

function LandTools() {
  return (
    <>
      <Row>
        {CUSTOM_TERRAINS.map((t) => (
          <Chip key={t} tool={{ kind: 'terrain', terrain: t }} label={TERRAIN_NAMES[t]}>
            <Hex fill={FILL[t]} />
          </Chip>
        ))}
        <Chip tool={{ kind: 'terrain', terrain: 'random' }} label="Random" tip="Random: dealt from the bag at the start of every game">
          <Die />
        </Chip>
        <Chip tool={{ kind: 'erase' }} label="Erase" tip="Take cells off the map">
          <span className="ed-erase" aria-hidden>
            <CloseIcon size={14} />
          </span>
        </Chip>
        <Chip tool={{ kind: 'robber' }} label="Robber" tip="The robber’s start (the desert, unless placed)">
          <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden>
            <path d="M7 21q-.5-8 5-10 5.5 2 5 10z" fill="#2e2a27" />
            <circle cx="12" cy="7.5" r="3.5" fill="#2e2a27" />
          </svg>
        </Chip>
      </Row>
      <Brush />
    </>
  );
}

function NumberTools() {
  const deal = useEditor((s) => !!s.map.deal);
  return (
    <>
      <Row>
        {CUSTOM_NUMBERS.map((n) => (
          <Chip key={n} tool={{ kind: 'number', n }} label={String(n)} tip={`${n}: ${PIPS[n]} in 36`}>
            <span className={`ed-disc${n === 6 || n === 8 ? ' red' : ''}`}>
              {n}
              <i>{'•'.repeat(PIPS[n])}</i>
            </span>
          </Chip>
        ))}
        <Chip tool={{ kind: 'number', n: 'deal' }} label="Dealt" tip="Leave this hex’s number to the deal at the start">
          <span className="ed-disc owed">?</span>
        </Chip>
      </Row>
      <label className="ed-switch" title="Every producing hex without a number is dealt one at the start of each game">
        <input type="checkbox" checked={deal} onChange={(e) => (press(), useEditor.getState().edit((m) => ({ ...m, deal: e.target.checked || undefined })))} />
        <span>Deal numbers each game</span>
      </label>
      <Actions>
        <Act icon="refresh" onClick={() => whole((m, rng) => dealNumbers(m, rng))} tip="Fixed numbers on every producing hex now, no 6 or 8 touching">
          Deal numbers now
        </Act>
      </Actions>
    </>
  );
}

function HarbourTools() {
  return (
    <>
      <Row>
        {PORT_TYPES.map((p) => (
          <Chip key={p} tool={{ kind: 'port', type: p }} label={p === 'any' ? '3:1' : p === 'random' ? 'Random' : CARD_NAMES[p]} tip={p === 'any' ? '3:1, any goods' : p === 'random' ? 'A type dealt at the start' : `2:1 ${CARD_NAMES[p].toLowerCase()}`}>
            {p === 'any' ? <span className="ed-badge">3:1</span> : p === 'random' ? <span className="ed-badge owed">?</span> : <img src={asset(CARD_ICON[p])} alt="" width={26} height={26} />}
          </Chip>
        ))}
      </Row>
      <Actions>
        <Act icon="anchor" onClick={() => whole((m, rng) => placeHarbours(m, rng))} tip="Harbours round the coast, of the classic mix">
          Place harbours
        </Act>
        <Act icon="sparkle" onClick={() => whole((m, rng) => placeHarbours(m, rng, true))} tip="Harbours round the coast, their types dealt each game">
          Place random harbours
        </Act>
      </Actions>
    </>
  );
}

function FeatureTools() {
  const drawing = useEditor((s) => s.drawing);
  const terrain = (t: CustomTerrain, label: string, tag: string, tip: string, pic: ReactNode) => (
    <Chip tool={{ kind: 'terrain', terrain: t }} label={label} small={tag} tip={tip}>
      {pic}
    </Chip>
  );
  return (
    <>
      <Row>
        {terrain('bounty', 'Bounty', 'Sea Lanes', 'A bounty field: produces a resource of its owner’s choice', <Glyph><BountyGlyph x={15} y={15} s={28} /></Glyph>)}
        {terrain('lake', 'Lake', 'Fisheries', 'The lake: fish on 2, 3, 11 and 12', <Hex fill={FILL.lake} />)}
        <Chip tool={{ kind: 'ground' }} label="Fishing" small="Fisheries" tip="A fishing ground on the sea beside the land (six: 4, 5, 6, 8, 9 and 10)">
          <svg viewBox="0 0 24 24" width="28" height="28" aria-hidden>
            <circle cx="12" cy="12" r="9" fill="none" stroke="#c03a2e" strokeWidth="1.6" strokeDasharray="2.5 2" />
            <circle cx="12" cy="12" r="4.5" fill="#f7efdc" stroke="#bfa877" />
          </svg>
        </Chip>
        {terrain('swamp', 'Swamp', 'Rivers', 'A swamp: where a river meets the sea', <Glyph><SwampGlyph x={15} y={15} s={28} /></Glyph>)}
        <Chip tool={{ kind: 'river' }} label={drawing !== null ? 'Drawing…' : 'River'} small="Rivers" tip="Tap hexes from a spring to a swamp on the coast; tap the end again to finish">
          <svg viewBox="0 0 24 24" width="28" height="28" fill="none" aria-hidden>
            <path d="M5 4q6 4 2 8t5 8" stroke="#3b8fc4" strokeWidth="3" strokeLinecap="round" />
          </svg>
        </Chip>
        {terrain('oasis', 'Oasis', 'Wagon Trains', 'The oasis the wagon trains run from', <Glyph><OasisGlyph x={15} y={15} s={28} /></Glyph>)}
        {terrain('castle', 'Castle', 'Invasion', 'The castle, on the home island’s coast', <Glyph><CastleGlyph x={15} y={15} s={28} /></Glyph>)}
        <Chip tool={{ kind: 'well' }} label="Well" small="Oil" tip="An oil well (three on the home island)">
          <Glyph>
            <OilWellGlyph x={15} y={15} s={28} />
          </Glyph>
        </Chip>
        <Chip tool={{ kind: 'corsair' }} label="Corsair" small="Sea Lanes" tip="Where the corsair starts, out on the sea">
          <svg viewBox="0 0 24 24" width="28" height="28" aria-hidden>
            <path d="M4 15h16l-3 4H7z" fill="#3b2a1e" />
            <path d="M12 15V4" stroke="#1d140d" strokeWidth="1.4" />
            <path d="M12.3 4.5Q19 9 12.3 14z" fill="#16120f" />
          </svg>
        </Chip>
      </Row>
      <p className="ed-help">Features you leave out are placed on the home island by the game, for the expansions in play.</p>
    </>
  );
}

function SeaTools() {
  return (
    <>
      <Row>
        <Chip tool={{ kind: 'fog' }} label="Fog" small="Sea Lanes" tip="Face down until a ship or road finds it">
          <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="#7c8b93" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
            <path d="M4 9q2-2 4 0t4 0 4 0 4 0M3 13q2-2 4 0t4 0 4 0 4 0M5 17q2-2 4 0t4 0 4 0" />
          </svg>
        </Chip>
        <Chip tool={{ kind: 'home' }} label="Home" tip="Mark an island where the starting houses go (the largest, unless marked)">
          <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden>
            <path d="M7 21V4" stroke="#5b3d24" strokeWidth="1.8" strokeLinecap="round" />
            <path d="M7 4l11 3-11 4z" fill="#c4953b" stroke="#6d4b17" strokeWidth="1" />
          </svg>
        </Chip>
        <Chip tool={{ kind: 'terrain', terrain: 'sea' }} label="Sea" tip="Open sea the ships sail">
          <Hex fill={FILL.sea} />
        </Chip>
        <Chip tool={{ kind: 'terrain', terrain: 'random' }} label="Islet" tip="Random land: paint it out at sea for an islet">
          <Die />
        </Chip>
      </Row>
      <Brush />
      <Actions>
        <Act icon="globe" onClick={() => whole((m) => surroundWithSea(m))} tip="Open sea round all the land, for ships to sail">
          Surround with sea
        </Act>
        <Act icon="ship" onClick={() => whole((m) => fillGaps(m))} tip="Open sea in the gaps between the islands, so ships can sail between them">
          Fill gaps with sea
        </Act>
        <Act icon="plus" onClick={() => whole((m, rng) => fillGaps(scatterIslets(m, rng, undefined, 3, false)))} tip="Islets of random land off the coast">
          Add islets
        </Act>
        <Act icon="cloud" onClick={() => whole((m, rng) => fillGaps(scatterIslets(m, rng, undefined, 3, true)))} tip="Islets face down in the fog, to be found">
          Add islets in the fog
        </Act>
        <Act icon="eye" onClick={() => whole((m) => ({ ...m, hexes: m.hexes.map(({ hidden: _h, ...h }) => h) }))} tip="Every cell face up">
          Clear the fog
        </Act>
      </Actions>
    </>
  );
}

function MapTools() {
  const s = useEditor();
  const { map, symmetry } = s;
  const randoms = map.hexes.filter((h) => h.terrain === 'random').length;
  const { cols, rows } = canvasSize(map);
  // (Open water laid to the new size, or taken off it; refused with land in the way.)
  const size = (c: number, r: number) => {
    press();
    s.edit((m) => resize(m, c, r), undefined, `That canvas won’t hold the map: land is in the way, or it reaches past ${MAX_REACH} hexes from the middle`);
  };
  return (
    <>
      <Field id="ed-size" label="Canvas">
        <div className="ed-size" role="group" aria-labelledby="ed-size">
          <SizeStep name="width" value={cols} onChange={(n) => size(n, rows)} />
          <span className="ed-times" aria-hidden>
            ×
          </span>
          <SizeStep name="height" value={rows} onChange={(n) => size(cols, n)} />
        </div>
      </Field>
      <Field id="ed-sym" label="Symmetry">
        <div className="seg" role="group" aria-labelledby="ed-sym">
          {([1, 2, 3, 6] as const).map((n) => (
            <button key={n} className={symmetry === n ? 'on' : ''} aria-pressed={symmetry === n} onClick={() => (press(), s.set({ symmetry: n }))} title={n === 1 ? 'Paint where you point' : `Every edit repeated ${n} times round the middle`}>
              {n === 1 ? 'Off' : `${n}×`}
            </button>
          ))}
        </div>
      </Field>
      <Actions>
        <Act icon="sparkle" onClick={() => whole((m, rng) => fillTerrain(m, rng))} tip="New terrain and numbers for the land you’ve drawn">
          Fill terrain
        </Act>
        <Act icon="play" onClick={() => whole((m) => ({ ...m, deal: true, hexes: m.hexes.map((h) => (['forest', 'pasture', 'fields', 'hills', 'mountains', 'desert'].includes(h.terrain) ? { q: h.q, r: h.r, terrain: 'random' as CellTerrain, ...(h.hidden && { hidden: true as const }) } : h)) }))} tip="Every plain land hex dealt from the bag each game">
          Make the land random
        </Act>
        {isRandom(map) && (
          <Act icon="eye" onClick={() => (press(), s.set({ preview: seed() }))} tip="One deal of the random hexes, as a game might deal it">
            Preview a deal
          </Act>
        )}
        <Act icon="map" onClick={() => (press(), s.edit((m) => crop(m), s.map.hexes.map((h) => `${h.q},${h.r}`)))} tip="Take off the open water far from the land, and centre the map">
          Crop to map
        </Act>
        <Act icon="focus" onClick={() => (press(), s.set({ fit: s.fit + 1 }))} tip="Frame the whole map in view">
          Fit view
        </Act>
      </Actions>
      {randoms > 0 && <BagEditor />}
    </>
  );
}

/** One side of the canvas, in hexes, stepped up and down. */
function SizeStep({ name, value, onChange }: { name: 'width' | 'height'; value: number; onChange: (n: number) => void }) {
  return (
    <div className="stepper">
      <button aria-label={name === 'width' ? 'Narrower' : 'Shorter'} disabled={value <= 1} onClick={() => onChange(value - 1)}>
        <LineIcon name="minus" size={14} />
      </button>
      <b aria-label={`${name} in hexes`}>
        <Morph>{value}</Morph>
      </b>
      <button aria-label={name === 'width' ? 'Wider' : 'Taller'} disabled={value >= 2 * MAX_REACH + 1} onClick={() => onChange(value + 1)}>
        <LineIcon name="plus" size={14} />
      </button>
    </div>
  );
}

/** The bag the random hexes are drawn from: the classic proportions, or counts of one's own. */
function BagEditor() {
  const map = useEditor((s) => s.map);
  const randoms = map.hexes.filter((h) => h.terrain === 'random').length;
  const bag = bagOf(map);
  const size = bagSize(bag);
  const kinds: CustomTerrain[] = ['forest', 'pasture', 'fields', 'hills', 'mountains', 'desert', 'bounty', 'sea'];
  const change = (t: CustomTerrain, d: number) => {
    press();
    useEditor.getState().edit((m) => ({ ...m, bag: { ...bagOf(m), [t]: Math.max(0, (bagOf(m)[t] ?? 0) + d) } }));
  };
  return (
    <div className="ed-bag">
      <div className="ed-bag-head">
        <b id="ed-bag">The bag</b>
        <span className={size === randoms ? 'ok' : 'bad'} aria-live="polite">
          {size === randoms ? <LineIcon name="check" size={14} /> : <LineIcon name="flag" size={14} />}
          <span>
            <Morph>{size}</Morph> tiles for {randoms} random hexes{size === randoms ? '' : ': make them match'}
          </span>
        </span>
        {map.bag && (
          <button className="ed-link" onClick={() => (press(), useEditor.getState().edit((m) => ({ ...m, bag: undefined })))}>
            Classic mix
          </button>
        )}
      </div>
      {kinds.map((t) => (
        <div key={t} className="ed-bag-row">
          <Hex fill={FILL[t]} />
          <span>{TERRAIN_NAMES[t]}</span>
          <div className="stepper small">
            <button aria-label={`Fewer ${TERRAIN_NAMES[t]}`} disabled={!bag[t]} onClick={() => change(t, -1)}>
              <LineIcon name="minus" size={14} />
            </button>
            <b>
              <Morph>{bag[t] ?? 0}</Morph>
            </b>
            <button aria-label={`More ${TERRAIN_NAMES[t]}`} onClick={() => change(t, 1)}>
              <LineIcon name="plus" size={14} />
            </button>
          </div>
        </div>
      ))}
      {!map.bag && <p className="ed-help">The classic mix for {randoms}: {Object.entries(classicBag(randoms)).map(([t, n]) => `${n} ${TERRAIN_NAMES[t as CustomTerrain].toLowerCase()}`).join(', ')}.</p>}
    </div>
  );
}
