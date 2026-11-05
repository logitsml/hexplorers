// The Multiplayer page's further sections (friends, notifications, your account), each its own
// lazily loaded component in a folder of its own under src/ui/online, listed once here. The page
// shows a section when the server says its feature is on (`when`), below its two ways aboard (Host
// a room, Join with a code), in this order.

import type { ComponentType } from 'react';
import type { ServerConfig } from '../../net/protocol';

export interface SectionProps {
  config: ServerConfig;
  /** The page's own choices (name, colour, avatar), as the identity reads them. */
  name: string;
  color: string;
  avatar: number;
  /** Close the menu for a room or a game the section opened. */
  leaveMenu: () => void;
}

export interface Section {
  id: string;
  /** Shown when the server has this on (absent: always, once online is available). */
  when?: (config: ServerConfig) => boolean;
  load: () => Promise<{ default: ComponentType<SectionProps> }>;
}

/** Add yours with one line. */
export const SECTIONS: Section[] = [
  { id: 'friends', load: () => import('./friends/FriendsSection') },
  { id: 'notifications', when: (c) => c.features.push && !!c.vapidPublicKey, load: () => import('./notifications/Notifications') },
  { id: 'account', load: () => import('./account/AccountSection') },
];
