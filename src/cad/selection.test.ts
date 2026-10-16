// Selection of faces and edges, and the display data the 3-D view draws them from: picks
// survive rebuilds by their history keys, relations come out as the geometry says.
import { describe, expect, it } from 'vitest';
import { rect, single, solve, withCircles } from './occ/fixtures';
import { occ } from './occ/kernel';
import { buildResultOcc } from './occ/result';
import { meshBuildResult, type BuildResult } from './buildResult';
import type { CadDesign } from './design';
import { displayMesh, weldedMesh } from './display';
import { kernel } from './solid';
import { pickGeometry, pickId, pickOf, polylineMid, relation, resolveSelection, select } from './selection';

const { PI } = Math;
const near = (v: number, want: number, rel = 1e-9) => expect(Math.abs(v - want) / Math.max(Math.abs(want), 1e-300)).toBeLessThan(rel);

/** 100 × 60 × 10 plate with a Ø20 hole at (50, 30) and a pocket of depth p from its top. */
const plate = (p = '4', pocket = true): CadDesign => single([
  { kind: 'sketch', id: 's1', name: 'S', plane: { ref: 'XY' }, sketch: withCircles(rect('a', 0, 0, 100, 60), 'h', [[50, 30, 10]]) },
  { kind: 'extrude', id: 'f1', name: 'Plate', sketch: 's1', extent: { type: 'one', d: '10' }, op: 'new' },
  { kind: 'sketch', id: 's2', name: 'P', plane: { ref: 'XY', offset: '10' }, sketch: rect('p', 10, 10, 30, 50) },
  { kind: 'extrude', id: 'f2', name: 'Pocket', sketch: 's2', extent: { type: 'one', d: p }, op: 'cut', suppressed: !pocket || undefined },
]);

function built(d: CadDesign): BuildResult {
  return buildResultOcc(occ()!, d, solve(d).numbers);
}

const faceIndex = (b: BuildResult, key: string) => b.components.c1.bodies[0].faces.find((f) => f.key === key)!.index;

describe('display data', () => {
  it('sorts triangles into one run per face, each run the area of its face', () => {
    const b = built(plate()).components.c1.bodies[0];
    const d = displayMesh(b);
    expect(d.faceStart).toHaveLength(b.faces.length + 1);
    expect(d.faceStart[b.faces.length]).toBe(b.mesh.faceOf.length);
    for (let f = 0; f < b.faces.length; f++) {
      let area = 0;
      for (let t = d.faceStart[f]; t < d.faceStart[f + 1]; t++) {
        expect(d.faceOf[t]).toBe(f);
        const [a, c, e] = [0, 1, 2].map((k) => Array.from(d.positions.subarray(3 * d.indices[3 * t + k], 3 * d.indices[3 * t + k] + 3)));
        const u = [c[0] - a[0], c[1] - a[1], c[2] - a[2]], v = [e[0] - a[0], e[1] - a[1], e[2] - a[2]];
        area += Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) / 2;
      }
      // flat faces bounded by straight edges are tiled exactly (float32 vertices); the
      // hole's cylinder and the faces it pierces within the chord error
      const info = b.faces[f];
      near(area, info.area, info.type === 'plane' && !b.edges.some((e) => e.type === 'circle' && e.faces.includes(f)) ? 1e-6 : 2e-3);
    }
    // one segment less than points, per edge; the hole's seam is not drawn
    const seams = b.edges.filter((e) => e.faces[0] === e.faces[1]);
    expect(seams).toHaveLength(1);
    expect(d.edgeStart[b.edges.length] * 2).toBe(b.edges.reduce((s, e) => s + (e === seams[0] ? 0 : 2 * (e.points.length / 3 - 1)), 0));
    expect(d.edgeStart[seams[0].index + 1]).toBe(d.edgeStart[seams[0].index]);
    expect(d.lines.length).toBe(d.edgeStart[b.edges.length] * 6);
  });

  it('welds a box into 8 corners and 12 triangles for the drawings', () => {
    const d = single([
      { kind: 'sketch', id: 's1', name: 'S', plane: { ref: 'XY' }, sketch: rect('a', 0, 0, 30, 20) },
      { kind: 'extrude', id: 'f1', name: 'Box', sketch: 's1', extent: { type: 'one', d: '10' }, op: 'new' },
    ]);
    const m = weldedMesh(built(d).components.c1.bodies[0], [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 100, 0, 0, 1]);
    expect(m.pos.length / 3).toBe(8);
    expect(m.tri.length / 3).toBe(12);
    // moved by the placement
    expect(Math.min(...Array.from(m.pos).filter((_, i) => i % 3 === 0))).toBe(100);
  });

  it('halves a polyline by length', () => {
    expect(polylineMid(new Float32Array([0, 0, 0, 10, 0, 0, 10, 10, 0]))).toEqual([10, 0, 0]);
    expect(polylineMid(new Float32Array([0, 0, 0, 4, 0, 0]))).toEqual([2, 0, 0]);
  });
});

describe('selection', () => {
  const b = built(plate());
  const d = plate();
  const top = pickOf(b, d, 'face', 'o1', 'f1', faceIndex(b, 'f1/end'))!;
  const floor = pickOf(b, d, 'face', 'o1', 'f1', faceIndex(b, 'f2/start'))!;

  it('a click replaces, shift adds or takes out, a click on nothing clears', () => {
    let sel = select([], top, false);
    expect(sel.map(pickId)).toEqual([pickId(top)]);
    sel = select(sel, floor, true);
    expect(sel).toHaveLength(2);
    sel = select(sel, top, true);
    expect(sel.map(pickId)).toEqual([pickId(floor)]);
    expect(select(sel, null, true)).toBe(sel);
    expect(select(sel, null, false)).toEqual([]);
  });

  it('finds picks again by their history keys after a rebuild', () => {
    // a deeper pocket: the floor moves down, the plate's top stays
    const d2 = plate('7');
    const b2 = built(d2);
    const [t2, f2] = resolveSelection([top, floor], b2, d2);
    expect(t2.key).toBe('f1/end');
    expect(f2.key).toBe('f2/start');
    expect(b2.components.c1.bodies[0].faces[f2.index].frame!.o[2]).toBeCloseTo(3, 9);
    // without the pocket its floor is gone; the top is still there
    const d3 = plate('4', false);
    expect(resolveSelection([top, floor], built(d3), d3).map((p) => p.key)).toEqual(['f1/end']);
  });

  it('the mesh kernel has no keys: picks are found by type and place', () => {
    const K = kernel()!;
    const d1 = plate(), n1 = solve(d1).numbers;
    const m = meshBuildResult(K, d1, n1);
    const faces = m.components.c1.bodies[0].faces;
    // the pocket floor: the flat face at z = 6 facing up
    const i = faces.findIndex((f) => f.frame && Math.abs(f.frame.o[2] - 6) < 1e-6 && f.frame.n[2] > 0.99);
    const p = pickOf(m, d1, 'face', 'o1', 'f1', i)!;
    expect(p.key).toBe('');
    // 1 mm deeper is well within 5 % of the part's size
    const d2 = plate('5');
    const [q] = resolveSelection([p], meshBuildResult(K, d2, solve(d2).numbers), d2);
    expect(q.type).toBe('plane');
    expect(q.at[2]).toBeCloseTo(5, 6);
  });

  it('relations: parallel faces and their gap, square faces, an axis and an edge', () => {
    const bottom = pickOf(b, d, 'face', 'o1', 'f1', faceIndex(b, 'f1/start'))!;
    const g = (p: typeof top) => pickGeometry(b, d, p)!;
    const r = relation(g(top), g(bottom));
    expect(r.angle).toBeCloseTo(0, 12);
    near(r.gap!, 10);
    expect(relation(g(top), g(floor)).gap).toBeCloseTo(4, 9);
    const side = pickOf(b, d, 'face', 'o1', 'f1', faceIndex(b, 'f1/side:al0'))!;
    const s = relation(g(top), g(side));
    expect(s.angle).toBeCloseTo(PI / 2, 12);
    expect(s.gap).toBeUndefined();
    // the hole's axis (x = 50, y = 30) and the vertical edge at (100, 60): parallel, √(50² + 30²) apart
    const edges = b.components.c1.bodies[0].edges;
    const corner = edges.findIndex((e) => e.line && Math.abs(e.line.a[0] - 100) < 1e-9 && Math.abs(e.line.a[1] - 60) < 1e-9 && Math.abs(e.line.b[1] - 60) < 1e-9 && Math.abs(e.line.b[0] - 100) < 1e-9);
    const hole = pickOf(b, d, 'face', 'o1', 'f1', faceIndex(b, 'f1/side:hk0'))!;
    const a = relation(g(hole), g(pickOf(b, d, 'edge', 'o1', 'f1', corner)!));
    expect(a.angle).toBeCloseTo(0, 9);
    near(a.gap!, Math.hypot(50, 30));
    // the hole's rim on the bottom face lies parallel to the top, the plate's thickness below it
    const rim = edges.findIndex((e) => e.circle && Math.abs(e.circle.c[2]) < 1e-9);
    const t = relation(g(top), g(pickOf(b, d, 'edge', 'o1', 'f1', rim)!));
    expect(t.angle).toBeCloseTo(0, 12);
    near(t.gap!, 10);
  });
});
