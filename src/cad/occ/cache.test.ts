// The timeline cache: a change rebuilds from the first step it touches, presentation edits
// rebuild nothing, and evicted steps free their OCCT objects. Volumes are checked against
// closed forms so a reused step cannot hide a wrong solid.
import { describe, expect, it } from 'vitest';
import { circles, rect, single, solve, watchHandles, withCircles } from './fixtures';
import type { CadDesign, DesignItem, ExtrudeFeature } from '../design';
import { TimelineCache } from './cache';
import { occ } from './kernel';
import { occMass } from './build';

const { PI } = Math;
const near = (v: number, want: number, rel = 1e-9) => expect(Math.abs(v - want) / Math.abs(want)).toBeLessThan(rel);

/** 100 × 60 × t plate with a Ø20 hole, a 20 × 40 pocket of depth p in its top, a Ø6 bore. */
function plate(): CadDesign {
  return single([
    { kind: 'sketch', id: 's1', name: 'S', plane: { ref: 'XY' }, sketch: withCircles(rect('a', 0, 0, 100, 60), 'h', [[50, 30, 10]]) },
    { kind: 'extrude', id: 'f1', name: 'Plate', sketch: 's1', extent: { type: 'one', d: 't' }, op: 'new' },
    { kind: 'sketch', id: 's2', name: 'P', plane: { ref: 'XY', offset: 't' }, sketch: rect('p', 10, 10, 30, 50) },
    { kind: 'extrude', id: 'f2', name: 'Pocket', sketch: 's2', extent: { type: 'one', d: 'p' }, op: 'cut' },
    { kind: 'sketch', id: 's3', name: 'B', plane: { ref: 'XY', offset: 't' }, sketch: circles('b', [[80, 30, 3]]) },
    { kind: 'extrude', id: 'f3', name: 'Bore', sketch: 's3', extent: { type: 'all' }, op: 'cut' },
  ]);
}

/** Exact volume of plate(): plate less hole, pocket and through bore. */
const plateVolume = (t: number, p: number) => 6000 * t - PI * 100 * t - 800 * p - PI * 9 * t;

function build(cache: TimelineCache, design: CadDesign, t = 10, p = 4) {
  const { numbers } = solve(design, [`t := ${t} mm`, `p := ${p} mm`]);
  const oc = occ()!;
  const b = cache.build(oc, design, numbers);
  return b.components.get('c1')!.bodies.map((x) => occMass(oc, x.solid.shape).V);
}

const edit = (d: CadDesign, id: string, patch: Partial<DesignItem>): CadDesign => ({
  ...d, components: d.components.map((c) => ({ ...c, items: c.items.map((i) => (i.id === id ? ({ ...i, ...patch } as DesignItem) : i)) })),
});

describe('timeline cache', () => {
  it('rebuilds a part from the feature that changed', () => {
    const cache = new TimelineCache();
    const d = plate();
    near(build(cache, d)[0], plateVolume(10, 4));
    expect(cache.ran).toBe(3);
    // a deeper pocket: the pocket and the bore after it, not the plate
    near(build(cache, d, 10, 6)[0], plateVolume(10, 6));
    expect(cache.ran).toBe(5);
    // a thicker plate moves every later sketch plane too: all of it
    near(build(cache, d, 12, 6)[0], plateVolume(12, 6));
    expect(cache.ran).toBe(8);
    // back to an earlier value: still cached
    near(build(cache, d, 10, 4)[0], plateVolume(10, 4));
    expect(cache.ran).toBe(8);
  });

  it('does not rebuild for names, colours, viewports or hidden sketches', () => {
    const cache = new TimelineCache();
    const d = plate();
    build(cache, d);
    const ran = cache.ran;
    let e = edit(d, 'f2', { name: 'Recess' });
    e = edit(e, 's1', { view: { cx: 5, cy: 7, zoom: 3 }, hidden: true } as Partial<DesignItem>);
    e = { ...e, components: e.components.map((c) => ({ ...c, color: '#ff0000', bodyNames: { f1: 'Base' } })) };
    near(build(cache, e)[0], plateVolume(10, 4));
    expect(cache.ran).toBe(ran);
  });

  it('rolls the timeline marker back and forth without rebuilding', () => {
    const cache = new TimelineCache();
    const d = plate();
    build(cache, d);
    const ran = cache.ran;
    const at = (m: number | undefined): CadDesign => ({ ...d, components: d.components.map((c) => ({ ...c, marker: m })) });
    // before the pocket: the plate with its hole
    near(build(cache, at(2))[0], 6000 * 10 - PI * 100 * 10);
    near(build(cache, at(4))[0], 6000 * 10 - PI * 100 * 10 - 800 * 4);
    near(build(cache, at(undefined))[0], plateVolume(10, 4));
    expect(cache.ran).toBe(ran);
  });

  it('rebuilds after an edited sketch, not before it', () => {
    const cache = new TimelineCache();
    const d = plate();
    build(cache, d);
    const ran = cache.ran;
    // a smaller pocket outline: the pocket and the bore after it
    const e = edit(d, 's2', { sketch: rect('p', 10, 10, 30, 30) } as Partial<DesignItem>);
    near(build(cache, e)[0], plateVolume(10, 4) + 20 * 20 * 4);
    expect(cache.ran).toBe(ran + 2);
  });

  it('a failing feature is cached with its error, and fixing it rebuilds from there', () => {
    const cache = new TimelineCache();
    const d = edit(plate(), 'f2', { targets: ['nope'] } as Partial<ExtrudeFeature>);
    const { numbers } = solve(d, ['t := 10 mm', 'p := 4 mm']);
    const b = cache.build(occ()!, d, numbers);
    expect(b.components.get('c1')!.errors.f2).toMatch(/target body/);
    near(occMass(occ()!, b.components.get('c1')!.bodies[0].solid.shape).V, plateVolume(10, 0));
    const ran = cache.ran;
    near(build(cache, plate())[0], plateVolume(10, 4));
    expect(cache.ran).toBe(ran + 2);
  });

  it('evicts the ends of old branches and frees what they built', () => {
    const oc = occ()!;
    const d = plate();
    // the worksheet evaluation builds too (into the shared cache): resolve first, then watch
    const numbers = [2, 3, 4, 5].map((p) => solve(d, ['t := 10 mm', `p := ${p} mm`]).numbers);
    const watch = watchHandles(oc);
    try {
      const cache = new TimelineCache(8);
      numbers.forEach((n, i) => near(occMass(oc, cache.build(oc, d, n).components.get('c1')!.bodies[0].solid.shape).V, plateVolume(10, i + 2)));
      // the latest chain (6 steps) is kept whole; older branch ends went until 8 were left
      expect(cache.size).toBe(8);
      cache.clear();
      expect(watch.undeleted()).toEqual([]);
    } finally {
      watch.stop();
    }
  });
});
