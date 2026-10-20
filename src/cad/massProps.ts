// Mass properties as the Inspect panel and the worksheet report them: the inertia tensor
// about the centre of gravity and about the origin (parallel-axis theorem), the principal
// moments and axes (its eigen-decomposition, Jacobi rotations) and the radii of gyration.
//
// Sign convention: J is the inertia tensor, J_xx = ∫(y² + z²) dm on the diagonal and
// J_xy = −∫xy dm off it; MassOut.Im keeps the products of inertia P_xy = +∫xy dm (as the
// worksheet's Imxy always has).
import type { MassOut } from './design';
import { cross3, dot3, norm3, type Vec3 } from './solid';

/** Row-major 3×3. */
export type M3 = [number, number, number, number, number, number, number, number, number];

/** The inertia tensor about the centre of gravity, kg·unit². */
export function inertiaTensor(Im: NonNullable<MassOut['Im']>): M3 {
  const [xx, yy, zz, xy, xz, yz] = Im;
  return [xx, -xy, -xz, -xy, yy, -yz, -xz, -yz, zz];
}

/** J about a point O, from J about the centre of gravity G: J_O = J_G + m(|r|²E − r rᵀ), r = G − O. */
export function shiftTensor(J: M3, m: number, r: Vec3): M3 {
  const rr = dot3(r, r);
  const out = [...J] as M3;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) out[3 * i + j] += m * ((i === j ? rr : 0) - r[i] * r[j]);
  return out;
}

/**
 * Eigenvalues (ascending) and unit eigenvectors of a symmetric 3×3 by cyclic Jacobi
 * rotations: the principal moments and axes of an inertia tensor. The axes are made a
 * right-handed set (e3 = e1 × e2), each pointing into the half-space its largest
 * component is positive in, so they do not flip from one rebuild to the next.
 */
export function principal(J: M3): { moments: Vec3; axes: [Vec3, Vec3, Vec3] } {
  const a = [[J[0], J[1], J[2]], [J[3], J[4], J[5]], [J[6], J[7], J[8]]];
  const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const scale = Math.abs(a[0][0]) + Math.abs(a[1][1]) + Math.abs(a[2][2]) || 1;
  for (let sweep = 0; sweep < 50; sweep++) {
    const off = Math.abs(a[0][1]) + Math.abs(a[0][2]) + Math.abs(a[1][2]);
    if (off <= 1e-15 * scale) break;
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
      if (Math.abs(a[p][q]) <= 1e-18 * scale) continue;
      // the rotation that zeroes a[p][q] (Golub & Van Loan, Algorithm 8.4.2)
      const tau = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const t = Math.sign(tau || 1) / (Math.abs(tau) + Math.sqrt(1 + tau * tau));
      const c = 1 / Math.sqrt(1 + t * t), s = t * c;
      for (let k = 0; k < 3; k++) {
        const akp = a[k][p], akq = a[k][q];
        a[k][p] = c * akp - s * akq;
        a[k][q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = a[p][k], aqk = a[q][k];
        a[p][k] = c * apk - s * aqk;
        a[q][k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = v[k][p], vkq = v[k][q];
        v[k][p] = c * vkp - s * vkq;
        v[k][q] = s * vkp + c * vkq;
      }
    }
  }
  const order = [0, 1, 2].sort((i, j) => a[i][i] - a[j][j]);
  const col = (i: number): Vec3 => {
    const e: Vec3 = [v[0][i], v[1][i], v[2][i]];
    const big = e.reduce((b, x, k) => (Math.abs(x) > Math.abs(e[b]) + 1e-12 ? k : b), 0);
    return norm3(e[big] < 0 ? [-e[0], -e[1], -e[2]] : e);
  };
  const e1 = col(order[0]), e2 = col(order[1]);
  return { moments: [a[order[0]][order[0]], a[order[1]][order[1]], a[order[2]][order[2]]], axes: [e1, e2, norm3(cross3(e1, e2))] };
}

export interface MassReport {
  V: number;
  /** Surface area, unit² (when measured). */
  A?: number;
  m: number;
  /** Mean density, kg/unit³. */
  rho: number;
  /** Centre of gravity. */
  c: Vec3;
  /** Inertia tensor about the centre of gravity and about the origin, kg·unit². */
  J: M3;
  JO: M3;
  /** Principal moments (ascending) and axes. */
  moments: Vec3;
  axes: [Vec3, Vec3, Vec3];
  /** Radii of gyration about the axes through the centre of gravity parallel to x, y, z, and about the principal axes. */
  k: Vec3;
  kp: Vec3;
}

/** Everything the Inspect panel shows, from a part's mass properties; null without a mass. */
export function massReport(mo: MassOut | null | undefined): MassReport | null {
  if (!mo || mo.m === undefined || !mo.Im || !(mo.m > 0)) return null;
  const c: Vec3 = [mo.xg, mo.yg, mo.zg];
  const J = inertiaTensor(mo.Im);
  const { moments, axes } = principal(J);
  const gyr = (I: number) => Math.sqrt(Math.max(0, I) / mo.m!);
  return {
    V: mo.V, ...(mo.A !== undefined ? { A: mo.A } : {}), m: mo.m, rho: mo.m / mo.V, c, J, JO: shiftTensor(J, mo.m, c), moments, axes,
    k: [gyr(J[0]), gyr(J[4]), gyr(J[8])], kp: [gyr(moments[0]), gyr(moments[1]), gyr(moments[2])],
  };
}
