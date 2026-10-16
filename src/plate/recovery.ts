// Superconvergent patch recovery (Zienkiewicz & Zhu 1992) of the moments of a plate: at
// each interior node a quadratic polynomial is fitted by least squares to the moments at
// the centres of the elements within two rings of it, the points where the four-node
// element's curvatures are superconvergent (its κ_x is constant along x, so the Gauss
// points of one element carry no gradient across it). The polynomial's value is the
// node's moment and its gradient gives the shear forces by equilibrium; nodes on an edge,
// a wall or a line load (where the shear jumps) take the polynomials of the interior nodes
// next to them, on their own side. Extrapolating one element's Gauss points instead left
// the moment at a clamped edge 12 % low on a 32 × 32 mesh and the shear at a simply
// supported edge 25 % low.
import { segmentDistance, type Pt } from './cdt';
import { shape } from './mitc4';
import { boundaryNodes, elementXY, type PlateMesh } from './mesh';

export interface Recovery {
  /** Element corners (4e + k) of each group: a node, or one side of a node on a jump line. */
  groups: number[][];
  /** Node of each group. */
  node: Int32Array;
  /** Interior groups: the least-squares operator (terms × samples) and the samples (elements, at their centres). */
  fit: ({ samples: Int32Array; op: Float64Array; terms: number } | null)[];
  /** Other groups: the interior groups whose polynomials they evaluate. */
  from: number[][];
  /** Length scale of the fits (m). */
  h: number;
}

/** The fits of a mesh (geometry only: one for every load case). */
export function buildRecovery(m: PlateMesh, jumps: [Pt, Pt][]): Recovery {
  const nn = m.x.length, ne = m.quads.length / 4;
  const groups = cornerGroups(m, jumps);
  const node = new Int32Array(groups.length);
  const groupOf = new Int32Array(4 * ne);
  groups.forEach((g, i) => {
    node[i] = m.quads[g[0]];
    for (const c of g) groupOf[c] = i;
  });
  // nodes on the mesh's boundary: on an edge of one element only
  const boundary = new Uint8Array(nn);
  for (const q of boundaryNodes(nn, m.quads)) boundary[q] = 1;
  const split = new Uint8Array(nn);
  const perNode = new Int32Array(nn);
  for (const n0 of node) perNode[n0]++;
  for (let i = 0; i < nn; i++) if (perNode[i] > 1) split[i] = 1;

  let area = 0;
  for (let e = 0; e < ne; e++) {
    const xy = elementXY(m, e);
    area += Math.abs((xy[4] - xy[0]) * (xy[7] - xy[3]) - (xy[6] - xy[2]) * (xy[5] - xy[1])) / 2;
  }
  const h = Math.sqrt(area / Math.max(1, ne));
  const gpx = new Float64Array(ne), gpy = new Float64Array(ne);
  for (let e = 0; e < ne; e++) {
    const xy = elementXY(m, e);
    const N = shape(0, 0);
    gpx[e] = N[0] * xy[0] + N[1] * xy[2] + N[2] * xy[4] + N[3] * xy[6];
    gpy[e] = N[0] * xy[1] + N[1] * xy[3] + N[2] * xy[5] + N[3] * xy[7];
  }

  const fit = groups.map((g, gi) => {
    const i = node[gi];
    if (boundary[i] || split[i]) return null;
    // two rings of elements round the node, each ring on the same side of any jump line
    const ring1 = new Set(g.map((c) => Math.floor(c / 4)));
    const patch = new Set<number>(ring1);
    for (const e of ring1) for (let k = 0; k < 4; k++) for (const c of groups[groupOf[4 * e + k]]) patch.add(Math.floor(c / 4));
    const samples = [...patch];
    // normal equations of [1, X, Y, X², XY, Y²], X = (x − x_i)/h; a linear fit where too few samples span the square terms
    for (const terms of [6, 3]) {
      if (samples.length < terms + 1) continue;
      const P = samples.map((q) => basis((gpx[q] - m.x[i]) / h, (gpy[q] - m.y[i]) / h, terms));
      const A = new Float64Array(terms * terms);
      for (const r of P) for (let a = 0; a < terms; a++) for (let b = 0; b < terms; b++) A[terms * a + b] += r[a] * r[b];
      const inv = invert(A, terms);
      if (!inv) continue;
      const n = samples.length, op = new Float64Array(terms * n);
      P.forEach((r, q) => {
        for (let a = 0; a < terms; a++) {
          let v = 0;
          for (let b = 0; b < terms; b++) v += inv[terms * a + b] * r[b];
          op[a * n + q] = v;
        }
      });
      return { samples: Int32Array.from(samples), op, terms };
    }
    return null;
  });
  const from = groups.map((g, gi) => {
    if (fit[gi]) return [];
    const out = new Set<number>();
    for (const c of g) {
      const e = Math.floor(c / 4);
      for (let k = 0; k < 4; k++) {
        const j = groupOf[4 * e + k];
        if (j !== gi && fit[j]) out.add(j);
      }
    }
    return [...out];
  });
  return { groups, node, fit, from, h };
}

const basis = (X: number, Y: number, terms: number) => (terms === 6 ? [1, X, Y, X * X, X * Y, Y * Y] : [1, X, Y]);

/** Inverse of a small symmetric positive matrix (Gauss–Jordan), or null when it is nearly singular. */
function invert(A: Float64Array, n: number): Float64Array | null {
  const M = Float64Array.from(A), I = new Float64Array(n * n);
  for (let i = 0; i < n; i++) I[n * i + i] = 1;
  const scale = Math.max(...Array.from({ length: n }, (_, i) => Math.abs(A[n * i + i])));
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[n * r + c]) > Math.abs(M[n * p + c])) p = r;
    if (!(Math.abs(M[n * p + c]) > 1e-9 * scale)) return null;
    if (p !== c) for (let k = 0; k < n; k++) {
      [M[n * c + k], M[n * p + k]] = [M[n * p + k], M[n * c + k]];
      [I[n * c + k], I[n * p + k]] = [I[n * p + k], I[n * c + k]];
    }
    const d = M[n * c + c];
    for (let k = 0; k < n; k++) {
      M[n * c + k] /= d;
      I[n * c + k] /= d;
    }
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[n * r + c];
      if (!f) continue;
      for (let k = 0; k < n; k++) {
        M[n * r + k] -= f * M[n * c + k];
        I[n * r + k] -= f * I[n * c + k];
      }
    }
  }
  return I;
}

/** A fit's value and gradient (per h) at (X, Y). */
function evalFit(c: Float64Array, off: number, terms: number, X: number, Y: number): [number, number, number] {
  if (terms === 3) return [c[off] + c[off + 1] * X + c[off + 2] * Y, c[off + 1], c[off + 2]];
  return [
    c[off] + c[off + 1] * X + c[off + 2] * Y + c[off + 3] * X * X + c[off + 4] * X * Y + c[off + 5] * Y * Y,
    c[off + 1] + 2 * c[off + 3] * X + c[off + 4] * Y,
    c[off + 2] + c[off + 4] * X + 2 * c[off + 5] * Y,
  ];
}

/**
 * Recovered moments and shear forces per element corner, from the moments at the element
 * centres (3 per element: m_x, m_y, m_xy) and, for groups no patch reaches, the
 * extrapolated corner values.
 */
export function recover(m: PlateMesh, r: Recovery, centres: Float64Array, fallback: (corner: number) => ArrayLike<number>) {
  const nc = m.quads.length;
  const out = { mx: new Float64Array(nc), my: new Float64Array(nc), mxy: new Float64Array(nc), vx: new Float64Array(nc), vy: new Float64Array(nc) };
  // coefficients of each fit, per moment (m_x, m_y, m_xy: `terms` each)
  const coef = r.fit.map((f) => {
    if (!f) return null;
    const n = f.samples.length, T = f.terms, c = new Float64Array(3 * T);
    for (let comp = 0; comp < 3; comp++) {
      for (let a = 0; a < T; a++) {
        let s = 0;
        for (let q = 0; q < n; q++) s += f.op[a * n + q] * centres[3 * f.samples[q] + comp];
        c[T * comp + a] = s;
      }
    }
    return c;
  });
  r.groups.forEach((g, gi) => {
    const i = r.node[gi];
    // m_x, m_y, m_xy and their gradients (∂/∂X, ∂/∂Y per comp)
    let val = [0, 0, 0];
    let grad = [0, 0, 0, 0, 0, 0];
    const sources = coef[gi] ? [gi] : r.from[gi];
    if (sources.length) {
      for (const j of sources) {
        const c = coef[j]!, T = r.fit[j]!.terms, nj = r.node[j];
        const X = (m.x[i] - m.x[nj]) / r.h, Y = (m.y[i] - m.y[nj]) / r.h;
        for (let comp = 0; comp < 3; comp++) {
          const [v, gx, gy] = evalFit(c, T * comp, T, X, Y);
          val[comp] += v;
          grad[2 * comp] += gx;
          grad[2 * comp + 1] += gy;
        }
      }
      const k = sources.length;
      val = val.map((v) => v / k);
      grad = grad.map((v) => v / k);
    } else {
      // no patch near (a mesh of a few elements): the extrapolated moments, no shear
      for (const c of g) {
        const f = fallback(c);
        for (let comp = 0; comp < 3; comp++) val[comp] += f[comp] / g.length;
      }
    }
    // q_x = ∂m_x/∂x + ∂m_xy/∂y, q_y = ∂m_xy/∂x + ∂m_y/∂y (gradients per h)
    const qx = (grad[0] + grad[5]) / r.h, qy = (grad[4] + grad[3]) / r.h;
    for (const c of g) {
      out.mx[c] = val[0];
      out.my[c] = val[1];
      out.mxy[c] = val[2];
      out.vx[c] = qx;
      out.vy[c] = qy;
    }
  });
  return out;
}

/**
 * For each node, the element corners around it, grouped by the side of each jump line
 * through it (one group where none passes).
 */
export function cornerGroups(m: PlateMesh, jumps: [Pt, Pt][]): number[][] {
  const nn = m.x.length, ne = m.quads.length / 4;
  const around: number[][] = Array.from({ length: nn }, () => []);
  for (let e = 0; e < ne; e++) for (let k = 0; k < 4; k++) around[m.quads[4 * e + k]].push(4 * e + k);
  const span = Math.hypot(Math.max(...m.x) - Math.min(...m.x), Math.max(...m.y) - Math.min(...m.y));
  const tol = 1e-7 * span;
  const lines: [Pt, Pt][] = [];
  for (const [a, b] of jumps) if (Math.hypot(b[0] - a[0], b[1] - a[1]) > tol) lines.push([a, b]);
  const out: number[][] = [];
  for (let i = 0; i < nn; i++) {
    const corners = around[i];
    const through = lines.filter(([a, b]) => segmentDistance([m.x[i], m.y[i]], a, b).d <= tol);
    if (!through.length) {
      out.push(corners);
      continue;
    }
    const byKey = new Map<string, number[]>();
    for (const c of corners) {
      const e = Math.floor(c / 4);
      let cx = 0, cy = 0;
      for (let k = 0; k < 4; k++) {
        cx += m.x[m.quads[4 * e + k]] / 4;
        cy += m.y[m.quads[4 * e + k]] / 4;
      }
      const key = through.map(([a, b]) => ((b[0] - a[0]) * (cy - a[1]) - (b[1] - a[1]) * (cx - a[0]) > 0 ? '+' : '-')).join('');
      byKey.set(key, [...(byKey.get(key) ?? []), c]);
    }
    for (const g of byKey.values()) out.push(g);
  }
  return out;
}
