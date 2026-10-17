// Projected and intersected reference geometry, built on the B-rep kernel. A projection
// square onto a plane is an affine map, so lines project to lines and a circle of radius
// r whose plane makes an angle θ with the sketch to an ellipse with semi-axes r and r·cos θ;
// a plane at θ to a cylinder's axis cuts it in an ellipse with semi-axes r/sin θ and r (a
// plane through the axis in two lines 2r apart). References are projected again on every
// build, so they follow an upstream dimension and what is constrained to them follows too.
import { describe, expect, it } from 'vitest';
import { circles, rect, single, solve, volumes, watchHandles } from './fixtures';
import { occ } from './kernel';
import { buildResultOcc } from './result';
import { buildDesignOcc } from './build';
import type { DesignItem } from '../design';
import type { CadEntity, CadSketch, SketchSource } from '../model';
import { refTo } from '../topology';
import { findProfiles, profileProperties } from '../profile';
import { withReferencesOf } from '../reference';

const { PI, abs, hypot, cos, sin, SQRT1_2 } = Math;
const near = (v: number, want: number, rel = 1e-9) => expect(abs(v - want) / Math.max(abs(want), 1e-300)).toBeLessThan(rel);

/** A w × 60 × 10 plate from the origin, w a worksheet variable through a length dimension. */
const plate = (): DesignItem[] => {
  const sk = rect('a', 0, 0, 100, 60);
  sk.constraints.push(
    { id: 'h0', type: 'horizontal', refs: ['al0'] }, { id: 'v1', type: 'vertical', refs: ['al1'] },
    { id: 'h2', type: 'horizontal', refs: ['al2'] }, { id: 'v3', type: 'vertical', refs: ['al3'] },
    { id: 'fx', type: 'fix', refs: ['ap0'], at: { x: 0, y: 0 } },
    { id: 'dw', type: 'length', refs: ['al0'], value: 'w' }, { id: 'dh', type: 'length', refs: ['al1'], value: '60' },
  );
  return [
    { kind: 'sketch', id: 's0', name: 'Base', plane: { ref: 'XY' }, sketch: sk },
    { kind: 'extrude', id: 'f0', name: 'Plate', sketch: 's0', extent: { type: 'one', d: '10' }, op: 'new' },
  ];
};

/** The plate's body as built, for picking references on it. */
const plateBody = (w = 100) => {
  const { numbers } = solve(single(plate()), [`w := ${w}`]);
  return buildResultOcc(occ()!, single(plate()), numbers).components.c1.bodies[0];
};

/** A sketch with only sources (its reference geometry comes from the build). */
const refSketch = (sources: SketchSource[], extra: Partial<CadSketch> = {}): CadSketch => ({ points: [], entities: [], constraints: [], sources, ...extra });

const built = (res: ReturnType<typeof solve>['res'], id: string) => res.design!.rebuilt?.[id];
const pointsOf = (sk: CadSketch, e: CadEntity) => {
  const ids = e.type === 'line' ? [e.p1, e.p2] : [];
  return ids.map((id) => sk.points.find((p) => p.id === id)!);
};

describe('projected edges', () => {
  it('a top edge of the plate projected onto a sketch on top: the edge as a line, following the width', () => {
    const b = plateBody();
    // the edge along x at y = 0 on the top face
    const edge = b.edges.find((e) => e.line && abs(e.line.a[1]) < 1e-9 && abs(e.line.b[1]) < 1e-9 && abs(e.line.a[2] - 10) < 1e-9)!;
    const src: SketchSource = { id: 'r1', kind: 'edge', ref: refTo('edge', b.id, edge), label: 'Edge' };
    const items: DesignItem[] = [...plate(), { kind: 'sketch', id: 's1', name: 'Top', plane: { ref: 'XY', offset: '10' }, sketch: refSketch([src]) }];
    for (const w of [100, 140]) {
      const { res } = solve(single(items), [`w := ${w}`]);
      expect(res.design!.errors).toEqual({});
      const sk = built(res, 's1')!;
      const line = sk.entities.find((e) => e.type === 'line')!;
      expect(line.ref).toBe('r1');
      expect(line.construction).toBe(true);
      const xs = pointsOf(sk, line).map((p) => p.x).sort((p, q) => p - q);
      near(xs[0] + 1, 1);
      near(xs[1], w);
      // the worksheet sees the sketch as built: the reference points where the edge is
      const r = res.design!.sketches.s1;
      expect(Math.max(...Object.values(r.points).map(([x]) => x))).toBeCloseTo(w, 9);
      // reference geometry is fixed: no freedom
      expect(r.dof).toBe(0);
    }
  });

  it('a hole constrained to a projected corner follows the plate: the cut volume moves with it', () => {
    const b = plateBody();
    const edge = b.edges.find((e) => e.line && abs(e.line.a[0] - 100) < 1e-9 && abs(e.line.b[0] - 100) < 1e-9 && abs(e.line.a[2] - 10) < 1e-9)!;
    const src: SketchSource = { id: 'r1', kind: 'edge', ref: refTo('edge', b.id, edge) };
    // a circle of radius 5, its centre 15 left of the projected edge's lower end, held there
    const sk: CadSketch = {
      ...refSketch([src]),
      points: [{ id: 'c', x: 85, y: 0 }, { id: 'r1.p0', x: 100, y: 0 }, { id: 'r1.p1', x: 100, y: 60 }],
      entities: [{ id: 'r1.e0', type: 'line', p1: 'r1.p0', p2: 'r1.p1', ref: 'r1', construction: true }, { id: 'k', type: 'circle', c: 'c', r: 5 }],
      constraints: [
        { id: 'dr', type: 'radius', refs: ['k'], value: '5' },
        { id: 'dx', type: 'distanceX', refs: ['c', 'r1.p0'], value: '15' },
        { id: 'dy', type: 'distanceY', refs: ['r1.p0', 'c'], value: '30' },
      ],
    };
    const items: DesignItem[] = [
      ...plate(),
      { kind: 'sketch', id: 's1', name: 'Hole', plane: { ref: 'XY', offset: '10' }, sketch: sk },
      { kind: 'extrude', id: 'f1', name: 'Hole', sketch: 's1', extent: { type: 'all' }, op: 'cut' },
    ];
    for (const w of [100, 130]) {
      const { res } = solve(single(items), [`w := ${w}`]);
      expect(res.design!.errors).toEqual({});
      near(volumes(res)[0], w * 60 * 10 - PI * 25 * 10);
      // the hole sits 15 from the right-hand edge wherever it is
      const c = res.design!.sketches.s1.points.c;
      near(c[0], w - 15);
      near(c[1], 30);
    }
  });

  it('a point of the sketch\'s own that no curve uses (only constraints) stays, and what hangs on it follows', () => {
    const b = plateBody();
    const edge = b.edges.find((e) => e.line && abs(e.line.a[0] - 100) < 1e-9 && abs(e.line.b[0] - 100) < 1e-9 && abs(e.line.a[2] - 10) < 1e-9)!;
    const src: SketchSource = { id: 'r1', kind: 'edge', ref: refTo('edge', b.id, edge) };
    // m: the projected edge's midpoint, only constraints on it; the hole 15 left of it
    const sk: CadSketch = {
      ...refSketch([src]),
      points: [{ id: 'r1.p0', x: 100, y: 0 }, { id: 'r1.p1', x: 100, y: 60 }, { id: 'm', x: 100, y: 30 }, { id: 'c', x: 85, y: 30 }],
      entities: [{ id: 'r1.e0', type: 'line', p1: 'r1.p0', p2: 'r1.p1', ref: 'r1', construction: true }, { id: 'k', type: 'circle', c: 'c', r: 5 }],
      constraints: [
        { id: 'mid', type: 'midpoint', refs: ['m', 'r1.e0'] },
        { id: 'hz', type: 'horizontal', refs: ['c', 'm'] },
        { id: 'dx', type: 'distanceX', refs: ['c', 'm'], value: '15' },
        { id: 'dr', type: 'radius', refs: ['k'], value: '5' },
      ],
    };
    const items: DesignItem[] = [...plate(), { kind: 'sketch', id: 's1', name: 'Hole', plane: { ref: 'XY', offset: '10' }, sketch: sk }];
    const { res } = solve(single(items), ['w := 130']);
    const rebuilt = built(res, 's1')!;
    expect(rebuilt.points.map((p) => p.id)).toContain('m');
    expect(rebuilt.constraints.map((k) => k.id).sort()).toEqual(['dr', 'dx', 'hz', 'mid']);
    const s = res.design!.sketches.s1;
    expect(s.dof).toBe(0);
    near(s.points.c[0], 115);
    near(s.points.m[0], 130);
    // written back into the stored sketch, the point and its constraints are still there
    const back = withReferencesOf(sk, rebuilt);
    expect(back).not.toBe(sk);
    expect(back.points.find((p) => p.id === 'm')).toBeDefined();
    expect(back.constraints).toHaveLength(4);
    near(back.points.find((p) => p.id === 'r1.p0')!.x, 130);
  });

  it('a face\'s outer loop: four lines that close a profile (made solid geometry, it extrudes to the face)', () => {
    const b = plateBody();
    const top = b.faces.find((f) => f.frame && abs(f.frame.n[2] - 1) < 1e-9)!;
    const src: SketchSource = { id: 'r1', kind: 'face', ref: refTo('face', b.id, top) };
    const items: DesignItem[] = [...plate(), { kind: 'sketch', id: 's1', name: 'Top', plane: { ref: 'XY', offset: '20' }, sketch: refSketch([src]) }];
    const { res } = solve(single(items), ['w := 100']);
    const sk = built(res, 's1')!;
    expect(sk.entities.filter((e) => e.type === 'line')).toHaveLength(4);
    // made part of the profile, its four corners close a 100 × 60 loop
    const solid = { ...sk, entities: sk.entities.map((e) => ({ ...e, construction: undefined })) };
    expect(profileProperties(findProfiles(solid).regions)!.A).toBeCloseTo(6000, 9);
  });

  it('a circle edge: a circle seen square, an ellipse r × r cos θ seen at θ, a line seen edge on', () => {
    const r = 12;
    const disc: DesignItem[] = [
      { kind: 'sketch', id: 's0', name: 'Disc', plane: { ref: 'XY' }, sketch: circles('c', [[0, 0, r]]) },
      { kind: 'extrude', id: 'f0', name: 'Disc', sketch: 's0', extent: { type: 'one', d: '5' }, op: 'new' },
    ];
    const { numbers } = solve(single(disc));
    const b = buildResultOcc(occ()!, single(disc), numbers).components.c1.bodies[0];
    const topEdge = b.edges.find((e) => e.circle && abs(e.circle.c[2] - 5) < 1e-9)!;
    const src: SketchSource = { id: 'r1', kind: 'edge', ref: refTo('edge', b.id, topEdge) };
    const th = PI / 4;
    const sketchOn = (plane: Extract<DesignItem, { kind: 'sketch' }>['plane']): CadSketch => {
      const { res } = solve(single([...disc, { kind: 'sketch', id: 's1', name: 'P', plane, sketch: refSketch([src]) }]));
      expect(res.design!.errors).toEqual({});
      return built(res, 's1')!;
    };
    const square = sketchOn({ ref: 'XY', offset: '30' });
    const k = square.entities.find((e) => e.type === 'circle') as Extract<CadEntity, { type: 'circle' }>;
    near(k.r, r);
    // a plane through the x axis tilted 45° about it
    const tilted = sketchOn({ frame: { o: [0, 0, 20], u: [1, 0, 0], v: [0, cos(th), sin(th)] } });
    const el = tilted.entities.find((e) => e.type === 'ellipse') as Extract<CadEntity, { type: 'ellipse' }>;
    near(el.r, r * cos(th));
    const c = tilted.points.find((p) => p.id === el.c)!, a = tilted.points.find((p) => p.id === el.a)!;
    near(hypot(a.x - c.x, a.y - c.y), r);
    // its area is the circle's times cos θ
    const solid = { ...tilted, entities: tilted.entities.map((e) => ({ ...e, construction: undefined })) };
    near(profileProperties(findProfiles(solid).regions)!.A, PI * r * r * SQRT1_2);
    const edgeOn = sketchOn({ ref: 'XZ' });
    const l = edgeOn.entities.find((e) => e.type === 'line')!;
    const [p, q] = pointsOf(edgeOn, l);
    near(hypot(q.x - p.x, q.y - p.y), 2 * r);
  });

  it('a reference that is gone keeps its geometry and says so', () => {
    const b = plateBody();
    const edge = b.edges.find((e) => e.line)!;
    const src: SketchSource = { id: 'r1', kind: 'edge', ref: { ...refTo('edge', b.id, edge), key: 'f9/side:zz|f9/end', hint: { ...refTo('edge', b.id, edge).hint, p: [999, 999, 999] } }, label: 'Lost edge' };
    const sk: CadSketch = { ...refSketch([src]), points: [{ id: 'r1.p0', x: 1, y: 2 }, { id: 'r1.p1', x: 3, y: 4 }], entities: [{ id: 'r1.e0', type: 'line', p1: 'r1.p0', p2: 'r1.p1', ref: 'r1', construction: true }] };
    const { res } = solve(single([...plate(), { kind: 'sketch', id: 's1', name: 'S', plane: { ref: 'XY' }, sketch: sk }]), ['w := 100']);
    expect(res.design!.warnings!.s1).toMatch(/Lost edge: reference lost/);
    expect(res.design!.sketches.s1.points['r1.p1']).toEqual([3, 4]);
  });
});

describe('intersect (section curves) and construction geometry', () => {
  const r = 10, h = 40;
  const cylinder: DesignItem[] = [
    { kind: 'sketch', id: 's0', name: 'Shaft', plane: { ref: 'XY' }, sketch: circles('c', [[0, 0, r]]) },
    { kind: 'extrude', id: 'f0', name: 'Shaft', sketch: 's0', extent: { type: 'one', d: String(h) }, op: 'new' },
  ];
  const section = (plane: Extract<DesignItem, { kind: 'sketch' }>['plane']): CadSketch => {
    const { res } = solve(single([...cylinder, { kind: 'sketch', id: 's1', name: 'Cut', plane, sketch: refSketch([{ id: 'x1', kind: 'section' }]) }]));
    expect(res.design!.errors).toEqual({});
    return built(res, 's1')!;
  };
  const solidArea = (sk: CadSketch) => profileProperties(findProfiles({ ...sk, entities: sk.entities.map((e) => ({ ...e, construction: undefined })) }).regions)!.A;

  it('across the axis: the circle; through it: a 2r × h rectangle', () => {
    const across = section({ ref: 'XY', offset: '15' });
    expect(across.entities.map((e) => e.type)).toEqual(['circle']);
    near((across.entities[0] as { r: number }).r, r);
    const through = section({ ref: 'XZ' });
    expect(through.entities.every((e) => e.type === 'line')).toBe(true);
    near(solidArea(through), 2 * r * h);
  });

  it('at 60° to the axis: an ellipse r/sin 60° × r, area πr²/sin 60°', () => {
    const th = PI / 3;
    // through (0, 0, 20), its normal at 30° to the axis
    const sk = section({ frame: { o: [0, 0, 20], u: [sin(th), 0, -cos(th)], v: [0, 1, 0] } });
    const el = sk.entities.find((e) => e.type === 'ellipse') as Extract<CadEntity, { type: 'ellipse' }>;
    expect(el).toBeDefined();
    near(solidArea(sk), (PI * r * r) / sin(th));
  });

  it('a construction axis comes in as a line along it', () => {
    // an axis along the cylinder's (a construction axis through it), seen from the side
    const b = buildResultOcc(occ()!, single(cylinder), solve(single(cylinder)).numbers).components.c1.bodies[0];
    const wall = b.faces.find((f) => f.type === 'cylinder')!;
    const withAxis: DesignItem[] = [
      ...cylinder,
      { kind: 'axis', id: 'ax', name: 'Axis1', def: { type: 'cylinder', face: refTo('face', b.id, wall) } },
      { kind: 'sketch', id: 's1', name: 'Side', plane: { ref: 'XZ' }, sketch: refSketch([{ id: 'd1', kind: 'datum', datum: 'ax' }]) },
    ];
    const { res } = solve(single(withAxis));
    expect(res.design!.errors).toEqual({});
    const sk = built(res, 's1')!;
    const line = sk.entities.find((e) => e.type === 'line')!;
    const [p, q] = pointsOf(sk, line);
    // the axis is the sketch's y (world z) through x = 0
    expect(abs(p.x) + abs(q.x)).toBeLessThan(1e-9);
    expect(abs(q.y - p.y)).toBeGreaterThan(h);
  });
});

describe('B-rep handles', () => {
  it('deletes every OCCT object of projections and sections', () => {
    const oc = occ()!;
    const b = plateBody();
    const top = b.faces.find((f) => f.frame && abs(f.frame.n[2] - 1) < 1e-9)!;
    const d = single([
      ...plate(),
      { kind: 'sketch', id: 's1', name: 'S', plane: { ref: 'XZ', offset: '-30' }, sketch: refSketch([{ id: 'x1', kind: 'section' }, { id: 'r2', kind: 'face', ref: refTo('face', b.id, top) }]) },
    ]);
    const { numbers } = solve(d, ['w := 100']);
    const watch = watchHandles(oc);
    try {
      const out = buildDesignOcc(oc, d, numbers);
      expect(Object.values(out.components.get('c1')!.errors)).toEqual([]);
      expect(out.components.get('c1')!.sketches?.s1).toBeDefined();
      out.free();
      expect(watch.undeleted()).toEqual([]);
    } finally {
      watch.stop();
    }
  });
});
