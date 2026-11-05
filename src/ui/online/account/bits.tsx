// What the account, friends and safety parts share: a sheet over the page (a parchment card on a
// veil, as the QR card is: Escape or a tap outside closes it), a person's face in their colour,
// and times in words.

import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'motion/react';
import { sfx } from '../../../audio/sfx';
import type { PlayerColor } from '../../../engine';
import { PLAYER_PALETTE } from '../../../render/board/pieces';
import { AvatarFace } from '../../Avatar';
import './account.css';

export const press = () => (sfx.unlock(), sfx.play('click'));

/** A colour as the table shows it: a preset's id, or #rrggbb. */
export const paint = (c?: string) => (c && PLAYER_PALETTE[c as PlayerColor]?.ui) || (c && /^#[0-9a-f]{6}$/i.test(c) ? c : '#8a7a62');

export function Face({ avatar, name, color, big }: { avatar?: number; name: string; color?: string; big?: boolean }) {
  const known = color && PLAYER_PALETTE[color as PlayerColor] ? (color as PlayerColor) : 'red';
  return (
    <span className={`acct-face${big ? ' big' : ''}`} style={{ ['--pc' as string]: paint(color) }}>
      <AvatarFace code={avatar ?? -1} name={name || '?'} color={known} />
    </span>
  );
}

/**
 * A sheet over everything: the card, its title for screen readers, and the ways to close it. It
 * goes on the document's own body, so the veil covers the whole window rather than the page it
 * was opened from (that page moves and frosts, which would pin a fixed veil to it), and the veil
 * comes in by its colour, never its opacity, so the card's frosted glass blurs what's behind it.
 */
export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const card = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const was = document.activeElement as HTMLElement | null;
    card.current?.focus({ preventScroll: true });
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // (Only the sheet: not the menu page or the harbour behind it too.)
      e.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener('keydown', esc, true);
    return () => {
      window.removeEventListener('keydown', esc, true);
      was?.focus?.({ preventScroll: true });
    };
  }, [onClose]);
  return createPortal(
    <motion.div className="acct-veil" onClick={onClose} initial={{ backgroundColor: 'rgba(20, 12, 4, 0)' }} animate={{ backgroundColor: 'rgba(20, 12, 4, 0.55)' }} exit={{ backgroundColor: 'rgba(20, 12, 4, 0)', transition: { duration: 0.15 } }}>
      <motion.div
        ref={card}
        tabIndex={-1}
        className="acct-sheet parchment"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        initial={{ opacity: 0, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.97, transition: { duration: 0.15 } }}
      >
        {children}
      </motion.div>
    </motion.div>,
    document.body,
  );
}

/** "just now", "5 min ago", "3 h ago", "2 days ago", then the date. */
export function ago(at: number | null | undefined, now = Date.now()): string {
  if (!at) return 'a while ago';
  const s = Math.max(0, (now - at) / 1000);
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 36 * 3600) return `${Math.round(s / 3600)} h ago`;
  if (s < 14 * 86400) return `${Math.round(s / 86400)} days ago`;
  return day(at);
}

export const day = (at: number) => new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
