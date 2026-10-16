// Every feature built by the B-rep kernel, checked against closed-form volumes and
// inertias. Exact geometry means exact numbers: tolerances are 1e-9 relative unless a
// test says why not.
import { describe, expect, it } from 'vitest';
import { circles, points, poly, rect, single, solve, volumes, watchHandles, withCircles } from './fixtures';
import type { DesignItem } from '../design';
import { occ, renewOcc, setOccEnabled } from './kernel';
import { buildDesignOcc } from './build';
import { builtResultOcc } from './result';
import { stepFile, stlFile } from './exchange';

const near = (v: number, want: number, rel = 1e-9) => expect(Math.abs(v - want) / Math.abs(want)).toBeLessThan(rel);
const { PI } = Math;

describe('B-rep extrude', () => {
  it('a plate with a hole: volume, centroid and inertia tensor', () => {
    // 100 × 60 × 10 plate, Ø20 hole at its centre
    const sk = withCircles(rect('a', 0, 0, 100, 60), 'h', [[50, 30, 10]]);
    const { res } = solve(single([
      { kind: 'sketch', id: 's1', name: 'S', plane: { ref: 'XY' }, sketch: sk },
      { kind: 'extrude', id: 'f1', name: 'E', sketch: 's1', extent: { type: 'one', d: '10' }, op: 'new' },
    ]));
    expect(res.featureError).toBeUndefined();
    expect(res.design!.brep).toBe(true);
    const m = res.design!.bodies.c1[0].mass!;
    // box minus cylinder; volume moments about the centroid (box: V(b² + h²)/12, cylinder: V r²/2 about its axis)
    const Vb = 100 * 60 * 10, Vc = PI * 100 * 10;
    near(m.V, Vb - Vc);
    near(m.xg, 50);
    near(m.zg, 5);
    near(m.Izz, Vb * (100 ** 2 + 60 ** 2) / 12 - Vc * 100 / 2);
    near(m.Ixx, Vb * (60 ** 2 + 10 ** 2) / 12 - Vc * (3 * 100 + 10 ** 2) / 12);
    expect(Math.abs(m.Pxy)).toBeLessThan(1e-6 * m.Izz);
    // mass in kg: 7850 kg/m³ with V in mm³
    near(m.m!, (Vb - Vc) * 7850e-9);
  });

  it('symmetric and two-sided extents', () => {
    const { res } = solve(single([
      { kind: 'sketch', id: 's1', name: 'S', plane: { ref: 'XY' }, sketch: circles('c', [[0, 0, 5]]) },
      { kind: 'extrude', id: 'f1', name: 'Sym', sketch: 's1', extent: { type: 'symmetric', d: '20' }, op: 'new' },
      { kind: 'sketch', id: 's2', name: 'S2', plane: { ref: 'XY' }, sketch: rect('r', 20, 0, 30, 10) },
      { kind: 'extrude', id: 'f2', name: 'Two', sketch: 's2', extent: { type: 'two', d: '12', d2: '4' }, op: 'new' },
    ]));
    const [a, b] = res.design!.bodies.c1.map((x) => x.mass!);
    near(a.V, PI * 25 * 20);
    expect(Math.abs(a.zg)).toBeLessThan(1e-9);
    // from z = −4 to 12: centroid at 4
    near(b.V, 100 * 16);
    near(b.zg, 4);
  });

  it('cuts through all and finds the side of an automatic cut', () => {
    const { res } = solve(single([
      { kind: 'sketch', id: 's1', name: 'S', plane: { ref: 'XY' }, sketch: rect('a', -50, -50, 50, 50) },
      { kind: 'extrude', id: 'f1', name: 'E', sketch: 's1', extent: { type: 'one', d: '10' }, op: 'new' },
      // a sketch on the top face, cut through everything below it
      { kind: 'sketch', id: 's2', name: 'Top', plane: { ref: 'XY', offset: '10' }, sketch: circles('c', [[20, 0, 6]]) },
      { kind: 'extrude', id: 'f2', name: 'Thru', sketch: 's2', extent: { type: 'all' }, op: 'cut' },
      // a pocket from the bottom plane: "auto" must go up into the material
      { kind: 'sketch', id: 's3', name: 'Bottom', plane: { ref: 'XY' }, sketch: circles('p', [[-20, 0, 8]]) },
      { kind: 'extrude', id: 'f3', name: 'Pocket', sketch: 's3', extent: { type: 'one', d: '4' }, op: 'cut' },
    ]));
    expect(res.featureError).toBeUndefined();
    near(volumes(res)[0], 100 * 100 * 10 - PI * 36 * 10 - PI * 64 * 4);
  });

  it('joins onto the last body and intersects', () => {
    const { res } = solve(single([
      { kind: 'sketch', id: 's1', name: 'S', plane: { ref: 'XY' }, sketch: rect('a', 0, 0, 40, 40) },
      { kind: 'extrude', id: 'f1', name: 'Base', sketch: 's1', extent: { type: 'one', d: '10' }, op: 'new' },
      { kind: 'sketch', id: 's2', name: 'Boss', plane: { ref: 'XY', offset: '10' }, sketch: circles('b', [[20, 20, 10]]) },
      { kind: 'extrude', id: 'f2', name: 'Boss', sketch: 's2', extent: { type: 'one', d: '15' }, op: 'join' },
      // keep only what lies inside a 30 × 30 column
      { kind: 'sketch', id: 's3', name: 'Keep', plane: { ref: 'XY' }, sketch: rect('k', 5, 5, 35, 35) },
      { kind: 'extrude', id: 'f3', name: 'Keep', sketch: 's3', extent: { type: 'one', d: '40' }, op: 'intersect' },
    ]));
    expect(res.featureError).toBeUndefined();
    expect(res.design!.bodies.c1).toHaveLength(1);
    near(volumes(res)[0], 30 * 30 * 10 + PI * 100 * 15);
  });
});

describe('B-rep shells and roundings', () => {
  const box = (extra: Partial<Extract<DesignItem, { kind: 'extrude' }>>, d = '40') => single([
    { kind: 'sketch', id: 's1', name: 'S', plane: { ref: 'XY' }, sketch: rect('a', 0, 0, 100, 60) },
    { kind: 'extrude', id: 'f1', name: 'E', sketch: 's1', extent: { type: 'one', d }, op: 'new', ...extra },
  ]);

  it('thin walls inside, outside and centred; caps', () => {
    // sharp (mitred) corners: the wall is the difference of two rectangles
    const t = 2, h = 40;
    const v = (thin: NonNullable<Extract<DesignItem, { kind: 'extrude' }>['thin']>) => volumes(solve(box({ thin })).res)[0];
    near(v({ t: '2', side: 'inside', cap: 'none' }), (100 * 60 - 96 * 56) * h);
    near(v({ t: '2', side: 'outside', cap: 'none' }), (104 * 64 - 100 * 60) * h);
    near(v({ t: '2', side: 'center', cap: 'none' }), (102 * 62 - 98 * 58) * h);
    // a box open at the top: walls plus a 2 mm floor
    near(v({ t: '2', side: 'inside', cap: 'start' }), (100 * 60 - 96 * 56) * h + 96 * 56 * t);
    near(v({ t: '2', side: 'inside', cap: 'both' }), (100 * 60 - 96 * 56) * h + 2 * 96 * 56 * t);
  });

  it('a thin wall around a profile with a hole', () => {
    // outline 100 × 60 with a Ø20 hole, wall 2 inside: the hole grows to Ø24
    const sk = withCircles(rect('a', 0, 0, 100, 60), 'h', [[50, 30, 10]]);
    const { res } = solve(single([
      { kind: 'sketch', id: 's1', name: 'S', plane: { ref: 'XY' }, sketch: sk },
      { kind: 'extrude', id: 'f1', name: 'E', sketch: 's1', extent: { type: 'one', d: '10' }, op: 'new', thin: { t: '2', side: 'inside', cap: 'none' } },
    ]));
    near(volumes(res)[0], ((100 * 60 - PI * 100) - (96 * 56 - PI * 144)) * 10);
  });

  it('a fillet round the top of a box', () => {
    // Removed along each straight edge: the square r × r minus the quarter disc, (1 − π/4) r²
    // per unit length. At the four convex corners the two roundings meet on the mitre
    // plane, so the straight-edge prisms overlap there by 2 ∫∫ s dA over that cross
    // section, ∫∫ s dA = r³/2 − (π r³/4 − r³/3) = r³ (5/6 − π/4) (s measured into the material).
    const r = 3, V0 = 100 * 60 * 40, L = 2 * (100 + 60);
    near(volumes(solve(box({ edgeEnd: { type: 'fillet', r: '3' } })).res)[0], V0 - (1 - PI / 4) * r * r * L + 4 * 2 * r ** 3 * (5 / 6 - PI / 4));
  });

  it('a chamfer round the bottom of a box', () => {
    // as the fillet with a triangle c²/2 whose ∫∫ s dA = c³/6
    const c = 4, V0 = 100 * 60 * 40, L = 2 * (100 + 60);
    near(volumes(solve(box({ edgeStart: { type: 'chamfer', r: '4' } })).res)[0], V0 - (c * c / 2) * L + 4 * 2 * c ** 3 / 6);
  });

  it('a filleted and chamfered disc (Pappus)', () => {
    // ring removed at radius R from the outside: 2π (R A − ∫∫ s dA)
    const R = 20, h = 18, r = 5, c = 1;
    const fil = 2 * PI * (R * (1 - PI / 4) * r * r - r ** 3 * (5 / 6 - PI / 4));
    const ch = 2 * PI * (R * c * c / 2 - c ** 3 / 6);
    const { res } = solve(single([
      { kind: 'sketch', id: 's1', name: 'S', plane: { ref: 'XY' }, sketch: circles('k', [[0, 0, R]]) },
      { kind: 'extrude', id: 'f1', name: 'Knob', sketch: 's1', extent: { type: 'one', d: '18' }, op: 'new', edgeStart: { type: 'chamfer', r: '1' }, edgeEnd: { type: 'fillet', r: '5' } },
    ]));
    near(volumes(res)[0], PI * R * R * h - fil - ch);
  });

  it('reports a rounding that does not fit', () => {
    const { res } = solve(box({ edgeEnd: { type: 'fillet', r: '35' } }));
    expect(res.featureError).toMatch(/rounding/);
  });

  it('lofts two squares into a frustum of a pyramid', () => {
    // V = h/3 (A1 + A2 + √(A1 A2)) for similar, parallel ends
    const { res } = solve(single([
      { kind: 'sketch', id: 's1', name: 'Bottom', plane: { ref: 'XY' }, sketch: rect('a', -20, -20, 20, 20) },
      { kind: 'sketch', id: 's2', name: 'Top', plane: { ref: 'XY', offset: '30' }, sketch: rect('b', -10, -10, 10, 10) },
      { kind: 'loft', id: 'f1', name: 'Loft', sketch: 's1', sketch2: 's2', op: 'new' },
    ]));
    const A1 = 1600, A2 = 400;
    near(volumes(res)[0], (30 / 3) * (A1 + A2 + Math.sqrt(A1 * A2)));
    // centroid of a frustum above the larger end: h (A1 + 2√(A1A2) + 3A2) / (4 (A1 + √(A1A2) + A2))
    near(res.design!.bodies.c1[0].mass!.zg, (30 * (A1 + 2 * 800 + 3 * A2)) / (4 * (A1 + 800 + A2)));
  });
});

describe('B-rep revolve and holes', () => {
  it('revolves a cylinder, a torus (Pappus) and a quarter ring', () => {
    const { res } = solve(single([
      // a 10 × 30 rectangle beside the sketch y axis on the front plane: a cylinder about world Z
      { kind: 'sketch', id: 's1', name: 'Cyl', plane: { ref: 'XZ' }, sketch: rect('a', 0, 0, 10, 30) },
      { kind: 'revolve', id: 'f1', name: 'Cyl', sketch: 's1', axis: 'y', angle: '360', op: 'new' },
      // a circle of radius 5 at 40 from the axis: V = 2πR · πa²
      { kind: 'sketch', id: 's2', name: 'Tor', plane: { ref: 'XZ' }, sketch: circles('t', [[40, 50, 5]]) },
      { kind: 'revolve', id: 'f2', name: 'Torus', sketch: 's2', axis: 'y', angle: '360', op: 'new' },
      { kind: 'revolve', id: 'f3', name: 'Quarter', sketch: 's2', axis: 'y', angle: '90 deg', op: 'new' },
    ]));
    expect(res.featureError).toBeUndefined();
    const [cyl, tor, quarter] = res.design!.bodies.c1.map((b) => b.mass!);
    near(cyl.V, PI * 100 * 30);
    near(cyl.Izz, PI * 100 * 30 * 100 / 2);
    near(tor.V, 2 * PI * 40 * PI * 25);
    // a solid torus about its axis: V (R² + 3a²/4)
    near(tor.Izz, 2 * PI * 40 * PI * 25 * (40 ** 2 + 0.75 * 25));
    near(quarter.V, tor.V / 4);
  });

  it('drills simple, counterbored and countersunk holes', () => {
    const T = 12;
    const plate = (style: 'simple' | 'counterbore' | 'countersink', through: boolean) => single([
      { kind: 'sketch', id: 's1', name: 'S', plane: { ref: 'XY' }, sketch: rect('a', -30, -30, 30, 30) },
      { kind: 'extrude', id: 'f1', name: 'E', sketch: 's1', extent: { type: 'one', d: `${T}` }, op: 'new' },
      { kind: 'sketch', id: 's2', name: 'Top', plane: { ref: 'XY', offset: `${T}` }, sketch: points('h', [[0, 0], [15, 15]]) },
      { kind: 'hole', id: 'f2', name: 'H', sketch: 's2', d: '8', depth: '7', through, style, cbD: '14', cbDepth: '5', csD: '16', csAngle: '90 deg' },
    ]);
    const V0 = 60 * 60 * T;
    const v = (style: 'simple' | 'counterbore' | 'countersink', through: boolean) => {
      const { res } = solve(plate(style, through));
      expect(res.featureError).toBeUndefined();
      return volumes(res)[0];
    };
    near(v('simple', false), V0 - 2 * PI * 16 * 7);
    near(v('simple', true), V0 - 2 * PI * 16 * T);
    // counterbore Ø14 × 5, then Ø8 to the bottom
    near(v('counterbore', true), V0 - 2 * (PI * 49 * 5 + PI * 16 * (T - 5)));
    // 90° countersink from Ø16 to Ø8: a cone frustum h = 4 deep, V = πh/3 (R² + Rr + r²)
    const h = 4;
    near(v('countersink', true), V0 - 2 * ((PI * h / 3) * (64 + 32 + 16) + PI * 16 * (T - h)));
  });
});

describe('B-rep revolve about a sketch line', () => {
  it('turns by the right-hand rule, the other way when flipped', () => {
    // a 10 × 30 rectangle 10 to 20 from a construction line along sketch y (world Y on XY)
    const sk = poly('a', [[10, 0], [20, 0], [20, 30], [10, 30]]);
    sk.points.push({ id: 'x0', x: 0, y: 0 }, { id: 'x1', x: 0, y: 30 });
    sk.entities.push({ id: 'ax', type: 'line', p1: 'x0', p2: 'x1', construction: true });
    const quarter = (flip: boolean) => solve(single([
      { kind: 'sketch', id: 's1', name: 'S', plane: { ref: 'XY' }, sketch: sk },
      { kind: 'revolve', id: 'f1', name: 'R', sketch: 's1', axis: 'ax', angle: '90 deg', flip, op: 'new' },
    ])).res.design!.bodies.c1[0].mass!;
    // V = φ ∫ r dA; the centroid sits (1 − cos φ) ∫ r² dA / V off the plane, and turning +x
    // about +Y by +90° heads for −Z
    const Mr = 30 * (20 ** 2 - 10 ** 2) / 2, Mrr = 30 * (20 ** 3 - 10 ** 3) / 3;
    const a = quarter(false), b = quarter(true);
    near(a.V, (PI / 2) * Mr);
    near(a.zg, -Mrr / ((PI / 2) * Mr));
    near(b.zg, Mrr / ((PI / 2) * Mr));
    near(a.xg, Mrr / ((PI / 2) * Mr));
  });

  it('refuses a profile across the axis', () => {
    const { res } = solve(single([
      { kind: 'sketch', id: 's1', name: 'S', plane: { ref: 'XY' }, sketch: rect('a', -5, 0, 5, 10) },
      { kind: 'revolve', id: 'f1', name: 'R', sketch: 's1', axis: 'y', angle: '360', op: 'new' },
    ]));
    expect(res.featureError).toMatch(/crosses the axis/);
  });
});

describe('B-rep patterns, mirrors and combines', () => {
  it('patterns holes round an axis and bodies along two directions', () => {
    const { res } = solve(single([
      { kind: 'sketch', id: 's1', name: 'Disc', plane: { ref: 'XY' }, sketch: circles('d', [[0, 0, 50]]) },
      { kind: 'extrude', id: 'f1', name: 'Disc', sketch: 's1', extent: { type: 'one', d: '10' }, op: 'new' },
      { kind: 'sketch', id: 's2', name: 'Holes', plane: { ref: 'XY', offset: '10' }, sketch: points('h', [[35, 0]]) },
      { kind: 'hole', id: 'f2', name: 'Hole', sketch: 's2', d: '6', depth: '', through: true, style: 'simple' },
      { kind: 'pattern', id: 'f3', name: 'Bolts', of: 'features', refs: ['f2'], type: 'circ', axis: 'Z', count: '6', spacing: '360 deg' },
      // a block repeated 3 × 2
      { kind: 'sketch', id: 's3', name: 'Block', plane: { ref: 'XY' }, sketch: rect('b', 100, 0, 110, 10) },
      { kind: 'extrude', id: 'f4', name: 'Block', sketch: 's3', extent: { type: 'one', d: '5' }, op: 'new' },
      { kind: 'pattern', id: 'f5', name: 'Grid', of: 'bodies', refs: ['f4'], type: 'rect', axis: 'X', count: '3', spacing: '20', axis2: 'Y', count2: '2', spacing2: '30' },
    ]));
    expect(res.featureError).toBeUndefined();
    const v = volumes(res);
    near(v[0], PI * 2500 * 10 - 6 * PI * 9 * 10);
    expect(v.slice(1)).toHaveLength(6);
    for (const x of v.slice(1)) near(x, 500);
    const box = res.design!.box!;
    near(box.max[0], 150);
    near(box.max[1], 50);
  });

  it('mirrors bodies, joins the copy and combines', () => {
    const { res } = solve(single([
      { kind: 'sketch', id: 's1', name: 'Arm', plane: { ref: 'XY' }, sketch: rect('a', 10, 0, 40, 10) },
      { kind: 'extrude', id: 'f1', name: 'Arm', sketch: 's1', extent: { type: 'symmetric', d: '10' }, op: 'new' },
      { kind: 'mirror', id: 'f2', name: 'Mirror', of: 'bodies', refs: ['f1'], plane: 'YZ' },
      { kind: 'sketch', id: 's2', name: 'Bar', plane: { ref: 'XY' }, sketch: rect('b', -50, 2, 50, 8) },
      { kind: 'extrude', id: 'f3', name: 'Bar', sketch: 's2', extent: { type: 'symmetric', d: '4' }, op: 'new' },
      // the bar cut out of the left arm (kept), then both arms joined
      { kind: 'combine', id: 'f4', name: 'Notch', target: 'f2.1.f1', tools: ['f3'], op: 'cut', keepTools: true },
      { kind: 'combine', id: 'f5', name: 'Join', target: 'f1', tools: ['f2.1.f1'], op: 'join' },
    ]));
    expect(res.featureError).toBeUndefined();
    const bodies = res.design!.bodies.c1;
    expect(bodies.map((b) => b.name)).toEqual(['Body1', 'Body3']);
    // arms 30 × 10 × 10 each, the left one notched by 30 × 6 × 4
    near(bodies[0].mass!.V, 2 * 3000 - 30 * 6 * 4);
    near(bodies[1].mass!.V, 100 * 6 * 4);
    // the notch sits at x < 0: the joined body's centroid moves right
    expect(bodies[0].mass!.xg).toBeGreaterThan(0);
  });

  it('mirrors a feature across a sketch plane and patterns a body joined', () => {
    const { res } = solve(single([
      { kind: 'sketch', id: 's1', name: 'Plate', plane: { ref: 'XY' }, sketch: rect('a', 0, 0, 100, 40) },
      { kind: 'extrude', id: 'f1', name: 'Plate', sketch: 's1', extent: { type: 'one', d: '8' }, op: 'new' },
      { kind: 'sketch', id: 's2', name: 'Slot', plane: { ref: 'XY', offset: '8' }, sketch: rect('s', 10, 10, 30, 30) },
      { kind: 'extrude', id: 'f2', name: 'Pocket', sketch: 's2', extent: { type: 'one', d: '3' }, op: 'cut' },
      // the plane x = 50 (a sketch on the right plane, offset)
      { kind: 'sketch', id: 's3', name: 'Mid', plane: { ref: 'YZ', offset: '50' }, sketch: rect('m', 0, 0, 1, 1) },
      { kind: 'mirror', id: 'f3', name: 'Mirror', of: 'features', refs: ['f2'], plane: 's3' },
    ]));
    expect(res.featureError).toBeUndefined();
    near(volumes(res)[0], 100 * 40 * 8 - 2 * 20 * 20 * 3);
    near(res.design!.bodies.c1[0].mass!.xg, 50);
  });
});

describe('B-rep extents, directions and combines', () => {
  const block = (extra: DesignItem[]) => single([
    { kind: 'sketch', id: 's1', name: 'S', plane: { ref: 'XY' }, sketch: rect('a', 0, 0, 40, 40) },
    { kind: 'extrude', id: 'f1', name: 'E', sketch: 's1', extent: { type: 'symmetric', d: '20' }, op: 'new' },
    ...extra,
  ]);

  it('cuts through all to both sides from a mid plane', () => {
    const { res } = solve(block([
      { kind: 'sketch', id: 's2', name: 'M', plane: { ref: 'XY' }, sketch: circles('c', [[20, 20, 5]]) },
      { kind: 'extrude', id: 'f2', name: 'Thru', sketch: 's2', extent: { type: 'all', both: true }, op: 'cut' },
    ]));
    near(volumes(res)[0], 40 * 40 * 20 - PI * 25 * 20);
  });

  it('drills only the way it is told', () => {
    const hole = (dir: '+' | '-') => volumes(solve(block([
      { kind: 'sketch', id: 's2', name: 'T', plane: { ref: 'XY', offset: '10' }, sketch: points('h', [[20, 20]]) },
      { kind: 'hole', id: 'f2', name: 'H', sketch: 's2', d: '8', depth: '6', dir, style: 'simple' },
    ])).res)[0];
    // up from the top face meets only the skin the tool starts behind (10⁻³ d, so a cut
    // never leaves one); down takes a Ø8 × 6 bore
    near(hole('+'), 40 * 40 * 20 - PI * 16 * 8e-3);
    near(hole('-'), 40 * 40 * 20 - PI * 16 * 6);
  });

  it('intersects bodies and keeps or drops the tools', () => {
    const two = (keepTools: boolean) => solve(block([
      { kind: 'sketch', id: 's2', name: 'B', plane: { ref: 'XY' }, sketch: rect('b', 30, 30, 60, 60) },
      { kind: 'extrude', id: 'f2', name: 'B', sketch: 's2', extent: { type: 'one', d: '5' }, op: 'new' },
      { kind: 'combine', id: 'f3', name: 'C', target: 'f1', tools: ['f2'], op: 'intersect', keepTools },
    ])).res;
    // the overlap: 10 × 10 × 5
    const kept = two(true);
    expect(kept.featureError).toBeUndefined();
    expect(volumes(kept)).toHaveLength(2);
    near(volumes(kept)[0], 500);
    near(volumes(kept)[1], 30 * 30 * 5);
    expect(volumes(two(false))).toHaveLength(1);
  });

  it('joins patterned copies into one body', () => {
    const { res } = solve(block([
      { kind: 'pattern', id: 'f2', name: 'P', of: 'bodies', refs: ['f1'], type: 'circ', axis: 'Z', count: '4', spacing: '360 deg', join: true },
    ]));
    // four 40 × 40 blocks round Z, overlapping only at the origin corner: none
    expect(volumes(res)).toHaveLength(1);
    near(volumes(res)[0], 4 * 40 * 40 * 20);
    expect(Math.abs(res.design!.bodies.c1[0].mass!.xg)).toBeLessThan(1e-9);
  });
});

describe('B-rep sketch planes and the worksheet', () => {
  it('sketches on a captured face frame', () => {
    // a side face of a 40 × 40 × 20 block (x = 40, normal +x) carries a Ø10 boss 5 long
    const { res } = solve(single([
      { kind: 'sketch', id: 's1', name: 'S', plane: { ref: 'XY' }, sketch: rect('a', 0, 0, 40, 40) },
      { kind: 'extrude', id: 'f1', name: 'Block', sketch: 's1', extent: { type: 'one', d: '20' }, op: 'new' },
      { kind: 'sketch', id: 's2', name: 'Side', plane: { frame: { o: [40, 20, 10], u: [0, 1, 0], v: [0, 0, 1] } }, sketch: circles('b', [[0, 0, 5]]) },
      { kind: 'extrude', id: 'f2', name: 'Boss', sketch: 's2', extent: { type: 'one', d: '5' }, op: 'join' },
    ]));
    expect(res.featureError).toBeUndefined();
    const m = res.design!.bodies.c1[0].mass!;
    const Vb = 40 * 40 * 20, Vc = PI * 25 * 5;
    near(m.V, Vb + Vc);
    // the boss is centred at x = 42.5
    near(m.xg, (Vb * 20 + Vc * 42.5) / (Vb + Vc));
  });

  it('falls back to the mesh kernel and says so', () => {
    const design = single([
      { kind: 'sketch', id: 's1', name: 'S', plane: { ref: 'XY' }, sketch: circles('c', [[0, 0, 10]]) },
      { kind: 'extrude', id: 'f1', name: 'E', sketch: 's1', extent: { type: 'one', d: '10' }, op: 'new' },
      { kind: 'sketch', id: 's2', name: 'H', plane: { ref: 'XY' }, sketch: circles('h', [[0, 0, 4]]) },
      { kind: 'extrude', id: 'f2', name: 'Cut', sketch: 's2', extent: { type: 'all' }, op: 'cut' },
    ]);
    const exact = PI * (100 - 16) * 10;
    setOccEnabled(false);
    try {
      const { res } = solve(design);
      expect(res.design!.brep).toBeUndefined();
      expect(res.needsBrep).toBe(true);
      // mesh booleans: within the 2° faceting (~2·10⁻⁴), but not exact
      near(volumes(res)[0], exact, 5e-4);
      expect(Math.abs(volumes(res)[0] - exact) / exact).toBeGreaterThan(1e-7);
    } finally {
      setOccEnabled(true);
    }
    const { res } = solve(design);
    expect(res.needsBrep).toBeUndefined();
    near(volumes(res)[0], exact);
  });

  it('deletes every OCCT object a build, its result and its export make', () => {
    // a handle left over keeps its whole solid (and triangulation) in WASM memory
    const oc = occ()!;
    const design = single([
      { kind: 'sketch', id: 's1', name: 'S', plane: { ref: 'XY' }, sketch: poly('a', [[0, 0], [80, 0], [80, 30], [40, 50], [0, 30]]) },
      { kind: 'extrude', id: 'f1', name: 'E', sketch: 's1', extent: { type: 'one', d: '20' }, op: 'new', edgeEnd: { type: 'fillet', r: '2' }, edgeStart: { type: 'chamfer', r: '1' } },
      { kind: 'sketch', id: 's2', name: 'T', plane: { ref: 'XY', offset: '20' }, sketch: points('h', [[20, 15], [60, 15]]) },
      { kind: 'hole', id: 'f2', name: 'H', sketch: 's2', d: '6', depth: '', through: true, style: 'countersink', csD: '12', csAngle: '90 deg' },
      { kind: 'pattern', id: 'f3', name: 'P', of: 'bodies', refs: ['f1'], type: 'rect', axis: 'Y', count: '2', spacing: '60', join: true },
      { kind: 'sketch', id: 's3', name: 'L', plane: { ref: 'XY', offset: '40' }, sketch: circles('l', [[40, 20, 8]]) },
      { kind: 'loft', id: 'f4', name: 'Loft', sketch: 's1', sketch2: 's3', op: 'new' },
      { kind: 'extrude', id: 'f5', name: 'Thin', sketch: 's3', extent: { type: 'one', d: '10' }, op: 'new', thin: { t: '1', side: 'center', cap: 'end' } },
      { kind: 'sketch', id: 's4', name: 'R', plane: { ref: 'XZ' }, sketch: rect('r', 100, 0, 110, 20) },
      { kind: 'revolve', id: 'f6', name: 'Rev', sketch: 's4', axis: 'y', angle: '270 deg', op: 'new' },
      { kind: 'mirror', id: 'f7', name: 'M', of: 'bodies', refs: ['f6'], plane: 'XZ' },
      { kind: 'combine', id: 'f8', name: 'C', target: 'f4', tools: ['f5'], op: 'cut', keepTools: true },
    ]);
    const { res, numbers } = solve(design);
    expect(res.featureError).toBeUndefined();
    const watch = watchHandles(oc);
    try {
      const b = buildDesignOcc(oc, design, numbers);
      builtResultOcc(oc, b);
      stepFile(oc, b, design, { kind: 'assembly' });
      stlFile(oc, b, design, { kind: 'assembly' });
      b.free();
      expect(watch.undeleted()).toEqual([]);
    } finally {
      watch.stop();
    }
  });

  it('renews a kernel whose heap filled up', async () => {
    const old = occ()!;
    const pending = renewOcc(0);
    expect(pending).not.toBeNull();
    // the old instance serves until the new one is ready
    expect(occ()).toBe(old);
    const fresh = await pending!;
    expect(occ()).toBe(fresh);
    expect(fresh).not.toBe(old);
    near(volumes(solve(single([
      { kind: 'sketch', id: 's1', name: 'S', plane: { ref: 'XY' }, sketch: circles('c', [[0, 0, 10]]) },
      { kind: 'extrude', id: 'f1', name: 'E', sketch: 's1', extent: { type: 'one', d: '10' }, op: 'new' },
    ])).res)[0], PI * 1000);
  });
});
