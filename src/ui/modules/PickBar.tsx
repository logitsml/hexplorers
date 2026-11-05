// On a phone, while a pick is on the board (a hex for the trader, an edge for a wagon): a strip in
// the dock that says what is asked and puts the pick away, in place of the panels that would cover
// the board it is made on (ui.css hides those while the strip shows). The panels come back the
// moment the pick ends, by a choice made or by Cancel.

import { useUI } from '../../game/store';
import { ModuleChoices } from '../ModuleControls';
import { stagedAsk, stagedStep } from '../../game/moduleActions';
import { SPOT_WORDS, endPick } from './shared';
import { CloseIcon } from '../LineIcons';

export function PickBar() {
  const it = useUI((s) => s.interaction);
  const choice = useUI((s) => s.choice);
  const step = it.kind === 'pick' && it.chosen ? stagedStep(it.actions, it.chosen) : null;
  if (it.kind !== 'pick') return null;
  const asks = step ? stagedAsk(it.actions[0].type, step) : choice ? 'several moves here: choose one below' : it.source ? `choose ${it.actions[0]?.type === 'sea/moveShip' ? 'a ship' : 'a warden'} on the board` : `choose ${SPOT_WORDS[it.target]} on the board`;
  return (
    <div className="pickbar parchment" data-hud-obstacle="pick" role="group" aria-label={`${it.label}: ${asks}`}>
      <div className="pickbar-text">
        <span className="pickbar-label">{it.label}</span>
        <span className="pickbar-asks">{asks}</span>
      </div>
      <button type="button" className="btn small ghost" onClick={endPick}>
        <CloseIcon size={14} />
        Cancel
      </button>
      {choice && <ModuleChoices />}
    </div>
  );
}
