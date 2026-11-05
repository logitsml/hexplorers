// The installable app's interface, for the rest of it: the Home Screen sheet (on demand, loaded
// when first shown) and the update note (which puts itself up, see app/pwa/register.ts). The logic
// is in app/pwa.

import { lazy } from 'react';
import type { CoachReason, CoachResult } from './HomeScreenCoaching';

export type { CoachReason, CoachResult };

/**
 * Put up the Home Screen sheet (iOS's Share → Add to Home Screen, with drawings) over whatever is
 * on screen: for a push card when pushNeedsHomeScreen(). Resolves
 * with how it was closed ('later': worth offering again, say after the next turn).
 */
export function showHomeScreenCoaching(reason: CoachReason = 'push'): Promise<CoachResult> {
  return import('./layer').then((m) => m.openCoaching(reason));
}

/** The sheet as a component, loaded on demand, for a page that places it itself (inside Suspense and an AnimatePresence). */
export const HomeScreenCoaching = lazy(() => import('./HomeScreenCoaching').then((m) => ({ default: m.HomeScreenCoaching })));
