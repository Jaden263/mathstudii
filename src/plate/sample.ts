// Values of a plate's results anywhere on it: the element holding a point (a bucket grid,
// then the inverse of the bilinear map) and the bilinear interpolation of its corner
// values. Used by the worksheet functions p.w(x, y) … and by the page (hover, section cut).
import { inverseMap, shape } from './mitc4';
import { ElementIndex, elementXY, type PlateMesh } from './mesh';

export interface PlateSpot {
  e: number;
  N: [number, number, number, number];
}

export class PlateSampler {
  private readonly index: ElementIndex;
  constructor(readonly mesh: PlateMesh) {
    this.index = new ElementIndex(mesh);
  }

  /** The element holding (x, y) and the shape functions there, or null off the plate. */
  locate(x: number, y: number): PlateSpot | null {
    let best: { e: number; xi: number; eta: number; out: number } | null = null;
    for (const e of this.index.candidates(x, y)) {
      const nat = inverseMap(elementXY(this.mesh, e), x, y);
      if (!nat) continue;
      // how far outside the element (0 inside): a point on a shared edge or a hair outside the boundary still counts
      const out = Math.max(0, Math.abs(nat[0]) - 1, Math.abs(nat[1]) - 1);
      if (!best || out < best.out) best = { e, xi: nat[0], eta: nat[1], out };
      if (out === 0) break;
    }
    if (!best || best.out > 1e-6) return null;
    const xi = Math.max(-1, Math.min(1, best.xi)), eta = Math.max(-1, Math.min(1, best.eta));
    return { e: best.e, N: shape(xi, eta) };
  }

  /** A field given per element corner (4 per element). */
  corner(field: ArrayLike<number>, s: PlateSpot): number {
    return s.N[0] * field[4 * s.e] + s.N[1] * field[4 * s.e + 1] + s.N[2] * field[4 * s.e + 2] + s.N[3] * field[4 * s.e + 3];
  }

  /** A field given per node. */
  nodal(field: ArrayLike<number>, s: PlateSpot): number {
    const q = this.mesh.quads;
    return s.N[0] * field[q[4 * s.e]] + s.N[1] * field[q[4 * s.e + 1]] + s.N[2] * field[q[4 * s.e + 2]] + s.N[3] * field[q[4 * s.e + 3]];
  }
}
