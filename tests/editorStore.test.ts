import { beforeEach, describe, expect, it } from 'vitest';
import { hexCenter } from '../src/engine/board';
import { MAX_LAND, blankMap, centreOf, hexagon, translate, type CustomMap } from '../src/engine/maps/custom';
import { MAX_RIVER_LEN, parseCustomMap } from '../src/engine/maps/custom';
import { canvasSize, crop, fillGaps, inGrid, resize, riverAt, toggleHome } from '../src/ui/editor/model';
import { applyTool, useEditor } from '../src/ui/editor/store';

/** The tool used at a cell's centre, as a press (or, with `carry`, a drag carrying a stroke on). */
const at = (q: number, r: number, carry = false) => applyTool(...hexCenter(q, r), carry);
const terrainAt = (q: number, r: number) => useEditor.getState().map.hexes.find((h) => h.q === q && h.r === r)?.terrain;

describe('the map editor', () => {
  beforeEach(() => {
    useEditor.setState({ map: blankMap('Test', 3, 2), past: [], future: [], preview: null, drawing: null, brush: 1, symmetry: 1, tool: { kind: 'terrain', terrain: 'forest' } });
  });

  it('keeps rivers and home islands within what the reader accepts', () => {
    // A strip of land along the middle row: a river stops at the longest the board check allows.
    let map = blankMap('Long', 5, 5);
    let drawing: number | null = null;
    for (let q = -5; q <= 5; q++) {
      const res = riverAt(map, q, 0, drawing);
      if (res?.refused) {
        expect(q).toBe(-5 + MAX_RIVER_LEN);
        break;
      }
      if (res) ({ map, drawing } = res);
    }
    expect(map.rivers?.[0].path).toHaveLength(MAX_RIVER_LEN);
    // Five islands can't all be home: the fifth mark is refused, and the map still reads back.
    let homes: CustomMap = { ...blankMap('Homes', 5, 5), hexes: [] };
    homes = { ...homes, hexes: [-8, -4, 0, 4, 8].map((q) => ({ q, r: 0, terrain: 'hills' as const })) };
    let made: CustomMap | null = homes;
    for (const q of [-8, -4, 0, 4]) made = toggleHome(made!, q, 0);
    expect(made?.home).toHaveLength(4);
    expect(toggleHome(made!, 8, 0)).toBeNull();
    expect(parseCustomMap(JSON.parse(JSON.stringify(made)))).not.toBeNull();
  });

  it('undoes a drag stroke in one step, however many cells it crossed', () => {
    at(0, 0);
    at(1, 0, true);
    at(2, 0, true);
    expect(useEditor.getState().past).toHaveLength(1);
    expect([terrainAt(0, 0), terrainAt(1, 0), terrainAt(2, 0)]).toEqual(['forest', 'forest', 'forest']);
    useEditor.getState().undo();
    expect([terrainAt(0, 0), terrainAt(1, 0), terrainAt(2, 0)]).not.toContain('forest');
  });

  it('gives each press a step of its own', () => {
    at(0, 0);
    at(1, 0);
    expect(useEditor.getState().past).toHaveLength(2);
  });

  it('takes back the expansion a feature brought in with the feature', () => {
    useEditor.setState({ modules: [], tool: { kind: 'well' } });
    at(0, 0);
    expect(useEditor.getState().modules).toContain('oil');
    useEditor.getState().undo();
    expect(useEditor.getState().modules).not.toContain('oil');
    useEditor.getState().redo();
    expect(useEditor.getState().modules).toContain('oil');
  });

  it('keeps the name as typed through undo and redo', () => {
    at(0, 0);
    useEditor.setState({ map: { ...useEditor.getState().map, name: 'Renamed' } });
    useEditor.getState().undo();
    expect(useEditor.getState().map.name).toBe('Renamed');
    expect(terrainAt(0, 0)).not.toBe('forest');
  });

  it('only ends a preview with a press during one, editing nothing', () => {
    useEditor.setState({ preview: 7 });
    at(0, 0);
    expect(useEditor.getState().preview).toBeNull();
    expect(useEditor.getState().past).toHaveLength(0);
  });

  it('paints nothing with the rest of a drag whose press only ended a preview', () => {
    useEditor.setState({ preview: 7 });
    at(0, 0);
    at(1, 0, true);
    expect(useEditor.getState().past).toHaveLength(0);
    expect(terrainAt(1, 0)).not.toBe('forest');
  });

  it('lays the fog along a stroke begun on an empty cell, whatever the last stroke did, as sea under the fog', () => {
    const hidden = (q: number, r: number) => !!useEditor.getState().map.hexes.find((h) => h.q === q && h.r === r)?.hidden;
    useEditor.setState({ tool: { kind: 'fog' } });
    // A tap that lifts the fog off a cell, then a stroke from off the map's cells onto them.
    at(0, 0);
    at(0, 0);
    expect(hidden(0, 0)).toBe(false);
    const empty = [-4, 0] as const;
    expect(terrainAt(...empty)).toBeUndefined();
    at(...empty);
    at(-3, 0, true);
    at(-2, 0, true);
    expect([hidden(...empty), hidden(-3, 0), hidden(-2, 0)]).toEqual([true, true, true]);
    expect(terrainAt(...empty)).toBe('sea');
    // A stroke pressed on the fog lifts it all the way.
    at(-2, 0);
    at(-3, 0, true);
    expect([hidden(-3, 0), hidden(-2, 0)]).toEqual([false, false]);
  });

  it('keeps the fog off the features that are seen from the start', () => {
    useEditor.setState({ tool: { kind: 'terrain', terrain: 'lake' } });
    at(0, 0);
    useEditor.setState({ tool: { kind: 'fog' } });
    at(0, 0);
    expect(useEditor.getState().map.hexes.find((h) => h.q === 0 && h.r === 0)?.hidden).toBeUndefined();
  });

  it('leaves a hex to the deal with Dealt, turning the deal on', () => {
    at(0, 0);
    useEditor.setState({ tool: { kind: 'number', n: 'deal' } });
    expect(useEditor.getState().map.deal).toBeFalsy();
    at(0, 0);
    expect(useEditor.getState().map.deal).toBe(true);
  });

  it('puts a harbour’s images round the middle only where they are coast too', () => {
    // A lone hex off the middle: its images land on open sea, where no harbour may stand.
    useEditor.setState({ map: { ...blankMap('Lone', 3, 3), hexes: [{ q: 0, r: 0, terrain: 'sea' }, { q: 1, r: 0, terrain: 'sea' }, { q: -1, r: 0, terrain: 'sea' }, { q: 0, r: 1, terrain: 'sea' }, { q: 0, r: -1, terrain: 'sea' }, { q: 1, r: -1, terrain: 'sea' }, { q: -1, r: 1, terrain: 'sea' }, { q: 2, r: 0, terrain: 'hills' }] }, symmetry: 3, tool: { kind: 'port', type: 'any' } });
    const [x, z] = hexCenter(2, 0);
    applyTool(x + 0.8, z);
    const ports = useEditor.getState().map.ports;
    expect(ports.length).toBeGreaterThan(0);
    for (const p of ports) expect(useEditor.getState().map.hexes.find((h) => h.q === p.q && h.r === p.r)?.terrain).toBe('hills');
  });

  it("starts a new step for a stroke whose first cell changed nothing, rather than joining the last press's", () => {
    at(0, 0);
    // (Off the grid: nothing painted, and the stroke carries on onto the map.)
    at(9, 0);
    at(1, 0, true);
    at(2, 0, true);
    expect(useEditor.getState().past).toHaveLength(2);
    useEditor.getState().undo();
    expect(terrainAt(0, 0)).toBe('forest');
    expect(terrainAt(1, 0)).not.toBe('forest');
  });
});

describe('the editor’s templates', () => {
  it('deal the random island one desert, as the classic game has', async () => {
    const { TEMPLATES } = await import('../src/ui/editor/templates');
    const { dealMap } = await import('../src/engine/maps/custom');
    const { Rng } = await import('../src/engine/rng');
    const map = TEMPLATES.find((t) => t.id === 'random')!.make();
    for (const seed of [1, 2, 3, 4, 5]) expect(dealMap(map, new Rng(seed)).hexes.filter((h) => h.terrain === 'desert')).toHaveLength(1);
  });
});

describe('the growing grid', () => {
  const count = () => useEditor.getState().map.hexes.length;
  const mapNow = () => useEditor.getState().map;
  const sea = (q: number, r: number) => ({ q, r, terrain: 'sea' as const });
  const reset = (map = blankMap('Test', 3, 2)) => useEditor.setState({ map, past: [], future: [], preview: null, drawing: null, brush: 1, symmetry: 1, tool: { kind: 'terrain', terrain: 'forest' }, note: null });
  beforeEach(() => reset());

  it('offers the cells listed and two rings round them, and grows as they are painted', () => {
    expect(inGrid(mapNow(), 5, 0)).toBe(true);
    expect(inGrid(mapNow(), 6, 0)).toBe(false);
    // Painting past the edge adds the cell, and the grid grows by a ring with it.
    at(5, 0);
    expect(terrainAt(5, 0)).toBe('forest');
    expect(inGrid(mapNow(), 7, 0)).toBe(true);
    at(7, 0);
    expect(terrainAt(7, 0)).toBe('forest');
    // A press three rings from anything is off the grid: nothing happens.
    const before = mapNow();
    at(11, 0);
    expect(mapNow()).toBe(before);
  });

  it('paints a stroke past the edge as one step, and takes the growth back with undo and redo', () => {
    const start = count();
    at(4, 0);
    at(5, 0, true);
    at(6, 0, true);
    at(7, 0, true);
    expect(useEditor.getState().past).toHaveLength(1);
    expect(count()).toBe(start + 4);
    expect(inGrid(mapNow(), 9, 0)).toBe(true);
    useEditor.getState().undo();
    expect(count()).toBe(start);
    expect(inGrid(mapNow(), 6, 0)).toBe(false);
    useEditor.getState().redo();
    expect(count()).toBe(start + 4);
    expect(terrainAt(7, 0)).toBe('forest');
  });

  it('writes the map in the newer format only while it is past the old limits', () => {
    expect(mapNow().v).toBe(2);
    for (const q of [4, 5, 6]) at(q, 0);
    expect(mapNow().v).toBe(3);
    // (Undone to radius 5, it is version 2 again.)
    useEditor.getState().undo();
    expect(mapNow().v).toBe(2);
  });

  it('stops at the reach maps have from the middle, and says why', () => {
    reset({ v: 3, name: 'Far', ports: [], hexes: [sea(0, 0), ...Array.from({ length: 16 }, (_, i) => sea(i + 1, 0))] });
    expect(inGrid(mapNow(), 16, 0)).toBe(true);
    expect(inGrid(mapNow(), 17, 0)).toBe(false);
    at(17, 0);
    expect(terrainAt(17, 0)).toBeUndefined();
    expect(useEditor.getState().note?.text).toMatch(/16 hexes from its middle/);
  });

  it('refuses land past the most an island holds, and cells past the most a map lists', () => {
    const land = hexagon(4).map(([q, r]) => ({ q, r, terrain: 'pasture' as const }));
    reset({ v: 3, name: 'Full', ports: [], hexes: [...land, sea(5, 0)] });
    expect(land).toHaveLength(MAX_LAND);
    at(5, 0);
    expect(terrainAt(5, 0)).toBe('sea');
    expect(useEditor.getState().note?.text).toMatch(/at most 61 land/);
  });

  it('turns a symmetry about the middle of the map, wherever that is', () => {
    reset(translate(blankMap('Off', 3, 2), 6, -3));
    useEditor.setState({ symmetry: 2, tool: { kind: 'terrain', terrain: 'hills' } });
    at(8, -3);
    expect([terrainAt(8, -3), terrainAt(4, -3)]).toEqual(['hills', 'hills']);
    // And in the middle of a map the origin isn't: the image of (8,-3) about (6,-3) is (4,-3).
    expect(centreOf(mapNow())).toEqual([6, -3]);
  });

  it('lays a canvas of the size asked for, open water in what the map lacks, and refuses it when land is in the way', () => {
    const start = canvasSize(mapNow());
    const wider = resize(mapNow(), start.cols + 2, start.rows)!;
    expect(wider.hexes.length).toBeGreaterThan(count());
    expect(canvasSize(wider).cols).toBe(start.cols + 2);
    expect(wider.hexes.filter((h) => h.terrain !== 'sea').length).toBe(mapNow().hexes.filter((h) => h.terrain !== 'sea').length);
    // Smaller: the open water goes; the land (a radius-2 island needs 5 across and 5 high) must stay.
    expect(resize(mapNow(), 5, 5)).not.toBeNull();
    expect(resize(mapNow(), 4, 5)).toBeNull();
    expect(resize(mapNow(), 40, 5)).toBeNull();
    // Through the editor, as one step to undo.
    useEditor.getState().edit((m) => resize(m, start.cols + 2, start.rows));
    expect(canvasSize(mapNow()).cols).toBe(start.cols + 2);
    useEditor.getState().undo();
    expect(canvasSize(mapNow())).toEqual(start);
  });

  it('crops open water far from the land, keeping the sea between islands, and centres what is left', () => {
    const island = blankMap('Isles', 2, 1);
    const far = [sea(9, 0), sea(10, 0), sea(11, 0)];
    const m = { ...island, hexes: [...island.hexes, ...far, ...hexagon(1).map(([q, r]) => ({ q: q + 6, r, terrain: 'forest' as const }))] };
    const cropped = crop(m);
    expect(cropped.hexes.length).toBeLessThan(m.hexes.length);
    // The fishing ground and the corsair's water stay wherever they lie; plain open water beyond a ring of the land goes.
    expect(cropped.hexes.filter((h) => h.terrain === 'forest')).toHaveLength(7);
    expect(crop(cropped)).toEqual(cropped);
    const across = cropped.hexes.map((h) => Math.sqrt(3) * (h.q + h.r / 2));
    expect(Math.abs(Math.min(...across) + Math.max(...across))).toBeLessThanOrEqual(Math.sqrt(3) + 1e-9);
    // Through the editor: one step, undone whole.
    useEditor.setState({ map: m });
    useEditor.getState().edit((x) => crop(x));
    expect(count()).toBe(cropped.hexes.length);
    useEditor.getState().undo();
    expect(count()).toBe(m.hexes.length);
  });

  it('fills the gaps of nothing between islands with sea, and nothing outside their outline', () => {
    const left = hexagon(1).map(([q, r]) => ({ q: q - 4, r, terrain: 'forest' as const }));
    const right = hexagon(1).map(([q, r]) => ({ q: q + 4, r, terrain: 'hills' as const }));
    const m: CustomMap = { v: 2, name: 'Two', ports: [], hexes: [...left, ...right] };
    const filled = fillGaps(m);
    const cell = (q: number, r: number) => filled.hexes.find((h) => h.q === q && h.r === r);
    expect(cell(0, 0)?.terrain).toBe('sea');
    expect(cell(-1, 0)?.terrain).toBe('sea');
    // Far from the outline's inside: not added.
    expect(cell(0, 4)).toBeUndefined();
    expect(cell(-4, 0)?.terrain).toBe('forest');
    expect(fillGaps(filled)).toBe(filled);
  });
});
