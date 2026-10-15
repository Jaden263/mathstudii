import { describe, it, expect, beforeAll } from 'vitest';
import {
  Arena, extrudeSolid, revolveSolid, holeTool, initKernel, solidMass, propsFromMass, massFromProps, transformMass, solidMesh, sectionInPlane,
  m4Inv, m4Mul, m4Pose, m4Point, m4Rotate, type Frame, type ManifoldToplevel,
} from './solid';
import { extrudeProps, revolveProps } from './features';
import type { ProfileRegion, Seg } from './profile';

const poly = (...p: [number, number][]): ProfileRegion['outer'] => ({
  segs: p.map(([x, y], i): Seg => ({ kind: 'line', a: { x, y }, b: { x: p[(i + 1) % p.length][0], y: p[(i + 1) % p.length][1] } })),
  entities: [],
});
const circleLoop = (cx: number, cy: number, r: number, ccw = true): ProfileRegion['outer'] => ({
  segs: [{ kind: 'arc', c: { x: cx, y: cy }, r, a0: ccw ? 0 : 2 * Math.PI, a1: ccw ? 2 * Math.PI : 0 }], entities: [],
});
const XY: Frame = { o: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1] };

let K: ManifoldToplevel;
beforeAll(async () => {
  K = await initKernel();
});

describe('solid kernel', () => {
  it('extrudes a plate with a hole and matches the exact volume', () => {
    const arena = new Arena();
    const reg: ProfileRegion = { outer: poly([0, 0], [80, 0], [80, 40], [0, 40]), holes: [circleLoop(40, 20, 8, false)] };
    const s = extrudeSolid(K, arena, [reg], XY, 0, 10);
    const exact = extrudeProps([reg], 10)!;
    const m = propsFromMass(solidMass(s));
    expect(m.V / exact.V).toBeCloseTo(1, 3);
    expect(m.xg).toBeCloseTo(40, 3);
    expect(m.zg).toBeCloseTo(5, 3);
    expect(m.Izz / exact.Izz).toBeCloseTo(1, 3);
    arena.free();
  });

  it('revolves like the exact formulas (direction and centroid included)', () => {
    const arena = new Arena();
    const reg: ProfileRegion = { outer: poly([10, 0], [30, 0], [30, 20], [10, 20]), holes: [] };
    const axis = { p: { x: 0, y: 0 }, d: { x: 0, y: 1 } };
    for (const ang of [Math.PI / 2, 2 * Math.PI]) {
      const s = revolveSolid(K, arena, [reg], XY, axis, ang);
      const exact = revolveProps([reg], axis, ang)!;
      const m = propsFromMass(solidMass(s));
      expect(m.V / exact.V).toBeCloseTo(1, 3);
      for (const k of ['xg', 'yg', 'zg'] as const) expect(m[k]).toBeCloseTo(exact[k], 1);
      expect(m.Iyy / exact.Iyy).toBeCloseTo(1, 3);
    }
    arena.free();
  });

  it('cuts holes with counterbores', () => {
    const arena = new Arena();
    const plate = extrudeSolid(K, arena, [{ outer: poly([0, 0], [50, 0], [50, 50], [0, 50]), holes: [] }], XY, 0, 10);
    const tool = holeTool(K, arena, [25, 25, 10], [0, 0, -1], { d: 6, depth: 20, style: 'counterbore', cbD: 10, cbDepth: 4 });
    const cut = arena.add(plate.subtract(tool));
    const want = 50 * 50 * 10 - Math.PI * 9 * 6 - Math.PI * 25 * 4;
    expect(cut.volume() / want).toBeCloseTo(1, 3);
    arena.free();
  });

  it('transforms mass properties with the solid', () => {
    const arena = new Arena();
    const s = extrudeSolid(K, arena, [{ outer: poly([0, 0], [40, 0], [40, 10], [0, 10]), holes: [] }], XY, 0, 5);
    const M = m4Pose([10, 20, 30], [30, 45, 60]);
    const moved = arena.add(s.transform(M as never));
    const a = transformMass(massFromProps(extrudeProps([{ outer: poly([0, 0], [40, 0], [40, 10], [0, 10]), holes: [] }], 5)!), M);
    const b = solidMass(moved);
    expect(b.V).toBeCloseTo(a.V, 3);
    for (let i = 0; i < 3; i++) expect(b.c[i]).toBeCloseTo(a.c[i], 3);
    for (let i = 0; i < 9; i++) expect(b.C[i]).toBeCloseTo(a.C[i], 0);
    arena.free();
  });

  it('inverts and composes matrices', () => {
    const M = m4Mul(m4Pose([1, 2, 3], [10, 20, 30]), m4Rotate([5, 0, 0], [0, 1, 1], 0.7));
    const p = m4Point(m4Mul(m4Inv(M), M), [3, -4, 5]);
    expect(p.map((v) => +v.toFixed(9))).toEqual([3, -4, 5]);
  });

  it('meshes with feature edges and slices for sketch references', () => {
    const arena = new Arena();
    const s = extrudeSolid(K, arena, [{ outer: poly([0, 0], [10, 0], [10, 10], [0, 10]), holes: [] }], XY, 0, 10);
    const mesh = solidMesh(s);
    expect(mesh.positions.length).toBe(12 * 9);
    expect(mesh.edges.length / 6).toBe(12); // a cube has 12 edges
    const top: Frame = { o: [0, 0, 10], u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1] };
    const sec = sectionInPlane(s, top);
    expect(sec.length).toBe(1);
    expect(sec[0].length).toBe(4);
    arena.free();
  });
});
