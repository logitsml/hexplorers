// Where How to play opens: the tab and the Expansions tab's page it was left on, for the session.
// (Apart from the dialog, which loads on demand, so the title's About link can choose its tab.)

import type { RulesPage } from './parts';

export type RulesTab = 'rules' | 'expansions' | 'controls' | 'about';

export const lastRules: { tab: RulesTab; page: RulesPage } = { tab: 'rules', page: 'contents' };

/** The game's source and its license, for the About tab. */
export const SOURCE_URL = 'https://github.com/logitsml/hexplorers';
export const LICENSE_URL = `${SOURCE_URL}/blob/main/LICENSE`;
export const NOTICES_URL = `${SOURCE_URL}/blob/main/THIRD_PARTY_NOTICES.md`;
