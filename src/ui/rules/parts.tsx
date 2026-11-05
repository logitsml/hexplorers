// The pieces the rules pages are built from: costs drawn as cards, sections, links between pages,
// and the notes on how two expansions meet (shown only for the expansions in play, or all of them
// from the title, each with its partners named).

import { createContext, useContext, type ReactNode } from 'react';
import { CARDS, type Card } from '../../engine';
import type { Expansion } from '../../engine/presets';
import { CARD_ICON, CARD_NAMES, TOKEN_ICON, asset, type UiIconName } from '../../game/names';
import { Icon } from '../Cards';
import { LineIcon, type LineIconName } from '../LineIcons';
import { applies, nameOf, type RulesCtx } from './context';

/** A page of the Expansions tab: its contents, the mix as a whole, or one expansion. */
export type RulesPage = 'contents' | 'mix' | Expansion;

/** Moving between pages (a link in a page's text, or the contents list). */
export const RulesNav = createContext<{ go: (page: RulesPage) => void; ctx: RulesCtx } | null>(null);

export function useRules() {
  const nav = useContext(RulesNav);
  if (!nav) throw new Error('A rules page is outside the Expansions tab.');
  return nav;
}

/** A cost as pictures (two wheat show twice), commodities and oil included. */
export function CostIcons({ cost }: { cost: Partial<Record<Card, number>> }) {
  return (
    <span className="cost-icons">
      {CARDS.flatMap((r) => Array.from({ length: cost[r] ?? 0 }, (_, i) => <img key={`${r}${i}`} src={asset(CARD_ICON[r])} alt={CARD_NAMES[r]} draggable={false} />))}
    </span>
  );
}

/** One card's picture inline with the text, named for screen readers. */
export function CardIcon({ card }: { card: Card }) {
  return <img className="rules-card" src={asset(CARD_ICON[card])} alt={CARD_NAMES[card]} draggable={false} />;
}

/** A link to another page, inline in the text. */
export function Go({ to, children }: { to: RulesPage; children?: ReactNode }) {
  const { go } = useRules();
  return (
    <button type="button" className="rules-link" onClick={() => go(to)}>
      {children ?? (to === 'contents' ? 'Contents' : to === 'mix' ? 'This game' : nameOf(to))}
    </button>
  );
}

/**
 * A page's head: its name (which takes the focus when the page opens), what it adds in a line or
 * two, and whether it's in this game.
 */
const IN_PLAY = 'In this game';

export function PageHead({ title, lead, tags = [] }: { title: string; lead: ReactNode; tags?: string[] }) {
  return (
    <header className="rules-head">
      <h4 className="rules-title" data-page-title tabIndex={-1}>
        {title}
      </h4>
      {tags.length > 0 && (
        <p className="rules-tags">
          {/* (In play is the dark tag, whatever else is tagged: the target stays light either way.) */}
          {tags.map((t) => (
            <span key={t} className={t === IN_PLAY ? 'on' : undefined}>
              {t}
            </span>
          ))}
        </p>
      )}
      <p className="rules-lead">{lead}</p>
    </header>
  );
}

/** The head of an expansion's page, tagged when it's in play. */
export function ExpansionHead({ id, lead, target }: { id: Expansion; lead: ReactNode; target?: string }) {
  const { ctx } = useRules();
  const tags = [...(ctx.inPlay.includes(id) ? [IN_PLAY] : []), ...(target ? [target] : [])];
  return <PageHead title={nameOf(id)} lead={lead} tags={tags} />;
}

/**
 * A section of a page, its title optionally pictured, and `art` hung in the page's margin beside it
 * (a Painting, an Emblem or a MapGlyph), like the marginalia of an old manual: on a phone it shrinks
 * to a thumbnail at the end of the title. The text keeps to its own column either way, so its lines
 * stay a comfortable length.
 */
export function Sec({ title, icon, art, children }: { title: string; icon?: UiIconName; art?: ReactNode; children: ReactNode }) {
  return (
    <section className={`rules-sec${art ? ' has-art' : ''}`}>
      {art && (
        <figure className="rules-art" aria-hidden>
          {art}
        </figure>
      )}
      <div className="rules-sec-body">
        <h5>
          {icon && <Icon name={icon} size={24} />} {title}
        </h5>
        {children}
      </div>
    </section>
  );
}

/** One of the game's paintings (a card, an award, a happening) for the margin, framed like a card. */
export function Painting({ src, square = false }: { src: string; square?: boolean }) {
  return <img className={`rules-painting${square ? ' square' : ''}`} src={asset(src)} alt="" draggable={false} />;
}

/** Painted icons for the margin (a token, a resource), on a coloured disc when `disc` is given. */
export function Emblem({ src, disc }: { src: string | string[]; disc?: string }) {
  const all = Array.isArray(src) ? src : [src];
  return (
    <span className={`rules-emblem n${all.length}`} style={disc ? { background: disc } : undefined}>
      {all.map((s) => (
        <img key={s} src={asset(s)} alt="" draggable={false} />
      ))}
    </span>
  );
}

/** One of the flat map's pictograms (ui/flatArt.tsx draws them in a 100-unit box) for the margin. */
export function MapGlyph({ children, box = '0 0 100 100' }: { children: ReactNode; box?: string }) {
  return (
    <svg className="rules-glyph" viewBox={box} aria-hidden>
      {children}
    </svg>
  );
}

/** A row of the costs table: the piece, what it takes, and its rule. */
export function CostRow({ name, icon, cost, children }: { name: string; icon?: UiIconName; cost?: Partial<Record<Card, number>>; children: ReactNode }) {
  return (
    <tr>
      <th scope="row">
        {icon && <Icon name={icon} size={26} />} {name}
      </th>
      <td>{cost ? <CostIcons cost={cost} /> : <span className="rules-free">—</span>}</td>
      <td>{children}</td>
    </tr>
  );
}

export function Costs({ children }: { children: ReactNode }) {
  return (
    <table className="costs">
      <tbody>{children}</tbody>
    </table>
  );
}

/** The points an expansion adds, as the base page's chips. */
export function Points({ items }: { items: { label: string; points: string; icon?: UiIconName }[] }) {
  return (
    <ul className="points">
      {items.map((it) => (
        <li key={it.label}>
          {it.icon && <Icon name={it.icon} size={26} />} {it.label} <b>{it.points}</b>
        </li>
      ))}
    </ul>
  );
}

/** A numbered step of the turn, pictured as the base page's are. */
export function Step({ icon, line, title, children }: { icon?: UiIconName; line?: LineIconName; title: string; children: ReactNode }) {
  return (
    <li>
      {icon ? <Icon name={icon} size={30} /> : <LineIcon name={line ?? 'turn'} size={28} />}
      <div>
        <b>{title}</b> {children}
      </div>
    </li>
  );
}

export function Steps({ children }: { children: ReactNode }) {
  return <ol className="steps">{children}</ol>;
}

/** Edge cases and reminders, as a short list. */
export function Bullets({ children }: { children: ReactNode }) {
  return <ul className="rules-bullets">{children}</ul>;
}

/** A note on how this expansion meets others: `with` names the others it needs in play. */
export interface Meet {
  with: Expansion[];
  body: ReactNode;
}

/**
 * How the page's expansion meets the others. In a game only the notes whose partners are all in play
 * are shown, open; from the title every note is listed under its partners' names, folded away.
 */
export function Together({ notes }: { notes: Meet[] }) {
  const { ctx } = useRules();
  const shown = notes.filter((n) => applies(ctx, ...n.with));
  if (!shown.length) return null;
  const list = (
    <ul className="rules-meets">
      {shown.map((n, i) => (
        <li key={i}>
          <span className="rules-with">
            {n.with.map((e) => (
              <Go key={e} to={e} />
            ))}
          </span>
          <div>{n.body}</div>
        </li>
      ))}
    </ul>
  );
  if (ctx.inGame)
    return (
      <Sec title="Alongside the others in this game">
        {list}
      </Sec>
    );
  return (
    <details className="rules-more">
      <summary>With other expansions ({shown.length})</summary>
      {list}
    </details>
  );
}

/**
 * The expansions' pieces as small pictograms for the cost table (the base pieces have painted icons):
 * drawn in code in the flat map's hand, flat fills under a dark ink edge.
 */
export function Pictogram({ kind }: { kind: 'ship' | 'bridge' | 'wall' | 'foundry' | 'mend' | 'warden' }) {
  if (kind === 'warden') return <img className="rules-pictogram" src={asset(TOKEN_ICON.warden)} alt="" draggable={false} />;
  const ink = '#2b2118';
  return (
    <svg className="rules-pictogram" viewBox="0 0 26 26" aria-hidden strokeLinejoin="round" strokeLinecap="round">
      {kind === 'ship' && (
        <>
          <path d="M3 21 q10 3 20 0" fill="none" stroke="#3a93bf" strokeWidth="1.6" />
          <path d="M3 15.5 H23 L20 20 H6 Z" fill="#7a5432" stroke={ink} strokeWidth="1.1" />
          <path d="M13 15.5 V3.5" stroke={ink} strokeWidth="1.3" />
          <path d="M13.6 4.5 L21 13.5 H13.6 Z" fill="#efe4c8" stroke={ink} strokeWidth="1.1" />
          <path d="M12.4 6 L6.5 13.5 H12.4 Z" fill="#d8ccb0" stroke={ink} strokeWidth="1.1" />
        </>
      )}
      {kind === 'bridge' && (
        <>
          <path d="M2 22 q3 -1.5 6 0 t6 0 t6 0 t6 0" fill="none" stroke="#3a93bf" strokeWidth="1.6" />
          <path d="M2 11 H24 V15 H22 Q13 8 4 15 H2 Z" fill="#a39a8c" stroke={ink} strokeWidth="1.1" />
          <path d="M2 11 H24" stroke="#6f675c" strokeWidth="2.4" />
          <path d="M4 15 V21 M22 15 V21" stroke="#6f675c" strokeWidth="2.4" />
        </>
      )}
      {kind === 'wall' && (
        <>
          <path d="M3 22 V10 H6 V7 H9 V10 H11.5 V7 H14.5 V10 H17 V7 H20 V10 H23 V22 Z" fill="#b3aa9c" stroke={ink} strokeWidth="1.1" />
          <path d="M3 14 H23 M3 18 H23 M8 10 V14 M14 14 V18 M19 10 V14 M9 18 V22 M18 18 V22" stroke="#7d756a" strokeWidth="0.9" />
        </>
      )}
      {kind === 'foundry' && (
        <>
          <circle cx="20" cy="3.6" r="2.2" fill="#9a958e" opacity="0.8" />
          <path d="M17.5 22 V6 H22 V22 Z" fill="#3a3532" stroke={ink} strokeWidth="1.1" />
          <path d="M3 22 V13 L10 9 L17.5 13 V22 Z" fill="#8d6a4a" stroke={ink} strokeWidth="1.1" />
          <rect x="7.5" y="15" width="5" height="4.5" rx="0.8" fill="#f2a33a" stroke={ink} strokeWidth="0.9" />
        </>
      )}
      {kind === 'mend' && (
        <>
          <path d="M3 21 L10.5 15.5 M14.5 12.5 L23 6" stroke={ink} strokeWidth="5.4" />
          <path d="M3 21 L10.5 15.5 M14.5 12.5 L23 6" stroke="#c9a46a" strokeWidth="3.4" />
          <path d="M10 11 L13.5 13 L11 15.5 L14.6 18" fill="none" stroke={ink} strokeWidth="1.2" />
        </>
      )}
    </svg>
  );
}