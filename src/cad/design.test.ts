import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initKernel, m4Point } from './solid';
import { setOccEnabled } from './occ/kernel';
import { evaluateWorksheet, type CadResult, type MathResult } from '../engine/evaluator';
import { createRegion, emptyWorksheet, type CadRegion } from '../model/types';
import type { CadSketch } from './model';
import type { CadDesign, DesignItem } from './design';

/** Rectangle x0..x1 × y0..y1 (unconstrained: the solver keeps it where it is). */
function rect(p: string, x0: number, y0: number, x1: number, y1: number): CadSketch {
  const c = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  return {
    points: c.map(([x, y], i) => ({ id: `${p}p${i}`, x, y })),
    entities: c.map((_, i) => ({ id: `${p}l${i}`, type: 'line' as const, p1: `${p}p${i}`, p2: `${p}p${(i + 1) % 4}` })),
    constraints: [],
  };
}
function circleSketch(p: string, cx: number, cy: number, r: number, name?: string): CadSketch {
  return {
    points: [{ id: `${p}c`, x: cx, y: cy }],
    entities: [{ id: `${p}k`, type: 'circle', c: `${p}c`, r }],
    constraints: name ? [{ id: `${p}d`, type: 'diameter', refs: [`${p}k`], value: name, name: `${p}D` }] : [],
  };
}
function pointsSketch(p: string, pts: [number, number][]): CadSketch {
  return {
    points: pts.map(([x, y], i) => ({ id: `${p}q${i}`, x, y })),
    entities: pts.map((_, i) => ({ id: `${p}e${i}`, type: 'point' as const, p: `${p}q${i}` })),
    constraints: [],
  };
}

function part(design: CadDesign, extra: string[] = [], pre: string[] = []) {
  const ws = emptyWorksheet();
  const before = pre.map((s, i) => createRegion('math', 20, 20 + 20 * i, { source: s }));
  const cad = createRegion('cad', 20, 200, { name: 'asm', design, density: '7850 kg/m^3' }) as CadRegion;
  const maths = extra.map((s, i) => createRegion('math', 20, 600 + 20 * i, { source: s }));
  ws.regions = [...before, cad, ...maths];
  const out = evaluateWorksheet(ws);
  const res = out.results.get(cad.id) as CadResult;
  const tex = (i: number) => {
    const m = out.results.get(maths[i].id) as MathResult;
    expect(m.error, extra[i]).toBeUndefined();
    return m.tex;
  };
  return { res, tex };
}

const single = (items: DesignItem[]): CadDesign => ({
  version: 2, components: [{ id: 'c1', name: 'Plate', items }], occurrences: [{ id: 'o1', component: 'c1', grounded: true }], joints: [],
});

beforeAll(async () => {
  await initKernel();
});

// every design builds the same with the B-rep kernel and with the mesh fallback
for (const brep of [true, false]) describe(`designs (${brep ? 'B-rep' : 'mesh'} kernel)`, () => {
  beforeAll(() => setOccEnabled(brep));
  afterAll(() => setOccEnabled(true));

  it('cuts holes and patterns them around an axis', () => {
    const items: DesignItem[] = [
      { kind: 'sketch', id: 's1', name: 'Base', plane: { ref: 'XY' }, sketch: rect('a', -50, -50, 50, 50) },
      { kind: 'extrude', id: 'f1', name: 'Extrude1', sketch: 's1', extent: { type: 'one', d: 'T' }, op: 'new' },
      // sketch on the top face; one point, drilled through, then patterned 4× about Z
      { kind: 'sketch', id: 's2', name: 'Holes', plane: { frame: { o: [0, 0, 10], u: [1, 0, 0], v: [0, 1, 0] } }, sketch: pointsSketch('h', [[30, 0]]) },
      { kind: 'hole', id: 'f2', name: 'Hole1', sketch: 's2', d: '8 mm', depth: '', through: true, style: 'simple' },
      { kind: 'pattern', id: 'f3', name: 'Pattern1', of: 'features', refs: ['f2'], type: 'circ', axis: 'Z', count: '4', spacing: '360 deg' },
      // a pocket from the bottom plane going up (auto direction finds the material)
      { kind: 'sketch', id: 's3', name: 'Pocket', plane: { ref: 'XY' }, sketch: circleSketch('p', 0, 0, 10) },
      { kind: 'extrude', id: 'f4', name: 'Extrude2', sketch: 's3', extent: { type: 'one', d: '4 mm' }, op: 'cut' },
    ];
    const { res, tex } = part(single(items), ['asm.V = cm^3', 'asm.m = g', 'asm.Lz = mm', 'asm.Base.A = cm^2'], ['T := 10 mm']);
    expect(res.featureError).toBeUndefined();
    const want = 100 * 100 * 10 - 4 * Math.PI * 16 * 10 - Math.PI * 100 * 4;
    expect(res.mass!.V / want).toBeCloseTo(1, 3);
    expect(res.mass!.m! / (want * 7850e-9)).toBeCloseTo(1, 3);
    expect(res.mass!.xg).toBeCloseTo(0, 3);
    expect(res.mass!.yg).toBeCloseTo(0, 3);
    expect(tex(0)).toMatch(/9\d\.\d/);
    expect(tex(2)).toContain('10');
    expect(tex(3)).toContain('100');
  });

  it('mirrors and combines bodies; revolves about a sketch line', () => {
    const items: DesignItem[] = [
      { kind: 'sketch', id: 's1', name: 'Arm', plane: { ref: 'XY' }, sketch: rect('a', 10, 0, 40, 10) },
      { kind: 'extrude', id: 'f1', name: 'Extrude1', sketch: 's1', extent: { type: 'symmetric', d: '10' }, op: 'new' },
      { kind: 'mirror', id: 'f2', name: 'Mirror1', of: 'bodies', refs: ['f1'], plane: 'YZ' },
      { kind: 'combine', id: 'f3', name: 'Combine1', target: 'f1', tools: ['f2.1.f1'], op: 'join' },
      // a ring revolved about the sketch y axis on the front plane
      { kind: 'sketch', id: 's2', name: 'Ring', plane: { ref: 'XZ' }, sketch: rect('r', 50, -2, 60, 2) },
      { kind: 'revolve', id: 'f4', name: 'Revolve1', sketch: 's2', axis: 'y', angle: '360', op: 'new' },
    ];
    const { res } = part(single(items));
    expect(res.featureError).toBeUndefined();
    const bodies = res.design!.bodies.c1;
    expect(bodies.map((b) => b.name)).toEqual(['Body1', 'Body3']);
    expect(bodies[0].mass!.V / (2 * 30 * 10 * 10)).toBeCloseTo(1, 4);
    // sketch y on XZ is world Z: the ring lies flat around Z
    const ring = bodies[1].mass!;
    expect(ring.V / (Math.PI * (60 ** 2 - 50 ** 2) * 4)).toBeCloseTo(1, 3);
    expect(ring.Izz).toBeGreaterThan(ring.Ixx);
  });

  it('places occurrences with joints driven from the worksheet', () => {
    const design: CadDesign = {
      version: 2,
      components: [
        { id: 'base', name: 'Base', items: [
          { kind: 'sketch', id: 'b1', name: 'BaseSketch', plane: { ref: 'XY' }, sketch: { ...rect('b', 0, 0, 100, 40), points: [...rect('b', 0, 0, 100, 40).points, { id: 'pin', x: 80, y: 20 }], entities: [...rect('b', 0, 0, 100, 40).entities, { id: 'pinE', type: 'point', p: 'pin' }] } },
          { kind: 'extrude', id: 'bf', name: 'Extrude1', sketch: 'b1', extent: { type: 'one', d: '10' }, op: 'new' },
        ] },
        { id: 'arm', name: 'Arm', items: [
          { kind: 'sketch', id: 'a1', name: 'ArmSketch', plane: { ref: 'XY' }, sketch: { ...rect('a', 0, -5, 60, 5), points: [...rect('a', 0, -5, 60, 5).points, { id: 'piv', x: 0, y: 0 }] } },
          { kind: 'extrude', id: 'af', name: 'Extrude1', sketch: 'a1', extent: { type: 'one', d: '5' }, op: 'new' },
        ] },
      ],
      occurrences: [{ id: 'o1', component: 'base', grounded: true }, { id: 'o2', component: 'arm', pos: [500, 0, 0] }],
      joints: [{
        id: 'j1', name: 'Rev1', type: 'revolute',
        a: { occ: 'o1', origin: { kind: 'point', sketch: 'b1', point: 'pin' } },
        b: { occ: 'o2', origin: { kind: 'point', sketch: 'a1', point: 'piv' } },
        angle: 'φ', offset: '10 mm',
      }],
    };
    const { res, tex } = part(design, ['asm.Rev1 = deg', 'asm.Arm.m = g', 'asm.m = g'], ['φ := 90 deg']);
    expect(res.featureError).toBeUndefined();
    const M = res.design!.placements.o2;
    expect(M.by).toBe('joint');
    // the arm's far end (60, 0, 0) swings to the pin + 60 along +Y, lifted onto the base top
    const p = m4Point(M.matrix, [60, 0, 0]);
    expect(p.map((v) => +v.toFixed(6))).toEqual([80, 80, 10]);
    expect(tex(0)).toContain('90');
    expect(tex(1)).toContain('23.55'); // 3 cm³ · 7.85 g/cm³
    const mTotal = (100 * 40 * 10 + 60 * 10 * 5) * 7850e-9;
    expect(res.mass!.m!).toBeCloseTo(mTotal, 9);
    // centre of mass: arm centre at (80, 50, 12.5)
    expect(res.mass!.yg).toBeCloseTo((100 * 40 * 10 * 20 + 3000 * 50) / 43000, 6);
  });

  it('keeps exact properties for single extrudes and reports bad features', () => {
    const items: DesignItem[] = [
      { kind: 'sketch', id: 's1', name: 'S', plane: { ref: 'XY', offset: '5 mm' }, sketch: circleSketch('c', 0, 0, 10, 'D') },
      { kind: 'extrude', id: 'f1', name: 'Extrude1', sketch: 's1', extent: { type: 'one', d: '20' }, op: 'new' },
      { kind: 'extrude', id: 'f2', name: 'Extrude2', sketch: 's1', extent: { type: 'one', d: '-3' }, op: 'join' },
    ];
    const { res } = part(single(items), [], ['D := 20 mm']);
    expect(res.mass!.V).toBeCloseTo(Math.PI * 100 * 20, 9);
    expect(res.mass!.zg).toBeCloseTo(15, 9);
    expect(res.featureError).toMatch(/Extrude2: the distance must be positive/);
  });
});
