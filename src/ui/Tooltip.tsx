import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { session } from '../app/session';
import { useUI } from '../game/store';
import { RESOURCES, publicVictoryPoints, totalVictoryPoints, type GameState, type Resource } from '../engine';
import { CARD_NAMES } from '../game/names';
import { seenHex } from '../game/hexView';
import type { HoverInfo } from '../app/input';
import { ResIcon } from './Cards';
import { SeatMark } from './SeatMark';
import { PLAYER_PALETTE } from '../render/board/pieces';
import { playersOn } from './advice';

/** Where the pointer last was over the board, and how to move the tooltip there (see Floating). */
const pointer: { current: HoverInfo | null } = { current: null };
const placeTooltip: { current: (() => void) | null } = { current: null };

/**
 * Info chip that follows the pointer. Over a legal building spot it summarises
 * what the spot would produce (dots per resource and any harbour); otherwise it
 * describes the hex under the cursor, and who has buildings on it (whom the robber
 * there would hurt, with the points they show).
 */
export function TileTooltip() {
  const [hover, setHover] = useState<HoverInfo | null>(null);
  const target = useRef<HoverInfo | null>(null);
  const view = useUI((s) => s.view);
  const me = useUI((s) => s.me);
  const show = useUI((s) => s.settings.showProbabilities);
  const robbing = useUI((s) => s.interaction.kind === 'robber');
  useEffect(() => {
    // (Over the same hex or spot, only the position changes: the tooltip is moved, not redrawn.)
    const fn = (h: HoverInfo | null) => {
      if (h) pointer.current = h;
      const was = target.current;
      if (was && h && was.hex === h.hex && was.vertex === h.vertex && was.touch === h.touch) {
        placeTooltip.current?.();
        return;
      }
      target.current = h;
      setHover(h);
    };
    session.hoverListeners.add(fn);
    return () => {
      session.hoverListeners.delete(fn);
    };
  }, []);
  // With odds turned off, only the robber's choice keeps its note (who a tile would hurt).
  if (!hover || !view || !(show || robbing)) return null;
  if (hover.vertex !== undefined) return show ? <SpotInfo state={view} vertex={hover.vertex} hover={hover} /> : null;
  if (!view.board.hexes[hover.hex]) return null;
  // (The hex as the table sees it: a face-down one says nothing of what lies under the fog.)
  const hex = seenHex(view, hover.hex);
  const robbed = view.robberHex === hex.id;
  const here = playersOn(view, hex.id);
  return (
    <Floating hover={hover}>
      <b className="title-font">{hex.label}</b>
      {hex.resource && <span style={{ color: 'var(--ink-soft)' }}> · {CARD_NAMES[hex.resource]}</span>}
      {hex.hidden && <div style={{ color: 'var(--ink-soft)' }}>A route that reaches it turns it up</div>}
      {hex.numbers.length > 0 && show && (
        <div style={{ color: 'var(--ink-soft)', fontVariantNumeric: 'tabular-nums' }}>
          {hex.numbers.join(' or ')} rolls about {Math.round((hex.pips / 36) * 100)}% of the time
        </div>
      )}
      {robbed && <div style={{ color: 'var(--bad)', fontWeight: 700 }}>Blocked by the robber</div>}
      {here.length > 0 && (
        <div className="tt-players">
          <div className="tt-head">{robbing && !robbed ? 'The robber here would block' : 'Buildings here'}</div>
          {here.map(({ player, settlements, cities }) => {
            const p = view.players[player];
            const vp = player === me ? totalVictoryPoints(view, player) : publicVictoryPoints(view, player);
            const pieces = [cities && `${cities} ${cities === 1 ? 'town' : 'towns'}`, settlements && `${settlements} house${settlements === 1 ? '' : 's'}`].filter(Boolean).join(', ');
            return (
              <div key={player} className="tt-player">
                <SeatMark seat={player} color={PLAYER_PALETTE[p.color].ui} size={10} />
                <span className="tt-name">{player === me ? 'You' : p.name}</span>
                <span className="tt-vp">{vp} VP</span>
                <span className="tt-pieces">{pieces}</span>
              </div>
            );
          })}
        </div>
      )}
    </Floating>
  );
}

/**
 * Beside a pointer, above a holding finger (which would cover it); turned to the other side of
 * the pointer where it would run off the window, and kept inside it. Measured after each render,
 * so a longer note never pokes out of a corner.
 */
function Floating({ hover: shown, children }: { hover: HoverInfo; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const size = useRef({ w: 0, h: 0, zoom: 1 });
  // Placed where the pointer is now (TileTooltip moves it, as the pointer goes, without a redraw).
  const place = () => {
    const el = ref.current;
    if (!el) return;
    const hover = pointer.current ?? shown;
    const { w, h, zoom } = size.current;
    const W = window.innerWidth, H = window.innerHeight, m = 8;
    let x: number, y: number;
    if (hover.touch) {
      x = hover.x - w / 2;
      y = hover.y - 36 - h;
      if (y < m) y = hover.y + 36;
    } else {
      x = hover.x + 18;
      y = hover.y + 20;
      if (x + w > W - m) x = hover.x - 18 - w;
      if (y + h > H - m) y = hover.y - 12 - h;
    }
    x = Math.min(W - w - m, Math.max(m, x));
    y = Math.min(H - h - m, Math.max(m, y));
    el.style.transform = `translate(${x / zoom}px, ${y / zoom}px)`;
  };
  // Measured once each time what it says changes (the HUD is zoomed to the interface size:
  // measure on screen, move in its own units).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const zoom = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui-scale')) || 1;
    const r = el.getBoundingClientRect();
    size.current = { w: r.width, h: r.height, zoom };
    place();
  });
  useEffect(() => {
    placeTooltip.current = place;
    return () => {
      if (placeTooltip.current === place) placeTooltip.current = null;
    };
  });
  return (
    <div ref={ref} className="parchment tooltip">
      {children}
    </div>
  );
}

function SpotInfo({ state, vertex, hover }: { state: GameState; vertex: number; hover: HoverInfo }) {
  const v = state.board.vertices[vertex];
  const per: Partial<Record<Resource, number>> = {};
  let total = 0;
  for (const h of v.hexes) {
    const { resource: r, pips: p } = seenHex(state, h);
    if (!r || p === 0) continue;
    per[r] = (per[r] ?? 0) + p;
    total += p;
  }
  const port = v.port;
  return (
    <Floating hover={hover}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'baseline' }}>
        <b className="title-font">This spot</b>
        <span style={{ fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>{total} dots</span>
      </div>
      <div style={{ display: 'flex', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
        {RESOURCES.filter((r) => per[r]).map((r) => (
          // Drawn as dots (like the number discs) so they don't read as dice numbers.
          <span key={r} className="chip pips">
            <ResIcon r={r} size={16} />
            <span className="pip-dots" aria-hidden>
              {'•'.repeat(Math.min(per[r]!, 10))}
            </span>
            <span className="sr-only">{per[r]} dots</span>
          </span>
        ))}
        {total === 0 && <span style={{ color: 'var(--ink-soft)' }}>No production</span>}
      </div>
      {total > 0 && (
        // (What dots mean: the more of them, the more often the dice pay this spot.)
        <div style={{ marginTop: 4, color: 'var(--ink-soft)' }}>{total >= 9 ? 'Pays often' : total >= 5 ? 'Pays fairly often' : 'Pays rarely'}: more dots, more rolls</div>
      )}
      {port && (
        <div style={{ marginTop: 4, color: 'var(--ink-soft)' }}>
          Harbour: {port === 'any' ? '3:1 any resource' : `2:1 ${CARD_NAMES[port]}`}
        </div>
      )}
      <div className="tt-foot">≈ {(total / 36).toFixed(2)} cards per roll</div>
    </Floating>
  );
}

/**
 * The island in words, for a screen reader (the board itself is a picture): each tile with its
 * resource, its number and how often that comes up, the robber, and who has built on it, the
 * busiest tiles first. Read with the list's own navigation; it isn't announced as it changes.
 */
export function IslandText() {
  const view = useUI((s) => s.view);
  const me = useUI((s) => s.me);
  if (!view) return null;
  // (Each tile as the table sees it, so a face-down one is only "Unexplored".)
  const tiles = view.board.hexes.map((h) => seenHex(view, h.id)).sort((a, b) => b.pips - a.pips);
  return (
    <section className="sr-only" aria-label="The island, tile by tile">
      <ul>
        {tiles.map((h) => {
          const here = playersOn(view, h.id)
            .map(({ player, settlements, cities }) => `${player === me ? 'you' : view.players[player].name} (${[cities && `${cities} ${cities === 1 ? 'town' : 'towns'}`, settlements && `${settlements} house${settlements === 1 ? '' : 's'}`].filter(Boolean).join(', ')})`)
            .join('; ');
          return (
            <li key={h.id}>
              {h.label}
              {h.resource ? `, ${CARD_NAMES[h.resource]}` : ''}
              {h.hidden ? '' : h.numbers.length > 0 ? `, number ${h.numbers.join(' or ')} (${h.pips} rolls in 36)` : ', no number'}
              {view.robberHex === h.id ? ', the robber is here' : ''}
              {here ? `. Built here: ${here}` : ''}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
