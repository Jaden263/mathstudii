// Sparse symmetric positive definite systems with many right-hand sides (influence
// lines): the matrix is assembled by rows, numbered by reverse Cuthill–McKee so its
// nonzeros stay near the diagonal, and factorised once as K = L Lᵀ inside that envelope
// (a skyline: row i of L is stored from its first nonzero on). Every load position is
// then one forward and one back substitution, n·b work instead of n³.

/** A symmetric matrix by rows; both triangles are stored. */
export class SparseSym {
  readonly rows: Map<number, number>[];
  constructor(readonly n: number) {
    this.rows = Array.from({ length: n }, () => new Map<number, number>());
  }

  add(i: number, j: number, v: number): void {
    if (!v) return;
    const r = this.rows[i];
    r.set(j, (r.get(j) ?? 0) + v);
  }
}

/** K = L Lᵀ in the numbering `order` (order[new] = old); row i of L covers columns first[i] … i. */
export interface Skyline {
  order: Int32Array;
  first: Int32Array;
  L: Float64Array[];
}

/**
 * Reverse Cuthill–McKee: breadth first from an unknown of least degree, neighbours by
 * increasing degree, then reversed. Keeps the envelope of a frame's stiffness narrow.
 */
export function bandOrder(adj: number[][]): number[] {
  const n = adj.length;
  const seen = new Array<boolean>(n).fill(false);
  const order: number[] = [];
  while (order.length < n) {
    let s = -1;
    for (let i = 0; i < n; i++) if (!seen[i] && (s < 0 || adj[i].length < adj[s].length)) s = i;
    seen[s] = true;
    const queue = [s];
    for (let h = 0; h < queue.length; h++) {
      const v = queue[h];
      order.push(v);
      for (const w of adj[v].filter((x) => !seen[x]).sort((x, y) => adj[x].length - adj[y].length)) {
        seen[w] = true;
        queue.push(w);
      }
    }
  }
  return order.reverse();
}

/** Cholesky factor within the envelope, or null when K is not positive definite (a mechanism). */
export function skylineCholesky(K: SparseSym): Skyline | null {
  const n = K.n;
  const adj = K.rows.map((r, i) => [...r.keys()].filter((j) => j !== i));
  const order = Int32Array.from(bandOrder(adj));
  const inv = new Int32Array(n);
  order.forEach((o, i) => (inv[o] = i));
  const first = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    let f = i;
    for (const j of K.rows[order[i]].keys()) f = Math.min(f, inv[j]);
    first[i] = f;
  }
  // (each pivot is judged against its own diagonal, as in eigen.ts cholesky)
  const L: Float64Array[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const fi = first[i];
    const Li = new Float64Array(i - fi + 1);
    const row = K.rows[order[i]];
    for (const [j, v] of row) {
      const c = inv[j];
      if (c <= i) Li[c - fi] = v;
    }
    for (let j = fi; j <= i; j++) {
      const Lj = j < i ? L[j] : Li, fj = first[j];
      let s = Li[j - fi];
      for (let k = Math.max(fi, fj); k < j; k++) s -= Li[k - fi] * Lj[k - fj];
      if (j < i) Li[j - fi] = s / Lj[j - fj];
      else {
        if (!(s > 1e-12 * (row.get(order[i]) ?? 0))) return null;
        Li[i - fi] = Math.sqrt(s);
      }
    }
    L[i] = Li;
  }
  return { order, first, L };
}

/** Solve K x = b with the factor (b and x in the original numbering). */
export function skylineSolve({ order, first, L }: Skyline, b: ArrayLike<number>): Float64Array {
  const n = order.length;
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const Li = L[i], fi = first[i];
    let s = b[order[i]];
    for (let k = fi; k < i; k++) s -= Li[k - fi] * y[k];
    y[i] = s / Li[i - fi];
  }
  for (let i = n - 1; i >= 0; i--) {
    const Li = L[i], fi = first[i];
    y[i] /= Li[i - fi];
    const yi = y[i];
    for (let k = fi; k < i; k++) y[k] -= Li[k - fi] * yi;
  }
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[order[i]] = y[i];
  return x;
}
