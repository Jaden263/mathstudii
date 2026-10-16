// Kernel requests as the UI makes them: sections, outlines, distances, interference and
// exports, answered by the B-rep kernel (and the mesh kernel's fallback), checked against
// closed-form volumes, areas and distances.
import { describe, expect, it, vi } from 'vitest';
import { circles, rect, single, solve, withCircles } from '../occ/fixtures';
import type { CadDesign } from '../design';
import { buildDesign } from '../design';
import { planeToLocal } from '../inspect';
import { fitCircle } from '../project';
import { kernel, m4Pose, m4Translate } from '../solid';
import { occ, renewOcc } from '../occ/kernel';
import { designNumbers } from '../keys';
import { answer, displayFor } from './service';
import { sectionMesh } from './meshFallback';
import type { KernelRequest, KernelValues, SectionBody } from './protocol';

const { PI } = Math;
const near = (v: number, want: number, rel = 1e-9) => expect(Math.abs(v - want) / Math.max(Math.abs(want), 1e-300)).toBeLessThan(rel);

async function ask<K extends KernelRequest['op']>(req: Extract<KernelRequest, { op: K }>): Promise<KernelValues[K]> {
  return (await answer(req)).value as KernelValues[K];
}

/** 100 × 60 × 10 plate from the origin with a Ø20 hole at (50, 30). */
const plate = () => single([
  { kind: 'sketch', id: 's1', name: 'S', plane: { ref: 'XY' }, sketch: withCircles(rect('a', 0, 0, 100, 60), 'h', [[50, 30, 10]]) },
  { kind: 'extrude', id: 'f1', name: 'Plate', sketch: 's1', extent: { type: 'one', d: '10' }, op: 'new' },
]);

/** Two occurrences of a 10 mm cube, the second moved by `dx`. */
function cubes(dx: number): CadDesign {
  const d = single([
    { kind: 'sketch', id: 's1', name: 'S', plane: { ref: 'XY' }, sketch: rect('a', 0, 0, 10, 10) },
    { kind: 'extrude', id: 'f1', name: 'Cube', sketch: 's1', extent: { type: 'one', d: '10' }, op: 'new' },
  ]);
  return { ...d, occurrences: [...d.occurrences, { id: 'o2', component: 'c1', grounded: true, pos: [dx, 0, 0] }] };
}

const capArea = (s: SectionBody) => s.caps.reduce((a, i) => a + s.body.faces[i].area, 0);

describe('kernel requests', () => {
  it('section: keeps the far side of the plane and marks the cut face', async () => {
    const design = plate();
    const { numbers } = solve(design);
    // keep x ≥ 30: a 70 × 60 × 10 block, its part of the hole a full cylinder (it is at x = 40…60)
    const [s] = await ask({ op: 'section', design, numbers, plane: { n: [1, 0, 0], offset: 30 } });
    near(s.body.mass.V, 70 * 60 * 10 - PI * 100 * 10);
    expect(s.caps).toHaveLength(1);
    near(capArea(s), 60 * 10);
    expect(s.body.faces[s.caps[0]].frame!.n[0]).toBeCloseTo(-1, 12);
    // through the hole (x ≥ 50): the cut face is the plate's 60 × 10 end less the hole's 20 × 10
    const [t] = await ask({ op: 'section', design, numbers, plane: { n: [1, 0, 0], offset: 50 } });
    near(t.body.mass.V, (50 * 60 * 10 - PI * 100 * 10 / 2));
    near(capArea(t), 60 * 10 - 20 * 10);
    // a plane past the part keeps nothing
    expect(await ask({ op: 'section', design, numbers, plane: { n: [1, 0, 0], offset: 150 } })).toHaveLength(0);
  });

  it('section of a placed occurrence: the plane moves into its coordinates', async () => {
    const design: CadDesign = { ...plate(), occurrences: [{ id: 'o1', component: 'c1', grounded: true, pos: [200, 0, 0], rot: [0, 0, 90] }] };
    const { numbers } = solve(design);
    // turned 90° about Z: the plate's x runs along world y; world y ≥ 25 keeps local x ≥ 25
    const [s] = await ask({ op: 'section', design, numbers, plane: { n: [0, 1, 0], offset: 25 } });
    near(s.body.mass.V, 75 * 60 * 10 - PI * 100 * 10);
    // the same plane by hand: n_local = Aᵀ n, offset − n·t
    const p = planeToLocal(m4Pose([200, 0, 0], [0, 0, 90]), { n: [0, 1, 0], offset: 25 });
    expect(p.n[0]).toBeCloseTo(1, 12);
    expect(p.offset).toBeCloseTo(25, 9);
    expect(planeToLocal(m4Translate([100, 0, 0]), { n: [1, 0, 0], offset: 130 }).offset).toBeCloseTo(30, 12);
  });

  it('outline: the loops a sketch plane cuts through the bodies', async () => {
    const design = plate();
    const { numbers } = solve(design);
    const loops = await ask({ op: 'outline', design, numbers, component: 'c1', frame: { o: [0, 0, 5], u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1] } });
    expect(loops).toHaveLength(2);
    const circle = loops.map((l) => fitCircle(l)).find(Boolean)!;
    expect(circle.r).toBeCloseTo(10, 3);
    expect(circle.c.x).toBeCloseTo(50, 3);
    const box = loops.find((l) => !fitCircle(l))!;
    expect(Math.max(...box.map((p) => p.x)) - Math.min(...box.map((p) => p.x))).toBeCloseTo(100, 9);
    expect(Math.max(...box.map((p) => p.y)) - Math.min(...box.map((p) => p.y))).toBeCloseTo(60, 9);
  });

  it('distance: exact between faces, an edge and points', async () => {
    const design = plate();
    const { numbers } = solve(design);
    const shown = displayFor(design, numbers)!;
    expect(shown.kernel).toBe('brep');
    const faces = shown.components.c1.bodies[0].faces;
    const face = (key: string) => ({ kind: 'face' as const, occ: 'o1', body: 'f1', index: faces.find((f) => f.key === key)!.index });
    const top = await ask({ op: 'distance', design, numbers, a: face('f1/start'), b: face('f1/end') });
    expect(top!.exact).toBe(true);
    near(top!.d, 10);
    // from the hole's axis to its wall: the radius
    const wall = await ask({ op: 'distance', design, numbers, a: face('f1/side:hk0'), b: { kind: 'point', p: [50, 30, 5] } });
    near(wall!.d, 10);
    // a corner point 3-4-5 away from the far corner edge (x = 100, y = 60, vertical)
    const edges = shown.components.c1.bodies[0].edges;
    const corner = edges.findIndex((e) => e.line && Math.abs(e.line.a[0] - 100) < 1e-9 && Math.abs(e.line.a[1] - 60) < 1e-9 && Math.abs(e.line.b[0] - 100) < 1e-9 && Math.abs(e.line.b[1] - 60) < 1e-9);
    const d = await ask({ op: 'distance', design, numbers, a: { kind: 'edge', occ: 'o1', body: 'f1', index: corner }, b: { kind: 'point', p: [103, 64, 5] } });
    near(d!.d, 5);
  });

  it('interference: the volume two occurrences share', async () => {
    const design = cubes(6);
    const { numbers } = solve(design);
    const rows = await ask({ op: 'interference', design, numbers });
    expect(rows).toHaveLength(1);
    // overlap 4 × 10 × 10
    near(rows[0].v, 400);
    expect(await ask({ op: 'interference', design: cubes(12), numbers: solve(cubes(12)).numbers })).toEqual([]);
  });

  it('export: STEP text and a binary STL of the assembly', async () => {
    const design = cubes(20);
    const { numbers } = solve(design);
    const step = new TextDecoder().decode(await ask({ op: 'export', design, numbers, format: 'step', scope: { kind: 'assembly' }, unit: 'mm', name: 'Cubes' }));
    expect(step.startsWith('ISO-10303-21;')).toBe(true);
    expect(step).toMatch(/AUTOMOTIVE_DESIGN|AP214/);
    const stl = await ask({ op: 'export', design, numbers, format: 'stl', scope: { kind: 'assembly' }, unit: 'mm', name: 'Cubes' });
    // 80-byte header, a count, 50 bytes a facet: two cubes of 12 triangles
    const n = new DataView(stl.buffer, stl.byteOffset).getUint32(80, true);
    expect(n).toBe(24);
    expect(stl.byteLength).toBe(84 + 50 * n);
  });

  it('drawing views: lines from the display mesh, dimensions from the exact box', async () => {
    // a Ø20 × 30 cylinder: its facets lie inside the circle, the exact box does not
    const design = single([
      { kind: 'sketch', id: 's1', name: 'S', plane: { ref: 'XY' }, sketch: circles('c', [[0, 0, 10]]) },
      { kind: 'extrude', id: 'f1', name: 'Pin', sketch: 's1', extent: { type: 'one', d: '30' }, op: 'new' },
    ]);
    const { numbers } = solve(design);
    const v = (await ask({ op: 'views', design, numbers, specs: [{ key: 'front', view: 'front', hidden: true }, { key: 'side', view: 'left', hidden: true }, { key: 'iso', view: 'iso', hidden: false }] }))!;
    expect(v.front.visible.length).toBeGreaterThan(0);
    near(v.front.box.x1 - v.front.box.x0, 20, 1e-9);
    near(v.front.box.y1 - v.front.box.y0, 30, 1e-9);
    // seen from the left (looking along +X) the paper's x runs along −Y
    near(v.side.box.x1 - v.side.box.x0, 20, 1e-9);
    expect(v.iso.hidden).toEqual([]);
  });

  it('display data is made once per design key', () => {
    const design = plate();
    const { numbers } = solve(design);
    const a = displayFor(design, numbers);
    expect(displayFor({ ...design, components: design.components.map((c) => ({ ...c, color: '#336699' })) }, numbers)).toBe(a);
  });

  it('the mesh kernel answers sections the same way', () => {
    const design = plate();
    const { numbers } = solve(design);
    const built = buildDesign(kernel()!, design, numbers);
    try {
      const [s] = sectionMesh(built, design, { n: [1, 0, 0], offset: 30 });
      // planar cuts of a faceted solid: the box part exact, the hole as a 180-gon
      near(s.body.mass.V, 70 * 60 * 10 - PI * 100 * 10, 3e-4);
      near(capArea(s), 600, 1e-9);
    } finally {
      built.free();
    }
  });

  it('OpenCascade failing on a part: the mesh kernel draws it', async () => {
    // the B-rep tessellator throws (as on a shape OCCT cannot mesh); a block of its own so
    // no display data is cached for it yet
    const design = single([
      { kind: 'sketch', id: 's1', name: 'S', plane: { ref: 'XY' }, sketch: rect('a', 0, 0, 37, 23) },
      { kind: 'extrude', id: 'f1', name: 'Block', sketch: 's1', extent: { type: 'one', d: '11' }, op: 'new' },
    ]);
    const { numbers } = solve(design);
    const X = occ()!.ReplicadMeshExtractor as unknown as Record<string, unknown>;
    const extract = X.extract;
    X.extract = () => {
      throw new Error('simulated meshing failure');
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const b = (await ask({ op: 'display', design, numbers }))!;
      expect(b.kernel).toBe('mesh');
      // a box is exact in the mesh kernel too: 37 × 23 × 11
      near(b.components.c1.bodies[0].mass.V, 37 * 23 * 11, 1e-9);
      expect(warn).toHaveBeenCalled();
    } finally {
      X.extract = extract;
      warn.mockRestore();
    }
  });

  it('a renewed kernel draws afresh what a trapped one failed on', async () => {
    // a trap inside a feature drops the body from the display; once the fresh instance is in,
    // the same design key must not come back from the display cache without it
    const design = single([
      { kind: 'sketch', id: 's1', name: 'S', plane: { ref: 'XY' }, sketch: rect('a', 0, 0, 29, 13) },
      { kind: 'extrude', id: 'f1', name: 'Block', sketch: 's1', extent: { type: 'one', d: '5' }, op: 'new' },
    ]);
    const K = occ()! as unknown as Record<string, unknown>;
    const Prism = K.BRepPrimAPI_MakePrism;
    K.BRepPrimAPI_MakePrism = function () {
      throw new WebAssembly.RuntimeError('memory access out of bounds');
    };
    let broken, numbers;
    try {
      // the worksheet builds it first (the trap), the display then comes from that build
      numbers = designNumbers(solve(design).res.design!);
      broken = displayFor(design, numbers)!;
    } finally {
      K.BRepPrimAPI_MakePrism = Prism;
    }
    expect(broken.components.c1.bodies).toHaveLength(0);
    expect(broken.components.c1.errors.f1).toMatch(/restarts/);
    await renewOcc(Infinity);
    const b = displayFor(design, numbers)!;
    expect(b.kernel).toBe('brep');
    near(b.components.c1.bodies[0].mass.V, 29 * 13 * 5);
  });
});
