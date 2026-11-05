// The way from an expansion's page to the trade dialog's Supply tab, where what oil, coins and fish
// buy is traded beside the cards (ui/SupplyTrade.tsx). A greyed button says why it can't open now.

import type { ReactNode } from 'react';
import { openModal } from '../../game/commands';
import { legalOf } from '../../game/modulePanels';
import { useUI } from '../../game/store';
import { ReasonButton } from '../Hud';
import { whyNot } from '../why';
import { useWatching } from './shared';
import { LineIcon } from '../LineIcons';

export function ToSupply({ children }: { children: ReactNode }) {
  const view = useUI((s) => s.view);
  const me = useUI((s) => s.me);
  const busy = useUI((s) => s.busy);
  const watching = useWatching();
  // (Fish buy a resource before the roll too: the Supply tab opens then, for that alone.)
  const fishOnRoll = !!view && !busy && !watching && view.phase === 'roll' && view.currentPlayer === me && view.pending.length === 0 && legalOf(view, me, 'fisheries/take').length > 0;
  return (
    <ReasonButton className="btn small ghost to-supply" reason={fishOnRoll ? null : whyNot('bank')} onClick={() => openModal('bank', fishOnRoll)}>
      <LineIcon name="swap" size={16} />
      {children}
    </ReasonButton>
  );
}
