// The interface's motion, in one place: every dialog, panel, toast, tab and list moves on one of
// these, so the whole of it feels like one thing. (The CSS has the same easings and durations as
// variables on :root, see ui.css: --ease-out, --ease-in, --ease-in-out, --dur-press, --dur-fast,
// --dur-base.)
//
// - Entrances ease out (quick, then settling); exits ease in (going, then gone), and are quicker.
// - Springs never overshoot in the game's interface (bounce 0).

/** Entrances and hover: a quick start that settles. */
export const EASE_OUT = [0.22, 1, 0.36, 1] as const;
/** Exits: away slowly, then gone. */
export const EASE_IN = [0.4, 0, 1, 1] as const;

/** Toasts, popovers, list items, pills and tabs. */
export const SPRING_UI = { type: 'spring', duration: 0.35, bounce: 0 } as const;
/** Dialogs, docks, menu pages and the HUD's regions. */
export const SPRING_PANEL = { type: 'spring', duration: 0.45, bounce: 0 } as const;
/** A thing growing into another (a menu card into its page), and the hand closing up. */
export const SPRING_MORPH = { type: 'spring', duration: 0.5, bounce: 0 } as const;

/** A small thing leaving, and a panel or dialog leaving. */
export const EXIT = { duration: 0.15, ease: EASE_IN } as const;
export const EXIT_PANEL = { duration: 0.2, ease: EASE_IN } as const;
/** A fade with no movement in it. */
export const FADE = { duration: 0.25, ease: EASE_OUT } as const;

/** What a panel's content does as it changes (a tab, a page): in from a little below, out a little above. */
export const PAGE_IN = { initial: { opacity: 0, y: 6 }, animate: { opacity: 1, y: 0, transition: SPRING_UI }, exit: { opacity: 0, y: -4, transition: EXIT } } as const;
