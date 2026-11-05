// Two tabs of one browser are one sailor: the identity lives in the browser's storage. A second
// tab opening a room the first is already aboard would take its seat (and the first would be
// put ashore), which is rarely what someone opening two tabs means. So the tabs in a room say so
// on a channel of their own, a tab about to come aboard asks first, and the harbour lets the
// person choose: play in this tab instead, or come aboard as another sailor, whose identity and
// face this tab keeps for itself (sessionStorage: it lasts through a reload, and dies with the tab).

const CHANNEL = 'exploratory.rooms';
/** This tab plays as a sailor of its own (see identity.ts, which keeps its keys in this tab). */
const OWN_KEY = 'exploratory.online.tabSailor';
/** How long another tab has to answer: a live tab answers within a frame or two, a busy one (raising its island) later. */
const ASK_MS = 1500;

type Msg = { t: 'who'; id: string; code: string; user: string } | { t: 'here'; id: string };

let channel: BroadcastChannel | null | undefined;
/** The room this tab is aboard, as whom. */
let aboard: { code: string; user: string } | null = null;

function open(): BroadcastChannel | null {
  if (channel !== undefined) return channel;
  try {
    channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(CHANNEL) : null;
  } catch {
    channel = null;
  }
  channel?.addEventListener('message', (e: MessageEvent<Msg>) => {
    const m = e.data;
    if (m?.t === 'who' && aboard && aboard.code === m.code && aboard.user === m.user) channel?.postMessage({ t: 'here', id: m.id } satisfies Msg);
  });
  return channel;
}

/** This tab is aboard `code` as `user` (null: no longer). */
export function setAboard(room: { code: string; user: string } | null) {
  aboard = room;
  if (room) open();
}

/** Whether another tab of this browser is aboard `code` as `user` just now. */
export function aboardElsewhere(code: string, user: string): Promise<boolean> {
  const ch = open();
  if (!ch) return Promise.resolve(false);
  const id = Math.random().toString(36).slice(2);
  return new Promise((resolve) => {
    const heard = (e: MessageEvent<Msg>) => {
      if (e.data?.t !== 'here' || e.data.id !== id) return;
      done(true);
    };
    const done = (yes: boolean) => {
      ch.removeEventListener('message', heard);
      clearTimeout(t);
      resolve(yes);
    };
    const t = setTimeout(() => done(false), ASK_MS);
    ch.addEventListener('message', heard);
    ch.postMessage({ t: 'who', id, code, user } satisfies Msg);
  });
}

function session(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

/** Whether this tab plays as a sailor of its own. */
export function ownSailor(): boolean {
  try {
    return session()?.getItem(OWN_KEY) === '1';
  } catch {
    return false;
  }
}

/** From now on this tab plays as a sailor of its own: a new guest, made on the next step online. */
export function becomeOwnSailor() {
  try {
    session()?.setItem(OWN_KEY, '1');
  } catch {
    /* (no session storage: this visit only, as the browser's sailor) */
  }
}

/** The storage this tab's own sailor keeps its identity and face in. */
export const tabStorage = session;
