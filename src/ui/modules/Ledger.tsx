// Where the expansions' own panels sit in the HUD. What's always worth a look (the guild board,
// the venture hand, the disaster track, your fish, the coast, the raider fleet) shares one panel, a ledger with a page for each, under the
// players on the full HUD and behind a button over the dock on a phone. What has to be answered
// now (the wagon auction, a happening's decision, a venture decision, cards a venture asks for,
// resources to take, a full purse's swap, a muster card) goes in the dock above the turn's buttons
// on both, where the generic panel's decisions go. Each shows only with its module.

import { useEffect, useRef, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { create } from 'zustand';
import type { GameState, PlayerId } from '../../engine';
import { useUI } from '../../game/store';
import { legalOf } from '../../game/modulePanels';
import { ErrorBoundary } from '../ErrorBoundary';
import { GuildBoard } from './GuildBoard';
import { VentureDecision, VentureHand } from './VentureHand';
import { OilTrack } from './OilTrack';
import { FishNets, FishSwap, fishToDo } from './FishNets';
import { fishOf } from '../../engine/modules/fisheries/fish';
import { Coast, MusterDecision } from './Coast';
import { raidersOnBoard } from '../../engine/modules/invasion/raids';
import { Fleet } from './FleetPage';
import { FLEET_STEPS } from '../../engine/modules/fleet';
import { CaravansAuction, WagonNews } from './CaravansAuction';
import { AlmanacDecision } from './Almanac';
import { HandPickDecision, SupplyPick } from './CardPicks';
import { ScrollCut } from './ScrollCut';
import { CloseIcon } from '../LineIcons';
import { useEscape } from '../hooks';

type Page = 'guilds' | 'ventures' | 'oil' | 'fish' | 'raiders' | 'fleet';

const PAGE_NAMES: Record<Page, string> = { guilds: 'Guilds', ventures: 'Ventures', oil: 'Oil', fish: 'Fish', raiders: 'Raiders', fleet: 'Fleet' };

const KEY = 'exploratory.ledger';

/**
 * The page last looked at and whether the ledger is open, remembered on this device (a convenience,
 * so it may be lost). It starts folded to its tabs, leaving the players' column to the players:
 * a tab, or the toggle, opens it.
 */
function remembered(): { page: Page; open: boolean } {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return { page: (Object.keys(PAGE_NAMES) as Page[]).includes(raw.page) ? raw.page : 'guilds', open: raw.open === true };
  } catch {
    return { page: 'guilds', open: false };
  }
}

/** The ledger's page and state, shared by the panel and (on a phone) the button that opens it. */
const useLedger = create<{ page: Page; open: boolean; sheet: boolean }>(() => ({ ...remembered(), sheet: false }));

function setLedger(p: Partial<{ page: Page; open: boolean; sheet: boolean }>) {
  useLedger.setState(p);
  const { page, open } = useLedger.getState();
  try {
    localStorage.setItem(KEY, JSON.stringify({ page, open }));
  } catch {
    /* storage unavailable */
  }
}

/** The ledger's pages for the modules in play. */
function pagesOf(s: GameState): Page[] {
  const out: Page[] = [];
  if (s.ext.guilds) out.push('guilds', 'ventures');
  if (s.ext.oil) out.push('oil');
  if (s.ext.fisheries) out.push('fish');
  if (s.ext.invasion) out.push('raiders');
  // (Never beside the raiders: the invasion takes the fleet's place.)
  if (s.ext.fleet) out.push('fleet');
  return out;
}

/** A word on a page's tab: your ventures held, the track's place, your fish, the raiders ashore, the fleet's steps sailed. */
function tabNote(s: GameState, me: PlayerId, page: Page): string | null {
  if (page === 'ventures') return String(s.ext.guilds?.hands[me]?.length ?? 0);
  if (page === 'oil') return `${s.ext.oil!.track}/5`;
  if (page === 'fish') return String(fishOf(s.ext.fisheries!.tokens[me].filter((t) => t > 0)));
  if (page === 'raiders') return String(raidersOnBoard(s));
  if (page === 'fleet') return `${s.ext.fleet!.position}/${FLEET_STEPS}`;
  return null;
}

/** Whether the ledger has something for you to do (a level to climb, a venture to play, fish to spend): the phone's button says so. */
function toDo(s: GameState, me: PlayerId): boolean {
  return (!!s.ext.guilds && (legalOf(s, me, 'guilds/improve').length > 0 || legalOf(s, me, 'guilds/play').length > 0)) || fishToDo(s, me);
}

function Body({ page }: { page: Page }) {
  return page === 'guilds' ? <GuildBoard /> : page === 'ventures' ? <VentureHand /> : page === 'oil' ? <OilTrack /> : page === 'fish' ? <FishNets /> : page === 'fleet' ? <Fleet /> : <Coast />;
}

/** The ledger: a page for each module's standing information, one shown at a time. */
export function ModuleLedger({ sheet = false }: { sheet?: boolean }) {
  const view = useUI((s) => s.view);
  const me = useUI((s) => s.me);
  const { page, open } = useLedger();
  // A venture decision owed opens the ledger at the hand, so the cards are in view while choosing.
  const ventureOwed = useUI((s) => {
    const top = s.view?.pending[s.view.pending.length - 1];
    return !!top && top.players.includes(s.me) && (top.kind === 'guilds/ventureLimit' || top.kind === 'guilds/spy');
  });
  useEffect(() => {
    if (ventureOwed) setLedger({ page: 'ventures', open: true });
  }, [ventureOwed]);
  // (On a phone the tabs scroll sideways in one row: the open one is brought into view.)
  const onTab = useRef<HTMLButtonElement>(null);
  const shownPage = view ? (pagesOf(view).includes(page) ? page : pagesOf(view)[0]) : null;
  useEffect(() => {
    // (A block, not an arrow's value: newer browsers return a promise from scrollIntoView, which React would take for a clean-up.)
    onTab.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [shownPage, sheet]);
  if (!view) return null;
  const pages = pagesOf(view);
  if (!pages.length) return null;
  const shown = shownPage!;
  const expanded = sheet || open;
  return (
    <section className={`ledger parchment${sheet ? ' sheet' : ''}${expanded ? '' : ' closed'}`} aria-label="Expansions">
      <div className="ledger-head">
        {pages.length > 1 ? (
          <div className="seg ledger-tabs" role="group" aria-label="Ledger page">
            {pages.map((p) => {
              const note = tabNote(view, me, p);
              return (
                <button key={p} ref={p === shown ? onTab : undefined} type="button" className={p === shown ? 'on' : ''} aria-pressed={p === shown} onClick={() => setLedger({ page: p, open: true })}>
                  {PAGE_NAMES[p]}
                  {note && <span className="ledger-note">{note}</span>}
                </button>
              );
            })}
          </div>
        ) : (
          <span className="ledger-title">{PAGE_NAMES[shown]}</span>
        )}
        {sheet ? (
          <button type="button" className="icon-btn small ledger-toggle" aria-label="Close the ledger" onClick={() => setLedger({ sheet: false })}>
            <CloseIcon />
          </button>
        ) : (
          <button type="button" className="icon-btn small ledger-toggle" aria-expanded={open} aria-label={open ? 'Fold the ledger away' : 'Open the ledger'} onClick={() => setLedger({ open: !open })}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ transform: open ? undefined : 'rotate(180deg)' }}>
              <path d="M6 15l6-6 6 6" />
            </svg>
          </button>
        )}
      </div>
      {expanded && (
        <ScrollCut className="ledger-body" wrap="ledger-scroll" label="on this page">
          <ErrorBoundary name={`ledger-${shown}`}>
            <Body page={shown} />
          </ErrorBoundary>
        </ScrollCut>
      )}
    </section>
  );
}

/** On a phone: the button over the dock that opens the ledger as a sheet (marked when it has something for you to do). */
export function LedgerButton() {
  const view = useUI((s) => s.view);
  const me = useUI((s) => s.me);
  const sheet = useLedger((s) => s.sheet);
  if (!view || !pagesOf(view).length) return null;
  const todo = toDo(view, me);
  return (
    <button type="button" className={`icon-btn ledger-btn${sheet ? ' on' : ''}`} aria-expanded={sheet} aria-label={`Expansions ledger${todo ? ': something to do' : ''}`} onClick={() => setLedger({ sheet: !sheet })}>
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z" />
        <path d="M5 17a3 3 0 0 1 3-3h11" />
        <path d="M9 8h6M9 11h4" />
      </svg>
      {todo && <span className="ledger-dot" aria-hidden />}
    </button>
  );
}

/** On a phone: the ledger as a sheet in the dock, while its button holds it open (a pick on the board folds it away). */
export function LedgerSheet() {
  const sheet = useLedger((s) => s.sheet);
  const picking = useUI((s) => s.interaction.kind === 'pick');
  useEffect(() => {
    if (picking) setLedger({ sheet: false });
  }, [picking]);
  useEscape(sheet, () => setLedger({ sheet: false }));
  return (
    <AnimatePresence>
      {sheet && (
        <motion.div key="ledger" className="ledger-wrap glass-fade" data-hud-obstacle="ledger" initial={{ '--fade': 0, y: 10 }} animate={{ '--fade': 1, y: 0 }} exit={{ '--fade': 0, y: 6, transition: { duration: 0.15 } }} transition={{ type: 'spring', duration: 0.3, bounce: 0 }}>
          <ModuleLedger sheet />
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/**
 * The dock's decisions and the expansions' moves, scrolling as one when they're taller than the
 * room left (so the turn's buttons below stay in reach), with a fade and a pill where they're cut.
 */
export function DecisionStack({ children }: { children: ReactNode }) {
  return (
    <ScrollCut className="dock-decisions" wrap="decisions" label="in the dock" mark="decisions">
      {children}
    </ScrollCut>
  );
}

/**
 * What has to be answered now, in the dock: a venture decision, cards a venture asks of your hand,
 * resources to take from the supply, a happening's (on a phone), the wagon auction, a full purse's
 * swap, a muster card.
 */
export function ModuleDecisions() {
  const modules = useUI((s) => s.view?.options.modules);
  if (!modules?.length) return null;
  return (
    <>
      {modules.includes('guilds') && (
        <ErrorBoundary name="venture-decision">
          <VentureDecision />
        </ErrorBoundary>
      )}
      {modules.includes('guilds') && (
        <ErrorBoundary name="hand-pick">
          <HandPickDecision />
        </ErrorBoundary>
      )}
      {(modules.includes('guilds') || modules.includes('sea')) && (
        <ErrorBoundary name="supply-pick">
          <SupplyPick />
        </ErrorBoundary>
      )}
      {modules.includes('almanac') && (
        <ErrorBoundary name="almanac-decision">
          <AlmanacDecision />
        </ErrorBoundary>
      )}
      {modules.includes('caravans') && (
        <ErrorBoundary name="caravans-auction">
          <CaravansAuction />
        </ErrorBoundary>
      )}
      {modules.includes('fisheries') && (
        <ErrorBoundary name="fish-swap">
          <FishSwap />
        </ErrorBoundary>
      )}
      {modules.includes('invasion') && (
        <ErrorBoundary name="muster-decision">
          <MusterDecision />
        </ErrorBoundary>
      )}
    </>
  );
}

/** What the expansions report rather than ask (where the wagon went): a line under the decisions that goes by itself. */
export function ModuleNews() {
  const caravans = useUI((s) => !!s.view?.ext.caravans);
  return caravans ? (
    <ErrorBoundary name="wagon-news">
      <WagonNews />
    </ErrorBoundary>
  ) : null;
}
