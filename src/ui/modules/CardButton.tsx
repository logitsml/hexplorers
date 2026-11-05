// A card kind as a button, for the decisions answered with a kind of card (a happening's take or
// gift, a supply pick). Apart from shared.tsx since it borrows the HUD's ReasonButton.

import type { Card } from '../../engine';
import { CARD_ICON, CARD_NAMES, asset } from '../../game/names';
import { ReasonButton } from '../Hud';

/**
 * A card kind as a button: its icon, its name, and how many you have (`n`) or have chosen
 * (`chosen`, a pick of several). Disabled with a reason, as the HUD's buttons are.
 */
export function CardButton({ card, n, chosen = 0, reason, onClick }: { card: Card; n?: number; chosen?: number; reason: string | null; onClick: () => void }) {
  return (
    <ReasonButton className={`btn small ghost card-btn${chosen ? ' on' : ''}`} reason={reason} onClick={onClick} aria-label={`${CARD_NAMES[card]}${n !== undefined ? `, you have ${n}` : ''}${chosen ? `, ${chosen} chosen` : ''}`}>
      <img src={asset(CARD_ICON[card])} alt="" draggable={false} />
      <span className="card-btn-name">{CARD_NAMES[card]}</span>
      {n !== undefined && <small>{n}</small>}
      {chosen > 0 && <b className="card-btn-n">×{chosen}</b>}
    </ReasonButton>
  );
}
