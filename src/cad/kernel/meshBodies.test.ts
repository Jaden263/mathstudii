// Imported mesh bodies in an assembly: placed, measured, checked for interference with a
// B-rep body, cut by the section view and drawn, each against the boxes' closed forms.
import { describe, expect, it } from 'vitest';
import { rect, single, solve } from '../occ/fixtures';
import type { CadDesign } from '../design';
import { insertImport, planImport } from '../importDesign';
import { boxTriangles } from '../meshFixtures';
import { meshToStl } from '../stl';
import { answer, displayFor } from './service';
import { snapsOn } from '../snaps';
import { m4Point } from '../solid';
import type { KernelRequest, KernelValues } from './protocol';

async function ask<K extends KernelRequest['op']>(req: Extract<KernelRequest, { op: K }>): Promise<KernelValues[K]> {
  return (await answer(req)).value as KernelValues[K];
}

const stl = (tris: number[][]) => meshToStl({ positions: new Float32Array(tris.flat()), normals: new Float32Array(0), edges: new Float32Array(0), bounds: { min: [0, 0, 0], max: [0, 0, 0] } });

/** A 100 × 60 × 10 plate, and a 10 mm cube from an STL placed over its corner at (−5, −5, 5): 5 × 5 × 5 inside the plate. */
function plateAndCube(): CadDesign {
  const d = single([
    { kind: 'sketch', id: 's1', name: 'S', plane: { ref: 'XY' }, sketch: rect('a', 0, 0, 100, 60) },
    { kind: 'extrude', id: 'f1', name: 'Plate', sketch: 's1', extent: { type: 'one', d: '10' }, op: 'new' },
  ]);
  const withCube: CadDesign = { ...d, components: [...d.components, { id: 'cm', name: 'Cube', items: [] }], occurrences: [...d.occurrences, { id: 'om', component: 'cm', grounded: true, pos: [-5, -5, 5] }] };
  return insertImport(withCube, planImport('cube.stl', 'stl', stl(boxTriangles(10, 10, 10))), { unit: 'mm', active: 'cm' }).design;
}

describe('mesh bodies', () => {
  it('are measured, shown and placed with the B-rep bodies', () => {
    const design = plateAndCube();
    const { res, numbers } = solve(design);
    expect(res.design!.errors).toEqual({});
    const cube = res.design!.bodies.cm[0];
    expect(cube.mesh).toBe(true);
    expect(cube.mass!.V).toBeCloseTo(1000, 9);
    // the assembly's volume and centre: the plate's and the cube's, the cube moved
    expect(res.design!.total!.V).toBeCloseTo(60000 + 1000, 6);
    expect(res.design!.total!.xg).toBeCloseTo((60000 * 50 + 1000 * 0) / 61000, 9);
    expect(res.design!.box!.min).toEqual([-5, -5, 0]);
    const shown = displayFor(design, numbers)!;
    const b = shown.components.cm.bodies[0];
    expect(b.meshOnly).toBe(true);
    // its smooth patches are the six faces of the cube, the creases its twelve edges
    expect(b.faces.map((f) => f.type)).toEqual(Array(6).fill('plane'));
    expect(b.edges).toHaveLength(12);
  });

  it('interference: the volume the cube shares with the plate', async () => {
    const design = plateAndCube();
    const { numbers } = solve(design);
    const rows = await ask({ op: 'interference', design, numbers });
    expect(rows).toHaveLength(1);
    expect(rows[0].v).toBeCloseTo(125, 6);
  });

  it('section: the cube clipped and closed, its cut face marked', async () => {
    const design = plateAndCube();
    const { numbers } = solve(design);
    const cut = await ask({ op: 'section', design, numbers, plane: { n: [1, 0, 0], offset: 0 } });
    const cube = cut.find((s) => s.component === 'cm')!;
    // x ≥ 0 of the cube at x = −5 … 5: half of it
    expect(cube.body.mass.V).toBeCloseTo(500, 6);
    expect(cube.caps).toHaveLength(1);
    expect(cube.body.faces[cube.caps[0]].area).toBeCloseTo(100, 9);
    expect(cube.body.faces[cube.caps[0]].frame!.n[0]).toBeCloseTo(-1, 9);
  });

  it('drawings: drawn from its facets beside the exact plate', async () => {
    const design = plateAndCube();
    const { numbers } = solve(design);
    const views = await ask({ op: 'drawing', design, numbers, views: [{ key: 'top', name: 'Top', dir: [0, 0, -1], up: [0, 1, 0], hidden: true }] });
    const v = views!.top;
    expect(v.mesh).toBe('some');
    // the plate's 100 × 60 outline and the cube sticking out 5 past its corner
    expect(v.box.x0).toBeCloseTo(-5, 6);
    expect(v.box.x1).toBeCloseTo(100, 6);
    expect(v.box.y0).toBeCloseTo(-5, 6);
    expect(v.box.y1).toBeCloseTo(60, 6);
  });

  it('joints: a snap point on the mesh body sets it on the plate', () => {
    const design = plateAndCube();
    const { numbers } = solve(design);
    const shown = displayFor(design, numbers)!;
    const plate = shown.components.c1.bodies[0], cube = shown.components.cm.bodies[0];
    const top = plate.faces.find((f) => f.frame && f.frame.n[2] > 0.999)!;
    const bottom = cube.faces.find((f) => f.frame && f.frame.n[2] < -0.999)!;
    const a = snapsOn(plate, { face: top.index }).find((q) => q.snap === 'centroid')!;
    const b = snapsOn(cube, { face: bottom.index }).find((q) => q.snap === 'centroid')!;
    const jointed: CadDesign = {
      ...design,
      occurrences: design.occurrences.map((o) => (o.id === 'om' ? { id: 'om', component: 'cm' } : o)),
      joints: [{ id: 'j', name: 'Seat', type: 'rigid', a: { occ: 'o1', origin: { kind: 'snap', ...a } }, b: { occ: 'om', origin: { kind: 'snap', ...b } }, angle: '0', offset: '0', flip: true }],
    };
    const { res } = solve(jointed);
    expect(res.design!.errors).toEqual({});
    expect(res.design!.warnings).toEqual({});
    expect(res.design!.placements.om.by).toBe('joint');
    // the cube's bottom on the plate's top, centred: its centre at (50, 30, 15)
    expect(m4Point(res.design!.placements.om.matrix, [5, 5, 5]).map((v) => +v.toFixed(9))).toEqual([50, 30, 15]);
  });
});
