// Compile attribution for the screenshot harness (`node scripts/capture/shots.mjs --compiles out.json`).
// The harness's Vite server makes this the first import of src/main.tsx, so it runs before the
// world exists. It records, for every render pipeline, shader program and node build the renderer
// creates, the render object that caused it: the object's kind, name, parent path and the code
// that added it to the scene, its material, its geometry's attributes, and the pass (the shadow
// map, the main camera, a render target). Programs are identified by a hash of their shader text,
// which is what three keys them by, so two trees' runs can be diffed program by program.
//
// (Not part of the game: it is only ever served by the harness, and it reaches into three's
// private renderer state, `_pipelines` and `_nodes`, as r186 lays it out.)

import { Mesh, Object3D, WebGPURenderer } from 'three/webgpu';

Error.stackTraceLimit = 40;

const C = {
  phase: 'title',
  events: [],
  released: [],
  stacks: new WeakMap(),
  ids: new WeakMap(),
  next: new Map(),
  seen: new WeakSet(),
  nodeKeys: new Set(),
  progs: new WeakMap(),
  ms: {},
  nodeMs: 0,
};
window.__compiles = C;

/** A short id for an object, per prefix, stable for the page's life (M3 a material, O12 an object). */
function id(x, prefix) {
  if (!x) return null;
  let v = C.ids.get(x);
  if (!v) {
    const n = (C.next.get(prefix) ?? 0) + 1;
    C.next.set(prefix, n);
    v = `${prefix}${n}`;
    C.ids.set(x, v);
  }
  return v;
}

// Where each object was added to the scene graph: the call stack of its first `add`.
const add = Object3D.prototype.add;
Object3D.prototype.add = function (...objs) {
  const stack = new Error().stack;
  for (const o of objs) if (o && o !== this && !C.stacks.has(o)) C.stacks.set(o, stack);
  return add.apply(this, objs);
};

/** The project's own frames of a stack ("render/board/pieces.ts PieceBatch.build"), innermost first. */
function frames(stack) {
  if (!stack) return [];
  const out = [];
  for (const line of stack.split('\n')) {
    const m = line.match(/at (?:(.*?) \()?(?:[a-z]+:\/\/[^/]+)?\/src\/([^?:)]+)/);
    if (!m) continue;
    out.push(`${m[2]} ${m[1] ?? '?'}`.trim());
    if (out.length >= 6) break;
  }
  return out;
}

/** The nearest ancestor (or the object itself) with an `add` stack. */
function addedBy(o) {
  for (let p = o, depth = 0; p && depth < 12; p = p.parent, depth++) {
    const s = C.stacks.get(p);
    if (s) return { via: depth, frames: frames(s) };
  }
  return { via: -1, frames: [] };
}

function cyrb53(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

/** Shader text with fixed array lengths taken out: two programs equal under it differ only in a count. */
const normalize = (code) => code.replace(/(array<\s*[\w<>, ]*?,\s*)\d+(\s*>)/g, '$1N$2').replace(/\[\s*\d+\s*\]/g, '[N]');

function prog(p) {
  if (!p) return null;
  let v = C.progs.get(p);
  if (!v) {
    v = { id: p.id, stage: p.stage, hash: cyrb53(p.code), nhash: cyrb53(normalize(p.code)), len: p.code.length };
    C.progs.set(p, v);
  }
  return v;
}

const pathOf = (o) => {
  const segs = [];
  for (let p = o.parent; p && segs.length < 10; p = p.parent) segs.push(p.name ? `${p.type}:${p.name}` : p.type);
  return segs.reverse().join('/');
};

function geometry(g) {
  if (!g) return null;
  const attrs = Object.keys(g.attributes)
    .sort()
    .map((k) => {
      const a = g.attributes[k];
      const inst = a.isInstancedBufferAttribute || a.data?.isInstancedInterleavedBuffer;
      return `${k}${a.itemSize}${inst ? 'i' : ''}${a.isInterleavedBufferAttribute ? 'x' : ''}${a.normalized ? 'n' : ''}`;
    });
  const morph = Object.keys(g.morphAttributes ?? {});
  return { id: id(g, 'G'), type: g.type, name: g.name || undefined, attrs: attrs.join(','), index: !!g.index, verts: g.attributes.position?.count ?? 0, morph: morph.length ? morph.join(',') : undefined };
}

function material(m) {
  if (!m) return null;
  const nodes = Object.keys(m).filter((k) => k.endsWith('Node') && m[k] && m[k].isNode);
  return {
    id: id(m, 'M'),
    type: m.type,
    name: m.name || undefined,
    flags: [m.transparent && 'transparent', m.side === 1 ? 'back' : m.side === 2 ? 'double' : null, m.depthWrite === false && 'noDepthWrite', m.depthTest === false && 'noDepthTest', m.alphaTest > 0 && 'alphaTest', m.vertexColors && 'vertexColors', m.fog === false && 'noFog', m.flatShading && 'flat', m.lights === false && 'unlit', m.blending !== 1 && `blend${m.blending}`].filter(Boolean).join(','),
    nodes: nodes.join(','),
  };
}

function describe(ro) {
  const o = ro.object, m = ro.material;
  const own = Array.isArray(o.material) ? o.material[ro.group?.materialIndex ?? 0] : o.material;
  const ctx = ro.context ?? {};
  const rt = ctx.renderTarget;
  const kind = o.isBatchedMesh ? 'BatchedMesh' : o.isInstancedMesh ? 'InstancedMesh' : o.type;
  const inst = o.isInstancedMesh
    ? { count: o.count, cap: o.instanceMatrix.count, color: !!o.instanceColor, storage: !!o.instanceMatrix.isStorageInstancedBufferAttribute }
    : o.isBatchedMesh
      ? { cap: o.maxInstanceCount ?? o._maxInstanceCount, colors: !!o._colorsTexture }
      : undefined;
  return {
    phase: C.phase,
    pass: m?.isShadowPassMaterial ? 'shadow' : 'colour',
    camera: id(ro.camera, 'C'),
    cameraType: ro.camera?.type,
    target: rt ? rt.texture?.name || rt.name || id(rt, 'T') : null,
    targetSize: rt ? `${rt.width}x${rt.height}` : undefined,
    context: ctx.id,
    mrt: ctx.mrt ? Object.keys(ctx.mrt.outputNodes ?? {}).join(',') || true : false,
    // (What else goes into the node build's key besides the material and geometry: the lights,
    // environment and fog. Two builds of one object that differ only here were built for two
    // light sets.)
    dyn: cyrb53(String(ro.getDynamicCacheKey?.() ?? '')).slice(0, 8),
    lights: ro.lightsNode?.getLights?.()?.length,
    textures: ctx.textures?.length ?? 0,
    scene: id(ro.scene, 'S'),
    passId: ro.passId ?? undefined,
    object: { id: id(o, 'O'), kind, name: o.name || undefined, path: pathOf(o), castShadow: o.castShadow, receiveShadow: o.receiveShadow, inst },
    added: addedBy(o),
    material: material(own),
    override: m && m !== own ? material(m) : undefined,
    geometry: geometry(ro.geometry ?? o.geometry),
  };
}

/**
 * An experiment, not a fix (`--compiles-dedupe`): name each instanced mesh's matrix and colour
 * buffers the same in every shader. Three names an unnamed buffer uniform after its node's id
 * ("NodeBuffer_1825108"), and each instanced mesh has its own buffer node, so two meshes sharing a
 * material and an instance capacity still get two shader texts, so two programs and pipelines.
 */
function dedupe(r) {
  const builder = r.backend.createNodeBuilder(new Mesh(), r);
  let owner = Object.getPrototypeOf(builder);
  while (owner && !Object.prototype.hasOwnProperty.call(owner, 'getUniformFromNode')) owner = Object.getPrototypeOf(owner);
  const get = owner.getUniformFromNode;
  owner.getUniformFromNode = function (node, type, shaderStage, name) {
    const o = this.object;
    if (!name && (type === 'buffer' || type === 'storageBuffer') && o?.isInstancedMesh) {
      if (node.value === o.instanceMatrix?.array || node.value === o.instanceMatrix) name = 'instanceMatrices';
      else if (o.instanceColor && (node.value === o.instanceColor.array || node.value === o.instanceColor)) name = 'instanceColors';
    }
    return get.call(this, node, type, shaderStage, name);
  };
}

function install(r) {
  const P = Object.getPrototypeOf(r._pipelines);
  const N = Object.getPrototypeOf(r._nodes);
  if (P.__hooked) return;
  P.__hooked = true;
  if (globalThis.__COMPILES_DEDUPE) dedupe(r);
  // (Patched on the prototypes: Stage.dryRun overrides `getForRender` on the instance for each dry
  // frame and deletes its override afterwards, which would take an instance patch with it.)
  const getForRender = P.getForRender;
  P.getForRender = function (ro, promises) {
    const t = performance.now();
    const built = C.nodeMs;
    const res = getForRender.call(this, ro, promises);
    const pipe = this.get(ro).pipeline;
    if (pipe && !C.seen.has(pipe)) {
      // (The main thread's share of a new pipeline: shader modules and the pipeline asked for.
      // The GPU process compiles it after this returns.)
      C.ms[`pipelines:${C.phase}`] = (C.ms[`pipelines:${C.phase}`] ?? 0) + performance.now() - t - (C.nodeMs - built);
      const vp = pipe.vertexProgram, fp = pipe.fragmentProgram;
      const newV = !C.seen.has(vp), newF = !C.seen.has(fp);
      C.seen.add(pipe);
      C.seen.add(vp);
      C.seen.add(fp);
      C.events.push({ kind: 'pipeline', newV, newF, cacheKey: pipe.cacheKey, v: prog(vp), f: prog(fp), ...describe(ro) });
    }
    return res;
  };
  const release = P._releaseProgram;
  P._releaseProgram = function (program) {
    C.released.push({ phase: C.phase, kind: 'program', prog: prog(program) });
    return release.call(this, program);
  };
  const releasePipeline = P._releasePipeline;
  P._releasePipeline = function (pipeline) {
    C.released.push({ phase: C.phase, kind: 'pipeline', cacheKey: pipeline.cacheKey });
    return releasePipeline.call(this, pipeline);
  };
  const nodes = N.getForRender;
  N.getForRender = function (ro, useAsync) {
    const key = this.getForRenderCacheKey(ro);
    const had = this.nodeBuilderCache.has(key);
    const t = performance.now();
    const res = nodes.call(this, ro, useAsync);
    const after = () => {
      if (!had && !C.nodeKeys.has(key) && this.nodeBuilderCache.has(key)) {
        // (A node build: the material's graph built and its WGSL generated, on the main thread.)
        const ms = performance.now() - t;
        C.nodeMs += ms;
        C.ms[`nodes:${C.phase}`] = (C.ms[`nodes:${C.phase}`] ?? 0) + ms;
        C.nodeKeys.add(key);
        C.events.push({ kind: 'node', key, ms: Math.round(ms * 10) / 10, ...describe(ro) });
      }
    };
    if (res && typeof res.then === 'function') res.then(after, () => {});
    else after();
    return res;
  };
}

// Install on the renderer as soon as it has its pipelines and node manager (Renderer.init).
let owner = WebGPURenderer.prototype;
while (owner && !Object.prototype.hasOwnProperty.call(owner, 'init')) owner = Object.getPrototypeOf(owner);
const init = owner.init;
owner.init = async function (...a) {
  const res = await init.apply(this, a);
  install(this);
  C.renderer = this;
  return res;
};

/** What the harness writes: every event, the releases, and the renderer's final counts. */
C.dump = (known = {}) => {
  const labels = {};
  for (const [name, x] of Object.entries(known)) if (x && C.ids.has(x)) labels[C.ids.get(x)] = name;
  const r = C.renderer;
  const p = r?._pipelines;
  return {
    labels,
    final: { pipelines: p?.caches?.size ?? null, vertex: p?.programs?.vertex?.size ?? null, fragment: p?.programs?.fragment?.size ?? null, nodeBuilds: r?._nodes?.nodeBuilderCache?.size ?? null },
    ms: Object.fromEntries(Object.entries(C.ms).map(([k, v]) => [k, Math.round(v)])),
    events: C.events,
    released: C.released,
  };
};
