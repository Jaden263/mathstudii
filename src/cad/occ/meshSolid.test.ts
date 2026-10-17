// Convert to solid: a closed mesh sewn into a B-rep, its coplanar triangles merged into
// faces, so the B-rep features work on it (a cube's edge rounded as any other's).
import { describe, expect, it } from 'vitest';
import { emptyDesign, type CadDesign } from '../design';
import { insertImport, planImport } from '../importDesign';
import { meshToStl } from '../stl';
import { boxTriangles, uvSphere, uvSphereVolume } from '../meshFixtures';
import { solve, watchHandles } from './fixtures';
import { occ } from './kernel';
import { buildDesignOcc } from './build';
import { topologyOcc } from './topology';
import { refTo } from '../topology';
import { clearStepFiles } from './stepImport';

const { PI } = Math;
const stl = (tris: number[][]) => meshToStl({ positions: new Float32Array(tris.flat()), normals: new Float32Array(0), edges: new Float32Array(0), bounds: { min: [0, 0, 0], max: [0, 0, 0] } });
const asSolid = (tris: number[][], name = 'mesh.stl'): CadDesign => insertImport(emptyDesign(), planImport(name, 'stl', stl(tris)), { unit: 'mm', active: 'c1', solid: true }).design;

describe('mesh to solid', () => {
  it('sews a cube into six faces that a fillet can round', () => {
    const oc = occ()!;
    const d = asSolid(boxTriangles(10, 10, 10));
    const { res, numbers } = solve(d);
    expect(res.design!.errors).toEqual({});
    const b = res.design!.bodies.c1[0];
    expect(b.mesh).toBeUndefined();
    expect(b.mass!.V).toBeCloseTo(1000, 9);
    const built = buildDesignOcc(oc, d, numbers);
    const topo = topologyOcc(oc, built.components.get('c1')!.bodies[0].solid, d.components[0].items[0].id);
    built.free();
    expect(topo.faces.map((f) => f.type)).toEqual(Array(6).fill('plane'));
    expect(topo.edges).toHaveLength(12);
    // round the edge along z at x = y = 10 (r = 2): the cube less (1 − π/4) r² per length
    const e = topo.edges.find((q) => q.line && Math.abs(q.mid[0] - 10) < 1e-9 && Math.abs(q.mid[1] - 10) < 1e-9)!;
    const f: CadDesign = { ...d, components: [{ ...d.components[0], items: [...d.components[0].items, { kind: 'fillet', id: 'r', name: 'Round', sets: [{ edges: [refTo('edge', topo.id, e)], r: '2' }] }] }] };
    const rounded = solve(f).res.design!;
    expect(rounded.errors).toEqual({});
    expect(rounded.bodies.c1[0].mass!.V).toBeCloseTo(1000 - (1 - PI / 4) * 4 * 10, 9);
  });

  it('a sewn sphere mesh keeps the polyhedron’s volume', () => {
    const [r, n, m] = [10, 24, 12];
    const { res } = solve(asSolid(uvSphere(r, n, m)));
    expect(res.design!.errors).toEqual({});
    expect(Math.abs(res.design!.bodies.c1[0].mass!.V / uvSphereVolume(r, n, m) - 1)).toBeLessThan(1e-6);
  });

  it('refuses to sew an open mesh', () => {
    const { res } = solve(asSolid(boxTriangles(10, 10, 10).slice(2)));
    expect(Object.values(res.design!.errors)[0]).toMatch(/cannot become a solid: the mesh is not closed \(4 edges with one triangle\)/);
  });

  it('deletes every OCCT object it makes', () => {
    const oc = occ()!;
    const d = asSolid(boxTriangles(10, 20, 30));
    const { numbers } = solve(d);
    const watch = watchHandles(oc);
    try {
      const built = buildDesignOcc(oc, d, numbers);
      expect(built.components.get('c1')!.errors).toEqual({});
      built.free();
      clearStepFiles();
      expect(watch.undeleted()).toEqual([]);
    } finally {
      watch.stop();
    }
  });
});
