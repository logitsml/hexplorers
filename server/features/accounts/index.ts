// Accounts: a guest upgraded, keeping its id (so its games, and later its ratings, carry over).
// Passkeys work on any server; Google, Apple, Discord and email sign-in each turn on once their
// keys are set. The services learn to identify an account's session token beside a guest's (with
// its handle and whether it talks in quick talk only), and every finished game is
// recorded a row per person for the profiles and "recent sailors".

import type { Feature } from '..';
import { configuredProviders } from '../../lib/oauth';
import { isConfigured as emailOn } from '../../lib/email';
import { ACCOUNT_SCHEMA, SESSION_PREFIX, aliasesOf, identifySession } from './core';
import { AUTH_ROUTES } from './auth';
import { ME_ROUTES, recordPlays } from './me';

export { ACCOUNT_HOOKS } from './core';

export const accounts: Feature = {
  id: 'accounts',
  schema: ACCOUNT_SCHEMA,
  routes: [...AUTH_ROUTES, ...ME_ROUTES],
  flags(env) {
    const on = configuredProviders(env);
    return { passkeys: true, google: on.includes('google'), apple: on.includes('apple'), discord: on.includes('discord'), email: emailOn(env) };
  },
  extend(services, deps) {
    const guestIdentify = services.identify.bind(services);
    services.identify = async (token) => {
      if (typeof token === 'string' && token.startsWith(`${SESSION_PREFIX}.`)) return identifySession(deps, token);
      return guestIdentify(token);
    };
    services.aliases = (user) => aliasesOf(deps.db, user);
    recordPlays(services, deps);
  },
};
