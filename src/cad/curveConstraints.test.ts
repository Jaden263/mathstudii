// Constraints and degrees of freedom of splines and ellipses. Freedom counts follow from
// the unknowns (a point has 2, an ellipse 5 = centre, axis end, minor semi-axis) less one
// per independent equation; the geometric checks are the definitions themselves: parallel
// directions for tangency, equal curvature vectors for G2 (κ = 1/r towards the centre),
// zero distance for points on curves, and d² = a²n_x² + b²n_y² for a line touching an
// ellipse (the support function of the ellipse).
import { describe, expect, it } from 'vitest';
import { solveSketch } from './solver';
import { applyConstraint, withSolution, type Geo } from './edit';
import { bsClosest, bsDomain, bsEval, bsPoint } from './curves';
import { ellipseOf, splineOf } from './sketchCurves';
import type { CadConstraint, CadEntity, CadPoint, CadSketch } from './model';
import type { Vec2 } from './profile';

const { hypot, abs, cos, sin, sqrt } = Math;
const pts = (o: Record<string, [number, number]>): CadPoint[] => Object.entries(o).map(([id, [x, y]]) => ({ id, x, y }));
const geo = (sk: CadSketch): Geo => ({ sk, P: new Map(sk.points.map((p) => [p.id, { x: p.x, y: p.y }])), R: new Map() });
const K = (id: string, type: CadConstraint['type'], refs: string[], extra: Partial<CadConstraint> = {}): CadConstraint => ({ id, type, refs, ...extra });
/** Solve and write the solution back. */
function solved(sk: CadSketch, values: Record<string, number> = {}) {
  const sol = solveSketch(sk, { values: new Map(Object.entries(values)) });
  return { sol, sk: withSolution(sk, sol.points, sol.radii) };
}
const P = (sk: CadSketch) => (id: string): Vec2 | undefined => sk.points.find((p) => p.id === id);
const cross = (a: Vec2, b: Vec2) => (a.x * b.y - a.y * b.x) / (hypot(a.x, a.y) * hypot(b.x, b.y));

const spline: CadEntity = { id: 's', type: 'spline', pts: ['q0', 'q1', 'q2', 'q3'] };
const splinePts = pts({ q0: [0, 0], q1: [20, 15], q2: [45, 8], q3: [60, 30] });

describe('degrees of freedom', () => {
  it('a fit spline: two per point, two per tangent handle', () => {
    expect(solveSketch({ points: splinePts, entities: [spline], constraints: [] }).dof).toBe(8);
    const withH: CadSketch = { points: [...splinePts, ...pts({ h: [5, 10] })], entities: [{ ...spline, type: 'spline', pts: ['q0', 'q1', 'q2', 'q3'], h1: 'h' }], constraints: [] };
    expect(solveSketch(withH).dof).toBe(10);
  });

  it('an ellipse has five (centre, axis end, minor semi-axis), an elliptical arc seven', () => {
    const base = pts({ c: [0, 0], a: [30, 0] });
    expect(solveSketch({ points: base, entities: [{ id: 'e', type: 'ellipse', c: 'c', a: 'a', r: 10 }], constraints: [] }).dof).toBe(5);
    const arc: CadSketch = {
      points: [...base, ...pts({ p: [30, 0], q: [0, 10] })],
      entities: [{ id: 'e', type: 'ellipse', c: 'c', a: 'a', r: 10, p1: 'p', p2: 'q' }], constraints: [],
    };
    expect(solveSketch(arc).dof).toBe(7);
  });

  it('a fully dimensioned ellipse: fixed centre, horizontal axis, a = 30, b = 12', () => {
    const sk: CadSketch = {
      points: pts({ c: [1, 2], a: [28, 6] }),
      entities: [{ id: 'e', type: 'ellipse', c: 'c', a: 'a', r: 9 }],
      constraints: [K('f', 'fix', ['c'], { at: { x: 0, y: 0 } }), K('h', 'horizontal', ['e']), K('da', 'majorRadius', ['e'], { value: '30' }), K('db', 'minorRadius', ['e'], { value: '12' })],
    };
    const { sol, sk: out } = solved(sk, { da: 30, db: 12 });
    expect(sol.ok).toBe(true);
    expect(sol.dof).toBe(0);
    expect(sol.determined.has('a')).toBe(true);
    expect(sol.determinedRadii.has('e')).toBe(true);
    expect(P(out)('a')!.x).toBeCloseTo(30, 9);
    expect(P(out)('a')!.y).toBeCloseTo(0, 9);
    expect(sol.radii.get('e')).toBeCloseTo(12, 9);
  });

  it('collinear takes two', () => {
    const sk: CadSketch = {
      points: pts({ a: [0, 0], b: [10, 1], c: [20, 3], d: [30, 2] }),
      entities: [{ id: 'l1', type: 'line', p1: 'a', p2: 'b' }, { id: 'l2', type: 'line', p1: 'c', p2: 'd' }],
      constraints: [K('k', 'collinear', ['l1', 'l2'])],
    };
    const { sol, sk: out } = solved(sk);
    expect(sol.dof).toBe(6);
    const q = P(out), a = q('a')!, b = q('b')!;
    for (const id of ['c', 'd']) expect(abs(cross({ x: b.x - a.x, y: b.y - a.y }, { x: q(id)!.x - a.x, y: q(id)!.y - a.y }))).toBeLessThan(1e-9);
  });

  it('reference geometry does not move and has no freedom; points drawn on it follow it', () => {
    const sk: CadSketch = {
      points: pts({ a: [0, 0], b: [50, 0], p: [12, 7] }),
      entities: [{ id: 'r', type: 'line', p1: 'a', p2: 'b', ref: 'src', construction: true }, { id: 'pt', type: 'point', p: 'p' }],
      constraints: [K('k', 'pointOnLine', ['p', 'r'])],
    };
    const { sol } = solved(sk);
    expect(sol.dof).toBe(1);
    expect(sol.points.get('b')).toEqual({ x: 50, y: 0 });
    expect(sol.points.get('p')!.y).toBeCloseTo(0, 9);
    expect(sol.determined.has('a') && sol.determined.has('b')).toBe(true);
    // dragging reference geometry does nothing
    const dragged = solveSketch(sk, { drag: new Map([['b', { x: 60, y: 20 }]]) });
    expect(dragged.points.get('b')).toEqual({ x: 50, y: 0 });
  });
});

describe('tangency and curvature with splines', () => {
  it('a spline end tangent to a line it does not touch: a handle is added and turned onto the line direction', () => {
    const sk0: CadSketch = { points: [...splinePts, ...pts({ l0: [-30, 20], l1: [-10, 40] })], entities: [spline, { id: 'l', type: 'line', p1: 'l0', p2: 'l1' }], constraints: [] };
    const before = solveSketch(sk0).dof;
    const sk1 = applyConstraint('tangent', geo(sk0), ['s', 'l']);
    if (typeof sk1 === 'string') throw new Error(sk1);
    const sp = sk1.entities.find((e) => e.id === 's') as Extract<CadEntity, { type: 'spline' }>;
    expect(sp.h1).toBeDefined();
    // the handle sits where the curve already pointed: the curve is the same
    const c0 = splineOf(spline as Extract<CadEntity, { type: 'spline' }>, P(sk0))!, c1 = splineOf(sp, P(sk1))!;
    for (const u of [0.1, 0.5, 0.9]) expect(hypot(bsPoint(c0, u).x - bsPoint(c1, u).x, bsPoint(c0, u).y - bsPoint(c1, u).y)).toBeLessThan(1e-9);
    const { sol, sk } = solved(sk1);
    expect(sol.ok).toBe(true);
    // two more unknowns (the handle), one equation
    expect(sol.dof).toBe(before + 1);
    const q = P(sk), h = q(sp.h1!)!, p0 = q('q0')!, a = q('l0')!, b = q('l1')!;
    expect(abs(cross({ x: h.x - p0.x, y: h.y - p0.y }, { x: b.x - a.x, y: b.y - a.y }))).toBeLessThan(1e-9);
  });

  it('a line ending where a spline starts, tangent there (natural end, no handle asked for)', () => {
    const sk0: CadSketch = {
      points: [...splinePts, ...pts({ l0: [-20, -10] })],
      entities: [spline, { id: 'l', type: 'line', p1: 'l0', p2: 'q0' }],
      constraints: [K('t', 'tangent', ['l', 's'], { ends: [-1, 0] })],
    };
    const { sol, sk } = solved(sk0);
    expect(sol.ok).toBe(true);
    const cv = splineOf(sk.entities[0] as Extract<CadEntity, { type: 'spline' }>, P(sk))!;
    const d = bsEval(cv, 0, 1)[1], a = P(sk)('l0')!, b = P(sk)('q0')!;
    expect(abs(cross(d, { x: b.x - a.x, y: b.y - a.y }))).toBeLessThan(1e-9);
  });

  it('G2: a spline end continues an arc with its curvature (κ = 1/r towards the centre)', () => {
    // arc of radius 20 about (0, −20) ending at the origin, where the spline starts
    const sk0: CadSketch = {
      points: [...splinePts, ...pts({ c: [0, -20], a0: [-20, -20] })],
      entities: [spline, { id: 'arc', type: 'arc', c: 'c', p1: 'a0', p2: 'q0' }],
      constraints: [K('f1', 'fix', ['c']), K('f2', 'fix', ['a0']), K('f3', 'fix', ['q0']), K('f4', 'fix', ['q3'])],
    };
    const t = applyConstraint('curvature', geo(sk0), ['arc', 's']);
    if (typeof t === 'string') throw new Error(t);
    expect(t.constraints.filter((c) => c.type === 'tangent' || c.type === 'curvature')).toHaveLength(2);
    const { sol, sk } = solved(t);
    expect(sol.ok).toBe(true);
    const cv = splineOf(sk.entities[0] as Extract<CadEntity, { type: 'spline' }>, P(sk))!;
    const [, d1, d2] = bsEval(cv, bsDomain(cv)[0], 2);
    const s2 = d1.x * d1.x + d1.y * d1.y, along = (d2.x * d1.x + d2.y * d1.y) / s2;
    const k = { x: (d2.x - along * d1.x) / s2, y: (d2.y - along * d1.y) / s2 };
    // curvature vector at the origin: towards (0, −20), length 1/20
    expect(k.x).toBeCloseTo(0, 9);
    expect(k.y).toBeCloseTo(-1 / 20, 9);
  });
});

describe('points on curves and ellipse tangency', () => {
  it('a point onto a spline lands on the curve', () => {
    const sk0: CadSketch = { points: [...splinePts, ...pts({ p: [30, 30] })], entities: [spline, { id: 'pt', type: 'point', p: 'p' }], constraints: [K('k', 'pointOnCurve', ['p', 's'])] };
    const { sol, sk } = solved(sk0);
    expect(sol.ok).toBe(true);
    // 8 for the spline, 2 for the point, less 1: it slides along the curve
    expect(sol.dof).toBe(9);
    expect(sol.determined.has('p')).toBe(false);
    const cv = splineOf(sk.entities[0] as Extract<CadEntity, { type: 'spline' }>, P(sk))!;
    const p = P(sk)('p')!, c = bsPoint(cv, bsClosest(cv, p));
    expect(hypot(p.x - c.x, p.y - c.y)).toBeLessThan(1e-9);
  });

  it('a point on a spline dragged past its end stops at the end (not on the end\'s tangent, off the curve)', () => {
    const fixed = splinePts.map((q) => K(`f${q.id}`, 'fix', [q.id], { at: { x: q.x, y: q.y } }));
    const sk0: CadSketch = { points: [...splinePts, ...pts({ p: [45, 8] })], entities: [spline, { id: 'pt', type: 'point', p: 'p' }], constraints: [...fixed, K('k', 'pointOnCurve', ['p', 's'])] };
    const cv = splineOf(spline as Extract<CadEntity, { type: 'spline' }>, P(sk0))!;
    // beyond the end at (60, 30), along its tangent and off to the side; and before the start
    const [, D] = bsEval(cv, 1, 1), L = hypot(D.x, D.y);
    for (const [to, end] of [[{ x: 60 + (20 * D.x) / L, y: 30 + (20 * D.y) / L }, { x: 60, y: 30 }], [{ x: 75, y: 20 }, { x: 60, y: 30 }], [{ x: -15, y: -10 }, { x: 0, y: 0 }]] as const) {
      const sol = solveSketch(sk0, { drag: new Map([['p', to]]) });
      const p = sol.points.get('p')!, c = bsPoint(cv, bsClosest(cv, p));
      expect(hypot(p.x - c.x, p.y - c.y)).toBeLessThan(1e-6);
      expect(hypot(p.x - end.x, p.y - end.y)).toBeLessThan(1e-6);
    }
  });

  it('a line tangent to a turned ellipse: d² = a²n_x² + b²n_y²', () => {
    const r = 10, a = 25, th = 0.4;
    const sk0: CadSketch = {
      points: pts({ c: [0, 0], ax: [a * cos(th), a * sin(th)], l0: [-40, 18], l1: [40, 22] }),
      entities: [{ id: 'e', type: 'ellipse', c: 'c', a: 'ax', r }, { id: 'l', type: 'line', p1: 'l0', p2: 'l1' }],
      constraints: [K('f1', 'fix', ['c']), K('f2', 'fix', ['ax']), K('h', 'horizontal', ['l']), K('t', 'tangent', ['l', 'e'])],
    };
    const { sol, sk } = solved({ ...sk0, constraints: [...sk0.constraints, K('dr', 'minorRadius', ['e'], { value: '10' })] }, { dr: 10 });
    expect(sol.ok).toBe(true);
    // a horizontal line touches the ellipse at height √(a² sin²θ + b² cos²θ)
    expect(P(sk)('l0')!.y).toBeCloseTo(sqrt(a * a * sin(th) ** 2 + r * r * cos(th) ** 2), 9);
  });

  it('an elliptical arc keeps its ends on the ellipse when the axis grows; concentric with a circle', () => {
    const sk0: CadSketch = {
      points: pts({ c: [0, 0], ax: [30, 0], p: [30, 0], q: [0, 10], k: [3, 4] }),
      entities: [{ id: 'e', type: 'ellipse', c: 'c', a: 'ax', r: 10, p1: 'p', p2: 'q' }, { id: 'ci', type: 'circle', c: 'k', r: 5 }],
      constraints: [K('f', 'fix', ['c']), K('h', 'horizontal', ['e']), K('d', 'majorRadius', ['e'], { value: '40' }), K('cc', 'concentric', ['ci', 'e'])],
    };
    const { sol, sk } = solved(sk0, { d: 40 });
    expect(sol.ok).toBe(true);
    const el = ellipseOf(sk.entities[0] as Extract<CadEntity, { type: 'ellipse' }>, P(sk), (id) => sol.radii.get(id))!;
    expect(el.ra).toBeCloseTo(40, 9);
    for (const id of ['p', 'q']) {
      const v = P(sk)(id)!;
      expect((v.x / el.ra) ** 2 + (v.y / el.rb) ** 2).toBeCloseTo(1, 9);
    }
    expect(hypot(P(sk)('k')!.x, P(sk)('k')!.y)).toBeLessThan(1e-9);
  });
});
