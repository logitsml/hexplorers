// Diff two `shots.mjs --compiles` runs: which features' shader programs, pipelines and node builds
// came or went, and what each one was built for.
//
//   node scripts/capture/compiles-diff.mjs before.json after.json [scene]    scene: "webgpu/base" (the first common one by default)
//   ... --json diff.json                                              also write the per-signature table as JSON
//
// Live means still in the renderer's caches when the run ended (what the harness's `rec.compiled`
// counts): a program the title screen built and the game start released isn't live. Each live
// program is credited to the render object that first needed it, and that object to a signature:
// the feature that put it in the scene (the first project frame of its `add`, past the shared
// instancing helper), its name, its kind and instance capacity, the pass, its material's type and
// its geometry's attributes. Signatures are compared across the two runs by count, so a program
// whose shader text changed but whose signature didn't (a shared material edited) nets out, and
// what's left is what a lane added or removed.

import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const jsonAt = args.indexOf('--json');
const jsonOut = jsonAt >= 0 ? args.splice(jsonAt, 2)[1] : null;
const [beforeFile, afterFile, sceneArg] = args;
const A = JSON.parse(readFileSync(beforeFile, 'utf8')).scenes;
const B = JSON.parse(readFileSync(afterFile, 'utf8')).scenes;
const scene = sceneArg ?? Object.keys(B).find((k) => k in A);
const a = A[scene], b = B[scene];
if (!a || !b) throw new Error(`scene ${scene} is not in both runs (${Object.keys(A)} / ${Object.keys(B)})`);

/** Helpers that add objects on a feature's behalf: credit the feature that called them. */
const HELPERS = /^render\/board\/(instancing|release)\.ts /;
const frames = (e) => (e.added?.frames ?? []).filter((x) => !/(^| )(\S*\.)?add$/.test(x));
const feature = (e) => {
  const f = frames(e);
  const own = f.find((x) => !HELPERS.test(x)) ?? f[0];
  if (!own) return `(not in the scene) ${e.object.kind}`;
  return own.split(' ')[0].replace(/^render\//, '');
};
const where = (e) => frames(e).slice(0, 3).join(' < ') || '(not in the scene)';
// Passes: the sun's shadow map; the scene pass (its MRT carries velocity or normals); the AO's
// normal prepass (a second pass of the scene camera whose MRT is the packed normal alone, on High
// and Ultra); the sea's mirror (an unnamed target seen from another perspective camera); and
// whatever else by its target's name.
const velocity = (run) => (run.__v ??= run.events.some((e) => typeof e.mrt === 'string' && e.mrt.includes('velocity')));
const passOf = (run, e) => {
  if (e.pass === 'shadow') return 'shadow';
  const cam = run.labels?.[e.camera] ?? e.cameraType;
  if (cam === 'main' && typeof e.mrt === 'string') return e.mrt === 'output' && velocity(run) ? 'aoPrepass' : 'scene';
  if (/^T\d+$/.test(e.target ?? '') && cam === 'PerspectiveCamera') return 'mirror';
  return `${e.target ?? 'canvas'}@${cam}${e.passId ? '/' + e.passId : ''}`;
};
const capOf = (e) => (e.object.inst ? ` cap ${e.object.inst.cap}${e.object.inst.color ? '+colour' : ''}${e.object.inst.storage ? ' storage' : ''}` : '');
const matOf = (e) => (e.material ? `${e.material.type}${e.material.name ? ':' + e.material.name : ''}` : '?');
const sig = (run, e) => `${feature(e)} | ${e.object.name ?? ''} | ${e.object.kind}${capOf(e)} | ${passOf(run, e)} | ${matOf(e)}${e.material?.flags ? ` [${e.material.flags}]` : ''} | ${e.geometry?.attrs ?? ''}`;

/** Per signature: live vertex and fragment programs, live pipelines and start-phase node builds. */
function tally(run) {
  const pipes = run.events.filter((e) => e.kind === 'pipeline');
  const live = { vertex: new Map(), fragment: new Map() };
  for (const e of pipes)
    for (const [stage, p, fresh] of [['vertex', e.v, e.newV], ['fragment', e.f, e.newF]]) {
      if (!fresh) continue;
      const cur = live[stage].get(p.hash) ?? { n: 0, first: e, prog: p };
      cur.n++;
      live[stage].set(p.hash, cur);
    }
  for (const r of run.released) {
    if (r.kind !== 'program') continue;
    const cur = live[r.prog.stage].get(r.prog.hash);
    if (cur && --cur.n <= 0) live[r.prog.stage].delete(r.prog.hash);
  }
  const livePipes = new Map(pipes.map((e) => [e.cacheKey, e]));
  for (const r of run.released) if (r.kind === 'pipeline') livePipes.delete(r.cacheKey);
  const S = new Map();
  const at = (e) => {
    const k = sig(run, e);
    if (!S.has(k)) S.set(k, { v: [], f: [], p: 0, nodes: 0, ex: e, feature: feature(e), where: where(e) });
    return S.get(k);
  };
  for (const [stage, m] of Object.entries(live)) for (const x of m.values()) at(x.first)[stage[0]].push(x.prog);
  for (const e of livePipes.values()) at(e).p++;
  // (And what each signature's objects use, shared or not: steadier than first-creator credit
  // for a line of its own, since which object first needs a shared program depends on order.)
  for (const e of livePipes.values()) {
    const g = at(e);
    g.uv ??= new Set();
    g.uf ??= new Set();
    if (live.vertex.has(e.v.hash)) g.uv.add(e.v.hash);
    if (live.fragment.has(e.f.hash)) g.uf.add(e.f.hash);
  }
  for (const e of run.events)
    if (e.kind === 'node' && e.phase === 'start') {
      const g = at(e);
      g.nodes++;
      g.ms = (g.ms ?? 0) + (e.ms ?? 0);
    }
  return { S, live };
}
const ta = tally(a), tb = tally(b);

const out = [];
const say = (s = '') => out.push(s);
say(`# ${scene}: ${beforeFile.split('/').pop()} → ${afterFile.split('/').pop()}`);
say();
say(`Renderer's final counts: before ${JSON.stringify(a.final)}, after ${JSON.stringify(b.final)}. Game-start precompile ${a.compileMs} → ${b.compileMs} ms (one run each); main thread in node builds and pipeline requests ${JSON.stringify(a.ms ?? {})} → ${JSON.stringify(b.ms ?? {})}.`);
for (const [label, run] of [['before', a], ['after', b]]) {
  const st = run.events.filter((e) => e.phase === 'start');
  say(`Built during the game start (${label}): ${st.filter((e) => e.kind === 'pipeline').length} pipelines, ${st.filter((e) => e.newV).length} vertex, ${st.filter((e) => e.newF).length} fragment, ${st.filter((e) => e.kind === 'node').length} node builds.`);
}
say();

// Per signature, and per feature.
const keys = new Set([...ta.S.keys(), ...tb.S.keys()]);
const zero = { v: [], f: [], p: 0, nodes: 0, ms: 0 };
const rows = [];
for (const k of keys) {
  const x = ta.S.get(k) ?? zero, y = tb.S.get(k) ?? zero;
  const ex = (y.ex ?? x.ex);
  const vChanged = y.v.filter((p) => !x.v.some((q) => q.hash === p.hash)).length;
  rows.push({ sig: k, feature: (y.feature ?? x.feature), where: (y.where ?? x.where), v: [x.v.length, y.v.length], f: [x.f.length, y.f.length], p: [x.p, y.p], nodes: [x.nodes, y.nodes], uv: [x.uv?.size ?? 0, y.uv?.size ?? 0], uf: [x.uf?.size ?? 0, y.uf?.size ?? 0], ms: [Math.round(x.ms ?? 0), Math.round(y.ms ?? 0)], vChanged, ex });
}
const feats = new Map();
for (const r of rows) {
  const g = feats.get(r.feature) ?? { feature: r.feature, v: [0, 0], f: [0, 0], p: [0, 0], nodes: [0, 0], ms: [0, 0], changed: 0, rows: [] };
  for (const k of ['v', 'f', 'p', 'nodes', 'ms']) for (const i of [0, 1]) g[k][i] += r[k][i];
  if (r.v[0] === r.v[1]) g.changed += r.vChanged;
  g.rows.push(r);
  feats.set(r.feature, g);
}
const d = (x) => (x[1] - x[0] > 0 ? `+${x[1] - x[0]}` : x[1] - x[0] < 0 ? `${x[1] - x[0]}` : '0');
const cell = (x) => `${x[0]} → ${x[1]} (${d(x)})`;
const list = [...feats.values()].sort((x, y) => y.v[1] - y.v[0] - (x.v[1] - x.v[0]) || y.f[1] - y.f[0] - (x.f[1] - x.f[0]));
say('Node builds and their milliseconds are the game start\'s (main thread: the material\'s graph built and its WGSL generated); programs and pipelines are what is live at the end.');
say();
say('| feature (what added the object) | vertex | fragment | pipelines | node builds at start | node-build ms at start | same signature, new text |');
say('|---|---|---|---|---|---|---|');
for (const g of list) say(`| ${g.feature} | ${cell(g.v)} | ${cell(g.f)} | ${cell(g.p)} | ${cell(g.nodes)} | ${cell(g.ms)} | ${g.changed || ''} |`);
const T = list.reduce((t, g) => ({ v: [t.v[0] + g.v[0], t.v[1] + g.v[1]], f: [t.f[0] + g.f[0], t.f[1] + g.f[1]], p: [t.p[0] + g.p[0], t.p[1] + g.p[1]], nodes: [t.nodes[0] + g.nodes[0], t.nodes[1] + g.nodes[1]], ms: [t.ms[0] + g.ms[0], t.ms[1] + g.ms[1]] }), { v: [0, 0], f: [0, 0], p: [0, 0], nodes: [0, 0], ms: [0, 0] });
say(`| **total** | ${cell(T.v)} | ${cell(T.f)} | ${cell(T.p)} | ${cell(T.nodes)} | ${cell(T.ms)} | |`);
say();

// The signatures that moved, by feature.
say('## Signatures whose counts moved');
say();
say('Each line: the live vertex and fragment programs its objects use (shared ones too), the pipelines and node builds it was first to need, before → after, then the signature (object name | kind, instance capacity | pass | material | attributes). `cN` counts the vertex programs that differ from another one only in a baked array length (an instanced mesh\'s matrix buffer sized to its capacity).');
say();
const nhashes = (t) => {
  const m = new Map();
  for (const x of t.live.vertex.values()) m.set(x.prog.nhash, (m.get(x.prog.nhash) ?? 0) + 1);
  return m;
};
const nb = nhashes(tb);
for (const g of list) {
  const moved = g.rows.filter((r) => ['uv', 'uf', 'p', 'nodes'].some((k) => r[k][0] !== r[k][1]));
  if (!moved.length) continue;
  say(`### ${g.feature}`);
  for (const r of moved.sort((x, y) => x.sig.localeCompare(y.sig))) {
    const y = tb.S.get(r.sig);
    const countOnly = y ? y.v.filter((p) => (nb.get(p.nhash) ?? 0) > 1).length : 0;
    const e = r.ex;
    const extra = [e.object.castShadow ? 'casts' : '', e.lights !== undefined ? `${e.lights} lights` : '', countOnly ? `c${countOnly}` : ''].filter(Boolean).join(', ');
    say(`- ${r.uv[0]}→${r.uv[1]} v, ${r.uf[0]}→${r.uf[1]} f, ${r.p[0]}→${r.p[1]} p, ${r.nodes[0]}→${r.nodes[1]} n (${r.ms[0]}→${r.ms[1]} ms): \`${r.sig.split(' | ').slice(1).join(' | ')}\`${extra ? ` (${extra})` : ''} — ${r.where}`);
  }
  say();
}

// One material object with several live vertex programs in the after run, where any of them is in a
// signature that grew: what tells the variants apart.
say('## Materials built more than once (after run, growing signatures only)');
say();
const grew = new Set(rows.filter((r) => r.v[1] > r.v[0]).map((r) => r.sig));
const byMat = new Map();
for (const e of b.events) {
  if (e.kind !== 'pipeline' || !e.material?.id || !e.newV || !tb.live.vertex.has(e.v.hash)) continue;
  if (!byMat.has(e.material.id)) byMat.set(e.material.id, []);
  byMat.get(e.material.id).push(e);
}
for (const [id, es] of [...byMat].sort((x, y) => y[1].length - x[1].length)) {
  if (es.length < 2 || !es.some((e) => grew.has(sig(b, e)))) continue;
  say(`- ${matOf(es[0])}#${id} (${feature(es[0])}): ${es.length} vertex programs`);
  for (const e of es) say(`  - ${passOf(b, e)} | ${e.object.kind}${e.object.name ? ':' + e.object.name : ''}${capOf(e)} | ${e.geometry?.attrs} | dyn ${e.dyn} ctx ${e.context}${e.lights !== undefined ? ` ${e.lights} lights` : ''} | ${e.phase}`);
}

console.log(out.join('\n'));
if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ scene, features: list.map(({ rows, ...g }) => ({ ...g, rows: rows.map(({ ex, ...r }) => r) })) }, null, 2));
