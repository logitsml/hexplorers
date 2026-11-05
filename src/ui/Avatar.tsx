import { AVATARS, asset } from '../game/names';
import { PLAYER_PALETTE, isPaleColor } from '../render/board/pieces';
import type { PlayerColor } from '../engine';
import { sfx } from '../audio/sfx';
import { LineIcon } from './LineIcons';

/**
 * Avatar codes, as stored with a game: 0 and up are the painted portraits (each one a bot's
 * face, so a player who takes one plays without that bot), -1 is the player's initial, and -2
 * down are the drawn crests.
 */
const CRESTS: { name: string; path: string }[] = [
  { name: 'Compass', path: 'M12 1.5 14.2 9.8 22.5 12l-8.3 2.2L12 22.5l-2.2-8.3L1.5 12l8.3-2.2zM12 9.6a2.4 2.4 0 1 0 0 4.8 2.4 2.4 0 0 0 0-4.8z' },
  { name: 'Anchor', path: 'M12 2.2a2.6 2.6 0 0 1 1.1 5V9h3.4v2.1h-3.4v8.6c2.5-.4 4.4-2 5.1-4.2l-1.9-.6 3.9-2.6.9 4.5-1.5-.5C18.6 19.7 15.6 22 12 22s-6.6-2.3-7.6-5.7l-1.5.5.9-4.5 3.9 2.6-1.9.6c.7 2.2 2.6 3.8 5.1 4.2v-8.6H7.5V9h3.4V7.2a2.6 2.6 0 0 1 1.1-5zm0 1.9a.8.8 0 1 0 0 1.6.8.8 0 0 0 0-1.6z' },
  { name: 'Sail', path: 'M11 2.5v14H4.5zm2 2.2c3.9 2.6 6.2 6.6 6.2 11.8H13zM3 18.5h18l-2.2 3.2H5.2z' },
  { name: 'Peak', path: 'M2 20.5 9.2 7.6l3.4 5.9 2.3-3.7 7.1 10.7zm7.2-9.5-1.6 2.9 1.6-.8 1.5.9z' },
];

const crestCode = (i: number) => -2 - i;

/** Every avatar a player can choose, in the title screen's order. */
export const AVATAR_CHOICES: number[] = [-1, ...AVATARS.map((_, i) => i), ...CRESTS.map((_, i) => crestCode(i))];

export function avatarName(code: number) {
  if (code >= 0) return `Portrait ${code + 1}`;
  if (code === -1) return 'Initial';
  return CRESTS[-2 - code]?.name ?? 'Initial';
}

/** A round face for a player: portrait, crest or initial, on their colour. Fills its container. */
export function AvatarFace({ code, name, color }: { code: number; name: string; color: PlayerColor }) {
  const crest = code <= -2 ? CRESTS[-2 - code] : undefined;
  return (
    <span className={`face${isPaleColor(color) ? ' pale' : ''}`} style={{ ['--pc' as string]: PLAYER_PALETTE[color].ui }} aria-hidden>
      {code >= 0 && AVATARS[code] ? (
        <img src={asset(AVATARS[code])} alt="" draggable={false} />
      ) : crest ? (
        <svg viewBox="0 0 24 24">
          <path d={crest.path} fillRule="evenodd" />
        </svg>
      ) : (
        initial(name)
      )}
    </span>
  );
}

/**
 * Who you'll sail as, on the Singleplayer and Multiplayer pages: your face and name, the whole row
 * a way to the Profile page to change them.
 */
export function SailingAs({ name, color, avatar, onChange }: { name: string; color: PlayerColor; avatar: number; onChange: () => void }) {
  const shown = name.trim() || 'You';
  return (
    <button type="button" className="sailing-as" onClick={() => (sfx.unlock(), sfx.play('click'), onChange())} style={{ ['--pc' as string]: PLAYER_PALETTE[color]?.ui ?? color }}>
      <span className="sailing-as-face">
        <AvatarFace code={avatar} name={shown} color={color} />
      </span>
      <span className="sailing-as-text">
        <small>Sailing as</small>
        <b>{shown}</b>
      </span>
      <span className="sailing-as-go">
        Change
        <LineIcon name="next" size={16} />
      </span>
    </button>
  );
}

const graphemes = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;

/** A name's first character as the reader sees it: a whole emoji, not half of its surrogate pair. */
function initial(name: string) {
  const s = name.trim();
  const first = graphemes ? graphemes.segment(s)[Symbol.iterator]().next().value?.segment : Array.from(s)[0];
  return (first ?? '?').toUpperCase();
}
