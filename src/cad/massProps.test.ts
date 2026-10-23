// Mass properties against closed forms: principal axes and moments of a block turned in
// space, the parallel-axis theorem against OCCT's own moments about the origin, radii of
// gyration.
import { describe, expect, it } from 'vitest';
import { circles, rect, single, solve } from './occ/fixtures';
import type { CadDesign, DesignItem } from './design';
import { inertiaTensor, massReport, principal, shiftTensor, type M3 } from './massProps';
import { occ, scratch, volumeProperties } from './occ/kernel';
import { buildDesignOcc } from './occ/build';
import { dot3, type Vec3 } from './solid';

const near = (v: number, want: number, tol: number) => expect(Math.abs(v - want), `${v} ≠ ${want}`).toBeLessThanOrEqual(tol);
const rel = (v: number, want: number, r = 1e-9) => near(v, want, r * Math.abs(want));

const block = (x0: number, y0: number, a: number, b: number, c: number): DesignItem[] => [
  { kind: 'sketch', id: 's1', name: 'S1', plane: { ref: 'XY' }, sketch: rect('a', x0, y0, x0 + a, y0 + b) },
  { kind: 'extrude', id: 'f1', name: 'Block', sketch: 's1', extent: { type: 'one', d: String(c) }, op: 'new' },
];

describe('principal moments and axes', () => {
  it('recover a diagonal tensor turned by a known rotation', () => {
    // R = Rz(40°) Ry(−25°) Rx(70°), J = R diag(2, 5, 9) Rᵀ
    const c = Math.cos, s = Math.sin, d = Math.PI / 180;
    const Rx = (t: number) => [1, 0, 0, 0, c(t), -s(t), 0, s(t), c(t)];
    const Ry = (t: number) => [c(t), 0, s(t), 0, 1, 0, -s(t), 0, c(t)];
    const Rz = (t: number) => [c(t), -s(t), 0, s(t), c(t), 0, 0, 0, 1];
    const mul = (A: number[], B: number[]) => [0, 1, 2].flatMap((i) => [0, 1, 2].map((j) => A[3 * i] * B[j] + A[3 * i + 1] * B[3 + j] + A[3 * i + 2] * B[6 + j]));
    const R = mul(Rz(40 * d), mul(Ry(-25 * d), Rx(70 * d)));
    const D = [2, 0, 0, 0, 5, 0, 0, 0, 9];
    const Rt = [R[0], R[3], R[6], R[1], R[4], R[7], R[2], R[5], R[8]];
    const J = mul(R, mul(D, Rt)) as M3;
    const p = principal(J);
    [2, 5, 9].forEach((m, i) => near(p.moments[i], m, 1e-12));
    p.axes.forEach((e, i) => near(Math.abs(dot3(e, [R[i], R[3 + i], R[6 + i]])), 1, 1e-12));
    // right-handed and orthonormal
    near(dot3(p.axes[0], p.axes[1]), 0, 1e-12);
    near(p.axes[0][1] * p.axes[1][2] - p.axes[0][2] * p.axes[1][1] - p.axes[2][0], 0, 1e-12);
  });

  it('handle equal moments (a square bar) and an already diagonal tensor', () => {
    const p = principal([3, 0, 0, 0, 3, 0, 0, 0, 1]);
    expect(p.moments).toEqual([1, 3, 3]);
    near(Math.abs(p.axes[0][2]), 1, 1e-15);
  });
});

describe('mass properties of parts', () => {
  it('a block turned in space: principal axes along its edges, moments m(b² + c²)/12, m(a² + c²)/12, m(a² + b²)/12', () => {
    const a = 100, b = 50, c = 20;
    const d: CadDesign = {
      ...single(block(-50, -25, a, b, c)),
      occurrences: [{ id: 'o1', component: 'c1', grounded: true, pos: [15, -40, 25], rot: [30, 20, 10] }],
    };
    d.components[0].material = 'S355';
    const { res } = solve(d, [], '');
    const r = massReport(res.design!.total)!;
    const m = a * b * c * 7850e-9;
    rel(r.m, m);
    rel(r.moments[0], (m * (b * b + c * c)) / 12);
    rel(r.moments[1], (m * (a * a + c * c)) / 12);
    rel(r.moments[2], (m * (a * a + b * b)) / 12);
    // the block's edges are the placement's axes
    const M = res.design!.placements.o1.matrix;
    const edge = (k: number): Vec3 => [M[4 * k], M[4 * k + 1], M[4 * k + 2]];
    r.axes.forEach((e, k) => near(Math.abs(dot3(e, edge(k))), 1, 1e-9));
    // radii of gyration about the principal axes: √(I/m)
    rel(r.kp[0], Math.sqrt((b * b + c * c) / 12));
    // the centre of gravity is where the block's centre went: (0, 0, c/2) placed
    const g = [0, 1, 2].map((i) => M[i] * 0 + M[4 + i] * 0 + M[8 + i] * (c / 2) + M[12 + i]);
    r.c.forEach((v, i) => near(v, g[i], 1e-9));
  });

  it('the inertia about the origin by the parallel-axis theorem, against a hand calculation and OCCT about the origin', () => {
    // 100 × 50 × 20 block from (30, 40, 0): its centre at (80, 65, 10)
    const design = single(block(30, 40, 100, 50, 20));
    const { res, numbers } = solve(design, [], '7850 kg/m^3');
    const r = massReport(res.design!.total)!;
    const m = 1e5 * 7850e-9, x = 80, y = 65, z = 10;
    // J_O,xx = m(b² + c²)/12 + m(y² + z²); J_O,xy = −m·x·y
    rel(r.JO[0], (m * (50 ** 2 + 20 ** 2)) / 12 + m * (y * y + z * z));
    rel(r.JO[4], (m * (100 ** 2 + 20 ** 2)) / 12 + m * (x * x + z * z));
    rel(r.JO[8], (m * (100 ** 2 + 50 ** 2)) / 12 + m * (x * x + y * y));
    rel(r.JO[1], -m * x * y);
    rel(r.JO[5], -m * y * z);
    // OCCT's own moments of the solid about axes through the origin
    const oc = occ()!;
    const built = buildDesignOcc(oc, design, numbers);
    try {
      const shape = built.components.get('c1')!.bodies[0].solid.shape;
      const about = (dx: number, dy: number, dz: number) => scratch((t) => {
        const p = volumeProperties(oc, t, shape, t.add(new oc.GProp_GProps()));
        return 7850e-9 * p.MomentOfInertia(t.add(new oc.gp_Ax1(t.add(new oc.gp_Pnt(0, 0, 0)), t.add(new oc.gp_Dir(dx, dy, dz)))));
      });
      rel(r.JO[0], about(1, 0, 0));
      rel(r.JO[4], about(0, 1, 0));
      rel(r.JO[8], about(0, 0, 1));
      // about (1, 1, 0)/√2: ½(Jxx + Jyy) + Jxy
      rel((r.JO[0] + r.JO[4]) / 2 + r.JO[1], about(1, 1, 0));
    } finally {
      built.free();
    }
  });

  it('shiftTensor moves to the centre of gravity and back', () => {
    const J: M3 = [4, -1, 0.5, -1, 6, 0.2, 0.5, 0.2, 7];
    const r: Vec3 = [3, -2, 5];
    const back = shiftTensor(shiftTensor(J, 2, r), -2, r);
    back.forEach((v, i) => near(v, J[i], 1e-12));
    // the products of inertia have the tensor's sign: J_xy = −P_xy
    expect(inertiaTensor([1, 2, 3, 0.4, 0.5, 0.6])).toEqual([1, -0.4, -0.5, -0.4, 2, -0.6, -0.5, -0.6, 3]);
  });

  it('a cylinder’s radius of gyration about its axis is R/√2, its area 2πR(R + h)', () => {
    const { res } = solve(single([
      { kind: 'sketch', id: 's1', name: 'S1', plane: { ref: 'XY' }, sketch: circles('c', [[0, 0, 10]]) },
      { kind: 'extrude', id: 'f1', name: 'Rod', sketch: 's1', extent: { type: 'one', d: '60' }, op: 'new' },
    ]));
    const r = massReport(res.design!.total)!;
    rel(r.k[2], 10 / Math.SQRT2);
    rel(r.A!, 2 * Math.PI * 10 * (10 + 60));
    rel(r.rho, 7850e-9);
    // m R²/2 about its axis, the smallest; m(3R² + h²)/12 about any transverse axis
    rel(r.moments[0], (r.m * 100) / 2);
    rel(r.moments[1], (r.m * (3 * 100 + 3600)) / 12);
    rel(r.moments[2], (r.m * (3 * 100 + 3600)) / 12);
    near(Math.abs(r.axes[0][2]), 1, 1e-9);
  });
});
