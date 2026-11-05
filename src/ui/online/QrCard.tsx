// "Show code": the room's link as a QR code on a parchment card, with the code in big letters
// under it, for a friend at the same table to point their phone's camera at. Drawn as SVG from
// the client's own encoder (src/online/qr.ts), dark on a light quiet zone whatever the theme.

import { useEffect, useMemo, useRef } from 'react';
import { motion } from 'motion/react';
import { encodeQr, qrPath } from '../../online/qr';
import { spacedCode } from '../../online/links';

export function QrCard({ url, code, title, onClose }: { url: string; code: string; title: string; onClose: () => void }) {
  const qr = useMemo(() => {
    try {
      return encodeQr(url);
    } catch {
      return null;
    }
  }, [url]);
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    close.current?.focus({ preventScroll: true });
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', esc, true);
    return () => window.removeEventListener('keydown', esc, true);
  }, [onClose]);
  const side = qr ? qr.size + 8 : 0;
  return (
    <motion.div className="qr-veil" onClick={onClose} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: 0.15 } }}>
      <motion.div
        className="qr-card parchment"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        initial={{ opacity: 0, scale: 0.94 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.15 } }}
      >
        <p className="qr-title">{title}</p>
        {qr ? (
          <svg className="qr" viewBox={`0 0 ${side} ${side}`} shapeRendering="crispEdges" role="img" aria-label="QR code for the room’s link">
            <rect width={side} height={side} fill="#fffaf0" />
            <path d={qrPath(qr)} fill="#2b2118" />
          </svg>
        ) : (
          <p className="page-note">This link is too long for a code: copy it instead.</p>
        )}
        <b className="room-code" aria-label={`Room code ${code.split('').join(' ')}`}>
          {spacedCode(code)}
        </b>
        <button ref={close} className="btn ghost" onClick={onClose}>
          Done
        </button>
      </motion.div>
    </motion.div>
  );
}
