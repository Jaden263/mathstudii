import { describe, it, expect } from 'vitest';
import { centerRectangle, fillet, mirror, polygon, rectangle, slot, threePointArc, trim, circumcenter, type ToolResult } from './tools';
import { solveSketch } from './solver';
import { findProfiles, profileProperties } from './profile';
import { emptySketch, type CadSketch } from './model';

const ok = (r: ToolResult | string): ToolResult => {
  if (typeof r === 'string') throw new Error(r);
  return r;
};
const pos = (sk: CadSketch) => new Map(sk.points.map((p) => [p.id, { x: p.x, y: p.y }]));
const rad = (sk: CadSketch) => new Map(sk.entities.filter((e) => e.type === 'circle').map((e) => [e.id, (e as { r: number }).r]));
const area = (sk: CadSketch) => profileProperties(findProfiles(sk).regions)?.A ?? 0;

describe('sketch tools', () => {
  it('rectangles keep their shape: 4 freedoms, a centre rectangle stays centred', () => {
    const r = ok(rectangle(emptySketch(), { p: { x: 0, y: 0 } }, { p: { x: 40, y: 20 } }));
    expect(solveSketch(r.sketch).dof).toBe(4);
    expect(area(r.sketch)).toBeCloseTo(800, 9);
    const c = ok(centerRectangle(emptySketch(), { p: { x: 10, y: 10 } }, { x: 30, y: 25 }));
    const s = solveSketch(c.sketch);
    expect(s.ok).toBe(true);
    expect(s.dof).toBe(4); // centre (2) + width + height
    expect(area(c.sketch)).toBeCloseTo(40 * 30, 9);
  });

  it('draws an arc through three points either way round', () => {
    const cc = circumcenter({ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 })!;
    expect(Math.hypot(cc.x, cc.y)).toBeCloseTo(0, 12);
    for (const m of [{ x: 0, y: 10 }, { x: 0, y: -10 }]) {
      const r = ok(threePointArc(emptySketch(), { p: { x: 10, y: 0 } }, { p: { x: -10, y: 0 } }, m));
      const arc = r.sketch.entities.find((e) => e.type === 'arc') as { p1: string; p2: string; c: string };
      const P = pos(r.sketch);
      const a0 = Math.atan2(P.get(arc.p1)!.y, P.get(arc.p1)!.x);
      // the arc's counter-clockwise middle is the pick point
      expect(Math.sin(a0 + Math.PI / 2) * Math.sign(m.y)).toBeCloseTo(1, 9);
    }
    expect(threePointArc(emptySketch(), { p: { x: 0, y: 0 } }, { p: { x: 2, y: 0 } }, { x: 1, y: 0 })).toMatch(/one line/);
  });

  it('keeps polygons regular with 4 freedoms', () => {
    const r = ok(polygon(emptySketch(), { p: { x: 0, y: 0 } }, { x: 20, y: 0 }, 6));
    const s = solveSketch(r.sketch);
    expect(s.ok).toBe(true);
    expect(s.dof).toBe(4);
    expect(area(r.sketch)).toBeCloseTo((3 * Math.sqrt(3) / 2) * 400, 8);
  });

  it('builds a slot of tangent, equal arcs with 5 freedoms', () => {
    const r = ok(slot(emptySketch(), { p: { x: 0, y: 0 } }, { x: 60, y: 0 }, 20));
    const s = solveSketch(r.sketch);
    expect(s.ok).toBe(true);
    expect(s.dof).toBe(5);
    expect(area(r.sketch)).toBeCloseTo(60 * 20 + Math.PI * 100, 8);
  });

  it('fillets a corner, keeps the corner dimensions on a virtual sharp', () => {
    let r = ok(rectangle(emptySketch(), { p: { x: 0, y: 0 } }, { p: { x: 100, y: 50 } }));
    const sk = r.sketch;
    const bottom = r.ids[0];
    sk.constraints.push({ id: 'w', type: 'length', refs: [bottom], value: '100' }, { id: 'fx', type: 'fix', refs: [sk.points[0].id], at: { x: 0, y: 0 } });
    const corner = sk.points[1].id; // (100, 0)
    r = ok(fillet(sk, pos(sk), corner, 10));
    expect(r.sketch.constraints.find((c) => c.id === 'w')).toMatchObject({ type: 'distance', refs: [corner, sk.points[0].id] });
    expect(r.sketch.points.some((p) => p.id === corner)).toBe(true);
    const values = new Map([['w', 100], [r.sketch.constraints.find((c) => c.type === 'radius')!.id, 10]]);
    const s = solveSketch(r.sketch, { values });
    expect(s.ok).toBe(true);
    // a 100 × 50 rectangle with one r = 10 corner: loses (1 − π/4)·r²
    const solved = { ...r.sketch, points: r.sketch.points.map((p) => ({ ...p, ...s.points.get(p.id)! })) };
    expect(area(solved)).toBeCloseTo(5000 - (1 - Math.PI / 4) * 100, 6);
    expect(fillet(sk, pos(sk), corner, 80)).toMatch(/too large/);
  });

  it('trims a line between crossings, a line end, and a circle into an arc', () => {
    // a horizontal line crossed by two verticals
    const sk: CadSketch = {
      points: [
        { id: 'a', x: 0, y: 0 }, { id: 'b', x: 100, y: 0 }, { id: 'c', x: 30, y: -30 }, { id: 'd', x: 30, y: 30 },
        { id: 'e', x: 70, y: -30 }, { id: 'f', x: 70, y: 30 }, { id: 'k', x: 50, y: 0 },
      ],
      entities: [
        { id: 'h', type: 'line', p1: 'a', p2: 'b' }, { id: 'v1', type: 'line', p1: 'c', p2: 'd' }, { id: 'v2', type: 'line', p1: 'e', p2: 'f' },
        { id: 'o', type: 'circle', c: 'k', r: 25 },
      ],
      constraints: [{ id: 'hz', type: 'horizontal', refs: ['h'] }, { id: 'len', type: 'length', refs: ['h'], value: '100' }],
    };
    const mid = ok(trim(sk, pos(sk), rad(sk), 'h', { x: 50, y: 0 }));
    const lines = mid.sketch.entities.filter((e) => e.type === 'line' && (e.id === 'h' || !['v1', 'v2'].includes(e.id)));
    expect(lines.length).toBe(2);
    expect(mid.notes.join()).toMatch(/length dimension/);
    // crossings around the pick: the verticals at 30 and 70 are nearer than the circle (25, 75)
    const P = pos(mid.sketch);
    const xs = lines.flatMap((l) => [P.get((l as { p1: string }).p1)!.x, P.get((l as { p2: string }).p2)!.x]).sort((a, b) => a - b);
    expect(xs).toEqual([0, expect.closeTo(30, 9), expect.closeTo(70, 9), 100]);
    expect(solveSketch(mid.sketch).ok).toBe(true);

    const end = ok(trim(sk, pos(sk), rad(sk), 'h', { x: 5, y: 0 }));
    const h = end.sketch.entities.find((e) => e.id === 'h') as { p1: string; p2: string };
    expect(pos(end.sketch).get(h.p1)!.x).toBeCloseTo(25, 9); // the circle is the nearest crossing

    const arc = ok(trim(sk, pos(sk), rad(sk), 'o', { x: 50, y: 25 }));
    const o = arc.sketch.entities.find((e) => e.id === 'o')!;
    expect(o.type).toBe('arc');
    const Pa = pos(arc.sketch);
    const ends = [Pa.get((o as { p1: string }).p1)!, Pa.get((o as { p2: string }).p2)!];
    // the top part between the verticals (x = 30 and 70) is gone; ends lie on the verticals
    expect(ends.map((p) => Math.round(p.x)).sort((a, b) => a - b)).toEqual([30, 70]);
    expect(ends.every((p) => p.y > 0)).toBe(true);
  });

  it('mirrors a half profile into a symmetric whole', () => {
    // half of a 40 × 20 rectangle right of the y axis, closed by the axis line
    const half: CadSketch = {
      points: [{ id: 'o', x: 0, y: 0 }, { id: 'p', x: 20, y: 0 }, { id: 'q', x: 20, y: 20 }, { id: 't', x: 0, y: 20 }],
      entities: [
        { id: 'l1', type: 'line', p1: 'o', p2: 'p' }, { id: 'l2', type: 'line', p1: 'p', p2: 'q' }, { id: 'l3', type: 'line', p1: 'q', p2: 't' },
        { id: 'ax', type: 'line', p1: 'o', p2: 't', construction: true },
      ],
      constraints: [],
    };
    const r = ok(mirror(half, pos(half), ['l1', 'l2', 'l3'], 'ax'));
    expect(r.ids.length).toBe(3);
    expect(r.sketch.constraints.filter((c) => c.type === 'symmetric').length).toBe(2); // o and t are on the axis
    expect(area(r.sketch)).toBeCloseTo(800, 9);
    expect(solveSketch(r.sketch).ok).toBe(true);
  });
});

describe('fillet on a centre rectangle', () => {
  it('ignores the construction diagonals and keeps them on the virtual sharp', () => {
    const r = ok(centerRectangle(emptySketch(), { p: { x: 0, y: 0 } }, { x: 50, y: 25 }));
    const corner = r.sketch.points[0].id;
    const f = ok(fillet(r.sketch, pos(r.sketch), corner, 5));
    expect(f.sketch.points.some((p) => p.id === corner)).toBe(true);
    const s = solveSketch(f.sketch, { values: new Map([[f.sketch.constraints.find((c) => c.type === 'radius')!.id, 5]]) });
    expect(s.ok).toBe(true);
    expect(s.dof).toBe(4); // still centre + width + height (radius is dimensioned)
  });
});
