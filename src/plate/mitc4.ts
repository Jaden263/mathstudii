// The MITC4 plate element (Bathe & Dvorkin 1985): a four-node Reissner–Mindlin quad with
// w, βx, βy per node, bilinear for all three. Bending is integrated in full (2 × 2); the
// transverse shear strains are not taken from the bilinear fields, which would lock a thin
// plate, but interpolated from the covariant strains at the midpoints of the four edges,
// where they are exact for a Kirchhoff-like field. The element so stays free of locking
// for t/a down to 1/1000 and passes the patch tests, on rectangles and distorted quads.
//
// Conventions: z points down, so w is positive downwards (with the load), u = z βx and
// v = z βy; the Kirchhoff limit is βx = −∂w/∂x. Curvatures κ = (∂βx/∂x, ∂βy/∂y,
// ∂βx/∂y + ∂βy/∂x), moments m = ∫σ z dz (m_x > 0 sagging, tension at the bottom face),
// shear strains γ = ∇w + β and forces q = κ_s G t γ, with ∂m_x/∂x + ∂m_xy/∂y = q_x.

/** Material of a plate in SI: D = E t³ / 12(1 − ν²) and the shear stiffness κ_s G t (κ_s = 5/6). */
export interface PlateRigidity {
  D: number;
  nu: number;
  /** κ_s G t, N/m. */
  S: number;
}

export function rigidity(E: number, nu: number, t: number): PlateRigidity {
  return { D: (E * t ** 3) / (12 * (1 - nu * nu)), nu, S: ((5 / 6) * E * t) / (2 * (1 + nu)) };
}

const G2 = 1 / Math.sqrt(3);
/** The 2 × 2 Gauss points (ξ, η) in the order of the nodes they are nearest. */
export const GAUSS2: [number, number][] = [[-G2, -G2], [G2, -G2], [G2, G2], [-G2, G2]];
/** Natural coordinates of the nodes: counter-clockwise from (−1, −1). */
const NODE_XI = [-1, 1, 1, -1], NODE_ETA = [-1, -1, 1, 1];

export function shape(xi: number, eta: number): [number, number, number, number] {
  return [(1 - xi) * (1 - eta) / 4, (1 + xi) * (1 - eta) / 4, (1 + xi) * (1 + eta) / 4, (1 - xi) * (1 + eta) / 4];
}

/** Derivatives of the shape functions, the Jacobian determinant and dN/dx, dN/dy at (ξ, η). */
export function jacobian(xy: ArrayLike<number>, xi: number, eta: number) {
  const dxi = [-(1 - eta) / 4, (1 - eta) / 4, (1 + eta) / 4, -(1 + eta) / 4];
  const deta = [-(1 - xi) / 4, -(1 + xi) / 4, (1 + xi) / 4, (1 - xi) / 4];
  let xx = 0, xy_ = 0, yx = 0, yy = 0;
  for (let i = 0; i < 4; i++) {
    xx += dxi[i] * xy[2 * i];
    xy_ += dxi[i] * xy[2 * i + 1];
    yx += deta[i] * xy[2 * i];
    yy += deta[i] * xy[2 * i + 1];
  }
  // J = [x_ξ y_ξ; x_η y_η]
  const det = xx * yy - xy_ * yx;
  const i11 = yy / det, i12 = -xy_ / det, i21 = -yx / det, i22 = xx / det;
  const dx = new Float64Array(4), dy = new Float64Array(4);
  for (let i = 0; i < 4; i++) {
    dx[i] = i11 * dxi[i] + i12 * deta[i];
    dy[i] = i21 * dxi[i] + i22 * deta[i];
  }
  return { det, dx, dy, inv: [i11, i12, i21, i22] as const };
}

/** Curvature–displacement matrix (3 × 12, row major) at a point. */
function bendingB(dx: Float64Array, dy: Float64Array): Float64Array {
  const B = new Float64Array(36);
  for (let i = 0; i < 4; i++) {
    B[3 * i + 1] = dx[i];
    B[12 + 3 * i + 2] = dy[i];
    B[24 + 3 * i + 1] = dy[i];
    B[24 + 3 * i + 2] = dx[i];
  }
  return B;
}

/**
 * Covariant shear strain of an edge from node a to node b at its midpoint, as a row of 12:
 * (w_b − w_a)/2 + (x_b − x_a)/4 (βx_a + βx_b) + (y_b − y_a)/4 (βy_a + βy_b).
 */
function edgeShear(xy: ArrayLike<number>, a: number, b: number): Float64Array {
  const r = new Float64Array(12);
  const hx = (xy[2 * b] - xy[2 * a]) / 4, hy = (xy[2 * b + 1] - xy[2 * a + 1]) / 4;
  r[3 * a] = -0.5;
  r[3 * b] = 0.5;
  r[3 * a + 1] = r[3 * b + 1] = hx;
  r[3 * a + 2] = r[3 * b + 2] = hy;
  return r;
}

/** The tying strains: γ_ξ at A (η = 1) and C (η = −1), γ_η at D (ξ = 1) and B (ξ = −1). */
function tying(xy: ArrayLike<number>) {
  return { A: edgeShear(xy, 3, 2), C: edgeShear(xy, 0, 1), D: edgeShear(xy, 1, 2), B: edgeShear(xy, 0, 3) };
}

/** Assumed Cartesian shear strains (2 × 12, row major) at (ξ, η). */
function shearB(t: ReturnType<typeof tying>, inv: readonly number[], xi: number, eta: number): Float64Array {
  const B = new Float64Array(24);
  for (let k = 0; k < 12; k++) {
    const gxi = 0.5 * (1 + eta) * t.A[k] + 0.5 * (1 - eta) * t.C[k];
    const geta = 0.5 * (1 + xi) * t.D[k] + 0.5 * (1 - xi) * t.B[k];
    // [γ_x; γ_y] = J⁻¹ [γ_ξ; γ_η]
    B[k] = inv[0] * gxi + inv[1] * geta;
    B[12 + k] = inv[2] * gxi + inv[3] * geta;
  }
  return B;
}

/** Element stiffness, 12 × 12 row major, DOFs (w, βx, βy) per node. */
export function mitc4Stiffness(xy: ArrayLike<number>, m: PlateRigidity): Float64Array {
  const K = new Float64Array(144);
  const { D, nu, S } = m;
  const Db = [D, D * nu, 0, D * nu, D, 0, 0, 0, (D * (1 - nu)) / 2];
  const tie = tying(xy);
  for (const [xi, eta] of GAUSS2) {
    const { det, dx, dy, inv } = jacobian(xy, xi, eta);
    if (!(det > 0)) throw new Error('A plate element is inverted or degenerate');
    const Bb = bendingB(dx, dy), Bs = shearB(tie, inv, xi, eta);
    // K += Bbᵀ Db Bb det + Bsᵀ S Bs det
    const DB = new Float64Array(36);
    for (let r = 0; r < 3; r++) for (let k = 0; k < 12; k++) DB[12 * r + k] = Db[3 * r] * Bb[k] + Db[3 * r + 1] * Bb[12 + k] + Db[3 * r + 2] * Bb[24 + k];
    for (let i = 0; i < 12; i++) {
      const b0 = Bb[i], b1 = Bb[12 + i], b2 = Bb[24 + i], s0 = Bs[i], s1 = Bs[12 + i];
      for (let j = 0; j < 12; j++) {
        K[12 * i + j] += det * (b0 * DB[j] + b1 * DB[12 + j] + b2 * DB[24 + j] + S * (s0 * Bs[j] + s1 * Bs[12 + j]));
      }
    }
  }
  return K;
}

/** Consistent nodal forces of a uniform pressure p (downwards): ∫ N_i p dA on the w DOFs. */
export function pressureLoad(xy: ArrayLike<number>, p: number): Float64Array {
  const f = new Float64Array(12);
  for (const [xi, eta] of GAUSS2) {
    const N = shape(xi, eta), { det } = jacobian(xy, xi, eta);
    for (let i = 0; i < 4; i++) f[3 * i] += N[i] * p * det;
  }
  return f;
}

/** ∫ c N_i N_j dA on the w DOFs: an elastic bedding of modulus c (N/m³) under the element. */
export function beddingStiffness(xy: ArrayLike<number>, c: number): Float64Array {
  const K = new Float64Array(144);
  for (const [xi, eta] of GAUSS2) {
    const N = shape(xi, eta), { det } = jacobian(xy, xi, eta);
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) K[12 * 3 * i + 3 * j] += c * N[i] * N[j] * det;
  }
  return K;
}

/** The moments (m_x, m_y, m_xy) at the element's centre from its nodal displacements: a 3 × 12 operator, row major. */
export function centreOperator(xy: ArrayLike<number>, m: PlateRigidity): Float64Array {
  const { D, nu } = m;
  const { dx, dy } = jacobian(xy, 0, 0);
  const op = new Float64Array(36);
  for (let i = 0; i < 4; i++) {
    // m_x = D (κx + ν κy), m_y = D (ν κx + κy), m_xy = D (1 − ν)/2 κxy
    op[3 * i + 1] = D * dx[i];
    op[3 * i + 2] = D * nu * dy[i];
    op[12 + 3 * i + 1] = D * nu * dx[i];
    op[12 + 3 * i + 2] = D * dy[i];
    op[24 + 3 * i + 1] = (D * (1 - nu) / 2) * dy[i];
    op[24 + 3 * i + 2] = (D * (1 - nu) / 2) * dx[i];
  }
  return op;
}

/**
 * Moments at the four nodes of an element, extrapolated bilinearly from the 2 × 2 Gauss
 * points (3 per node): the usual recovery of a four-node element, used where no patch of
 * the superconvergent recovery reaches.
 */
export function extrapolatedMoments(xy: ArrayLike<number>, m: PlateRigidity, u: ArrayLike<number>): Float64Array {
  const { D, nu } = m;
  const gm: number[][] = [];
  for (const [xi, eta] of GAUSS2) {
    const { dx, dy } = jacobian(xy, xi, eta);
    let kx = 0, ky = 0, kxy = 0;
    for (let i = 0; i < 4; i++) {
      kx += dx[i] * u[3 * i + 1];
      ky += dy[i] * u[3 * i + 2];
      kxy += dy[i] * u[3 * i + 1] + dx[i] * u[3 * i + 2];
    }
    gm.push([D * (kx + nu * ky), D * (nu * kx + ky), (D * (1 - nu) / 2) * kxy]);
  }
  // node i sits at (ξ, η) = √3 (±1, ±1) in the coordinates of the Gauss-point square
  const nodal = new Float64Array(12);
  for (let i = 0; i < 4; i++) {
    const N = shape(NODE_XI[i] * Math.sqrt(3), NODE_ETA[i] * Math.sqrt(3));
    for (let c = 0; c < 3; c++) nodal[3 * i + c] = N[0] * gm[0][c] + N[1] * gm[1][c] + N[2] * gm[2][c] + N[3] * gm[3][c];
  }
  return nodal;
}

/** Natural coordinates of a point in a (convex) quad by Newton's method on the bilinear map; null when it does not converge. */
export function inverseMap(xy: ArrayLike<number>, x: number, y: number): [number, number] | null {
  let xi = 0, eta = 0;
  for (let it = 0; it < 20; it++) {
    const N = shape(xi, eta);
    let px = 0, py = 0;
    for (let i = 0; i < 4; i++) {
      px += N[i] * xy[2 * i];
      py += N[i] * xy[2 * i + 1];
    }
    const rx = x - px, ry = y - py;
    const dxi = [-(1 - eta) / 4, (1 - eta) / 4, (1 + eta) / 4, -(1 + eta) / 4];
    const deta = [-(1 - xi) / 4, -(1 + xi) / 4, (1 + xi) / 4, (1 - xi) / 4];
    let a = 0, b = 0, c = 0, d = 0;
    for (let i = 0; i < 4; i++) {
      a += dxi[i] * xy[2 * i];
      b += deta[i] * xy[2 * i];
      c += dxi[i] * xy[2 * i + 1];
      d += deta[i] * xy[2 * i + 1];
    }
    const det = a * d - b * c;
    if (!(Math.abs(det) > 0)) return null;
    const sx = (d * rx - b * ry) / det, sy = (-c * rx + a * ry) / det;
    xi += sx;
    eta += sy;
    if (Math.abs(sx) + Math.abs(sy) < 1e-12) return [xi, eta];
  }
  return Math.abs(xi) < 1e3 && Math.abs(eta) < 1e3 ? [xi, eta] : null;
}
