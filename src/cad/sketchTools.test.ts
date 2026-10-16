// The sketch tools for chains and patterns, against closed forms: an a × b rectangle offset
// outward by d with arc corners encloses (a + 2d)(b + 2d) − (4 − π)d² (the corners are
// quarter circles of radius d), inward (a − 2d)(b − 2d); a rounded rectangle offset by d
// is a rounded rectangle with corner radius r + d; a chamfer d × d takes d²/2 off a square
// corner; patterns make count copies that follow the source and its spacing.
import { describe, expect, it } from 'vitest';
import { chamfer, breakCurve, ellipse, ellipticalArc, extend, offset, pattern, repattern, spline } from './sketchTools';
import { solveSketch } from './solver';
import { withSolution } from './edit';
import { findProfiles, profileProperties, type Vec2 } from './profile';
import type { CadConstraint, CadEntity, CadSketch } from './model';
import { bsPoint } from './curves';
import { splineOf } from './sketchCurves';

const { PI, abs, hypot, cos, sin } = Math;
const near = (v: number, want: number, rel = 1e-9) => expect(abs(v - want) / abs(want)).toBeLessThan(rel);

/** An a × b rectangle from the origin, held by a fixed corner and two length dimensions (fully defined). */
function rectangle(a: number, b: number): CadSketch {
  return {
    points: [{ id: 'A', x: 0, y: 0 }, { id: 'B', x: a, y: 0 }, { id: 'C', x: a, y: b }, { id: 'D', x: 0, y: b }],
    entities: [
      { id: 'l0', type: 'line', p1: 'A', p2: 'B' }, { id: 'l1', type: 'line', p1: 'B', p2: 'C' },
      { id: 'l2', type: 'line', p1: 'C', p2: 'D' }, { id: 'l3', type: 'line', p1: 'D', p2: 'A' },
    ],
    constraints: [
      { id: 'h0', type: 'horizontal', refs: ['l0'] }, { id: 'v1', type: 'vertical', refs: ['l1'] },
      { id: 'h2', type: 'horizontal', refs: ['l2'] }, { id: 'v3', type: 'vertical', refs: ['l3'] },
      { id: 'fx', type: 'fix', refs: ['A'], at: { x: 0, y: 0 } },
      { id: 'da', type: 'length', refs: ['l0'], value: String(a), name: 'a' },
      { id: 'db', type: 'length', refs: ['l1'], value: String(b), name: 'b' },
    ],
  };
}
const posOf = (sk: CadSketch) => new Map(sk.points.map((p) => [p.id, { x: p.x, y: p.y } as Vec2]));
const R0 = new Map<string, number>();
/** Every driving dimension's value from its text (plain numbers, or "<n> deg"). */
function values(sk: CadSketch): Map<string, number> {
  const out = new Map<string, number>();
  for (const c of sk.constraints) {
    if (!c.value) continue;
    const deg = /deg/.test(c.value);
    out.set(c.id, deg ? (parseFloat(c.value) * PI) / 180 : parseFloat(c.value));
  }
  return out;
}
function solved(sk: CadSketch) {
  const sol = solveSketch(sk, { values: values(sk) });
  return { sol, sk: withSolution(sk, sol.points, sol.radii) };
}
/** Area of the profiles made only of the given entities. */
function areaOf(sk: CadSketch, ids: string[]): number {
  const only = { ...sk, entities: sk.entities.filter((e) => ids.includes(e.id) || e.construction === true).map((e) => (ids.includes(e.id) ? { ...e, construction: undefined } : { ...e, construction: true })) };
  return profileProperties(findProfiles(only).regions)!.A;
}
const setDim = (sk: CadSketch, id: string, v: number): CadSketch => ({ ...sk, constraints: sk.constraints.map((c) => (c.id === id ? { ...c, value: String(v) } : c)) });

describe('offset', () => {
  const a = 80, b = 50, d = 6;

  it('a rectangle outward by d with arc corners: (a + 2d)(b + 2d) − (4 − π)d²', () => {
    const base = solved(rectangle(a, b)).sk;
    const r = offset(base, posOf(base), R0, ['l0', 'l1', 'l2', 'l3'], d, { x: -10, y: -10 });
    if (typeof r === 'string') throw new Error(r);
    expect(r.ids).toHaveLength(8); // four lines and four corner arcs
    const { sol, sk } = solved(r.sketch);
    expect(sol.ok).toBe(true);
    // fully defined: the rectangle is, and one dimension holds the offset
    expect(sol.dof).toBe(0);
    near(areaOf(sk, r.ids), (a + 2 * d) * (b + 2 * d) - (4 - PI) * d * d);
  });

  it('follows its chain: the rectangle made wider, the offset is still d all round', () => {
    const base = solved(rectangle(a, b)).sk;
    const r = offset(base, posOf(base), R0, ['l0', 'l1', 'l2', 'l3'], d, { x: -10, y: -10 });
    if (typeof r === 'string') throw new Error(r);
    const { sol, sk } = solved(setDim(r.sketch, 'da', 120));
    expect(sol.ok).toBe(true);
    near(areaOf(sk, r.ids), (120 + 2 * d) * (b + 2 * d) - (4 - PI) * d * d);
    // and the offset distance itself is a dimension
    const off = sk.constraints.find((c) => c.type === 'offset')!;
    const { sk: sk2 } = solved(setDim(sk, off.id, 10));
    near(areaOf(sk2, r.ids), (120 + 20) * (b + 20) - (4 - PI) * 100);
  });

  it('inward the corners meet: (a − 2d)(b − 2d)', () => {
    const base = solved(rectangle(a, b)).sk;
    const r = offset(base, posOf(base), R0, ['l0', 'l1', 'l2', 'l3'], d, { x: 40, y: 25 });
    if (typeof r === 'string') throw new Error(r);
    expect(r.ids).toHaveLength(4);
    const { sol, sk } = solved(r.sketch);
    expect(sol.dof).toBe(0);
    near(areaOf(sk, r.ids), (a - 2 * d) * (b - 2 * d));
  });

  it('a rounded rectangle (arcs tangent to lines) outward: corner radius r + d', () => {
    // w × h with corners of radius rc: lines and quarter arcs, tangent
    const w = 60, h = 40, rc = 8;
    const pts: [number, number][] = [[rc, 0], [w - rc, 0], [w, rc], [w, h - rc], [w - rc, h], [rc, h], [0, h - rc], [0, rc]];
    const cs: [number, number][] = [[w - rc, rc], [w - rc, h - rc], [rc, h - rc], [rc, rc]];
    const sk0: CadSketch = {
      points: [...pts.map(([x, y], i) => ({ id: `p${i}`, x, y })), ...cs.map(([x, y], i) => ({ id: `c${i}`, x, y }))],
      entities: [0, 1, 2, 3].flatMap((k): CadEntity[] => [
        { id: `l${k}`, type: 'line', p1: `p${2 * k}`, p2: `p${2 * k + 1}` },
        { id: `a${k}`, type: 'arc', c: `c${k}`, p1: `p${2 * k + 1}`, p2: `p${(2 * k + 2) % 8}` },
      ]),
      constraints: [],
    };
    const ids = sk0.entities.map((e) => e.id);
    const r = offset(sk0, posOf(sk0), R0, ids, 3, { x: -5, y: 20 });
    if (typeof r === 'string') throw new Error(r);
    expect(r.ids).toHaveLength(8); // no corner arcs: every joint is smooth
    const { sol, sk } = solved(r.sketch);
    expect(sol.ok).toBe(true);
    near(areaOf(sk, r.ids), (w + 6) * (h + 6) - (4 - PI) * (rc + 3) ** 2);
  });

  it('a circle: concentric, r + d', () => {
    const sk0: CadSketch = { points: [{ id: 'c', x: 5, y: 5 }], entities: [{ id: 'k', type: 'circle', c: 'c', r: 10 }], constraints: [] };
    const r = offset(sk0, posOf(sk0), new Map([['k', 10]]), ['k'], 4, { x: 30, y: 5 });
    if (typeof r === 'string') throw new Error(r);
    const k2 = r.sketch.entities.find((e) => e.id === r.ids[0]) as Extract<CadEntity, { type: 'circle' }>;
    expect(k2.c).toBe('c');
    expect(k2.r).toBe(14);
    const { sol } = solved({ ...r.sketch, constraints: [...r.sketch.constraints, { id: 'dk', type: 'radius', refs: ['k'], value: '20' }] });
    expect(sol.radii.get(r.ids[0])).toBeCloseTo(24, 9);
  });

  it('an open chain: the ends square to the source ends, nothing left free', () => {
    const sk0: CadSketch = {
      points: [{ id: 'A', x: 0, y: 0 }, { id: 'B', x: 50, y: 0 }, { id: 'C', x: 50, y: 30 }],
      entities: [{ id: 'l0', type: 'line', p1: 'A', p2: 'B' }, { id: 'l1', type: 'line', p1: 'B', p2: 'C' }],
      constraints: [{ id: 'f1', type: 'fix', refs: ['A'] }, { id: 'f2', type: 'fix', refs: ['B'] }, { id: 'f3', type: 'fix', refs: ['C'] }],
    };
    const r = offset(sk0, posOf(sk0), R0, ['l0', 'l1'], 5, { x: 25, y: 10 });
    if (typeof r === 'string') throw new Error(r);
    const { sol, sk } = solved(r.sketch);
    expect(sol.dof).toBe(0);
    // inside the corner: the offsets meet at (45, 5) and end at (0, 5) and (45, 30)
    const ends = r.ids.flatMap((id) => {
      const e = sk.entities.find((x) => x.id === id) as Extract<CadEntity, { type: 'line' }>;
      return [e.p1, e.p2];
    }).map((id) => sk.points.find((p) => p.id === id)!);
    const has = (x: number, y: number) => ends.some((p) => hypot(p.x - x, p.y - y) < 1e-9);
    expect(has(0, 5) && has(45, 5) && has(45, 30)).toBe(true);
  });

  it('refuses an offset larger than an arc of the chain', () => {
    const sk0: CadSketch = {
      points: [{ id: 'c', x: 0, y: 0 }, { id: 'a', x: 5, y: 0 }, { id: 'b', x: 0, y: 5 }],
      entities: [{ id: 'arc', type: 'arc', c: 'c', p1: 'a', p2: 'b' }],
      constraints: [],
    };
    expect(offset(sk0, posOf(sk0), R0, ['arc'], 8, { x: 0.5, y: 0.5 })).toMatch(/larger than the radius/);
  });
});

describe('chamfer, extend and break', () => {
  it('a chamfer d × d takes d²/2 off a corner and keeps the freedom count', () => {
    const base = solved(rectangle(40, 30)).sk;
    const r = chamfer(base, posOf(base), 'C', 5);
    if (typeof r === 'string') throw new Error(r);
    const { sol, sk } = solved(r.sketch);
    expect(sol.ok).toBe(true);
    expect(sol.dof).toBe(0);
    const ids = sk.entities.filter((e) => e.type === 'line' && !e.construction).map((e) => e.id);
    near(areaOf(sk, ids), 40 * 30 - 12.5);
  });

  it('extend: a line runs on to the circle it points at', () => {
    const sk0: CadSketch = {
      points: [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 10, y: 0 }, { id: 'c', x: 40, y: 0 }],
      entities: [{ id: 'l', type: 'line', p1: 'a', p2: 'b' }, { id: 'k', type: 'circle', c: 'c', r: 10 }],
      constraints: [],
    };
    const r = extend(sk0, posOf(sk0), new Map([['k', 10]]), 'l', { x: 9, y: 0 });
    if (typeof r === 'string') throw new Error(r);
    expect(r.sketch.points.find((p) => p.id === 'b')!.x).toBeCloseTo(30, 9);
    expect(r.sketch.constraints.some((c) => c.type === 'pointOnCircle' && c.refs[0] === 'b')).toBe(true);
  });

  it('break: a line into two collinear lines, an arc into two on one circle', () => {
    const sk0: CadSketch = {
      points: [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 30, y: 0 }, { id: 'c', x: 0, y: 20 }, { id: 'p', x: 10, y: 20 }, { id: 'q', x: 0, y: 30 }],
      entities: [{ id: 'l', type: 'line', p1: 'a', p2: 'b' }, { id: 'arc', type: 'arc', c: 'c', p1: 'p', p2: 'q' }],
      constraints: [],
    };
    const r = breakCurve(sk0, posOf(sk0), R0, 'l', { x: 12, y: 1 });
    if (typeof r === 'string') throw new Error(r);
    expect(r.sketch.entities.filter((e) => e.type === 'line')).toHaveLength(2);
    expect(r.sketch.constraints.some((c) => c.type === 'collinear')).toBe(true);
    const mid = r.sketch.points.find((p) => !sk0.points.some((q) => q.id === p.id))!;
    expect(mid.x).toBeCloseTo(12, 9);
    expect(mid.y).toBeCloseTo(0, 12);
    const r2 = breakCurve(r.sketch, posOf(r.sketch), R0, 'arc', { x: 7, y: 27 });
    if (typeof r2 === 'string') throw new Error(r2);
    const arcs = r2.sketch.entities.filter((e) => e.type === 'arc');
    expect(arcs).toHaveLength(2);
    expect(r2.sketch.constraints.some((c) => c.type === 'equal' && c.refs.includes('arc'))).toBe(true);
    // a solve keeps both on the circle
    const { sol } = solved(r2.sketch);
    expect(sol.ok).toBe(true);
  });

  it('break: a control spline into two exact pieces', () => {
    const P = [{ x: 0, y: 0 }, { x: 10, y: 20 }, { x: 30, y: 25 }, { x: 45, y: 5 }, { x: 60, y: 15 }];
    const sk0: CadSketch = { points: P.map((p, i) => ({ id: `q${i}`, ...p })), entities: [{ id: 's', type: 'spline', mode: 'control', pts: P.map((_, i) => `q${i}`) }], constraints: [] };
    const whole = splineOf(sk0.entities[0] as Extract<CadEntity, { type: 'spline' }>, (id) => posOf(sk0).get(id))!;
    const at = bsPoint(whole, 0.37);
    const r = breakCurve(sk0, posOf(sk0), R0, 's', at);
    if (typeof r === 'string') throw new Error(r);
    const [a, b] = r.sketch.entities.map((e) => splineOf(e as Extract<CadEntity, { type: 'spline' }>, (id) => posOf(r.sketch).get(id))!);
    for (let i = 0; i <= 10; i++) {
      const u = (0.37 * i) / 10, v = 0.37 + (0.63 * i) / 10;
      expect(hypot(bsPoint(a, u).x - bsPoint(whole, u).x, bsPoint(a, u).y - bsPoint(whole, u).y)).toBeLessThan(1e-9);
      expect(hypot(bsPoint(b, v).x - bsPoint(whole, v).x, bsPoint(b, v).y - bsPoint(whole, v).y)).toBeLessThan(1e-9);
    }
  });
});

describe('patterns', () => {
  const hole = (): CadSketch => ({
    points: [{ id: 'c', x: 10, y: 10 }],
    entities: [{ id: 'k', type: 'circle', c: 'c', r: 3 }],
    constraints: [{ id: 'fx', type: 'fix', refs: ['c'] }, { id: 'dr', type: 'radius', refs: ['k'], value: '3' }],
  });

  it('rectangular 4 × 3: twelve circles, all determined, following the spacings', () => {
    const sk0 = hole();
    const r = pattern(sk0, posOf(sk0), ['k'], { kind: 'rect', count: 4, spacing: 15, count2: 3, spacing2: 12 });
    if (typeof r === 'string') throw new Error(r);
    const { sol, sk } = solved(r.sketch);
    expect(sk.entities.filter((e) => e.type === 'circle')).toHaveLength(12);
    expect(sol.ok).toBe(true);
    expect(sol.dof).toBe(0);
    const pats = sk.constraints.filter((c) => c.type === 'pattern');
    expect(pats).toHaveLength(2);
    // a wider spacing moves every copy
    const { sk: sk2 } = solved(setDim(sk, pats[0].id, 20));
    const xs = [...new Set(sk2.entities.filter((e) => e.type === 'circle').map((e) => +sk2.points.find((p) => p.id === (e as { c: string }).c)!.x.toFixed(9)))].sort((p, q) => p - q);
    expect(xs).toEqual([10, 30, 50, 70]);
  });

  it('circular, 6 round a point: 60° apart on the circle through the source', () => {
    const sk0: CadSketch = { ...hole(), points: [...hole().points, { id: 'o', x: 0, y: 0 }], entities: [...hole().entities, { id: 'po', type: 'point', p: 'o' }] };
    const r = pattern(sk0, posOf(sk0), ['k'], { kind: 'circ', count: 6, spacing: 0, about: 'o', angle: 360 });
    if (typeof r === 'string') throw new Error(r);
    const { sol, sk } = solved({ ...r.sketch, constraints: [...r.sketch.constraints, { id: 'fo', type: 'fix', refs: ['o'] }] });
    expect(sol.dof).toBe(0);
    const centres = sk.entities.filter((e) => e.type === 'circle').map((e) => sk.points.find((p) => p.id === (e as { c: string }).c)!);
    expect(centres).toHaveLength(6);
    const R = hypot(10, 10);
    centres.forEach((p, k) => {
      const a = PI / 4 + (k * PI) / 3;
      expect(p.x).toBeCloseTo(R * cos(a), 9);
      expect(p.y).toBeCloseTo(R * sin(a), 9);
    });
  });

  it('repattern: another count makes the copies again, the spacing kept', () => {
    const sk0 = hole();
    const r = pattern(sk0, posOf(sk0), ['k'], { kind: 'rect', count: 5, spacing: 15 });
    if (typeof r === 'string') throw new Error(r);
    const sk1 = solved(r.sketch).sk;
    const cid = sk1.constraints.find((c) => c.type === 'pattern')!.id;
    const r2 = repattern(sk1, posOf(sk1), cid, 3);
    if (typeof r2 === 'string') throw new Error(r2);
    expect(r2.sketch.entities.filter((e) => e.type === 'circle')).toHaveLength(3);
    const p = r2.sketch.constraints.find((c) => c.type === 'pattern') as CadConstraint;
    expect(p.id).toBe(cid);
    expect(p.pattern!.count).toBe(3);
    expect(solved(r2.sketch).sol.dof).toBe(0);
  });
});

describe('creating splines and ellipses', () => {
  it('a closed fit spline from clicked points (the first clicked again closes it)', () => {
    const empty: CadSketch = { points: [], entities: [], constraints: [] };
    const r = spline(empty, [{ p: { x: 0, y: 0 } }, { p: { x: 20, y: 0 } }, { p: { x: 10, y: 15 } }], { closed: true });
    if (typeof r === 'string') throw new Error(r);
    expect(findProfiles(r.sketch).regions).toHaveLength(1);
    expect(spline(empty, [{ p: { x: 0, y: 0 } }], {})).toMatch(/two points/);
  });

  it('an elliptical arc: the start sets the minor semi-axis', () => {
    const empty: CadSketch = { points: [], entities: [], constraints: [] };
    // on x²/30² + y²/b² = 1 through (18, 8): b = 8 / √(1 − 0.36) = 10
    const r = ellipticalArc(empty, { p: { x: 0, y: 0 } }, { p: { x: 30, y: 0 } }, { x: 18, y: 8 }, { x: -30, y: 1 });
    if (typeof r === 'string') throw new Error(r);
    const e = r.sketch.entities.find((x) => x.type === 'ellipse') as Extract<CadEntity, { type: 'ellipse' }>;
    expect(e.r).toBeCloseTo(10, 12);
    expect(solveSketch(r.sketch).dof).toBe(7);
    const full = ellipse(empty, { p: { x: 0, y: 0 } }, { p: { x: 30, y: 0 } }, 10);
    if (typeof full === 'string') throw new Error(full);
    expect(profileProperties(findProfiles(full.sketch).regions)!.A).toBeCloseTo(PI * 300, 9);
  });
});
