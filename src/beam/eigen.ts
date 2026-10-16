// Symmetric linear algebra for buckling: Cholesky factorisation within the envelope of
// a banded matrix, Lanczos for the few largest eigenvalues, and the full eigen
// decomposition of a small symmetric matrix (Householder reduction to tridiagonal form,
// then the implicit QL algorithm, as in EISPACK tred2 / tql2).

/** A Cholesky factor A = L Lᵀ; row i of L is zero left of `first[i]` (the envelope of A). */
export interface Cholesky {
  L: number[][];
  first: number[];
}

/**
 * Cholesky factorisation within the envelope of A (fill-in stays inside it), or null
 * when A is not positive definite. With a banded ordering this costs n b², not n³.
 */
export function cholesky(A: number[][]): Cholesky | null {
  const n = A.length;
  const first = A.map((row, i) => {
    let j = 0;
    while (j < i && row[j] === 0) j++;
    return j;
  });
  const L = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  let scale = 1e-300;
  for (let i = 0; i < n; i++) scale = Math.max(scale, Math.abs(A[i][i]));
  for (let i = 0; i < n; i++) {
    const Li = L[i];
    for (let j = first[i]; j <= i; j++) {
      const Lj = L[j];
      let s = A[i][j];
      for (let k = Math.max(first[i], first[j]); k < j; k++) s -= Li[k] * Lj[k];
      if (j < i) Li[j] = s / Lj[j];
      else {
        if (!(s > 1e-12 * scale)) return null;
        Li[i] = Math.sqrt(s);
      }
    }
  }
  return { L, first };
}

/** Solve L x = b (forward substitution). */
export function forward({ L, first }: Cholesky, b: number[]): number[] {
  const n = b.length, x = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    let s = b[i];
    const Li = L[i];
    for (let k = first[i]; k < i; k++) s -= Li[k] * x[k];
    x[i] = s / Li[i];
  }
  return x;
}

/** Solve Lᵀ x = b (back substitution). */
export function backward({ L, first }: Cholesky, b: number[]): number[] {
  const x = [...b];
  for (let i = b.length - 1; i >= 0; i--) {
    const Li = L[i];
    x[i] /= Li[i];
    const xi = x[i];
    for (let k = first[i]; k < i; k++) x[k] -= Li[k] * xi;
  }
  return x;
}

/**
 * The largest `count` positive eigenvalues (descending) and their unit eigenvectors of
 * a symmetric operator, by Lanczos with full reorthogonalisation. Extreme eigenvalues
 * converge first, so a few dozen products usually do; it runs on to n steps (exact) if
 * needed.
 */
export function largestEigen(apply: (x: number[]) => number[], n: number, count: number): { values: number[]; vectors: number[][] } {
  if (!n) return { values: [], vectors: [] };
  const Q: number[][] = [];
  const alpha: number[] = [], beta: number[] = [];
  const dot = (a: number[], b: number[]) => a.reduce((s, v, i) => s + v * b[i], 0);
  // a start with every mode in it (no symmetry)
  let q = Array.from({ length: n }, (_, i) => 1 + 0.5 * Math.sin(1.7 * i + 0.3));
  let nq = Math.sqrt(dot(q, q));
  q = q.map((v) => v / nq);
  let ritz = { values: [] as number[], vectors: [] as number[][] };
  for (let j = 0; j < n; j++) {
    Q.push(q);
    const w = apply(q);
    alpha.push(dot(q, w));
    // w ⟂ all previous vectors, twice for safety (full reorthogonalisation)
    for (let pass = 0; pass < 2; pass++) for (const qi of Q) {
      const c = dot(qi, w);
      for (let k = 0; k < n; k++) w[k] -= c * qi[k];
    }
    nq = Math.sqrt(dot(w, w));
    const m = Q.length;
    const done = m === n || nq <= 1e-14 * Math.max(...alpha.map(Math.abs), 1e-300);
    if (done || (m >= Math.min(n, 12) && m % 4 === 0)) {
      // Ritz values from the tridiagonal T_m; residual of each pair = β_m |last component|
      const T = Array.from({ length: m }, (_, i) => Array.from({ length: m }, (_, k) => (i === k ? alpha[i] : k === i + 1 ? beta[i] : i === k + 1 ? beta[k] : 0)));
      const { values, vectors } = symmetricEigen(T);
      const top = Math.max(...values.map(Math.abs), 1e-300);
      const want: number[] = [];
      for (let i = m - 1; i >= 0 && want.length < count; i--) if (values[i] > 1e-10 * top) want.push(i);
      const converged = want.every((i) => nq * Math.abs(vectors[m - 1][i]) <= 1e-9 * top);
      if (done || (converged && (want.length === count || m >= Math.min(n, 60)))) {
        ritz = {
          values: want.map((i) => values[i]),
          vectors: want.map((i) => Array.from({ length: n }, (_, k) => Q.reduce((s, qv, r) => s + qv[k] * vectors[r][i], 0))),
        };
        break;
      }
    }
    beta.push(nq);
    q = w.map((v) => v / nq);
  }
  return ritz;
}

/**
 * Eigenvalues (ascending) and eigenvectors (columns of `vectors`, orthonormal) of a
 * symmetric matrix.
 */
export function symmetricEigen(A: number[][]): { values: number[]; vectors: number[][] } {
  const n = A.length;
  if (!n) return { values: [], vectors: [] };
  const V = A.map((row) => [...row]);
  const d = new Array<number>(n).fill(0), e = new Array<number>(n).fill(0);
  tred2(V, d, e);
  tql2(V, d, e);
  return { values: d, vectors: V };
}

/** Householder reduction to tridiagonal form: diagonal d, subdiagonal e, transforms in V. */
function tred2(V: number[][], d: number[], e: number[]): void {
  const n = d.length;
  for (let j = 0; j < n; j++) d[j] = V[n - 1][j];
  for (let i = n - 1; i > 0; i--) {
    // scale to avoid under/overflow
    let scale = 0, h = 0;
    for (let k = 0; k < i; k++) scale += Math.abs(d[k]);
    if (scale === 0) {
      e[i] = d[i - 1];
      for (let j = 0; j < i; j++) {
        d[j] = V[i - 1][j];
        V[i][j] = 0;
        V[j][i] = 0;
      }
    } else {
      // Householder vector
      for (let k = 0; k < i; k++) {
        d[k] /= scale;
        h += d[k] * d[k];
      }
      let f = d[i - 1];
      let g = Math.sqrt(h);
      if (f > 0) g = -g;
      e[i] = scale * g;
      h -= f * g;
      d[i - 1] = f - g;
      for (let j = 0; j < i; j++) e[j] = 0;
      // similarity transformation of the remaining columns
      for (let j = 0; j < i; j++) {
        f = d[j];
        V[j][i] = f;
        g = e[j] + V[j][j] * f;
        for (let k = j + 1; k <= i - 1; k++) {
          g += V[k][j] * d[k];
          e[k] += V[k][j] * f;
        }
        e[j] = g;
      }
      f = 0;
      for (let j = 0; j < i; j++) {
        e[j] /= h;
        f += e[j] * d[j];
      }
      const hh = f / (h + h);
      for (let j = 0; j < i; j++) e[j] -= hh * d[j];
      for (let j = 0; j < i; j++) {
        f = d[j];
        g = e[j];
        for (let k = j; k <= i - 1; k++) V[k][j] -= f * e[k] + g * d[k];
        d[j] = V[i - 1][j];
        V[i][j] = 0;
      }
    }
    d[i] = h;
  }
  // accumulate the transformations
  for (let i = 0; i < n - 1; i++) {
    V[n - 1][i] = V[i][i];
    V[i][i] = 1;
    const h = d[i + 1];
    if (h !== 0) {
      for (let k = 0; k <= i; k++) d[k] = V[k][i + 1] / h;
      for (let j = 0; j <= i; j++) {
        let g = 0;
        for (let k = 0; k <= i; k++) g += V[k][i + 1] * V[k][j];
        for (let k = 0; k <= i; k++) V[k][j] -= g * d[k];
      }
    }
    for (let k = 0; k <= i; k++) V[k][i + 1] = 0;
  }
  for (let j = 0; j < n; j++) {
    d[j] = V[n - 1][j];
    V[n - 1][j] = 0;
  }
  V[n - 1][n - 1] = 1;
  e[0] = 0;
}

/** Implicit QL on the tridiagonal (d, e), accumulating into V; then sort ascending. */
function tql2(V: number[][], d: number[], e: number[]): void {
  const n = d.length;
  for (let i = 1; i < n; i++) e[i - 1] = e[i];
  e[n - 1] = 0;
  let f = 0, tst1 = 0;
  const eps = 2 ** -52;
  for (let l = 0; l < n; l++) {
    // find a small subdiagonal element
    tst1 = Math.max(tst1, Math.abs(d[l]) + Math.abs(e[l]));
    let m = l;
    while (m < n) {
      if (Math.abs(e[m]) <= eps * tst1) break;
      m++;
    }
    // m = l: d[l] is an eigenvalue; otherwise iterate
    if (m > l) {
      let iter = 0;
      do {
        if (++iter > 60) throw new Error('Eigenvalues did not converge');
        // implicit shift
        let g = d[l];
        let p = (d[l + 1] - g) / (2 * e[l]);
        let r = Math.hypot(p, 1);
        if (p < 0) r = -r;
        d[l] = e[l] / (p + r);
        d[l + 1] = e[l] * (p + r);
        const dl1 = d[l + 1];
        let h = g - d[l];
        for (let i = l + 2; i < n; i++) d[i] -= h;
        f += h;
        // implicit QL transformation
        p = d[m];
        let c = 1, c2 = c, c3 = c, s = 0, s2 = 0;
        const el1 = e[l + 1];
        for (let i = m - 1; i >= l; i--) {
          c3 = c2;
          c2 = c;
          s2 = s;
          g = c * e[i];
          h = c * p;
          r = Math.hypot(p, e[i]);
          e[i + 1] = s * r;
          s = e[i] / r;
          c = p / r;
          p = c * d[i] - s * g;
          d[i + 1] = h + s * (c * g + s * d[i]);
          for (let k = 0; k < n; k++) {
            h = V[k][i + 1];
            V[k][i + 1] = s * V[k][i] + c * h;
            V[k][i] = c * V[k][i] - s * h;
          }
        }
        p = (-s * s2 * c3 * el1 * e[l]) / dl1;
        e[l] = s * p;
        d[l] = c * p;
      } while (Math.abs(e[l]) > eps * tst1);
    }
    d[l] += f;
    e[l] = 0;
  }
  // selection sort, ascending, with the vectors
  for (let i = 0; i < n - 1; i++) {
    let k = i, p = d[i];
    for (let j = i + 1; j < n; j++) if (d[j] < p) { k = j; p = d[j]; }
    if (k !== i) {
      d[k] = d[i];
      d[i] = p;
      for (let j = 0; j < n; j++) [V[j][i], V[j][k]] = [V[j][k], V[j][i]];
    }
  }
}
