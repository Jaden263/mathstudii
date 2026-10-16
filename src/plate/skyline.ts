// The plate's system solver: K = L Lᵀ inside the envelope, as the beam solver does it, but
// numbered by mesh nodes (three unknowns each, together), assembled straight into one
// array (no sparse rows to fill first) and factorised there with the inner products
// unrolled, which halves the time of the factor on a plate mesh. The node
// numbering is the one of least envelope work among reverse Cuthill–McKee from a
// pseudo-peripheral node and sorts along x and y: on the eight-neighbour graph of a quad
// mesh RCM's fronts from a corner turn round it in an L, while a sort along the long side
// keeps the fronts as short as the short side (10 000 unknowns: 0.2 s instead of 0.4 s).

export interface Envelope {
  /** order[new] = old unknown. */
  order: Int32Array;
  /** First column of each row of L, and where the row starts in L (L[start[i] + j − first[i]]). */
  first: Int32Array;
  start: Int32Array;
  L: Float64Array;
}

/** Node adjacency of a quad mesh (nodes sharing an element). */
export function nodeGraph(nn: number, quads: Int32Array): Int32Array[] {
  const sets: Set<number>[] = Array.from({ length: nn }, () => new Set());
  for (let e = 0; e < quads.length / 4; e++) {
    for (let a = 0; a < 4; a++) for (let b = 0; b < 4; b++) if (a !== b) sets[quads[4 * e + a]].add(quads[4 * e + b]);
  }
  return sets.map((s) => Int32Array.from(s));
}

/** Σ (row length)² of the envelope of a node numbering: the factor's work, up to a constant. */
function work(adj: Int32Array[], order: ArrayLike<number>): number {
  const n = order.length, pos = new Int32Array(n);
  for (let i = 0; i < n; i++) pos[order[i]] = i;
  let w = 0;
  for (let i = 0; i < n; i++) {
    let f = i;
    for (const j of adj[order[i]]) f = Math.min(f, pos[j]);
    w += (i - f + 1) ** 2;
  }
  return w;
}

/** Breadth-first levels from a node; the last level and the depth. */
function levels(adj: Int32Array[], s: number, seen: Int32Array, mark: number): { last: number[]; depth: number; order: number[] } {
  let front = [s], depth = 0;
  const order = [s];
  seen[s] = mark;
  for (;;) {
    const next: number[] = [];
    for (const v of front) for (const w of adj[v]) if (seen[w] !== mark) {
      seen[w] = mark;
      next.push(w);
      order.push(w);
    }
    if (!next.length) return { last: front, depth, order };
    front = next;
    depth++;
  }
}

/** Reverse Cuthill–McKee per connected part, from a pseudo-peripheral node (George & Liu). */
function rcm(adj: Int32Array[]): number[] {
  const n = adj.length, done = new Uint8Array(n), seen = new Int32Array(n).fill(-1);
  const out: number[] = [];
  let mark = 0;
  for (let s0 = 0; s0 < n; s0++) {
    if (done[s0]) continue;
    let s = s0, lv = levels(adj, s, seen, mark++);
    for (let it = 0; it < 8; it++) {
      const cand = lv.last.reduce((a, b) => (adj[b].length < adj[a].length ? b : a));
      const l2 = levels(adj, cand, seen, mark++);
      if (l2.depth <= lv.depth) break;
      s = cand;
      lv = l2;
    }
    const queue = [s];
    done[s] = 1;
    for (let h = 0; h < queue.length; h++) {
      const v = queue[h];
      out.push(v);
      const nb = [...adj[v]].filter((w) => !done[w]).sort((a, b) => adj[a].length - adj[b].length);
      for (const w of nb) {
        done[w] = 1;
        queue.push(w);
      }
    }
  }
  return out.reverse();
}

/** The node numbering with the least envelope work. */
export function nodeOrder(adj: Int32Array[], x: ArrayLike<number>, y: ArrayLike<number>): number[] {
  const n = adj.length;
  const ids = [...Array(n).keys()];
  const candidates = [
    rcm(adj),
    [...ids].sort((p, q) => x[p] - x[q] || y[p] - y[q]),
    [...ids].sort((p, q) => y[p] - y[q] || x[p] - x[q]),
  ];
  let best = candidates[0], bw = Infinity;
  for (const c of candidates) {
    const w = work(adj, c);
    if (w < bw) {
      bw = w;
      best = c;
    }
  }
  return best;
}

/** A symmetric matrix stored as its lower envelope, rows from first[i] to i, ready to be factorised in place. */
export class EnvelopeMatrix {
  readonly start: Int32Array;
  readonly L: Float64Array;
  constructor(readonly first: Int32Array) {
    const n = first.length;
    this.start = new Int32Array(n + 1);
    for (let i = 0; i < n; i++) this.start[i + 1] = this.start[i] + (i - first[i] + 1);
    this.L = new Float64Array(this.start[n]);
  }

  get n(): number {
    return this.first.length;
  }

  /** Add v at (i, j) of the lower triangle (j ≤ i, inside the envelope). */
  add(i: number, j: number, v: number): void {
    this.L[this.start[i] + j - this.first[i]] += v;
  }
}

/**
 * K = L Lᵀ in place, or null when K is not positive definite (a mechanism); `fail.row`
 * then receives the unknown where it broke down.
 */
export function envelopeCholesky(K: EnvelopeMatrix, fail?: { row: number }): Envelope | null {
  const { first, start, L } = K, n = K.n;
  for (let i = 0; i < n; i++) {
    const fi = first[i], si = start[i] - fi;
    const diag = L[si + i];
    for (let j = fi; j <= i; j++) {
      const sj = start[j] - first[j];
      let s = L[si + j];
      let k = fi > first[j] ? fi : first[j];
      for (; k + 3 < j; k += 4) s -= L[si + k] * L[sj + k] + L[si + k + 1] * L[sj + k + 1] + L[si + k + 2] * L[sj + k + 2] + L[si + k + 3] * L[sj + k + 3];
      for (; k < j; k++) s -= L[si + k] * L[sj + k];
      if (j < i) L[si + j] = s / L[sj + j];
      else {
        // each pivot judged against its own diagonal (as the beam solver does)
        if (!(s > 1e-12 * diag)) {
          if (fail) fail.row = i;
          return null;
        }
        L[si + i] = Math.sqrt(s);
      }
    }
  }
  return { order: Int32Array.from({ length: n }, (_, i) => i), first, start, L };
}

/** Solve K x = b with the factor (b and x in the original numbering). */
export function envelopeSolve({ order, first, start, L }: Envelope, b: ArrayLike<number>): Float64Array {
  const n = order.length, y = new Float64Array(n);
  for (let i = 0; i < n; i++) y[i] = b[order[i]];
  for (let i = 0; i < n; i++) {
    const si = start[i] - first[i];
    let s = y[i];
    for (let k = first[i]; k < i; k++) s -= L[si + k] * y[k];
    y[i] = s / L[si + i];
  }
  for (let i = n - 1; i >= 0; i--) {
    const si = start[i] - first[i];
    const yi = (y[i] /= L[si + i]);
    for (let k = first[i]; k < i; k++) y[k] -= L[si + k] * yi;
  }
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[order[i]] = y[i];
  return x;
}
