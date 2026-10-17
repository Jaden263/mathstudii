// The exact 2-D geometry of drawing views, checked against closed forms: chords of a
// circle, the crossing of two circles and of an ellipse with a circle, hatching areas.
import { describe, expect, it } from 'vitest';
import { clipToCircle, hatch, hatchStyle, loopsArea, overlayPrims, primAt, primLength, primsBox, recognise, subPrim, type Prim } from './drawing2d';

const { PI, sqrt, cos, sin, acos } = Math;
const len = (ps: Prim[]) => ps.reduce((s, p) => s + primLength(p), 0);

describe('drawing primitives', () => {
  it('recognises a flat B-spline as a line and a round one as an arc', () => {
    // a circle of radius 10 seen edge-on comes out as a curve running back over itself
    const flat: number[] = [];
    for (let i = 0; i <= 40; i++) flat.push(50 + 10 * cos((i / 40) * 2 * PI), 30);
    const l = recognise(flat, 1e-9);
    expect(l.k).toBe('line');
    expect(primLength(l)).toBeCloseTo(20, 12);
    // a quarter circle, sampled
    const q: number[] = [];
    for (let i = 0; i <= 16; i++) q.push(3 + 7 * cos((i / 16) * (PI / 2)), -2 + 7 * sin((i / 16) * (PI / 2)));
    const a = recognise(q, 1e-9) as Extract<Prim, { k: 'arc' }>;
    expect(a.k).toBe('arc');
    expect(a.r).toBeCloseTo(7, 12);
    expect(a.cx).toBeCloseTo(3, 12);
    expect(a.a1 - a.a0).toBeCloseTo(PI / 2, 12);
    // anything else stays a polyline
    const s: number[] = [];
    for (let i = 0; i <= 16; i++) s.push(i, (i * i) / 10);
    expect(recognise(s, 1e-9).k).toBe('poly');
  });

  it('exact boxes of arcs and ellipses', () => {
    // a half circle above its centre reaches up to r, not just its ends
    expect(primsBox([{ k: 'arc', cx: 0, cy: 0, r: 5, a0: 0, a1: PI }])).toEqual({ x0: -5, y0: 0, x1: 5, y1: expect.closeTo(5, 12) });
    // an ellipse turned 30°: half-extents √(a²cos²θ + b²sin²θ) and √(a²sin²θ + b²cos²θ)
    const th = PI / 6, a = 10, b = 4;
    const bx = primsBox([{ k: 'ellipse', cx: 1, cy: 2, rx: a, ry: b, rot: th, t0: 0, t1: 2 * PI }]);
    expect(bx.x1 - 1).toBeCloseTo(sqrt(a * a * cos(th) ** 2 + b * b * sin(th) ** 2), 12);
    expect(bx.y1 - 2).toBeCloseTo(sqrt(a * a * sin(th) ** 2 + b * b * cos(th) ** 2), 12);
  });

  it('merges collinear and concentric pieces; a hidden line under a visible one goes', () => {
    const v: Prim[] = [{ k: 'line', x1: 0, y1: 0, x2: 60, y2: 0 }, { k: 'line', x1: 100, y1: 0, x2: 40, y2: 0 }];
    // the back edge of a box behind its front edge, and a hidden line partly past it
    const h: Prim[] = [{ k: 'line', x1: 0, y1: 0, x2: 100, y2: 0 }, { k: 'line', x1: 80, y1: 0, x2: 130, y2: 0 }];
    const [vis, hid] = overlayPrims([v, h], 100);
    expect(vis).toHaveLength(1);
    expect(primLength(vis[0])).toBeCloseTo(100, 9);
    expect(hid).toHaveLength(1);
    expect(primLength(hid[0])).toBeCloseTo(30, 9);
    // two halves of a circle, one of them drawn the other way round its start: one circle
    const arcs: Prim[] = [{ k: 'arc', cx: 5, cy: 5, r: 2, a0: -PI / 2, a1: PI / 2 }, { k: 'arc', cx: 5, cy: 5, r: 2, a0: PI / 2, a1: (3 * PI) / 2 }];
    const [c] = overlayPrims([arcs], 100);
    expect(c).toHaveLength(1);
    expect(len(c)).toBeCloseTo(4 * PI, 9);
    // a hidden circle under the visible one (the bottom of a hole under its top) is dropped
    expect(overlayPrims([arcs, [{ k: 'arc', cx: 5, cy: 5, r: 2, a0: 0, a1: 2 * PI }]], 100)[1]).toEqual([]);
    // the same ellipse with its axes turned half a turn
    const e1: Prim = { k: 'ellipse', cx: 0, cy: 0, rx: 10, ry: 5, rot: 0.3, t0: 0, t1: PI };
    const e2: Prim = { k: 'ellipse', cx: 0, cy: 0, rx: 10, ry: 5, rot: 0.3 + PI, t0: 0, t1: PI };
    const [es] = overlayPrims([[e1, e2]], 100);
    expect(es).toHaveLength(1);
    expect((es[0] as Extract<Prim, { k: 'ellipse' }>).t1 - (es[0] as Extract<Prim, { k: 'ellipse' }>).t0).toBeCloseTo(2 * PI, 9);
  });

  it('clips lines, arcs and ellipses exactly at a circle', () => {
    // a line 3 from the centre of a circle of radius 5 keeps a chord of 2√(r² − h²) = 8
    const [chord] = clipToCircle({ k: 'line', x1: -20, y1: 3, x2: 20, y2: 3 }, 0, 0, 5) as Extract<Prim, { k: 'line' }>[];
    expect(primLength(chord)).toBeCloseTo(8, 12);
    expect(chord.x1).toBeCloseTo(-4, 12);
    // a circle of radius R about a point R away from the clip circle's centre (radius R):
    // they cross at ±60° about the clip's centre, so a third of the circle is inside
    const R = 6;
    const inside = clipToCircle({ k: 'arc', cx: R, cy: 0, r: R, a0: 0, a1: 2 * PI }, 0, 0, R);
    expect(inside).toHaveLength(1);
    expect(len(inside)).toBeCloseTo(R * ((2 * PI) / 3), 10);
    // x²/a² + y²/b² = 1 cut by r (b < r < a): cos²t = (r² − b²)/(a² − b²) at the crossings
    const a = 10, b = 4, r = 7;
    const parts = clipToCircle({ k: 'ellipse', cx: 0, cy: 0, rx: a, ry: b, rot: 0, t0: 0, t1: 2 * PI }, 0, 0, r) as Extract<Prim, { k: 'ellipse' }>[];
    const t = acos(sqrt((r * r - b * b) / (a * a - b * b)));
    expect(parts).toHaveLength(2);
    for (const p of parts) {
      expect(p.t1 - p.t0).toBeCloseTo(PI - 2 * t, 12);
      // its ends lie on the circle
      for (const s of [0, 1]) expect(Math.hypot(...primAt(p, s))).toBeCloseTo(r, 12);
    }
  });

  it('pieces of primitives by parameter', () => {
    expect(primLength(subPrim({ k: 'arc', cx: 0, cy: 0, r: 2, a0: 0, a1: PI }, 0.25, 0.75))).toBeCloseTo(PI, 12);
    const p = subPrim({ k: 'poly', pts: [0, 0, 1, 0, 2, 0, 3, 0] }, 0.5, 1);
    expect(p).toEqual({ k: 'poly', pts: [1.5, 0, 2, 0, 3, 0] });
  });

  it('hatches loops by the even–odd rule at the spacing asked', () => {
    // an annulus-like square frame: 40 × 40 less 20 × 20
    const outer = [0, 0, 40, 0, 40, 40, 0, 40], inner = [10, 10, 30, 10, 30, 30, 10, 30];
    expect(loopsArea([outer, inner])).toBeCloseTo(1200, 12);
    // horizontal lines 1 apart: their length adds up to the area (one line per unit of height)
    const segs = hatch([outer, inner], 0, 1);
    let L = 0;
    for (let i = 0; i < segs.length; i += 4) L += Math.hypot(segs[i + 2] - segs[i], segs[i + 3] - segs[i + 1]);
    // a vertex on a line counts once (half-open): lines at y = 0 … 39, those at 10 … 29 across the hole
    expect(segs.length / 4).toBe(40 + 20);
    expect(L).toBeCloseTo(40 * 40 - 20 * 20, 9);
    // 45° lines spaced s apart cover the area: ΣL·s ≈ A
    const s45 = hatch([outer, inner], PI / 4, 0.25);
    let L45 = 0;
    for (let i = 0; i < s45.length; i += 4) L45 += Math.hypot(s45[i + 2] - s45[i], s45[i + 3] - s45[i + 1]);
    expect(Math.abs(L45 * 0.25 - 1200) / 1200).toBeLessThan(5e-3);
    // neighbouring bodies differ in angle or spacing (ISO 128-50)
    const a = hatchStyle(0, 3), b = hatchStyle(1, 3), c = hatchStyle(2, 3);
    expect(a.angle).toBeCloseTo(PI / 4, 12);
    expect(b.angle).toBeCloseTo((3 * PI) / 4, 12);
    expect(c.angle === a.angle && c.spacing === a.spacing).toBe(false);
  });
});
