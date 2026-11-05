// The Profile page's body (the menu's card grows into it, as the others' do): the face you sail
// under everywhere, alone and online, large at its top, then your name, colour and picture, and,
// where this build has a harbour server, your online account (keeping your progress, your
// handle, record and devices). A change here is the singleplayer page's too: they share the
// set-up (see App.tsx), and online play comes aboard with it.

import { lazy, Suspense, useEffect, useState } from 'react';
import { sfx } from '../../audio/sfx';
import type { PlayerColor } from '../../engine';
import type { ServerConfig } from '../../net/protocol';
import { fetchConfig } from '../../online/api';
import { PLAYER_PALETTE, PRESET_COLORS } from '../../render/board/pieces';
import { AVATAR_CHOICES, AvatarFace, avatarName } from '../Avatar';
import '../../styles/online.css';

const AccountSection = lazy(() => import('./account/AccountSection'));

export interface ProfileProps {
  name: string;
  onName: (name: string) => void;
  color: PlayerColor;
  onColor: (c: PlayerColor) => void;
  avatar: number;
  onAvatar: (a: number) => void;
  onLeave: () => void;
}

const press = () => (sfx.unlock(), sfx.play('click'));

export default function ProfilePage(p: ProfileProps) {
  const [config, setConfig] = useState<ServerConfig | null>(null);
  useEffect(() => {
    let live = true;
    void fetchConfig().then((r) => live && r.ok && setConfig(r.config));
    return () => {
      live = false;
    };
  }, []);
  const ownColour = p.color.startsWith('#') ? p.color : null;
  const shown = p.name.trim() || 'You';
  return (
    <div className="form profile-form">
      <div className="profile-hero" style={{ ['--pc' as string]: PLAYER_PALETTE[p.color]?.ui ?? p.color }}>
        <span className="profile-face">
          <AvatarFace code={p.avatar} name={shown} color={p.color} />
        </span>
        <span className="profile-who">
          <small>Sailing as</small>
          <b>{shown}</b>
        </span>
      </div>
      <label>
        Your name
        <input type="text" value={p.name} maxLength={18} autoComplete="nickname" onChange={(e) => p.onName(e.target.value)} />
      </label>
      <div className="field" role="group" aria-label="Your picture">
        <span className="field-label">Your picture</span>
        <div className="avatar-choices">
          {AVATAR_CHOICES.map((a) => (
            <button key={a} className={`avatar-choice tip ${p.avatar === a ? 'on' : ''}`} data-tip={avatarName(a)} aria-label={avatarName(a)} aria-pressed={p.avatar === a} onClick={() => (press(), p.onAvatar(a))}>
              <AvatarFace code={a} name={shown} color={p.color} />
            </button>
          ))}
        </div>
      </div>
      <div className="field" role="group" aria-label="Your colour">
        <span className="field-label">Your colour</span>
        <div className="swatches">
          {PRESET_COLORS.map((c) => (
            <button key={c.id} className={`swatch tip ${p.color === c.id ? 'on' : ''}`} data-tip={c.name} style={{ background: PLAYER_PALETTE[c.id].ui }} aria-label={c.name} aria-pressed={p.color === c.id} onClick={() => (press(), p.onColor(c.id))} />
          ))}
          <label className={`swatch custom tip ${ownColour ? 'on' : ''}`} data-tip="Your own colour" style={ownColour ? { background: ownColour } : undefined}>
            <input type="color" aria-label="Your own colour" value={ownColour ?? '#3aa36b'} onChange={(e) => p.onColor(e.target.value as PlayerColor)} />
          </label>
        </div>
      </div>
      <p className="page-note">You sail under this face alone and online.</p>
      {config && (
        <Suspense fallback={null}>
          <AccountSection config={config} name={p.name} color={p.color} avatar={p.avatar} leaveMenu={p.onLeave} />
        </Suspense>
      )}
    </div>
  );
}
