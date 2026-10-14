// Mass properties of the 3-D features, from exact profile integrals.
import { frameMoment, profileProperties, type ProfileRegion, type Vec2 } from './profile';

export interface MassProps {
  /** Volume, sketch units³. */
  V: number;
  /** Centre of volume (centre of gravity for a uniform material). */
  xg: number;
  yg: number;
  zg: number;
  /**
   * Second moments of volume about centroidal axes parallel to x, y, z
   * (multiply by the density for mass moments of inertia).
   */
  Ixx: number;
  Iyy: number;
  Izz: number;
  /** Products ∫(x−xg)(y−yg) dV etc. */
  Pxy: number;
  Pxz: number;
  Pyz: number;
}

type M3 = number[][];

/** Inertia about the centroid from second moments S about a point, given the volume and centroid offset c from that point. */
function inertiaFrom(S: M3, V: number, c: number[]): Pick<MassProps, 'Ixx' | 'Iyy' | 'Izz' | 'Pxy' | 'Pxz' | 'Pyz'> {
  const Sc = S.map((row, i) => row.map((v, j) => v - V * c[i] * c[j]));
  const clean = (v: number) => (Math.abs(v) < 1e-12 * (Math.abs(Sc[0][0]) + Math.abs(Sc[1][1]) + Math.abs(Sc[2][2])) ? 0 : v);
  return {
    Ixx: Sc[1][1] + Sc[2][2], Iyy: Sc[0][0] + Sc[2][2], Izz: Sc[0][0] + Sc[1][1],
    Pxy: clean(Sc[0][1]), Pxz: clean(Sc[0][2]), Pyz: clean(Sc[1][2]),
  };
}

/** Prism: the profile (XY plane) extruded along +z by depth, or centred on z = 0. */
export function extrudeProps(regions: ProfileRegion[], depth: number, symmetric = false): MassProps | null {
  const s = profileProperties(regions);
  if (!s || !(depth > 0)) return null;
  const h = depth, A = s.A;
  return {
    V: A * h, xg: s.xc, yg: s.yc, zg: symmetric ? 0 : h / 2,
    Ixx: h * s.Ix + (A * h ** 3) / 12,
    Iyy: h * s.Iy + (A * h ** 3) / 12,
    Izz: h * (s.Ix + s.Iy),
    Pxy: h * s.Ixy, Pxz: 0, Pyz: 0,
  };
}

/**
 * Solid of revolution: the profile turned by `angle` radians about the in-plane axis
 * through p with direction d (right-hand rule about d). The profile must lie on one
 * side of the axis.
 */
export function revolveProps(regions: ProfileRegion[], axis: { p: Vec2; d: Vec2 }, angle: number): MassProps | null {
  const len = Math.hypot(axis.d.x, axis.d.y);
  if (!regions.length || !(len > 0) || !(angle > 0)) return null;
  const a = { x: axis.d.x / len, y: axis.d.y / len };
  const M = (i: number, j: number) => frameMoment(regions, axis.p, a, i, j);
  const A = M(0, 0);
  if (!(A > 0)) return null;
  // side of the axis: r = s·w ≥ 0 everywhere
  const s = Math.sign(M(0, 1)) || 1;
  const area = Math.abs(A);
  const wMin = s * M(0, 1) / area; // mean radius; validated below
  if (!(wMin > 0)) throw new Error('The profile lies on the axis of revolution');
  if (crossesAxis(regions, axis.p, a)) throw new Error('The profile crosses the axis of revolution');
  // moments of u and r (= s·w)
  const R = (i: number, j: number) => s ** j * M(i, j);
  const M01 = R(0, 1), M11 = R(1, 1), M21 = R(2, 1), M02 = R(0, 2), M12 = R(1, 2), M03 = R(0, 3);
  const phi = angle, sn = Math.sin(phi), cs = Math.cos(phi);
  const V = phi * M01;
  // local frame ξ = (u, r cosθ, r sinθ) about the axis point p
  const c = [M11 / M01, (sn * M02) / V, ((1 - cs) * M02) / V];
  const S: M3 = [
    [phi * M21, sn * M12, (1 - cs) * M12],
    [sn * M12, M03 * (phi / 2 + Math.sin(2 * phi) / 4), (M03 * sn * sn) / 2],
    [(1 - cs) * M12, (M03 * sn * sn) / 2, M03 * (phi / 2 - Math.sin(2 * phi) / 4)],
  ];
  // local axes in sketch space: a, e1 (towards the profile), e2 = a × e1 (±z)
  const e1 = { x: -a.y * s, y: a.x * s };
  const e2z = a.x * e1.y - a.y * e1.x;
  const Rm: M3 = [[a.x, e1.x, 0], [a.y, e1.y, 0], [0, 0, e2z]];
  const mul = (X: M3, Y: M3) => X.map((row) => Y[0].map((_, j) => row.reduce((acc, v, k) => acc + v * Y[k][j], 0)));
  const T = (X: M3) => X[0].map((_, j) => X.map((row) => row[j]));
  const Sg = mul(mul(Rm, S), T(Rm));
  const cg = [0, 1, 2].map((i) => Rm[i][0] * c[0] + Rm[i][1] * c[1] + Rm[i][2] * c[2]);
  const I = inertiaFrom(Sg, V, cg);
  // rounding noise on a symmetry axis reads as 0
  const size = Math.sqrt(Math.abs(M(0, 2)) / Math.abs(A)) + Math.hypot(axis.p.x, axis.p.y);
  const tidy = (v: number) => (Math.abs(v) < 1e-12 * size ? 0 : v);
  return { V, xg: tidy(axis.p.x + cg[0]), yg: tidy(axis.p.y + cg[1]), zg: tidy(cg[2]), ...I };
}

function crossesAxis(regions: ProfileRegion[], o: Vec2, a: Vec2): boolean {
  let pos = false, neg = false;
  let size = 0;
  for (const r of regions) for (const s of r.outer.segs) {
    const q = s.kind === 'line' ? s.a : s.c;
    size = Math.max(size, Math.abs(q.x - o.x), Math.abs(q.y - o.y), s.kind === 'arc' ? s.r : 0);
  }
  const tol = 1e-7 * Math.max(size, 1e-300);
  for (const r of regions) {
    for (const loop of [r.outer, ...r.holes]) {
      for (const s of loop.segs) {
        const pts = s.kind === 'line' ? [s.a, s.b] : Array.from({ length: 33 }, (_, k) => {
          const t = s.a0 + ((s.a1 - s.a0) * k) / 32;
          return { x: s.c.x + s.r * Math.cos(t), y: s.c.y + s.r * Math.sin(t) };
        });
        for (const p of pts) {
          const w = -(p.x - o.x) * a.y + (p.y - o.y) * a.x;
          if (w > tol) pos = true;
          if (w < -tol) neg = true;
        }
      }
    }
  }
  return pos && neg;
}
