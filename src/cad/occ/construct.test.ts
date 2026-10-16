// Construction planes, axes and points: where each type puts its plane, axis or point on a
// box and a boss whose sizes are worksheet values, before and after an upstream edit (the
// references find their faces, edges and vertices again), and features that use them.
import { describe, expect, it } from 'vitest';
import { circles, single, solve, volumes, watchHandles } from './fixtures';
import { occ } from './kernel';
import { buildResultOcc } from './result';
import { buildDesignOcc } from './build';
import type { CadDesign, ConstructItem, Datum, DesignItem, PlaneDef } from '../design';
import type { BodyResult } from '../buildResult';
import type { CadSketch } from '../model';
import { refTo, type TopoRef } from '../topology';
import type { Vec3 } from '../solid';

const { PI, cos, sin, SQRT1_2 } = Math;
const close = (v: Vec3, want: Vec3, tol = 1e-9) => expect(Math.hypot(v[0] - want[0], v[1] - want[1], v[2] - want[2])).toBeLessThan(tol);
/** Two unit normals equal, or opposite when `either`. */
const sameDir = (v: Vec3, want: Vec3, either = false) => {
  const d = v[0] * want[0] + v[1] * want[1] + v[2] * want[2];
  expect(either ? Math.abs(d) : d).toBeGreaterThan(1 - 1e-9);
};
/** A point lies on the plane of a datum. */
const onPlane = (d: Datum, p: Vec3) => {
  if (d.kind !== 'plane') throw new Error('not a plane');
  const { o, n } = d.frame;
  expect(Math.abs((p[0] - o[0]) * n[0] + (p[1] - o[1]) * n[1] + (p[2] - o[2]) * n[2])).toBeLessThan(1e-9);
};

/** An L × 60 rectangle from the origin, fully defined: L a worksheet value. */
function base(): CadSketch {
  const pts: [number, number][] = [[0, 0], [100, 0], [100, 60], [0, 60]];
  return {
    points: pts.map(([x, y], i) => ({ id: `r${i}`, x, y })),
    entities: pts.map((_, i) => ({ id: `rl${i}`, type: 'line' as const, p1: `r${i}`, p2: `r${(i + 1) % 4}` })),
    constraints: [
      { id: 'k0', type: 'fix', refs: ['r0'], at: { x: 0, y: 0 } },
      { id: 'k1', type: 'horizontal', refs: ['rl0'] }, { id: 'k2', type: 'horizontal', refs: ['rl2'] },
      { id: 'k3', type: 'vertical', refs: ['rl1'] }, { id: 'k4', type: 'vertical', refs: ['rl3'] },
      { id: 'k5', type: 'length', refs: ['rl0'], value: 'L' }, { id: 'k6', type: 'length', refs: ['rl1'], value: '60' },
    ],
  };
}

/** A box L × 60 × h from the origin (Extrude1, body f1) with a boss of radius R and height 10 centred on its top at (30, 30). */
const part = (): DesignItem[] => [
  { kind: 'sketch', id: 's1', name: 'Base', plane: { ref: 'XY' }, sketch: base() },
  { kind: 'extrude', id: 'f1', name: 'Box', sketch: 's1', extent: { type: 'one', d: 'h' }, op: 'new' },
  {
    kind: 'sketch', id: 's2', name: 'BossSketch', plane: { ref: 'XY', offset: 'h' },
    sketch: { ...circles('b', [[30, 30, 10]]), constraints: [{ id: 'bf', type: 'fix', refs: ['bc0'], at: { x: 30, y: 30 } }, { id: 'br', type: 'radius', refs: ['bk0'], value: 'R' }] },
  },
  { kind: 'extrude', id: 'f2', name: 'Boss', sketch: 's2', extent: { type: 'one', d: '10' }, op: 'join' },
];
const pre = (L: number, h: number, R = 10) => [`L := ${L} mm`, `h := ${h} mm`, `R := ${R} mm`];

const built = (items: DesignItem[], p: string[]) => buildResultOcc(occ()!, single(items), solve(single(items), p).numbers).components.c1;
const bodyOf = (items: DesignItem[], p: string[]): BodyResult => built(items, p).bodies[0];
const at = (p: Vec3, q: Vec3) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) < 1e-6;

/** References picked on the part as first built (L = 100, h = 10, R = 10). */
function refs() {
  const b = bodyOf(part(), pre(100, 10));
  const face = (c: Vec3) => refTo('face', b.id, b.faces.find((f) => at(f.c, c))!);
  const edge = (m: Vec3) => refTo('edge', b.id, b.edges.find((e) => at(e.mid, m))!);
  const vertex = (p: Vec3) => refTo('vertex', b.id, b.vertices.find((v) => at(v.p, p))!);
  const cyl = refTo('face', b.id, b.faces.find((f) => f.type === 'cylinder')!);
  const bossTop = b.edges.find((e) => e.circle && Math.abs(e.mid[2] - 20) < 1e-6)!;
  return {
    left: face([0, 30, 5]), right: face([100, 30, 5]),
    // the top's centroid is off its middle: the boss's disc is not part of it
    top: refTo('face', b.id, b.faces.find((f) => f.frame && f.frame.n[2] > 0.5 && Math.abs(f.c[2] - 10) < 1e-6)!),
    topFront: edge([50, 0, 10]), rightFront: edge([100, 0, 5]),
    v000: vertex([0, 0, 10]), vL00: vertex([100, 0, 10]), v0b0: vertex([0, 60, 10]), vLb0: vertex([100, 60, 10]),
    cyl, bossRim: refTo('edge', b.id, bossTop),
  } satisfies Record<string, TopoRef>;
}

const plane = (id: string, def: PlaneDef): ConstructItem => ({ kind: 'plane', id, name: id, def });
/** The datums of a part with the construction items after it, for each (L, h, R). */
function datums(items: ConstructItem[], sizes: [number, number, number?][]): Record<string, Datum>[] {
  return sizes.map(([L, h, R]) => {
    const c = built([...part(), ...items], pre(L, h, R));
    expect(c.errors).toEqual({});
    expect(c.warnings ?? {}).toEqual({});
    return c.datums ?? {};
  });
}

describe('construction planes', () => {
  const r = refs();

  it('offset from a face, and from an origin plane', () => {
    const [a, b] = datums([plane('p1', { type: 'offset', plane: r.top, d: '5' }), plane('p2', { type: 'offset', plane: 'XZ', d: '-20' })], [[100, 10], [150, 25]]);
    for (const [d, h] of [[a, 10], [b, 25]] as const) {
      onPlane(d.p1, [7, 3, h + 5]);
      sameDir((d.p1 as { frame: { n: Vec3 } }).frame.n, [0, 0, 1]);
      // XZ's normal is −Y: 20 against it is y = 20
      onPlane(d.p2, [0, 20, 0]);
    }
  });

  it('at an angle about an edge, from the flat face it lies on', () => {
    const [a, b] = datums([plane('p1', { type: 'angle', axis: r.topFront, angle: '30 deg', plane: r.top })], [[100, 10], [150, 25]]);
    for (const [d, h] of [[a, 10], [b, 25]] as const) {
      const f = (d.p1 as { frame: { o: Vec3; n: Vec3 } }).frame;
      // the top's normal +z turned 30° about the edge (+x or −x): z cos 30°, y ∓ sin 30°
      onPlane(d.p1, [0, 0, h]);
      onPlane(d.p1, [100, 0, h]);
      expect(Math.abs(f.n[2] - cos(PI / 6))).toBeLessThan(1e-9);
      expect(Math.abs(Math.abs(f.n[1]) - sin(PI / 6))).toBeLessThan(1e-9);
    }
    // through the X axis at 0° is the XY plane
    const [c] = datums([plane('p1', { type: 'angle', axis: 'X', angle: '0' })], [[100, 10]]);
    sameDir((c.p1 as { frame: { n: Vec3 } }).frame.n, [0, 0, 1], true);
  });

  it('midplane between two faces: halfway when parallel, the bisector when they meet', () => {
    const [a, b] = datums([plane('p1', { type: 'midplane', a: r.left, b: r.right }), plane('p2', { type: 'midplane', a: r.top, b: r.right })], [[100, 10], [150, 25]]);
    for (const [d, L, h] of [[a, 100, 10], [b, 150, 25]] as const) {
      onPlane(d.p1, [L / 2, 13, 2]);
      sameDir((d.p1 as { frame: { n: Vec3 } }).frame.n, [1, 0, 0]);
      // the top (z = h) and the right side (x = L) meet along x = L, z = h: the bisector between them
      // contains that line and points along (1, 0, −1)/√2 or the other way
      onPlane(d.p2, [L, 0, h]);
      onPlane(d.p2, [L, 60, h]);
      sameDir((d.p2 as { frame: { n: Vec3 } }).frame.n, [SQRT1_2, 0, -SQRT1_2], true);
    }
  });

  it('through three vertices', () => {
    const [a, b] = datums([plane('p1', { type: 'points', points: [r.v000, r.vL00, r.v0b0] })], [[100, 10], [150, 25]]);
    for (const [d, L, h] of [[a, 100, 10], [b, 150, 25]] as const) {
      close((d.p1 as { frame: { o: Vec3 } }).frame.o, [0, 0, h]);
      onPlane(d.p1, [L, 60, h]);
      sameDir((d.p1 as { frame: { n: Vec3 } }).frame.n, [0, 0, 1]);
    }
  });

  it('tangent to a cylinder, turned about its axis from a plane’s normal', () => {
    // from XZ's normal (−Y) turned 90° about the boss's axis (+z or −z): ±X; at 0°: the side y = 30 − R
    const [a, b] = datums([plane('p1', { type: 'tangent', face: r.cyl, angle: '0', plane: 'XZ' }), plane('p2', { type: 'tangent', face: r.cyl, angle: '90 deg', plane: 'XZ' })], [[100, 10, 10], [150, 25, 15]]);
    for (const [d, h, R] of [[a, 10, 10], [b, 25, 15]] as const) {
      onPlane(d.p1, [30, 30 - R, h + 3]);
      sameDir((d.p1 as { frame: { n: Vec3 } }).frame.n, [0, -1, 0]);
      const n = (d.p2 as { frame: { n: Vec3 } }).frame.n;
      sameDir(n, [1, 0, 0], true);
      onPlane(d.p2, [30 + R * Math.sign(n[0]), 30, h]);
    }
  });

  it('square to an edge at a fraction of its length, the edge’s point its origin', () => {
    const [a, b] = datums([plane('p1', { type: 'path', curve: r.topFront, at: '0.25' }), plane('p2', { type: 'path', curve: r.bossRim, at: '0' })], [[100, 10], [150, 25]]);
    for (const [d, L, h] of [[a, 100, 10], [b, 150, 25]] as const) {
      const f = (d.p1 as { frame: { o: Vec3; n: Vec3 } }).frame;
      sameDir(f.n, [1, 0, 0], true);
      // a quarter of the way along, from whichever end the edge starts
      expect([L / 4, (3 * L) / 4].some((x) => Math.hypot(f.o[0] - x, f.o[1], f.o[2] - h) < 1e-9)).toBe(true);
      // on the boss's rim (radius 10 about (30, 30)) the plane is square to the circle: it holds its axis
      onPlane(d.p2, [30, 30, h + 10]);
      onPlane(d.p2, [30, 30, h + 50]);
    }
  });

  it('of a sketch line: square to it at its middle', () => {
    const items: DesignItem[] = [...part(), { kind: 'sketch', id: 's3', name: 'Path', plane: { ref: 'XZ' }, sketch: { points: [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 0, y: 80 }], entities: [{ id: 'l', type: 'line', p1: 'a', p2: 'b' }], constraints: [] } },
      plane('p1', { type: 'path', curve: 's3/l', at: '0.5' })];
    const d = built(items, pre(100, 10)).datums!;
    close((d.p1 as { frame: { o: Vec3 } }).frame.o, [0, 0, 40]);
    sameDir((d.p1 as { frame: { n: Vec3 } }).frame.n, [0, 0, 1]);
  });
});

describe('construction axes and points', () => {
  const r = refs();
  const axis = (id: string, def: Extract<ConstructItem, { kind: 'axis' }>['def']): ConstructItem => ({ kind: 'axis', id, name: id, def });
  const point = (id: string, def: Extract<ConstructItem, { kind: 'point' }>['def']): ConstructItem => ({ kind: 'point', id, name: id, def });

  it('axes through two points, along an edge, through a cylinder, normal to a face', () => {
    const items = [axis('a1', { type: 'points', a: r.v000, b: r.vLb0 }), axis('a2', { type: 'edge', edge: r.rightFront }), axis('a3', { type: 'cylinder', face: r.cyl }), axis('a4', { type: 'normal', face: r.top, point: r.vL00 })];
    for (const [d, L, h] of datums(items, [[100, 10], [150, 25]]).map((d, i) => [d, [100, 150][i], [10, 25][i]] as const)) {
      const A = (id: string) => d[id] as { p: Vec3; d: Vec3 };
      close(A('a1').p, [0, 0, h]);
      sameDir(A('a1').d, [L / Math.hypot(L, 60), 60 / Math.hypot(L, 60), 0]);
      sameDir(A('a2').d, [0, 0, 1], true);
      expect(Math.hypot(A('a2').p[0] - L, A('a2').p[1])).toBeLessThan(1e-9);
      sameDir(A('a3').d, [0, 0, 1], true);
      expect(Math.hypot(A('a3').p[0] - 30, A('a3').p[1] - 30)).toBeLessThan(1e-9);
      close(A('a4').p, [L, 0, h]);
      sameDir(A('a4').d, [0, 0, 1]);
    }
  });

  it('points at a vertex, a circle’s centre, where an edge crosses a plane', () => {
    const items = [
      point('q1', { type: 'vertex', vertex: r.vLb0 }), point('q2', { type: 'centre', of: r.bossRim }),
      plane('p1', { type: 'offset', plane: 'XY', d: '4' }), point('q3', { type: 'edgePlane', curve: r.rightFront, plane: 'p1' }),
    ];
    for (const [d, L, h] of datums(items, [[100, 10], [150, 25]]).map((d, i) => [d, [100, 150][i], [10, 25][i]] as const)) {
      close((d.q1 as { p: Vec3 }).p, [L, 60, h]);
      close((d.q2 as { p: Vec3 }).p, [30, 30, h + 10]);
      close((d.q3 as { p: Vec3 }).p, [L, 0, 4]);
    }
  });

  it('a plane through three construction points, an axis through two', () => {
    const items = [
      point('q1', { type: 'vertex', vertex: r.v000 }), point('q2', { type: 'vertex', vertex: r.vL00 }), point('q3', { type: 'centre', of: r.bossRim }),
      plane('p1', { type: 'points', points: ['q1', 'q2', 'q3'] }), axis('a1', { type: 'points', a: 'q1', b: 'q2' }),
    ];
    const [d] = datums(items, [[100, 10]]);
    onPlane(d.p1, [30, 30, 20]);
    onPlane(d.p1, [100, 0, 10]);
    sameDir((d.a1 as { d: Vec3 }).d, [1, 0, 0]);
  });

  it('a lost reference says so; collinear points are refused', () => {
    // the boss suppressed: its rim is gone
    const items: DesignItem[] = [...part().map((i) => (i.id === 'f2' ? { ...i, suppressed: true } : i)), point('q2', { type: 'centre', of: r.bossRim })];
    expect(built(items, pre(100, 10)).errors.q2).toMatch(/reference lost: .*Boss/);
    // a sketch point halfway between the two vertices
    const mid: DesignItem = { kind: 'sketch', id: 's3', name: 'Mid', plane: { ref: 'XY', offset: 'h' }, sketch: { points: [{ id: 'm', x: 50, y: 0 }], entities: [{ id: 'me', type: 'point', p: 'm' }], constraints: [] } };
    const line = [...part(), mid, plane('p1', { type: 'points', points: [r.v000, r.vL00, 's3/m'] })];
    expect(built(line, pre(100, 10)).errors.p1).toBe('the three points lie on one line');
  });
});

describe('features on construction geometry', () => {
  const r = refs();

  it('a sketch on a construction plane follows it: a peg on a plane 5 above the top', () => {
    const items: DesignItem[] = [...part(),
      plane('p1', { type: 'offset', plane: r.top, d: '5' }),
      { kind: 'sketch', id: 's3', name: 'Peg', plane: { frame: { o: [0, 0, 15], u: [1, 0, 0], v: [0, 1, 0] }, datum: 'p1' }, sketch: circles('p', [[80, 30, 4]]) },
      { kind: 'extrude', id: 'f3', name: 'Peg', sketch: 's3', extent: { type: 'one', d: '6', dir: '+' }, op: 'new' },
    ];
    for (const h of [10, 25]) {
      const { res } = solve(single(items), pre(100, h));
      expect(res.design!.errors).toEqual({});
      const peg = res.design!.bodies.c1[1].mass!;
      expect(Math.abs(peg.V - PI * 16 * 6)).toBeLessThan(1e-9 * peg.V);
      // from h + 5 to h + 11
      expect(Math.abs(peg.zg - (h + 8))).toBeLessThan(1e-9);
    }
  });

  it('mirror about a midplane, a circular pattern about an axis, a split by a plane', () => {
    const peg = (op: 'new' | 'join'): DesignItem[] => [
      { kind: 'sketch', id: 's3', name: 'Peg', plane: { ref: 'XY', offset: 'h' }, sketch: circles('p', [[90, 30, 4]]) },
      { kind: 'extrude', id: 'f3', name: 'Peg', sketch: 's3', extent: { type: 'one', d: '6', dir: '+' }, op },
    ];
    // mirrored about x = L/2: a second peg at x = L − 90
    const mirrored: DesignItem[] = [...part(), ...peg('new'), plane('p1', { type: 'midplane', a: r.left, b: r.right }), { kind: 'mirror', id: 'f4', name: 'Mirror1', of: 'bodies', refs: ['f3'], plane: 'p1' }];
    const m = solve(single(mirrored), pre(150, 10)).res.design!;
    expect(m.errors).toEqual({});
    expect(Math.abs(m.bodies.c1[2].mass!.xg - 60)).toBeLessThan(1e-9);
    // four pegs about the boss's axis
    const patterned: DesignItem[] = [...part(), ...peg('join'), { kind: 'axis', id: 'a1', name: 'Axis1', def: { type: 'cylinder', face: r.cyl } },
      { kind: 'pattern', id: 'f4', name: 'Pattern1', of: 'features', refs: ['f3'], type: 'circ', axis: 'a1', count: '4', spacing: '360 deg' }];
    const { V: Vp, errors } = (() => { const { res } = solve(single(patterned), pre(100, 10)); return { V: volumes(res), errors: res.design!.errors }; })();
    expect(errors).toEqual({});
    // the box, the boss and four pegs 60 from the boss's axis: one on the top, three beside the box standing free
    expect(Math.abs(Vp[0] - (100 * 60 * 10 + PI * 100 * 10 + 4 * PI * 16 * 6))).toBeLessThan(1e-6);
    // split by the midplane: two pieces whose volumes add up to the box and boss
    const split: DesignItem[] = [...part(), plane('p1', { type: 'midplane', a: r.left, b: r.right }), { kind: 'split', id: 'f4', name: 'Split1', body: 'f1', plane: 'p1' }];
    const sp = volumes(solve(single(split), pre(100, 10)).res);
    expect(sp.length).toBe(2);
    expect(Math.abs(sp[0] + sp[1] - (100 * 60 * 10 + PI * 100 * 10))).toBeLessThan(1e-6);
    expect(Math.abs(sp[1] - 50 * 60 * 10)).toBeLessThan(1e-6);
  });

  it('a coil stands on a construction plane; a joint takes a construction point as its origin', () => {
    const items: DesignItem[] = [...part(), plane('p1', { type: 'offset', plane: r.top, d: '20' }),
      { kind: 'coil', id: 'f3', name: 'Coil1', plane: 'p1', mode: 'revs-pitch', d: '30', revs: '2', pitch: '6', section: 'circle', size: '2', op: 'new' }];
    const c = built(items, pre(100, 10));
    expect(c.errors).toEqual({});
    const h = c.datums!.f3 as { kind: 'helix'; helix: { o: Vec3; axis: Vec3 } };
    // the plane's origin is the component origin's foot on it: (0, 0, 30)
    close(h.helix.o, [0, 0, 30]);
    sameDir(h.helix.axis, [0, 0, 1]);
    const design: CadDesign = {
      version: 2,
      components: [
        { id: 'c1', name: 'Base', items: [...part(), { kind: 'point', id: 'q1', name: 'Point1', def: { type: 'vertex', vertex: r.vLb0 } }] },
        { id: 'c2', name: 'Pin', items: [{ kind: 'sketch', id: 't1', name: 'Pin', plane: { ref: 'XY' }, sketch: circles('t', [[0, 0, 2]]) }, { kind: 'extrude', id: 't2', name: 'Pin', sketch: 't1', extent: { type: 'one', d: '5' }, op: 'new' }] },
      ],
      occurrences: [{ id: 'o1', component: 'c1', grounded: true }, { id: 'o2', component: 'c2', pos: [300, 0, 0] }],
      joints: [{ id: 'j1', name: 'Pin', type: 'rigid', a: { occ: 'o1', origin: { kind: 'datum', id: 'q1' } }, b: { occ: 'o2', origin: { kind: 'origin' } }, angle: '0', offset: '0' }],
    };
    for (const L of [100, 150]) {
      const { res } = solve(design, pre(L, 10));
      expect(res.design!.errors).toEqual({});
      const M = res.design!.placements.o2.matrix;
      close([M[12], M[13], M[14]], [L, 60, 10]);
    }
  });
});

describe('construction handles', () => {
  it('deletes every OCCT object of construction geometry along edges', () => {
    const oc = occ()!;
    const r = refs();
    const d = single([...part(),
      plane('p1', { type: 'path', curve: r.bossRim, at: '0.3' }), plane('p2', { type: 'tangent', face: r.cyl, angle: '20 deg' }),
      // the rim crosses y = 30 (XZ's normal is −Y)
      plane('p3', { type: 'offset', plane: 'XZ', d: '-30' }),
      { kind: 'point', id: 'q1', name: 'q1', def: { type: 'edgePlane', curve: r.bossRim, plane: 'p3' } },
    ]);
    const { numbers } = solve(d, pre(100, 10));
    const watch = watchHandles(oc);
    try {
      const b = buildDesignOcc(oc, d, numbers);
      expect(b.components.get('c1')!.errors).toEqual({});
      b.free();
      expect(watch.undeleted()).toEqual([]);
    } finally {
      watch.stop();
    }
  });
});
