// Draft and curvature analyses against closed forms: a drafted face reads its draft angle,
// cylinders, spheres and tori their curvatures exactly, and the mesh estimate comes close
// to them where it has to stand in.
import { describe, expect, it } from 'vitest';
import { circles, rect, single, solve } from './occ/fixtures';
import type { DesignItem } from './design';
import type { CadSketch } from './model';
import type { BodyMesh, BodyResult } from './buildResult';
import { buildResultOcc } from './occ/result';
import { occ } from './occ/kernel';
import { bodyCurvature, curvatureRange, divergingColour, draftAngle, draftClass, draftTint, DRAFT_COLOURS, exactCurvature, meshCurvature } from './analysis';
import { refTo } from './topology';
import type { Vec3 } from './solid';

const { PI } = Math;
const deg = PI / 180;
const near = (v: number, want: number, tol: number) => expect(Math.abs(v - want), `${v} ≠ ${want}`).toBeLessThanOrEqual(tol);
const bodies = (items: DesignItem[]): BodyResult[] => {
  const d = single(items);
  return buildResultOcc(occ()!, d, solve(d).numbers).components.c1.bodies;
};
const box: DesignItem[] = [
  { kind: 'sketch', id: 's1', name: 'Base', plane: { ref: 'XY' }, sketch: rect('r', 0, 0, 100, 60) },
  { kind: 'extrude', id: 'f1', name: 'Extrude1', sketch: 's1', extent: { type: 'one', d: '40' }, op: 'new' },
];
const at = (b: BodyResult, p: Vec3) => b.faces.find((f) => Math.hypot(f.c[0] - p[0], f.c[1] - p[1], f.c[2] - p[2]) < 1e-6)!;

describe('draft analysis', () => {
  it('a face drafted 3° reads 3° against the pull direction (1e-6), and the faces sort into positive, negative and too little', () => {
    const [plain] = bodies(box);
    const front = refTo('face', plain.id, at(plain, [50, 0, 20]));
    const [b] = bodies([...box, { kind: 'draft', id: 'f2', name: 'Draft1', faces: [front], plane: 'XY', angle: '3 deg' }]);
    const face = (key: string) => b.faces.find((f) => f.key === key)!;
    const pull: Vec3 = [0, 0, 1];
    const a = draftAngle(face(front.key).frame!.n, pull);
    near(a / deg, 3, 1e-6);
    const least = 1 * deg;
    expect(draftClass(a, least)).toBe('positive');
    const top = b.faces.find((f) => f.frame && f.frame.n[2] > 0.99)!, bottom = b.faces.find((f) => f.frame && f.frame.n[2] < -0.99)!;
    expect(draftClass(draftAngle(top.frame!.n, pull), least)).toBe('positive');
    expect(draftClass(draftAngle(bottom.frame!.n, pull), least)).toBe('negative');
    const walls = b.faces.filter((f) => f !== top && f !== bottom && f.key !== front.key);
    expect(walls.length).toBe(3);
    for (const w of walls) expect(draftClass(draftAngle(w.frame!.n, pull), least)).toBe('insufficient');
    // past the least draft the mould wants, the drafted face is too little as well; pulled the other way it is negative
    expect(draftClass(a, 5 * deg)).toBe('insufficient');
    expect(draftClass(draftAngle(face(front.key).frame!.n, [0, 0, -1]), least)).toBe('negative');
    // its vertices are painted green, the walls' yellow
    const tint = draftTint(b, pull, least);
    const fi = face(front.key).index;
    for (let t = 0; t < b.mesh.faceOf.length; t++) {
      const v = b.mesh.indices[3 * t];
      const want = b.mesh.faceOf[t] === fi ? DRAFT_COLOURS.positive : b.mesh.faceOf[t] === walls[0].index ? DRAFT_COLOURS.insufficient : null;
      if (want) want.forEach((c, k) => near(tint[3 * v + k], c, 1e-6));
    }
  });

  it('a curved face is classed vertex by vertex: a cylinder standing on its end is too little all round, lying it is both', () => {
    const [cyl] = bodies([
      { kind: 'sketch', id: 's1', name: 'S', plane: { ref: 'XY' }, sketch: circles('c', [[0, 0, 10]]) },
      { kind: 'extrude', id: 'f1', name: 'Rod', sketch: 's1', extent: { type: 'one', d: '30' }, op: 'new' },
    ]);
    const side = cyl.faces.find((f) => f.type === 'cylinder')!;
    const colours = (pull: Vec3, least = deg) => {
      const tint = draftTint(cyl, pull, least), seen = new Set<string>();
      for (let t = 0; t < cyl.mesh.faceOf.length; t++) if (cyl.mesh.faceOf[t] === side.index) seen.add([...tint.subarray(3 * cyl.mesh.indices[3 * t], 3 * cyl.mesh.indices[3 * t] + 3)].map((x) => x.toFixed(2)).join());
      return seen;
    };
    expect([...colours([0, 0, 1])]).toEqual([DRAFT_COLOURS.insufficient.map((x) => x.toFixed(2)).join()]);
    // lying along the pull: the half facing it positive, the other negative, the sides within 20° of square too little
    expect(colours([1, 0, 0], 20 * deg).size).toBe(3);
  });
});

/** The upper half of a circle of radius r about (cx, cy), closed by its diameter. */
function halfDisc(r: number, cx = 0, cy = 0): CadSketch {
  return {
    points: [{ id: 'c', x: cx, y: cy }, { id: 'a', x: cx + r, y: cy }, { id: 'b', x: cx - r, y: cy }],
    entities: [{ id: 'arc', type: 'arc', c: 'c', p1: 'a', p2: 'b' }, { id: 'l', type: 'line', p1: 'b', p2: 'a' }],
    constraints: [],
  };
}

describe('curvature', () => {
  it('cylinders exactly: H = ±1/2R (a shaft +, a hole −), K = 0; planes 0', () => {
    const [plate] = bodies([
      { kind: 'sketch', id: 's1', name: 'S', plane: { ref: 'XY' }, sketch: { ...rect('r', -30, -30, 30, 30), points: [...rect('r', -30, -30, 30, 30).points, { id: 'hc', x: 0, y: 0 }], entities: [...rect('r', -30, -30, 30, 30).entities, { id: 'h', type: 'circle', c: 'hc', r: 8 }] } },
      { kind: 'extrude', id: 'f1', name: 'Plate', sketch: 's1', extent: { type: 'one', d: '10' }, op: 'new' },
      { kind: 'sketch', id: 's2', name: 'S2', plane: { ref: 'XY', offset: '10' }, sketch: circles('k', [[15, 15, 5]]) },
      { kind: 'extrude', id: 'f2', name: 'Pin', sketch: 's2', extent: { type: 'one', d: '20' }, op: 'join' },
    ]);
    const hk = bodyCurvature(plate);
    // (single precision is what the colours need)
    const check = (pred: (f: BodyResult['faces'][number]) => boolean, H: number) => {
      let n = 0;
      for (let t = 0; t < plate.mesh.faceOf.length; t++) if (pred(plate.faces[plate.mesh.faceOf[t]])) {
        const v = plate.mesh.indices[3 * t];
        near(hk[2 * v], H, 1e-8);
        near(hk[2 * v + 1], 0, 1e-12);
        n++;
      }
      expect(n).toBeGreaterThan(0);
    };
    check((f) => f.type === 'cylinder' && f.radius === 8, -1 / 16);
    check((f) => f.type === 'cylinder' && f.radius === 5, 1 / 10);
    check((f) => f.type === 'plane', 0);
  });

  it('a sphere exactly H = 1/R, K = 1/R², and the mesh estimate within 1 % and 2 %', () => {
    const R = 12;
    const [ball] = bodies([
      { kind: 'sketch', id: 's1', name: 'S', plane: { ref: 'XY' }, sketch: halfDisc(R) },
      { kind: 'revolve', id: 'f1', name: 'Ball', sketch: 's1', axis: 'x', angle: '360', op: 'new' },
    ]);
    const sphere = ball.faces.find((f) => f.type === 'sphere')!;
    expect(sphere).toBeDefined();
    const hk = bodyCurvature(ball);
    const v = ball.mesh.indices[3 * ball.mesh.faceOf.indexOf(sphere.index)];
    near(hk[2 * v], 1 / R, 1e-8);
    near(hk[2 * v + 1], 1 / (R * R), 1e-9);
    // the estimate on OCCT's own mesh of it (as for a B-spline face): its vertices away from the poles
    const tris = [...ball.mesh.faceOf.keys()].filter((t) => ball.mesh.faceOf[t] === sphere.index);
    const est = new Float32Array(hk.length);
    meshCurvature(ball.mesh, tris, est);
    let H = 0, K = 0, n = 0;
    for (const t of tris) for (let k = 0; k < 3; k++) {
      const q = ball.mesh.indices[3 * t + k];
      if (Math.abs(ball.mesh.positions[3 * q]) > 0.9 * R) continue;
      H += est[2 * q];
      K += est[2 * q + 1];
      n++;
    }
    near(H / n, 1 / R, 0.01 / R);
    near(K / n, 1 / (R * R), 0.02 / (R * R));
  });

  it('a torus exactly: K = cos v / (r ρ), +1/(r (R + r)) on the outer equator and −1/(r (R − r)) on the inner', () => {
    const Rm = 20, r = 5;
    const [ring] = bodies([
      { kind: 'sketch', id: 's1', name: 'S', plane: { ref: 'XY' }, sketch: circles('c', [[0, Rm, r]]) },
      { kind: 'revolve', id: 'f1', name: 'Ring', sketch: 's1', axis: 'x', angle: '360', op: 'new' },
    ]);
    const torus = ring.faces.find((f) => f.type === 'torus')!;
    expect(torus.radius).toBeCloseTo(Rm, 9);
    const outer: Vec3 = [0, Rm + r, 0], inner: Vec3 = [0, Rm - r, 0];
    const [Ho, Ko] = exactCurvature(torus, outer, [0, 1, 0])!;
    const [Hi, Ki] = exactCurvature(torus, inner, [0, -1, 0])!;
    near(Ko, 1 / (r * (Rm + r)), 1e-12);
    near(Ho, (1 / r + 1 / (Rm + r)) / 2, 1e-12);
    near(Ki, -1 / (r * (Rm - r)), 1e-12);
    near(Hi, (1 / r - 1 / (Rm - r)) / 2, 1e-12);
    // on top of the tube (cos v = 0, the axis is x): K = 0, H = 1/2r
    const [Ht, Kt] = exactCurvature(torus, [r, Rm, 0], [1, 0, 0])!;
    near(Kt, 0, 1e-12);
    near(Ht, 1 / (2 * r), 1e-12);
  });

  it('the mesh estimate on a saddle z = (x² − y²)/2a: H = 0, K = −1/a² at its middle', () => {
    // a fine grid round the origin with the exact normals (−x/a, y/a, 1)/|…|
    const a = 50, n = 21, h = 1;
    const pos: number[] = [], nrm: number[] = [], idx: number[] = [];
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const x = (i - (n - 1) / 2) * h, y = (j - (n - 1) / 2) * h;
      pos.push(x, y, (x * x - y * y) / (2 * a));
      const l = Math.hypot(x / a, y / a, 1);
      nrm.push(-x / a / l, y / a / l, 1 / l);
    }
    for (let j = 0; j + 1 < n; j++) for (let i = 0; i + 1 < n; i++) {
      const v = j * n + i;
      idx.push(v, v + 1, v + n + 1, v, v + n + 1, v + n);
    }
    const mesh: BodyMesh = { positions: new Float32Array(pos), normals: new Float32Array(nrm), indices: new Uint32Array(idx), faceOf: new Uint32Array(idx.length / 3) };
    const out = new Float32Array((pos.length / 3) * 2);
    meshCurvature(mesh, [...Array(idx.length / 3).keys()], out);
    const mid = ((n - 1) / 2) * n + (n - 1) / 2;
    near(out[2 * mid], 0, 1e-4 / a);
    near(out[2 * mid + 1], -1 / (a * a), 0.01 / (a * a));
  });

  it('colours: white at 0, the ends of the range blue and red; the range from the 95th percentile', () => {
    const same = (a: number[], b: number[]) => a.forEach((x, i) => near(x, b[i], 1e-12));
    same(divergingColour(0, 1), [0.97, 0.97, 0.97]);
    same(divergingColour(-5, 1), [0.13, 0.4, 0.67]);
    same(divergingColour(2, 1), [0.7, 0.09, 0.17]);
    same(divergingColour(0.25, 1), [(0.97 + 0.96) / 2, (0.97 + 0.65) / 2, (0.97 + 0.51) / 2]);
    const [cyl] = bodies([
      { kind: 'sketch', id: 's1', name: 'S', plane: { ref: 'XY' }, sketch: circles('c', [[0, 0, 10]]) },
      { kind: 'extrude', id: 'f1', name: 'Rod', sketch: 's1', extent: { type: 'one', d: '30' }, op: 'new' },
    ]);
    // the curved side's 1/2R is all there is besides the flat ends
    near(curvatureRange([cyl], 0), 1 / 20, 1e-8);
    expect(curvatureRange([cyl], 1)).toBe(0);
  });
});
