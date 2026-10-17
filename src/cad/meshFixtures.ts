// Meshes for the import and export tests: a box and a UV sphere as triangle soups, and
// the volume of that sphere's polyhedron by hand.
const { PI, sin, cos } = Math;

/** Triangles of an axis-aligned box from the origin, counter-clockwise from outside. */
export function boxTriangles(a: number, b: number, c: number): number[][] {
  const v = (i: number) => [i & 1 ? a : 0, i & 2 ? b : 0, i & 4 ? c : 0];
  // each face as two triangles, corners by bit (x 1, y 2, z 4)
  const quads = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]];
  return quads.flatMap(([p, q, r, s]) => [[...v(p), ...v(q), ...v(r)], [...v(p), ...v(r), ...v(s)]]);
}

/** A UV sphere of radius r: n segments round, m bands from pole to pole (triangles to the poles). */
export function uvSphere(r: number, n: number, m: number): number[][] {
  // the poles and the seam exactly the same points wherever they are reached from
  const P = (i: number, j: number) => {
    if (i === 0 || i === m) return [0, 0, i ? -r : r];
    const th = (PI * i) / m, ph = (2 * PI * (j % n)) / n;
    return [r * sin(th) * cos(ph), r * sin(th) * sin(ph), r * cos(th)];
  };
  const out: number[][] = [];
  for (let i = 0; i < m; i++) for (let j = 0; j < n; j++) {
    const a = P(i, j), b = P(i + 1, j), c = P(i + 1, j + 1), d = P(i, j + 1);
    if (i > 0) out.push([...a, ...b, ...d]);
    if (i < m - 1) out.push([...d, ...b, ...c]);
  }
  return out;
}

/**
 * The volume of that UV sphere, by hand: each band is a frustum of a regular n-gonal pyramid
 * between parallel n-gons of radii ρ = r sin θ (area n/2 ρ² sin(2π/n)), V = h/3 (A₁ + A₂ + √(A₁A₂));
 * the end bands are pyramids. (Its quads are planar: isosceles trapezoids between aligned n-gons.)
 */
export function uvSphereVolume(r: number, n: number, m: number): number {
  let V = 0;
  for (let i = 0; i < m; i++) {
    const t0 = (PI * i) / m, t1 = (PI * (i + 1)) / m;
    const A0 = (n / 2) * (r * sin(t0)) ** 2 * sin((2 * PI) / n), A1 = (n / 2) * (r * sin(t1)) ** 2 * sin((2 * PI) / n);
    V += (Math.abs(r * cos(t0) - r * cos(t1)) / 3) * (A0 + A1 + Math.sqrt(A0 * A1));
  }
  return V;
}

