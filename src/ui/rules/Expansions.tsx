// How to play's Expansions tab: a contents list (the expansions in play first, then the rest), a
// page for how the mix runs as a whole, and a page for each expansion. Pages link to one another;
// moving between them puts the new page's title at the top, and the focus on it.

import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { PAGE_IN } from '../motion';
import { EXPANSIONS, type Expansion } from '../../engine/presets';
import { LineIcon } from '../LineIcons';
import { AWARD_ART, HAPPENING_ART, MUSTER_ART, SEAT_ART, TOKEN_ICON, asset } from '../../game/names';
import { OasisGlyph } from '../flatArt';
import { blurbOf, nameOf, type RulesCtx } from './context';
import { RulesNav, type RulesPage } from './parts';
import { MixPage } from './mix';
import { SeaPage } from './sea';
import { GuildsPage } from './guilds';
import { InvasionPage } from './invasion';
import { RiversPage } from './rivers';
import { CaravansPage } from './caravans';
import { FisheriesPage } from './fisheries';
import { OilPage } from './oil';
import { AlmanacPage } from './almanac';
import { HarbourmasterPage } from './harbourmaster';

const PAGES: Record<Expansion, () => ReactNode> = {
  sea: SeaPage,
  guilds: GuildsPage,
  invasion: InvasionPage,
  rivers: RiversPage,
  caravans: CaravansPage,
  fisheries: FisheriesPage,
  oil: OilPage,
  almanac: AlmanacPage,
  harbourmaster: HarbourmasterPage,
};

/** The pages in reading order: the mix first, then the expansions in play, then the others. */
function order(ctx: RulesCtx): RulesPage[] {
  const all = EXPANSIONS.map((e) => e.id);
  return ['mix', ...ctx.inPlay, ...all.filter((e) => !ctx.inPlay.includes(e))];
}

const titleOf = (p: RulesPage, ctx: RulesCtx) => (p === 'contents' ? 'Contents' : p === 'mix' ? (ctx.inPlay.length ? 'This game' : 'Playing them together') : nameOf(p));

export function ExpansionsTab({ ctx, page, go: goTo }: { ctx: RulesCtx; page: RulesPage; go: (p: RulesPage) => void }) {
  const top = useRef<HTMLDivElement>(null);
  // (A move between pages puts the focus on the new page's title; the dialog goes back to its top
  // with it, see TabPanel, so the tabs stay in reach.)
  const moved = useRef(page !== 'contents');
  const pages = useMemo(() => order(ctx), [ctx]);
  const go = (p: RulesPage) => {
    moved.current = true;
    goTo(p);
  };
  useEffect(() => {
    if (!moved.current) return;
    top.current?.closest('.modal')?.scrollTo({ top: 0 });
    top.current?.querySelector<HTMLElement>('[data-page-title]')?.focus({ preventScroll: true });
  }, [page]);
  const nav = useMemo(() => ({ go, ctx }), [ctx, goTo]);
  const at = pages.indexOf(page);
  const prev = at > 0 ? pages[at - 1] : null;
  const next = at >= 0 && at < pages.length - 1 ? pages[at + 1] : null;
  return (
    <RulesNav.Provider value={nav}>
      <div className="rules-pages" ref={top}>
        <AnimatePresence mode="wait" initial={false}>
          <motion.div key={page} className="rules-pages" {...PAGE_IN}>
            {page === 'contents' ? (
              <Contents ctx={ctx} pages={pages} go={go} />
            ) : (
              <>
                {/* One way back, at the head of the page (Escape goes there too). */}
                <button type="button" className="rules-back" onClick={() => go('contents')}>
                  <LineIcon name="back" size={18} /> Contents
                </button>
                <article className="rules-page" aria-label={titleOf(page, ctx)}>
                  {page === 'mix' ? <MixPage /> : <Page id={page} />}
                </article>
                <nav className="rules-turn" aria-label="Pages">
                  {prev ? (
                    <button type="button" className="btn ghost" onClick={() => go(prev)}>
                      <LineIcon name="back" size={18} /> {titleOf(prev, ctx)}
                    </button>
                  ) : (
                    <span />
                  )}
                  {next && (
                    <button type="button" className="btn ghost" onClick={() => go(next)}>
                      {titleOf(next, ctx)} <LineIcon name="next" size={18} />
                    </button>
                  )}
                </nav>
              </>
            )}
          </motion.div>
        </AnimatePresence>
      </div>
    </RulesNav.Provider>
  );
}

/** An expansion's page, rendered as a component of its own so its hooks sit inside the tab's context. */
function Page({ id }: { id: Expansion }) {
  const View = PAGES[id];
  return <View />;
}

/** The mix's picture: a few islands of hexes in the flat map's colours, on the sea. */
function MiniArchipelago() {
  const r = 10.5, w = r * Math.sqrt(3);
  const hexes: [number, number, string][] = [
    [0, 0, '#3c7531'], [1, 0, '#dcb042'], [-1, 1, '#b95d33'], [0, 1, '#80b441'], [1, 1, '#78828c'],
    [3, -1, '#a8946a'], [3, 0, '#80b441'], [-2, 3, '#3c7531'], [-1, 3, '#dcb042'],
  ];
  const corner = (cx: number, cy: number) => Array.from({ length: 6 }, (_, i) => `${(cx + r * Math.cos(((60 * i - 30) * Math.PI) / 180)).toFixed(1)},${(cy + r * Math.sin(((60 * i - 30) * Math.PI) / 180)).toFixed(1)}`).join(' ');
  return (
    <svg viewBox="0 0 100 100" className="glyph">
      <rect width="100" height="100" fill="#3a93bf" />
      {hexes.map(([q, rr, fill]) => {
        const cx = 34 + w * (q + rr / 2), cy = 22 + r * 1.5 * rr;
        return <polygon key={`${q},${rr}`} points={corner(cx, cy)} fill={fill} stroke="#e7d4a2" strokeWidth="1.6" strokeLinejoin="round" />;
      })}
    </svg>
  );
}

/**
 * Each contents entry's picture, from the art the expansion brings: a painting of its own where it
 * has one, a token or the flat map's pictogram where it doesn't.
 */
const THUMBS: Record<RulesPage, ReactNode> = {
  contents: null,
  mix: <MiniArchipelago />,
  sea: <img src={asset(AWARD_ART.firstLanding)} alt="" />,
  guilds: <img src={asset(SEAT_ART.commerce)} alt="" />,
  invasion: <img className="portrait" src={asset(MUSTER_ART.levy)} alt="" />,
  rivers: <img src={asset(AWARD_ART.richest)} alt="" />,
  caravans: (
    <svg viewBox="0 0 100 100" className="glyph">
      <OasisGlyph x={50} y={50} s={104} />
    </svg>
  ),
  fisheries: <img className="token" src={asset(TOKEN_ICON.fish)} alt="" />,
  oil: <img src={asset(AWARD_ART.steward)} alt="" />,
  almanac: <img src={asset(HAPPENING_ART.fairDay)} alt="" />,
  harbourmaster: <img src={asset(AWARD_ART.harbourmaster)} alt="" />,
};

function Contents({ ctx, pages, go }: { ctx: RulesCtx; pages: RulesPage[]; go: (p: RulesPage) => void }) {
  const entry = (p: RulesPage) => (
    <li key={p}>
      <button type="button" className={`rules-entry thumbed${p === 'fisheries' ? ' sea' : ''}`} onClick={() => go(p)}>
        <span className="rules-thumb" aria-hidden>
          {THUMBS[p]}
        </span>
        <span className="rules-entry-name">{titleOf(p, ctx)}</span>
        <span className="rules-entry-blurb">
          {p === 'mix'
            ? ctx.inPlay.length
              ? `${ctx.preset ?? (ctx.inPlay.length === 1 ? nameOf(ctx.inPlay[0]) : `${ctx.inPlay.length} expansions`)}: the target, the turn and how they meet`
              : 'Any mix: the target, the turn, and the rules where expansions meet'
            : p === 'guilds' && ctx.inPlay.includes('invasion')
              ? 'Commodities, guild seats, venture cards and wardens (Invasion takes the raider fleet’s place)'
              : blurbOf(p as Expansion)}
        </span>
        <LineIcon name="next" size={18} />
      </button>
    </li>
  );
  const playing = pages.filter((p) => p !== 'mix' && ctx.inPlay.includes(p as Expansion));
  const others = pages.filter((p) => p !== 'mix' && !ctx.inPlay.includes(p as Expansion));
  return (
    <div className="rules-contents">
      {ctx.inPlay.length > 0 ? (
        <>
          <h4 data-page-title tabIndex={-1}>In this game</h4>
          <ul>{[entry('mix'), ...playing.map(entry)]}</ul>
          <h4>The other expansions</h4>
          <ul>{others.map(entry)}</ul>
        </>
      ) : (
        <>
          <p className="rule-note" data-page-title tabIndex={-1}>
            {ctx.inGame ? 'This game is the base game. ' : ''}Each expansion is switched on from the set-up page, alone or together with others.
          </p>
          <ul>{[entry('mix'), ...others.map(entry)]}</ul>
        </>
      )}
    </div>
  );
}
