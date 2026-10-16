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

  it('ignore where a dimension text sits, not its value or a plane offset', () => {
    const dim = (offset?: { x: number; y: number }, value = '10'): DesignSketch => {
      const s = sketch('s1');
      return { ...s, sketch: { ...s.sketch, constraints: [{ id: 'k1', type: 'length', refs: ['l0'], value, ...(offset ? { offset } : {}) }] } };
    };
    const at = (s: DesignSketch) => (id: string) => (id === 's1' ? s : undefined);
    const f = extrude('f1', 's1');
    const a = stepKey('root', f, numbers(), at(dim()));
    expect(stepKey('root', f, numbers(), at(dim({ x: 4, y: -12 })))).toBe(a);
    expect(stepKey('root', dim({ x: 4, y: -12 }), numbers(), find)).toBe(stepKey('root', dim(), numbers(), find));
    expect(designKey(design([dim({ x: 0, y: 30 }), f]), numbers())).toBe(designKey(design([dim(), f]), numbers()));
    // the value drives the solve (its result is in the numbers), but a changed value still shows
    expect(stepKey('root', f, numbers(), at(dim(undefined, '12')))).not.toBe(a);
    // an offset plane is geometry
    const off: DesignSketch = { ...sketch('s1'), plane: { ref: 'XY', offset: '5' } };
    expect(stepKey('root', off, numbers(), find)).not.toBe(stepKey('root', sketch('s1'), numbers(), find));
  });

  it('a sketch step ignores whether the sketch is hidden, not its curves', () => {
    const s = sketch('s1');
    expect(stepKey('root', { ...s, hidden: true }, numbers(), find)).toBe(stepKey('root', s, numbers(), find));
    const more: DesignSketch = { ...s, sketch: { ...s.sketch, points: [...s.sketch.points, { id: 'p2', x: 5, y: 5 }], entities: [...s.sketch.entities, { id: 'l1', type: 'line', p1: 'p1', p2: 'p2' }] } };
    expect(stepKey('root', more, numbers(), find)).not.toBe(stepKey('root', s, numbers(), find));
  });

  it('a construction plane hidden in the view keeps its key (the features after it need no rebuild); its offset does not', () => {
    const p: DesignItem = { kind: 'plane', id: 'p1', name: 'Plane1', def: { type: 'offset', plane: 'XY', d: '5' } };
    expect(stepKey('root', { ...p, hidden: true }, numbers(), find)).toBe(stepKey('root', p, numbers(), find));
    expect(stepKey('root', { ...p, def: { type: 'offset', plane: 'XY', d: '6' } }, numbers(), find)).not.toBe(stepKey('root', p, numbers(), find));
  });

  it('ignore the positions a sketch stores: the solved geometry in the numbers counts', () => {
    // the page writes the solution back into the stored sketch: same numbers, same solid
    const circ = (x: number, r: number): DesignSketch => ({
      ...sketch('s1', x), sketch: { ...sketch('s1', x).sketch, points: [...sketch('s1', x).sketch.points, { id: 'c', x: 0, y: 0 }], entities: [...sketch('s1', x).sketch.entities, { id: 'k', type: 'circle', c: 'c', r }] },
    });
    const at = (s: DesignSketch) => (id: string) => (id === 's1' ? s : undefined);
    const f = extrude('f1', 's1');
    expect(stepKey('root', circ(20, 7), numbers(), find)).toBe(stepKey('root', circ(10, 3), numbers(), find));
    expect(stepKey('root', f, numbers(), at(circ(20, 7)))).toBe(stepKey('root', f, numbers(), at(circ(10, 3))));
    expect(designKey(design([circ(20, 7), f]), numbers())).toBe(designKey(design([circ(10, 3), f]), numbers()));
  });

  it('read solved geometry to 1e-9: solver noise keeps the key, a real change does not', () => {
    const f = extrude('f1', 's1');
    const k = designKey(design([sketch('s1'), f]), numbers(10));
    const s = stepKey('root', f, numbers(10), find);
    // a solve started elsewhere lands an ulp or a few away (1.3e-15 for a zero in the example)
    for (const x of [10 + 1.8e-15, 10 - 3.6e-15, 10 + 2e-12]) {
      expect(designKey(design([sketch('s1'), f]), numbers(x))).toBe(k);
      expect(stepKey('root', f, numbers(x), find)).toBe(s);
    }
    const n = numbers();
    n.sketches.s1.points.p0 = [1.29e-15, -0];
    expect(designKey(design([sketch('s1'), f]), n)).toBe(k);
    // a micrometre in a millimetre sketch is geometry
    expect(designKey(design([sketch('s1'), f]), numbers(10.001))).not.toBe(k);
    expect(stepKey('root', f, numbers(10 + 1e-6), find)).not.toBe(s);
  });

  it('knows which sketches an item reads', () => {
    expect(sketchesOf(extrude('f1', 's1'))).toEqual(['s1']);
    expect(sketchesOf({ kind: 'loft', id: 'l', name: 'L', sketch: 's1', sketch2: 's2', op: 'new' })).toEqual(['s1', 's2']);
    expect(sketchesOf({ kind: 'mirror', id: 'm', name: 'M', of: 'bodies', refs: [], plane: 'XZ' })).toEqual([]);
    expect(sketchesOf({ kind: 'mirror', id: 'm', name: 'M', of: 'bodies', refs: [], plane: 's2' })).toEqual(['s2']);
    expect(sketchesOf({ kind: 'pattern', id: 'p', name: 'P', of: 'features', refs: [], type: 'rect', axis: 's1/l0', axis2: 'Z', count: '2', spacing: '5' })).toEqual(['s1']);
    expect(sketchesOf(sketch('s1'))).toEqual([]);
    // modify features: a sketch's plane or line, not an origin plane or a picked face
    const face = { kind: 'face' as const, body: 'f1', key: 'f1/end', hint: { p: [0, 0, 0] as [number, number, number], type: 'plane' as const } };
    expect(sketchesOf({ kind: 'split', id: 'q', name: 'Q', body: 'f1', plane: 's2' })).toEqual(['s2']);
    expect(sketchesOf({ kind: 'split', id: 'q', name: 'Q', body: 'f1', plane: face })).toEqual([]);
    expect(sketchesOf({ kind: 'draft', id: 'd', name: 'D', faces: [face], plane: 'XY', pull: 's1/l0', angle: '3' })).toEqual(['s1']);
    expect(sketchesOf({ kind: 'move', id: 'm', name: 'M', bodies: ['f1'], axis: 's2/l0', angle: '90' })).toEqual(['s2']);
    expect(sketchesOf({ kind: 'fillet', id: 'r', name: 'R', sets: [{ edges: [], r: '2' }] })).toEqual([]);
  });

  it('a step key changes with the part unit (its messages say sizes in it)', () => {
    const find = (id: string) => (id === 's1' ? sketch('s1') : undefined);
    const f = extrude('f1', 's1');
    expect(stepKey('root', f, { ...numbers(), unit: 'cm' }, find)).not.toBe(stepKey('root', f, { ...numbers(), unit: 'mm' }, find));
  });
});
