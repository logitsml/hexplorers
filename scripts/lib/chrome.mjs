// Which Chromium the scripts drive: CHROME_PATH if set, else the newest of Playwright's builds
// (`npx playwright install chromium`), else Google Chrome installed in macOS's Applications folder.

import { existsSync, readdirSync } from 'node:fs';

const SYSTEM = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

export function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const root = `${process.env.HOME}/Library/Caches/ms-playwright`;
  // (Newest first by build number: as text, chromium-999 would come before chromium-1248.)
  const build = (d) => Number(/^chromium-(\d+)$/.exec(d)?.[1] ?? NaN);
  const builds = existsSync(root) ? readdirSync(root).filter((d) => build(d) >= 0).sort((a, b) => build(b) - build(a)) : [];
  for (const b of builds) {
    const p = `${root}/${b}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
    if (existsSync(p)) return p;
  }
  if (existsSync(SYSTEM)) return SYSTEM;
  throw new Error('No Chromium found: set CHROME_PATH');
}
