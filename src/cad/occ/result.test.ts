// BuildResults: faces, edges and meshes from the B-rep kernel, keys from the feature
// history, and the mesh kernel's fallback in the same shape.
import { describe, expect, it } from 'vitest';
import { circles, rect, single, solve, withCircles } from './fixtures';
import { occ } from './kernel';
import { buildResultOcc } from './result';
import { meshBuildResult, type BodyResult } from '../buildResult';
import { kernel } from '../solid';

const { PI } = Math;
const near = (v: number, want: number, rel = 1e-9) => expect(Math.abs(v - want) / Math.max(Math.abs(want), 1e-300)).toBeLessThan(rel);

/** 100 × 60 × 10 plate with a Ø20 hole, a pocket cut into its top. */
function plate() {
  return single([
    { kind: 'sketch', id: 's1', name: 'S', plane: { ref: 'XY' }, sketch: withCircles(rect('a', 0, 0, 100, 60), 'h', [[50, 30, 10]]) },
    { kind: 'extrude', id: 'f1', name: 'Plate', sketch: 's1', extent: { type: 'one', d: '10' }, op: 'new' },
    { kind: 'sketch', id: 's2', name: 'P', plane: { ref: 'XY', offset: '10' }, sketch: rect('p', 10, 10, 30, 50) },
    { kind: 'extrude', id: 'f2', name: 'Pocket', sketch: 's2', extent: { type: 'one', d: '4' }, op: 'cut' },
  ]);
}

/** Signed volume enclosed by a triangle mesh (divergence theorem). */
function meshVolume(b: BodyResult): number {
  const p = b.mesh.positions, ix = b.mesh.indices;
  let v = 0;
  for (let t = 0; t < ix.length; t += 3) {
    const [a, c, d] = [ix[t], ix[t + 1], ix[t + 2]].map((i) => [p[3 * i], p[3 * i + 1], p[3 * i + 2]]);
    v += (a[0] * (c[1] * d[2] - c[2] * d[1]) - a[1] * (c[0] * d[2] - c[2] * d[0]) + a[2] * (c[0] * d[1] - c[1] * d[0])) / 6;
  }
  return v;
}

describe('B-rep build results', () => {
  it('lists exact faces with their history keys', () => {
    const design = plate();
    const { numbers } = solve(design);
    const r = buildResultOcc(occ()!, design, numbers);
    expect(r.kernel).toBe('brep');
    const [b] = r.components.c1.bodies;
    // 4 outer sides, the hole, bottom, top, and the pocket's 4 walls and floor
    expect(b.faces).toHaveLength(12);
    const byKey = (k: string) => b.faces.filter((f) => f.key === k);
    const hole = byKey('f1/side:hk0');
    expect(hole).toHaveLength(1);
    expect(hole[0].type).toBe('cylinder');
    near(hole[0].radius!, 10);
    expect(Math.abs(hole[0].axis!.d[2])).toBeCloseTo(1, 12);
    near(hole[0].area, 2 * PI * 10 * 10);
    // the top: a plane facing up, its area less the hole and the pocket mouth
    const [top] = byKey('f1/end');
    expect(top.type).toBe('plane');
    expect(top.frame!.n[2]).toBeCloseTo(1, 12);
    near(top.area, 6000 - PI * 100 - 20 * 40);
    const [bottom] = byKey('f1/start');
    expect(bottom.frame!.n[2]).toBeCloseTo(-1, 12);
    // the pocket floor is the cut tool's start face: "auto" ran it down from z = 10 to 6
    const [floor] = byKey('f2/start');
    expect(floor.frame!.o[2]).toBeCloseTo(6, 12);
    expect(floor.frame!.n[2]).toBeCloseTo(1, 12);
    near(floor.area, 20 * 40);
    expect(b.faces.filter((f) => f.key.startsWith('f2/side:'))).toHaveLength(4);
    // every face has a key here
    expect(b.faces.every((f) => f.key)).toBe(true);
    near(b.mass.V, 6000 * 10 - PI * 1000 - 20 * 40 * 4);
    near(b.area, b.faces.reduce((s, f) => s + f.area, 0));
  });

  it('lists edges with their curves and both faces', () => {
    const design = plate();
    const { numbers } = solve(design);
    const [b] = buildResultOcc(occ()!, design, numbers).components.c1.bodies;
    // a closed solid: every edge has two faces (the hole's seam has the cylinder twice)
    for (const e of b.edges) {
      expect(e.faces[0]).toBeGreaterThanOrEqual(0);
      expect(e.faces[1]).toBeGreaterThanOrEqual(0);
      expect(e.points.length).toBeGreaterThanOrEqual(6);
    }
    const rims = b.edges.filter((e) => e.type === 'circle');
    expect(rims).toHaveLength(2);
    for (const e of rims) {
      near(e.circle!.r, 10);
      near(e.length, 2 * PI * 10);
      expect(e.circle!.c[0]).toBeCloseTo(50, 9);
    }
    const seam = b.edges.find((e) => e.faces[0] === e.faces[1])!;
    expect(b.faces[seam.faces[0]].type).toBe('cylinder');
    // the edge between the top and the hole carries both keys
    expect(rims.map((e) => e.key).sort()).toEqual(['f1/end|f1/side:hk0', 'f1/side:hk0|f1/start']);
    const total = b.edges.filter((e) => e.type === 'line').reduce((s, e) => s + e.length, 0);
    // 12 box edges, 12 pocket edges, the hole seam
    near(total, 4 * (100 + 60 + 10) + 2 * (20 + 40) * 2 + 4 * 4 + 10);
  });

  it('meshes every face, closed and outward', () => {
    const design = plate();
    const { numbers } = solve(design);
    const [b] = buildResultOcc(occ()!, design, numbers, { deflection: 1e-4, angle: 0.05 }).components.c1.bodies;
    const nt = b.mesh.indices.length / 3;
    expect(b.mesh.faceOf).toHaveLength(nt);
    expect(new Set(b.mesh.faceOf).size).toBe(b.faces.length);
    // the mesh encloses nearly the exact volume (the hole is a polygon inside the circle)
    near(meshVolume(b), b.mass.V, 1e-3);
    // triangles of the top face point up
    const top = b.faces.find((f) => f.key === 'f1/end')!.index;
    for (let t = 0; t < nt; t++) {
      if (b.mesh.faceOf[t] !== top) continue;
      for (let k = 0; k < 3; k++) expect(b.mesh.normals[3 * b.mesh.indices[3 * t + k] + 2]).toBeCloseTo(1, 5);
    }
  });

  it('keys pattern copies and boolean pieces after their features', () => {
    const design = single([
      { kind: 'sketch', id: 's1', name: 'S', plane: { ref: 'XY' }, sketch: circles('d', [[0, 0, 30]]) },
      { kind: 'extrude', id: 'f1', name: 'Disc', sketch: 's1', extent: { type: 'one', d: '8' }, op: 'new' },
      { kind: 'sketch', id: 's2', name: 'H', plane: { ref: 'XY', offset: '8' }, sketch: { points: [{ id: 'q', x: 20, y: 0 }], entities: [{ id: 'e', type: 'point', p: 'q' }], constraints: [] } },
      { kind: 'hole', id: 'f2', name: 'Hole', sketch: 's2', d: '5', depth: '', through: true, style: 'counterbore', cbD: '9', cbDepth: '3' },
      { kind: 'pattern', id: 'f3', name: 'P', of: 'features', refs: ['f2'], type: 'circ', axis: 'Z', count: '3', spacing: '360 deg' },
    ]);
    const { numbers } = solve(design);
    const [b] = buildResultOcc(occ()!, design, numbers).components.c1.bodies;
    const keys = b.faces.map((f) => f.key);
    expect(keys).toContain('f2/hole0:wall');
    expect(keys).toContain('f2/hole0:cb');
    expect(keys).toContain('f2/hole0:cbFloor');
    expect(keys).toContain('f3.1.f2/hole0:cbFloor');
    expect(keys).toContain('f3.1.f2/hole0:wall');
    expect(keys).toContain('f3.2.f2/hole0:wall');
    const copy = b.faces.find((f) => f.key === 'f3.2.f2/hole0:wall')!;
    expect(copy.feature).toBe('f3');
    expect(copy.type).toBe('cylinder');
    near(copy.radius!, 2.5);
    // the copy turned 240° about Z
    const p = copy.axis!.p;
    near(Math.atan2(p[1], p[0]), -2 * PI / 3, 1e-9);
  });

  it('describes cones and tori', () => {
    const design = single([
      { kind: 'sketch', id: 's1', name: 'S', plane: { ref: 'XZ' }, sketch: circles('t', [[40, 0, 5]]) },
      { kind: 'revolve', id: 'f1', name: 'Torus', sketch: 's1', axis: 'y', angle: '360', op: 'new' },
      { kind: 'sketch', id: 's2', name: 'B', plane: { ref: 'XY', offset: '20' }, sketch: rect('b', -10, -10, 10, 10) },
      { kind: 'extrude', id: 'f2', name: 'Block', sketch: 's2', extent: { type: 'one', d: '10' }, op: 'new' },
      { kind: 'sketch', id: 's3', name: 'T', plane: { ref: 'XY', offset: '30' }, sketch: { points: [{ id: 'q', x: 0, y: 0 }], entities: [{ id: 'e', type: 'point', p: 'q' }], constraints: [] } },
      { kind: 'hole', id: 'f3', name: 'Csk', sketch: 's3', d: '4', depth: '6', style: 'countersink', csD: '10', csAngle: '90 deg', targets: ['f2'] },
    ]);
    const { numbers } = solve(design);
    const [torus, block] = buildResultOcc(occ()!, design, numbers).components.c1.bodies;
    expect(torus.faces.map((f) => f.type)).toEqual(['torus']);
    // a torus' area: 4π² R a
    near(torus.faces[0].area, 4 * PI * PI * 40 * 5);
    const cone = block.faces.find((f) => f.type === 'cone')!;
    expect(cone.key).toBe('f3/hole0:cone');
    near(cone.angle!, PI / 4);
    expect(Math.abs(cone.axis!.d[2])).toBeCloseTo(1, 12);
  });
});

describe('mesh-kernel build results', () => {
  it('have the same shape: planar faces, creases, mass', () => {
    const design = plate();
    const { numbers } = solve(design);
    const r = meshBuildResult(kernel()!, design, numbers);
    expect(r.kernel).toBe('mesh');
    const [b] = r.components.c1.bodies;
    // smooth patches: 6 + 5 planes and the faceted hole as one face
    expect(b.faces).toHaveLength(12);
    expect(b.faces.filter((f) => f.type === 'plane')).toHaveLength(11);
    const top = b.faces.find((f) => f.type === 'plane' && f.frame!.n[2] > 0.99 && Math.abs(f.frame!.o[2] - 10) < 1e-6)!;
    near(top.area, 6000 - PI * 100 - 800, 1e-3);
    expect(b.mesh.faceOf).toHaveLength(b.mesh.indices.length / 3);
    near(meshVolume(b), b.mass.V, 1e-6);
    // the hole's rims are closed polylines between the hole and a plane
    const rims = b.edges.filter((e) => b.faces[e.faces[0]].type === 'other' || b.faces[e.faces[1]].type === 'other');
    expect(rims).toHaveLength(2);
    for (const e of rims) near(e.length, 2 * PI * 10, 1e-3);
    expect(b.faces.every((f) => f.key === '')).toBe(true);
  });
});
