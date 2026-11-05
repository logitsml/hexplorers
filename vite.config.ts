import { defineConfig, type Plugin } from 'vite';
import { configDefaults } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { onlinePlay } from './server/node/vite.ts';

// (The project's own folder: the watcher's exclusions are anchored to it, so they never catch the project itself when its path runs through one of them.)
const here = fileURLToPath(new URL('.', import.meta.url));
const timeoutScale = Number(process.env.TEST_TIMEOUT_SCALE) > 0 ? Number(process.env.TEST_TIMEOUT_SCALE) : 1;

/**
 * The fonts the loading screen and the title use, preloaded from the page itself: otherwise the
 * browser only asks for them once the scripts have run and drawn the first text (a flash of the
 * fallback face). Latin only; the other subsets still load by their unicode-range if a name needs them.
 */
function preloadFonts(patterns: RegExp[]): Plugin {
  return {
    name: 'preload-fonts',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(_html, ctx) {
        const files = Object.keys(ctx.bundle ?? {}).filter((f) => f.endsWith('.woff2') && patterns.some((p) => p.test(f)));
        return files.map((f) => ({ tag: 'link', attrs: { rel: 'preload', as: 'font', type: 'font/woff2', href: `/${f}`, crossorigin: '' }, injectTo: 'head' as const }));
      },
    },
  };
}

/** The build's id for online play's version check (see src/net/build.ts): the commit, and when it was built. */
function buildId() {
  let commit = 'local';
  try {
    commit = execSync('git rev-parse --short HEAD', { cwd: here, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    // (Not a checkout: a build from an archive.)
  }
  return `${commit}-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}`;
}

export default defineConfig({
  define: { __BUILD__: JSON.stringify(buildId()) },
  plugins: [react(), onlinePlay(), preloadFonts([/lilita-one-latin-400-normal-/, /fraunces-latin-wght-normal-/, /alegreya-sans-latin-(400|700)-normal-/])],
  build: {
    target: 'es2022',
    // three.js (its WebGPU build) is about 1 MB minified by itself and can't be split further; the
    // limit sits just above it, so the warning still speaks up for anything else that grows.
    chunkSizeWarningLimit: 1100,
    rolldownOptions: {
      output: {
        // three.js changes far less often than the game: in a chunk of its own it stays cached
        // across releases. (Settings, the rules and the results are split off by their dynamic
        // imports, see ui/Modals.tsx.) The other libraries are left to the bundler: in a group of
        // their own, React's CommonJS wrappers came from the bundler's runtime in one of the game's
        // chunks, which imported the libraries back, and in that cycle the page stopped before the
        // loading screen. (three.js imports nothing, so its chunk can't close a cycle.)
        codeSplitting: {
          groups: [{ name: 'three', test: /node_modules[\\/]three[\\/]/ }],
        },
      },
    },
  },
  // (Local tool state, screenshots, online play's data and the built server change while it runs: they mustn't reload its pages.)
  server: { port: 5173, host: true, watch: { ignored: [`${here}.claude/**`, `${here}shots/**`, `${here}.data/**`, `${here}dist-server/**`] } },
  // (The tiers and TEST_TIMEOUT_SCALE are tests/tier.ts's: the default timeouts stretch the same way,
  // and the quick tier leaves out the files that load three/webgpu.)
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: [...configDefaults.exclude, ...(process.env.QUICK ? ['tests/decisionFlows.test.ts', 'tests/dice.test.ts', 'tests/marks.test.ts', 'tests/scenery.test.ts'] : [])],
    testTimeout: 5000 * timeoutScale,
    hookTimeout: 10_000 * timeoutScale,
  },
});
