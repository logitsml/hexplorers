// Render measurements against a running dev server: what the frame loop costs in a watched game,
// and what games and the map editor's 3D view leave behind once they're gone.
//
//   node scripts/checks/perf.mjs frames      a watched game (?watch&autostart): the frame's CPU time, split
//                                     into the updates and the render submission, and where the
//                                     updates spend it (a CPU profile and an allocation profile)
//        --mix allHands               a mix as ?mix= takes it (the base game by default)
//        --land 61                    a custom map instead: a filled hexagon of 7, 19, 37, 61 or 91 land hexes, bots playing
//        --secs 20                    how long to measure, once the game is under way
//        --q high                     the quality preset (Auto is turned off, so it stays put)
//        --webgl                      the WebGL2 backend
//        --top 30                     how many functions to list
//   node scripts/checks/perf.mjs gpu         a watched game held still: stage.render() timed to the end of the GPU's work
//        --n 240                      how many frames (--land, --mix, --q, --webgl as above)
//   node scripts/checks/perf.mjs uploads     a watched game: which buffers and textures go up to the GPU,
//                                     how many times a frame and how much (--secs 10, --mix, --q, --webgl)
//   node scripts/checks/perf.mjs leaks       start and leave watched games, and open and close the map
//                                     editor's 3D view, counting the renderer's resources, the
//                                     scene, the frame handlers, live three.js objects and the heap
//                                     (after forced GC) after each; then names what the renderer
//                                     still holds from earlier cycles, and any texture it drew
//                                     after it was disposed (it never lets go of one)
//        --cycles 4 --mix allHands --webgl --q low
//
// Under a heavily loaded machine the CPU profile's times are wall-clock and swing from run to run;
// the upload and resource counts don't.
//
//   PERF_URL=http://localhost:5181    the dev server (5173 by default)
//   CHROME_PATH=...                   another Chromium (see scripts/lib/chrome.mjs)

import { chromium } from 'playwright-core';
import { chromePath } from '../lib/chrome.mjs';

const args = process.argv.slice(2);
const mode = args[0] ?? 'frames';
const opt = (name, d) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d;
};
const flag = (name) => args.includes(`--${name}`);
const URL = (process.env.PERF_URL ?? 'http://localhost:5173').replace(/\/$/, '');
const CHROME = chromePath();
const MIX = opt('mix', '');
const LAND = Number(opt('land', 0));
const Q = opt('q', mode === 'leaks' ? 'low' : 'high');
const webgl = flag('webgl');

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU', '--ignore-gpu-blocklist', '--use-angle=metal', '--js-flags=--expose-gc'],
});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
await page.addInitScript((q) => {
  try {
    localStorage.clear();
    // (A fixed preset: Auto would step down mid-measurement on a slow machine.)
    localStorage.setItem('exploratory.settings', JSON.stringify({ v: 3, quality: q }));
    localStorage.setItem('exploratory.touchCoach', '1');
  } catch {}
}, Q);
const ui = (fn, arg) => page.evaluate(fn, arg);
const wait = (fn, timeout = 600000) => page.waitForFunction(fn, null, { timeout, polling: 250 });
const params = (extra) => new URLSearchParams({ seed: '7', q: Q, ...(webgl && { webgl: '' }), ...extra }).toString().replace(/=(&|$)/g, '$1');

const median = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1] ?? 0;
const pct = (xs, p) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))] ?? 0;
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
const f = (x) => x.toFixed(2);

/** Self time (ms) or size per function, from a CPU or sampling heap profile's nodes. */
function tally(nodes, weight, top) {
  const by = new Map();
  for (const n of nodes) {
    const { functionName, url, lineNumber } = n.callFrame;
    const file = url.replace(/^.*?\/src\//, 'src/').replace(/\?.*$/, '');
    const k = `${functionName || '(anonymous)'}  ${file}:${lineNumber + 1}`;
    by.set(k, (by.get(k) ?? 0) + weight(n));
  }
  return [...by].sort((a, b) => b[1] - a[1]).slice(0, top);
}

/** A watched game under way (the base game, a mix, or with --land a custom map of that much land). */
async function openGame() {
  if (LAND) {
    // A custom map of a hexagon of land (a sea ring round it), dealt and given harbours, with bots at every seat.
    await page.goto(`${URL}/?${params({})}`, { timeout: 300000 });
    await wait(() => !!document.querySelector('.menu-card') && window.__ui?.getState().worldReady);
    await ui(async (land) => {
      const { blankMap, fillTerrain, placeHarbours } = await import('/src/engine/maps/custom.ts');
      const { Rng } = await import('/src/engine/rng.ts');
      const radius = { 7: 1, 19: 2, 37: 3, 61: 4, 91: 5 }[land];
      const rng = new Rng(5);
      const custom = placeHarbours(fillTerrain(blankMap(`${land} land`, radius + 1, radius), rng), rng);
      window.session.start({ name: 'You', color: 'red', opponents: 3, difficulty: 'normal', layout: 'random', numberPlacement: 'spiral', seed: 7, watch: true, map: 'custom', custom });
    }, LAND);
  } else await page.goto(`${URL}/?${params({ watch: '', autostart: '', ...(MIX && { mix: MIX }) })}`, { timeout: 300000 });
  await wait(() => window.__ui?.getState().screen === 'game' && (window.__ui.getState().view?.turn ?? 0) > 1 && !window.session.world.rig.flying);
}

if (mode === 'frames') {
  const secs = Number(opt('secs', 20));
  const top = Number(opt('top', 30));
  await openGame();
  await page.waitForTimeout(3000);
  // The render submission timed apart from the rest of the frame.
  await ui(() => {
    const w = window.session.world;
    const render = w.stage.render.bind(w.stage);
    window.__perf = { frame: [], render: [], gaps: [], last: 0, renderMs: 0 };
    w.stage.render = () => {
      const t0 = performance.now();
      render();
      window.__perf.renderMs = performance.now() - t0;
    };
    w.onFrame(() => {
      const p = window.__perf, now = performance.now();
      // (frameMs and renderMs are the frame before this one's.)
      if (p.last) {
        p.frame.push(w.frameMs);
        p.render.push(p.renderMs);
        p.gaps.push(now - p.last);
      }
      p.last = now;
      p.renderMs = 0;
    });
  });
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 250 });
  await cdp.send('HeapProfiler.enable');
  await cdp.send('Profiler.start');
  await cdp.send('HeapProfiler.startSampling', { samplingInterval: 8192, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
  await ui(() => {
    const p = window.__perf;
    p.frame.length = p.render.length = p.gaps.length = 0;
  });
  await page.waitForTimeout(secs * 1000);
  const { profile } = await cdp.send('Profiler.stop');
  const { profile: heap } = await cdp.send('HeapProfiler.stopSampling');
  const p = await ui(() => ({ ...window.__perf, quality: window.__ui.getState().quality, turn: window.__ui.getState().view?.turn }));
  const update = p.frame.map((x, i) => x - p.render[i]);
  console.log(`${LAND ? `${LAND}-land custom map` : MIX || 'base'} game, ${Q} (${p.quality}), ${webgl ? 'WebGL2' : 'WebGPU'}: ${p.frame.length} frames in ${secs} s, to turn ${p.turn}`);
  console.log(`  frame gap    median ${f(median(p.gaps))} ms, p95 ${f(pct(p.gaps, 0.95))}`);
  console.log(`  frame CPU    median ${f(median(p.frame))} ms, mean ${f(mean(p.frame))}, p95 ${f(pct(p.frame, 0.95))}`);
  console.log(`  updates      median ${f(median(update))} ms, mean ${f(mean(update))}, p95 ${f(pct(update, 0.95))}`);
  console.log(`  render call  median ${f(median(p.render))} ms, mean ${f(mean(p.render))}, p95 ${f(pct(p.render, 0.95))}`);
  // Self time per function: samples times their interval.
  const dt = new Map();
  profile.samples.forEach((id, i) => dt.set(id, (dt.get(id) ?? 0) + (profile.timeDeltas[i] ?? 0) / 1000));
  const total = [...dt.values()].reduce((a, b) => a + b, 0);
  const idle = profile.nodes.filter((n) => ['(idle)', '(program)'].includes(n.callFrame.functionName)).reduce((a, n) => a + (dt.get(n.id) ?? 0), 0);
  console.log(`\n  CPU self time, top ${top} (of ${f(total - idle)} ms busy):`);
  for (const [k, ms] of tally(profile.nodes, (n) => dt.get(n.id) ?? 0, top)) console.log(`    ${f(ms).padStart(9)} ms  ${k}`);
  const render = tally(profile.nodes.filter((n) => /\/src\/render\//.test(n.callFrame.url)), (n) => dt.get(n.id) ?? 0, top);
  console.log(`\n  CPU self time in src/render, top ${top}:`);
  for (const [k, ms] of render) console.log(`    ${f(ms).padStart(9)} ms  ${k}`);
  const flat = [];
  const walk = (n) => (flat.push(n), n.children.forEach(walk));
  walk(heap.head);
  const bytes = flat.reduce((a, n) => a + n.selfSize, 0);
  console.log(`\n  allocated ${f(bytes / 1048576)} MB in ${secs} s; top ${top} by size:`);
  for (const [k, b] of tally(flat, (n) => n.selfSize, top)) console.log(`    ${f(b / 1024).padStart(9)} KB  ${k}`);
} else if (mode === 'gpu') {
  // The GPU's cost of a frame, as the project measures it: the game held still, stage.render() called
  // back to back and each waited for to the end of the GPU's work (timestamp queries mislead here).
  // Run it with each build in turn, the order alternated, as a fanless machine runs the second hotter.
  const n = Number(opt('n', 240));
  await openGame();
  await page.waitForTimeout(3000);
  const t = await ui(async (n) => {
    const w = window.session.world;
    w.stage.renderer.setAnimationLoop(null);
    window.session.presenter?.hold('pause', true);
    const b = w.stage.renderer.backend;
    const done = () => (b.device ? b.device.queue.onSubmittedWorkDone() : (b.gl.finish(), Promise.resolve()));
    for (let i = 0; i < 30; i++) w.stage.render();
    await done();
    const out = [];
    for (let i = 0; i < n; i++) {
      const t0 = performance.now();
      w.stage.render();
      await done();
      out.push(performance.now() - t0);
    }
    return { out };
  }, n);
  console.log(`${LAND ? `${LAND}-land custom map` : MIX || 'base'}, ${Q}, ${webgl ? 'WebGL2' : 'WebGPU'}: render + GPU per frame, ${n} frames: median ${f(median(t.out))} ms, mean ${f(mean(t.out))}, p10 ${f(pct(t.out, 0.1))}, p90 ${f(pct(t.out, 0.9))}`);
} else if (mode === 'uploads') {
  // Which buffers and textures go up to the GPU, how often and how big, over `secs` of a watched game.
  const secs = Number(opt('secs', 10));
  await page.goto(`${URL}/?${params({ watch: '', autostart: '', ...(MIX && { mix: MIX }) })}`, { timeout: 300000 });
  await wait(() => window.__ui?.getState().screen === 'game' && (window.__ui.getState().view?.turn ?? 0) > 1 && !window.session.world.rig.flying);
  await page.waitForTimeout(3000);
  const out = await ui(async (secs) => {
    const w = window.session.world, r = w.stage.renderer, backend = r.backend;
    // Each attribute's owner: the mesh (named by its ancestry) and the attribute's name.
    const owner = new Map();
    const label = (o) => {
      const names = [];
      for (let p = o; p && names.length < 4; p = p.parent) names.push(p.name || p.type);
      return names.join('<');
    };
    const scan = () =>
      w.stage.scene.traverse((o) => {
        if (o.instanceMatrix) owner.set(o.instanceMatrix, `${label(o)} instanceMatrix`);
        if (o.instanceColor) owner.set(o.instanceColor, `${label(o)} instanceColor`);
        for (const k of ['_matricesTexture', '_indirectTexture', '_colorsTexture']) if (o[k]) owner.set(o[k], `${label(o)} ${k.slice(1)}`);
        const g = o.geometry;
        if (g?.attributes) for (const [k, a] of Object.entries(g.attributes)) if (!owner.has(a)) owner.set(a, `${label(o)} ${k}`);
        if (g?.index && !owner.has(g.index)) owner.set(g.index, `${label(o)} index`);
      });
    scan();
    const counts = new Map();
    const note = (k, bytes) => {
      const c = counts.get(k) ?? { n: 0, bytes: 0 };
      c.n++;
      c.bytes += bytes;
      counts.set(k, c);
    };
    const update = backend.updateAttribute.bind(backend);
    backend.updateAttribute = (a) => {
      const ranges = a.updateRanges?.length ? a.updateRanges.reduce((s, x) => s + x.count, 0) : a.array.length;
      note(`attr ${owner.get(a) ?? a.name ?? '?'}`, ranges * a.array.BYTES_PER_ELEMENT);
      return update(a);
    };
    const tex = backend.updateTexture.bind(backend);
    backend.updateTexture = (t, o) => {
      note(`texture ${owner.get(t) || t.name || t.constructor.name} ${t.image?.width}x${t.image?.height}`, (t.image?.data?.byteLength ?? 0) || (t.image?.width ?? 0) * (t.image?.height ?? 0) * 4);
      return tex(t, o);
    };
    let frames = 0;
    const off = w.onFrame(() => frames++);
    const t0 = performance.now();
    while (performance.now() - t0 < secs * 1000) {
      await new Promise((res) => setTimeout(res, 500));
      scan();
    }
    off();
    backend.updateAttribute = update;
    backend.updateTexture = tex;
    return { frames, rows: [...counts].sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 40) };
  }, secs);
  console.log(`${MIX || 'base'} game, ${Q}, ${webgl ? 'WebGL2' : 'WebGPU'}: uploads over ${out.frames} frames`);
  for (const [k, c] of out.rows) console.log(`  ${(c.n / out.frames).toFixed(2).padStart(6)}/frame ${((c.bytes / out.frames) / 1024).toFixed(1).padStart(8)} KB/frame  ${k}`);
} else if (mode === 'leaks') {
  const cycles = Number(opt('cycles', 4));
  await page.goto(`${URL}/?${params({})}`, { timeout: 300000 });
  await wait(() => !!document.querySelector('.menu-card') && window.__ui?.getState().worldReady);
  await ui(async () => {
    window.__presets = await import('/src/engine/presets.ts');
    window.__editor = await import('/src/ui/editor/store.ts');
  });
  await page.waitForTimeout(3000);
  // Every texture and attribute the renderer holds, weakly (the census mustn't keep them alive),
  // to name what is left over from a cycle.
  await ui(() => {
    const info = window.session.world.stage.renderer.info;
    const live = (window.__held = new Map());
    let serial = 0;
    // (A texture first drawn after it was disposed is never let go of: the renderer only listens
    // for a dispose from then on. So each dispose is noted.)
    let proto = window.session.world.ocean.sdfTex;
    while (proto && !Object.prototype.hasOwnProperty.call(proto, 'dispose')) proto = Object.getPrototypeOf(proto);
    const dispose = proto.dispose;
    proto.dispose = function () {
      this.__disposed = true;
      return dispose.call(this);
    };
    const track = (create, destroy, describe) => {
      const c = info[create].bind(info), d = info[destroy].bind(info);
      info[create] = (x) => {
        x.__held = ++serial;
        live.set(x.__held, { ref: new WeakRef(x), what: describe(x) });
        return c(x);
      };
      info[destroy] = (x) => {
        live.delete(x.__held);
        return d(x);
      };
    };
    track('createTexture', 'destroyTexture', (t) => {
      const data = t.image?.data;
      return `texture ${t.name || t.constructor.name} ${t.image ? `${t.image.width}x${t.image.height}` : ''} ${t.format}/${t.type}${data ? ` ${data.constructor.name}` : ''}${t.__disposed ? ' DRAWN AFTER DISPOSE' : ''}`;
    });
    track('createAttribute', 'destroyAttribute', (a) => `attribute ${a.constructor.name} ${a.name || ''} ${a.count}x${a.itemSize}`);
  });
  const newHeld = (label) =>
    ui((label) => {
      const w = window.session.world;
      // Who holds each attribute now (a geometry in the scene, by its mesh and name).
      const owner = new Map();
      w.stage.scene.traverse((o) => {
        const g = o.geometry;
        if (g?.attributes) for (const [k, a] of Object.entries(g.attributes)) owner.set(a, `${o.name || o.type}<${o.parent?.name || o.parent?.type || ''} ${k}`);
        if (o.instanceMatrix) owner.set(o.instanceMatrix, `${o.name || o.type} instanceMatrix`);
      });
      const out = [];
      window.__seenHeld ??= new Map();
      for (const [id, { ref, what }] of window.__held) {
        if (window.__seenHeld.has(id)) continue;
        window.__seenHeld.set(id, label);
        const x = ref.deref();
        out.push(`${what}${x?.__disposed ? ' (disposed, still held)' : ''}${x ? (owner.has(x) ? ` in ${owner.get(x)}` : x.isTexture ? '' : ' (in nothing in the scene)') : ' (collected)'}`);
      }
      return out;
    }, label);

  // Live JS objects by kind (whatever the renderer holds or not), counted through the inspector.
  const cdp = await ctx.newCDPSession(page);
  const protoOf = (from, name) => `(() => { let p = ${from}; while (p && !Object.prototype.hasOwnProperty.call(p, 'constructor') || (p && p.constructor.name !== '${name}')) p = Object.getPrototypeOf(p); return p; })()`;
  const kinds = {
    obj3d: protoOf('window.session.world.stage.scene', 'Object3D'),
    geos: protoOf('window.session.world.ocean.mesh.geometry', 'BufferGeometry'),
    mats: protoOf('window.session.world.ocean.mesh.material', 'Material'),
    texs: protoOf('window.session.world.ocean.sdfTex', 'Texture'),
  };
  const protoIds = {};
  const count = async () => {
    const out = {};
    for (const [k, expr] of Object.entries(kinds)) {
      protoIds[k] ??= (await cdp.send('Runtime.evaluate', { expression: expr, objectGroup: 'protos' })).result.objectId;
      const { objects } = await cdp.send('Runtime.queryObjects', { prototypeObjectId: protoIds[k], objectGroup: 'census' });
      const { result } = await cdp.send('Runtime.callFunctionOn', { objectId: objects.objectId, functionDeclaration: 'function () { return this.length; }', returnByValue: true });
      out[k] = result.value;
    }
    await cdp.send('Runtime.releaseObjectGroup', { objectGroup: 'census' });
    return out;
  };

  const census = async () => {
    await ui(() => (window.gc?.(), window.gc?.()));
    await page.waitForTimeout(400);
    await ui(() => (window.gc?.(), window.gc?.()));
    const js = await count();
    return { ...js, ...(await ui(() => {
      const w = window.session.world, r = w.stage.renderer, m = r.info.memory;
      let objects = 0;
      w.stage.scene.traverse(() => objects++);
      const live = Object.values(w.particles).reduce((a, p) => a + (p.mesh.count ?? 0), 0);
      return {
        heap: performance.memory?.usedJSHeapSize ?? 0,
        geometries: m.geometries,
        textures: m.textures,
        programs: m.programs,
        attributes: m.attributes,
        uniformBuffers: m.uniformBuffers,
        renderTargets: m.renderTargets,
        objects,
        handlers: w.frameHandlers.size,
        tweens: w.animator.tasks.size,
        particles: live,
        lamps: w.lamps.lamps.size,
      };
    })) };
  };
  const rows = [];
  const kept = [];
  const show = async (label, c) => {
    rows.push({ label, ...c, heap: +(c.heap / 1048576).toFixed(2) });
    for (const t of await newHeld(label)) kept.push(`${label}: ${t}`);
  };

  const game = async (watch) => {
    await ui(async ({ mix }) => {
      const { PRESETS, EXPANSIONS, mixOf } = window.__presets;
      const ids = mix ? (PRESETS.find((p) => p.id === mix)?.expansions ?? mix.split(',').filter((id) => EXPANSIONS.some((e) => e.id === id))) : [];
      const m = ids.length ? mixOf(ids) : null;
      void window.session.start({ ...(m && { modules: m.modules, map: m.map === 'classic' ? undefined : m.map, knobs: m.knobs, victoryPoints: m.target }), name: 'You', color: 'red', opponents: 3, difficulty: 'normal', layout: 'random', numberPlacement: 'spiral', seed: 7, watch: true });
    }, { mix: MIX });
    await wait(() => window.__ui.getState().screen === 'game' && (window.__ui.getState().view?.turn ?? 0) > 0 && !window.session.introducing);
    await page.waitForTimeout(watch * 1000);
    await ui(() => void window.session.quitToTitle());
    await wait(() => window.__ui.getState().screen === 'title');
    await page.waitForTimeout(4000);
  };

  const editor = async () => {
    await ui(() => window.__ui.getState().set({ screen: 'editor' }));
    await page.waitForTimeout(1500);
    await ui(() => window.__editor.useEditor.getState().set({ view: '3d' }));
    await page.waitForTimeout(4000);
    // A few deals of the map (every hex changes), then back to the map as drawn.
    for (let i = 1; i <= 3; i++) {
      await ui((i) => window.__editor.useEditor.getState().set({ preview: i }), i);
      await page.waitForTimeout(1800);
    }
    await ui(() => window.__editor.useEditor.getState().set({ preview: null }));
    await page.waitForTimeout(2000);
    await ui(() => window.__editor.useEditor.getState().set({ view: '2d' }));
    await page.waitForTimeout(800);
    await ui(() => window.__ui.getState().set({ screen: 'title' }));
    await page.waitForTimeout(3000);
  };

  await show('title', await census());
  // (The first of each is a warm-up: caches, pools and compiled shaders that are kept on purpose.)
  await game(8);
  await show('game 1', await census());
  await editor();
  await show('editor 1', await census());
  for (let i = 2; i <= cycles; i++) {
    await game(8);
    await show(`game ${i}`, await census());
    await editor();
    await show(`editor ${i}`, await census());
  }
  console.log(`${MIX || 'base'} games and the editor's 3D view, ${Q}, ${webgl ? 'WebGL2' : 'WebGPU'}`);
  console.table(rows);
  const a = rows[2], b = rows[rows.length - 1];
  const n = cycles - 1;
  console.log(`per cycle after the first: ${Object.keys(a)
    .filter((k) => k !== 'label')
    .map((k) => `${k} ${((b[k] - a[k]) / n).toFixed(k === 'heap' ? 2 : 1)}`)
    .join(', ')}`);
  // What the renderer still holds from a cycle after the first, other than the last (whose island
  // waits under the title's sea): a leak.
  const last = rows[rows.length - 2].label;
  const left = await ui((skip) => {
    const out = [];
    for (const [id, { ref, what }] of window.__held) {
      const label = window.__seenHeld.get(id);
      if (!label || skip.includes(label)) continue;
      const x = ref.deref();
      out.push(`${label}: ${what}${x?.__disposed ? ' (disposed)' : ''}${x ? '' : ' (collected)'}`);
    }
    return out;
  }, ['title', 'game 1', 'editor 1', last, rows[rows.length - 1].label]);
  if (left.length) console.log(`\nstill held from earlier cycles:\n  ${left.join('\n  ')}`);
}
if (errors.length) console.log(`\npage errors:\n  ${errors.slice(0, 5).join('\n  ')}`);
await browser.close();
