// How to play: the base rules, a page for each expansion (the ones in play first: see rules/), the
// controls, and About (the credits, the license and the source), on four tabs. Loaded on demand (see Modals.tsx).

import { useMemo, useState, type ReactNode } from 'react';
import { COSTS, type Card } from '../engine';
import { useUI } from '../game/store';
import { keyLabel, keysOf, type BindAction, type DragJob } from '../game/bindings';
import { Icon } from './Cards';
import { Gesture } from './Compact';
import { LineIcon } from './LineIcons';
import { isTouch } from './useCompact';
import { Modal, TabPanel, Tabs, closeBack } from './ModalFrame';
import { nameOf, rulesCtx, type RulesCtx } from './rules/context';
import { CostIcons, Pictogram, type RulesPage } from './rules/parts';
import { ExpansionsTab } from './rules/Expansions';
import { LICENSE_URL, NOTICES_URL, SOURCE_URL, lastRules, type RulesTab } from './rules/where';
import type { Expansion } from '../engine/presets';
import { SHIP_COST } from '../engine/modules/sea/rules';
import { BRIDGE_COST } from '../engine/modules/rivers/queries';
import { RECRUIT_COST, WALL_COST } from '../engine/modules/garrisons/actions';
import { FOUNDRY_COST } from '../engine/modules/oil/rules';
import { REPAIR_COST } from '../engine/modules/almanac/happenings';

/**
 * What the expansions in play change on the base Rules tab: the base pieces they take out of the
 * game (shown dimmed, with what stands in their place), and their own pieces, which join the cost
 * table as rows tagged with the expansion they come from. Nothing changes from the title or in a
 * base game. (As the engine plays it: ventures or the muster deck replace the development cards,
 * and Biggest Army goes with the knights; Invasion takes the robber off the board for good.)
 */
function baseChanges(ctx: RulesCtx) {
  const on = (e: Expansion) => ctx.inGame && ctx.inPlay.includes(e);
  const devFor: Expansion | null = on('guilds') ? 'guilds' : on('invasion') ? 'invasion' : null;
  const rows: { name: string; kind: Parameters<typeof Pictogram>[0]['kind']; cost: Partial<Record<Card, number>>; from: Expansion; text: string }[] = [
    ...(on('sea') ? [{ name: 'Ship', kind: 'ship' as const, cost: SHIP_COST, from: 'sea' as const, text: 'On an edge beside the sea, joined to your own ship or building.' }] : []),
    ...(on('rivers') ? [{ name: 'Bridge', kind: 'bridge' as const, cost: BRIDGE_COST, from: 'rivers' as const, text: 'On a river crossing joined to your road or building; it counts as a road.' }] : []),
    ...(on('guilds') ? [{ name: 'Warden', kind: 'warden' as const, cost: RECRUIT_COST, from: 'guilds' as const, text: on('invasion') ? 'Recruited at the castle, to march on the raiders.' : 'Recruited beside your routes, to guard and drive off.' }] : []),
    ...(on('guilds') ? [{ name: 'Town wall', kind: 'wall' as const, cost: WALL_COST, from: 'guilds' as const, text: 'Under one of your towns: hold 2 more cards on a 7.' }] : []),
    ...(on('oil') ? [{ name: 'Foundry', kind: 'foundry' as const, cost: FOUNDRY_COST, from: 'oil' as const, text: 'Under one of your towns: a point more, and more from its tiles.' }] : []),
    ...(on('almanac') ? [{ name: 'Mend a road', kind: 'mend' as const, cost: REPAIR_COST, from: 'almanac' as const, text: 'Repairs a road the Almanac cracked, so you may build routes again.' }] : []),
  ];
  return {
    // The development cards' stand-in, if anything replaces them, and its name.
    dev: devFor ? { to: devFor, as: devFor === 'guilds' ? 'Ventures' : 'Muster cards' } : null,
    robber: on('invasion') ? ('gone' as const) : on('guilds') || on('fisheries') || on('oil') || on('caravans') ? ('held' as const) : null,
    corsair: on('sea') && !!ctx.knobs.corsairStays,
    rows,
  };
}

/** A base rule the mix sets aside or replaces: a tag saying what instead, linking to its page. */
function Instead({ to, children, open }: { to?: RulesPage; children: ReactNode; open: (p: RulesPage) => void }) {
  if (!to) return <span className="rules-instead">{children}</span>;
  return (
    <button type="button" className="rules-instead" onClick={() => open(to)}>
      {children}
    </button>
  );
}

export function RulesModal() {
  const view = useUI((s) => s.view);
  const inGame = useUI((s) => s.screen === 'game');
  const binds = useUI((s) => s.settings.keys);
  const mouse = useUI((s) => s.settings.mouse);
  // (The pages read the game as it was when opened: what's in play doesn't change mid-game.)
  const ctx = useMemo(() => rulesCtx(view, inGame), [view?.options, inGame]);
  // (Where it was left, as Settings keeps its tab: the tab, and the Expansions tab's page.)
  const [tab, setTabState] = useState<RulesTab>(lastRules.tab);
  const [page, setPageState] = useState<RulesPage>(lastRules.page);
  const setTab = (t: RulesTab) => {
    lastRules.tab = t;
    setTabState(t);
  };
  const setPage = (p: RulesPage) => {
    lastRules.page = p;
    setPageState(p);
  };
  const openPage = (p: RulesPage) => {
    setPage(p);
    setTab('expansions');
  };
  // Escape steps back to the contents from a page before it closes the dialog.
  const onClose = () => (tab === 'expansions' && page !== 'contents' ? setPage('contents') : closeBack());
  const changes = baseChanges(ctx);
  const touch = isTouch();
  const mixNames = ctx.inPlay.length ? (ctx.preset ? `the ${ctx.preset} mix` : ctx.inPlay.length === 1 ? 'an expansion' : `${ctx.inPlay.length} expansions`) : null;
  const touchControls = (
    <dl className="controls-list">
      <dt><Gesture kind="pan" /> One finger</dt><dd>Drag the map around</dd>
      <dt><Gesture kind="pinch" /> Pinch · twist</dt><dd>Zoom · turn the island</dd>
      <dt><Gesture kind="tilt" /> Two fingers</dt><dd>Drag up or down to tilt, sideways to turn</dd>
      <dt><Gesture kind="hold" /> Press and hold</dt><dd>A tile's details</dd>
      <dt><LineIcon name="hand" size={30} /> Tap a glowing spot</dt><dd>Preview the piece there; tap it again (or Build here) to place it</dd>
    </dl>
  );
  // (The keys and buttons as the player has them: game/bindings.ts, Settings, Controls.)
  const K = ({ a }: { a: BindAction }) => <kbd>{keyLabel(keysOf(a, binds)[0] ?? '')}</kbd>;
  const drags = (job: DragJob) => (['left', 'middle', 'right'] as const).filter((b) => mouse[b] === job);
  const dragName = (bs: readonly string[]) => (bs.length ? bs.map((b, i) => (i ? b : b[0].toUpperCase() + b.slice(1))).join(' or ') + '-drag' : null);
  const panDrag = dragName(drags('pan'));
  const turnDrag = dragName(drags('turn'));
  const pointerControls = (
    <>
      <dl className="controls-list">
        {panDrag && <><dt><LineIcon name="mouse" size={30} /> {panDrag}</dt><dd>Move the map</dd></>}
        {turnDrag && <><dt><LineIcon name="mouse" size={30} /> {turnDrag}</dt><dd>Turn and tilt the island</dd></>}
        <dt><LineIcon name="mouse" size={30} /> Scroll</dt><dd>Zoom towards the pointer</dd>
      </dl>
      <dl className="keys-list">
        <dt><K a="roll" /></dt><dd>Roll the dice</dd>
        <dt><K a="road" /> <K a="house" /> <K a="town" /> <K a="card" /></dt><dd>Build a road, house or town; buy a development card</dd>
        <dt><kbd>←</kbd> <kbd>↑</kbd> <kbd>→</kbd> <kbd>↓</kbd> <kbd>Enter</kbd></dt><dd>Choose a spot while placing, then place</dd>
        <dt><K a="trade" /> <K a="supply" /></dt><dd>Offer a trade · trade with the supply</dd>
        <dt><K a="endTurn" /></dt><dd>End your turn</dd>
        <dt><kbd>Esc</kbd></dt><dd>Cancel placing · close a dialog</dd>
        <dt><kbd>Ctrl</kbd> <kbd>Z</kbd></dt><dd>Take back your last move</dd>
        <dt><K a="panUp" /><K a="panLeft" /><K a="panDown" /><K a="panRight" /> <K a="turnLeft" /><K a="turnRight" /> <K a="tiltUp" /><K a="tiltDown" /></dt><dd>Move, turn and tilt the view</dd>
        <dt><K a="flat" /></dt><dd>Switch between the 3D island and the flat 2D map</dd>
        <dt><K a="home" /> <K a="mute" /> <kbd>?</kbd></dt><dd>Reset the view · mute · these rules</dd>
      </dl>
      <p className="setting-note">Change any of these in Settings, Controls.</p>
    </>
  );
  return (
    <Modal onClose={onClose} width={640}>
      <h3>How to play</h3>
      <Tabs<RulesTab>
        label="How to play"
        idBase="rules"
        value={tab}
        onChange={(t) => {
          setPage('contents');
          setTab(t);
        }}
        items={[
          { id: 'rules', label: 'Rules', icon: 'book' },
          { id: 'expansions', label: 'Expansions', icon: 'compass' },
          { id: 'controls', label: 'Controls', icon: touch ? 'hand' : 'keyboard' },
          { id: 'about', label: 'About', icon: 'info' },
        ]}
      />
      <TabPanel page={tab} idBase="rules" tab={tab} className="rules">
        {tab === 'expansions' ? (
          <ExpansionsTab ctx={ctx} page={page} go={setPage} />
        ) : tab === 'rules' ? (
          <>
            {mixNames && (
              <div className="callout rules-mix">
                <LineIcon name="compass" size={28} />
                <div>
                  <b>This game plays {mixNames}.</b>{' '}
                  <button
                    type="button"
                    className="rules-link"
                    onClick={() => {
                      setTab('expansions');
                      // (The focus goes with it, to the tab it opened, rather than falling to the page.)
                      requestAnimationFrame(() => document.getElementById('rules-tab-expansions')?.focus());
                    }}
                  >
                    Read the expansions
                  </button>
                </div>
              </div>
            )}
            <section>
              <h4>
                <Icon name="vp" size={24} /> First to {ctx.target ?? 10} points wins
              </h4>
              <ul className="points">
                <li><Icon name="settlement" size={26} /> House <b>1</b></li>
                <li><Icon name="city" size={26} /> Town <b>2</b></li>
                <li><Icon name="route" size={26} /> Longest Route <b>2</b></li>
                {changes.dev ? (
                  <>
                    <li className="gone"><Icon name="knight" size={26} /> Biggest Army <b>2</b> <Instead open={openPage}>not in this game</Instead></li>
                    <li className="gone"><Icon name="devcard" size={26} /> Victory Point card <b>1</b> <Instead to={changes.dev.to} open={openPage}>{changes.dev.to === 'guilds' ? '→ victory ventures' : 'not in this game'}</Instead></li>
                  </>
                ) : (
                  <>
                    <li><Icon name="knight" size={26} /> Biggest Army <b>2</b></li>
                    <li><Icon name="devcard" size={26} /> Victory Point card <b>1</b></li>
                  </>
                )}
              </ul>
              <p className="rule-note">The win only counts on your own turn.</p>
            </section>
            <section>
              <h4>
                <Icon name="settlement" size={24} /> The opening
              </h4>
              <p className="rule-note">
                Before the first roll, in turn order and then back again, each player places a house and a road next to it: two houses and two roads each. Your second house collects one card from each tile it touches. Houses must be at least two edges from any building.
              </p>
              <p className="rule-note">
                <b>Land gives cards:</b> hills give brick, forest wood, pasture wool, fields wheat and mountains ore. The desert gives nothing.
              </p>
              <p className="rule-note">
                <b>The number and dots on a tile</b> say which roll pays it. The dots show how often that number comes up (6 and 8 most, 2 and 12 least), so more dots, more cards. A spot's tooltip adds up the dots of the tiles around it.
              </p>
              {/* (Where an expansion changes the robber, "Rolling a 7" below tells it for this game.) */}
              {changes.robber === null && (
                <p className="rule-note">
                  <b>The robber</b> sits on the desert at first. On a 7 nobody collects: anyone holding more than 7 cards discards half, then the roller moves the robber to any other tile and takes a card from someone with a building there. A tile under the robber pays nothing until it moves.
                </p>
              )}
              <p className="rule-note">
                A 1-point house becomes a 2-point town when you build on it; towns pay double.
              </p>
            </section>
            <section>
              <h4>Your turn</h4>
              <ol className="steps">
                <li>
                  <Icon name="dice" size={30} />
                  <div>
                    <b>Roll.</b> Every tile showing the number pays the buildings on its corners: 1 card for a house, 2 for a town.{changes.robber === 'gone' ? '' : " The robber's tile pays nothing."}{changes.dev ? '' : ' You may play one development card before rolling.'}
                  </div>
                </li>
                <li>
                  <Icon name="trade" size={30} />
                  <div>
                    <b>Trade.</b> Swap cards with the other players, or with the supply at 4 for 1: a harbour you've built on gives 3 for 1, or 2 for 1 for its own resource.
                  </div>
                </li>
                <li>
                  <Icon name="settlement" size={30} />
                  <div>
                    <b>Build</b> anything you can pay for, in any order, then end your turn.
                  </div>
                </li>
              </ol>
            </section>
            <section>
              <h4>What things cost</h4>
              <table className="costs">
                <tbody>
                  <tr>
                    <th scope="row"><Icon name="road" size={26} /> Road</th>
                    <td><CostIcons cost={COSTS.road} /></td>
                    <td>Joins your road or building; can't pass through another player's building.</td>
                  </tr>
                  <tr>
                    <th scope="row"><Icon name="settlement" size={26} /> House</th>
                    <td><CostIcons cost={COSTS.settlement} /></td>
                    <td>On your road, at least two edges from any building.</td>
                  </tr>
                  <tr>
                    <th scope="row"><Icon name="city" size={26} /> Town</th>
                    <td><CostIcons cost={COSTS.city} /></td>
                    <td>Replaces one of your houses.</td>
                  </tr>
                  <tr className={changes.dev ? 'gone' : undefined}>
                    <th scope="row"><Icon name="devcard" size={26} /> Development card</th>
                    <td><CostIcons cost={COSTS.devCard} /></td>
                    <td>
                      {changes.dev ? (
                        <Instead to={changes.dev.to} open={openPage}>→ {changes.dev.as}</Instead>
                      ) : (
                        'Play one per turn, not on the turn you buy it (Victory Points need no playing).'
                      )}
                    </td>
                  </tr>
                  {changes.rows.map((r) => (
                    <tr key={r.name} className="from-expansion">
                      <th scope="row">
                        <Pictogram kind={r.kind} /> {r.name}
                      </th>
                      <td><CostIcons cost={r.cost} /></td>
                      <td>
                        {r.text} <Instead to={r.from} open={openPage}>{nameOf(r.from)}</Instead>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
            <section className="callouts">
              <div className="callout warn">
                <span className="callout-num" aria-hidden>7</span>
                <div>
                  <b>Rolling a 7.</b> Anyone holding more than 7 cards discards half, rounded down.{' '}
                  {changes.robber === 'gone' ? (
                    <>
                      This game has no robber: the roller {changes.corsair ? 'moves the corsair and ' : ''}takes a random card from anyone. <Instead to="mix" open={openPage}>→ This game</Instead>
                    </>
                  ) : (
                    <>
                      Then the roller moves the robber to another tile and takes a random card from someone with a building on it.
                      {changes.robber === 'held' && (
                        <>
                          {' '}In this game the robber starts off the board. <Instead to="mix" open={openPage}>→ when it comes in</Instead>
                        </>
                      )}
                    </>
                  )}
                </div>
              </div>
              <div className="callout">
                <Icon name="route" size={30} />
                <div>
                  <b>Longest Route.</b> First to 5 connected roads; taken by anyone with more.
                </div>
              </div>
              <div className={`callout${changes.dev ? ' gone' : ''}`}>
                <Icon name="knight" size={30} />
                <div>
                  <b>Biggest Army.</b> First to 3 knights played; taken by anyone with more.{changes.dev && <> <Instead open={openPage}>Not in this game: there are no knights</Instead></>}
                </div>
              </div>
            </section>
          </>
        ) : tab === 'about' ? (
          <About />
        ) : (
          <>
            <section>
              <h4>{touch ? 'Touch' : 'Mouse and keyboard'}</h4>
              {touch ? touchControls : pointerControls}
            </section>
            <details className="more-controls">
              <summary>{touch ? 'Mouse and keyboard' : 'Touch'}</summary>
              {touch ? pointerControls : touchControls}
            </details>
          </>
        )}
      </TabPanel>
      <div className="footer">
        <button className="btn gold" onClick={closeBack}>
          Done
        </button>
      </div>
    </Modal>
  );
}

/** The About tab: what the game is, its license and source, and the work it builds on (THIRD_PARTY_NOTICES.md). */
function About() {
  return (
    <>
      <section className="about">
        <h4>Hexplorers</h4>
        <p>
          A game of sailing, trading and building on an island, free to play in your browser. Its code,
          art and text are open source under the Apache License 2.0: free to use, change and share, as long as the makers are credited.
        </p>
        <p>
          Made by{' '}
          <a className="rules-link" href="https://x.com/_a9lim" target="_blank" rel="noopener noreferrer">
            @_a9lim
          </a>{' '}
          and{' '}
          <a className="rules-link" href="https://x.com/treetowntree" target="_blank" rel="noopener noreferrer">
            @treetowntree
          </a>
          .
        </p>
        <div className="about-links">
          <a className="btn" href={SOURCE_URL} target="_blank" rel="noopener noreferrer">
            <LineIcon name="link" size={18} /> Source on GitHub
          </a>
          <a className="btn" href={LICENSE_URL} target="_blank" rel="noopener noreferrer">
            <LineIcon name="book" size={18} /> Apache 2.0 license
          </a>
        </div>
      </section>
      <section className="about">
        <h4>Credits</h4>
        <dl className="credits-list">
          <dt>The sea</dt>
          <dd>Tessendorf's FFT ocean, adapted from web-ocean by Maksymilian Dendura (MIT)</dd>
          <dt>The sky</dt>
          <dd>The Preetham daylight model, adapted from three.js's sky (MIT)</dd>
          <dt>Built with</dt>
          <dd>three.js, React, Motion and Zustand (MIT)</dd>
          <dt>Icons</dt>
          <dd>Drawn after Lucide (ISC), and Material Symbols by Google (Apache 2.0)</dd>
          <dt>Type</dt>
          <dd>Fraunces, Google Sans Flex, Alegreya Sans and Lilita One (SIL Open Font License)</dd>
          <dt>Art</dt>
          <dd>Painted with an AI image model</dd>
          <dt>Sound</dt>
          <dd>Synthesised in code, with no recordings</dd>
        </dl>
        <p className="rule-note">
          Each license in full is in the{' '}
          <a className="rules-link" href={NOTICES_URL} target="_blank" rel="noopener noreferrer">
            third-party notices
          </a>
          .
        </p>
      </section>
      <p className="rule-note">Hexplorers is not affiliated with or endorsed by the publisher of any other board game.</p>
    </>
  );
}
