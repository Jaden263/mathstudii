// Keys of built designs and timeline steps: what must rebuild and what must not.
import { describe, expect, it } from 'vitest';
import { designKey, hashString, sketchesOf, stepKey } from './keys';
import type { CadDesign, DesignItem, DesignNumbers, DesignSketch } from './design';

const sketch = (id: string, x = 10): DesignSketch => ({
  kind: 'sketch', id, name: id, plane: { ref: 'XY' },
  sketch: { points: [{ id: 'p0', x: 0, y: 0 }, { id: 'p1', x, y: 0 }], entities: [{ id: 'l0', type: 'line', p1: 'p0', p2: 'p1' }], constraints: [] },
});
const extrude = (id: string, s: string): DesignItem => ({ kind: 'extrude', id, name: id, sketch: s, extent: { type: 'one', d: '10' }, op: 'new' });

function numbers(x = 10, d = 10): DesignNumbers {
  const frame = { o: [0, 0, 0] as [number, number, number], u: [1, 0, 0] as [number, number, number], v: [0, 1, 0] as [number, number, number], n: [0, 0, 1] as [number, number, number] };
  return {
    sketches: { s1: { points: { p0: [0, 0], p1: [x, 0] }, radii: {} }, s2: { points: { p0: [0, 0], p1: [5, 0] }, radii: {} } },
    frames: { s1: frame, s2: frame },
    params: { f1: { d }, f2: { d: 3 } },
    errors: {},
  };
}

const design = (items: DesignItem[]): CadDesign => ({ version: 2, components: [{ id: 'c1', name: 'P', items }], occurrences: [{ id: 'o1', component: 'c1' }], joints: [] });

describe('design keys', () => {
  it('hash: the same text gives the same key, no collisions over many near-identical texts', () => {
    expect(hashString('flange')).toBe(hashString('flange'));
    expect(hashString('flange')).toMatch(/^[0-9a-f]{14}$/);
    const seen = new Set<string>();
    for (let i = 0; i < 20000; i++) seen.add(hashString(`{"d":${i}}`));
    expect(seen.size).toBe(20000);
  });

  it('the design key ignores viewports and colours but not geometry or names', () => {
    const base = design([sketch('s1'), extrude('f1', 's1')]);
    const k = designKey(base, numbers());
    const viewed = design([{ ...sketch('s1'), view: { cx: 3, cy: 4, zoom: 2 } }, extrude('f1', 's1')]);
    expect(designKey(viewed, numbers())).toBe(k);
    expect(designKey({ ...base, components: [{ ...base.components[0], color: '#123456' }] }, numbers())).toBe(k);
    // a resolved depth, a solved point, a body name: all show in the built design
    expect(designKey(base, numbers(10, 12))).not.toBe(k);
    expect(designKey(base, numbers(11))).not.toBe(k);
    expect(designKey({ ...base, components: [{ ...base.components[0], bodyNames: { f1: 'Base' } }] }, numbers())).not.toBe(k);
  });
});

describe('timeline step keys', () => {
  const find = (id: string) => (id === 's1' ? sketch('s1') : id === 's2' ? sketch('s2') : undefined);

  it('chain the keys of the steps before', () => {
    const n = numbers();
    const a = stepKey('root', extrude('f1', 's1'), n, find);
    expect(stepKey('root', extrude('f1', 's1'), n, find)).toBe(a);
    expect(stepKey('other', extrude('f1', 's1'), n, find)).not.toBe(a);
  });

  it('change with the parameters and the sketches a feature reads, not with its name', () => {
    const f = extrude('f1', 's1');
    const a = stepKey('root', f, numbers(), find);
    expect(stepKey('root', { ...f, name: 'Base plate' }, numbers(), find)).toBe(a);
    expect(stepKey('root', f, numbers(10, 11), find)).not.toBe(a);
    // the sketch it extrudes was solved differently
    expect(stepKey('root', f, numbers(12), find)).not.toBe(a);
    // a feature on another sketch does not care about s1's solution
    const g = extrude('f2', 's2');
    expect(stepKey('root', g, numbers(12), find)).toBe(stepKey('root', g, numbers(10), find));
  });

  it('a sketch step ignores whether the sketch is hidden', () => {
    const s = sketch('s1');
    expect(stepKey('root', { ...s, hidden: true }, numbers(), find)).toBe(stepKey('root', s, numbers(), find));
    expect(stepKey('root', sketch('s1', 20), numbers(), find)).not.toBe(stepKey('root', s, numbers(), find));
  });

  it('knows which sketches an item reads', () => {
    expect(sketchesOf(extrude('f1', 's1'))).toEqual(['s1']);
    expect(sketchesOf({ kind: 'loft', id: 'l', name: 'L', sketch: 's1', sketch2: 's2', op: 'new' })).toEqual(['s1', 's2']);
    expect(sketchesOf({ kind: 'mirror', id: 'm', name: 'M', of: 'bodies', refs: [], plane: 'XZ' })).toEqual([]);
    expect(sketchesOf({ kind: 'mirror', id: 'm', name: 'M', of: 'bodies', refs: [], plane: 's2' })).toEqual(['s2']);
    expect(sketchesOf({ kind: 'pattern', id: 'p', name: 'P', of: 'features', refs: [], type: 'rect', axis: 's1/l0', axis2: 'Z', count: '2', spacing: '5' })).toEqual(['s1']);
    expect(sketchesOf(sketch('s1'))).toEqual([]);
  });
});
