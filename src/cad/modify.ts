// What the modify features (fillet, chamfer, shell, draft, press-pull) need besides the
// kernel: how large a rounding an edge takes, which face a chamfer's first distance is
// measured on, and the words of their messages. Kernel-neutral: it reads the named
// topology of a body (topology.ts), whichever kernel made it.
import type { DesignItem } from './design';
import { dot3, len3, norm3, scale3, sub3, type Vec3 } from './solid';
import type { BodyTopology } from './topology';

/** How far a flat face reaches from a straight edge of it, square to the edge (its farthest corner). */
function reach(b: BodyTopology, face: number, a: Vec3, d: Vec3): number {
  let m = 0;
  for (const e of b.edges) {
    if (!e.faces.includes(face)) continue;
    for (const vi of e.v) {
      const v = b.vertices[vi];
      if (!v) continue;
      const w = sub3(v.p, a);
      m = Math.max(m, len3(sub3(w, scale3(d, dot3(w, d)))));
    }
  }
  return m;
}

/**
 * About the largest roundings a straight edge between two flat faces takes, on each of the
 * two faces (in the order of `edge.faces`). A fillet of radius r meets a face r·cot(φ/2)
 * from the edge (φ the angle between the faces, 90° on a box: r), a chamfer at its distance;
 * that point must stay on the face, inside its farthest corner from the edge. Null where
 * it cannot say (curved edges or faces, a seam).
 */
export function edgeRoom(b: BodyTopology, edge: number): { reach: [number, number]; phi: number } | null {
  const e = b.edges[edge];
  if (!e?.line || e.faces[0] === e.faces[1]) return null;
  const fa = b.faces[e.faces[0]], fb = b.faces[e.faces[1]];
  if (!fa?.frame || !fb?.frame) return null;
  const d = norm3(sub3(e.line.b, e.line.a));
  const phi = Math.PI - Math.acos(Math.max(-1, Math.min(1, dot3(fa.frame.n, fb.frame.n))));
  return { reach: [reach(b, e.faces[0], e.line.a, d), reach(b, e.faces[1], e.line.a, d)], phi };
}

/** The largest fillet radius an edge takes (≈), or null. */
export function filletLimit(b: BodyTopology, edge: number): number | null {
  const room = edgeRoom(b, edge);
  return room && Math.min(...room.reach) * Math.tan(room.phi / 2);
}

/** The face of an edge a chamfer's first distance (and its angle) is measured on: the one first by name, or the other one. */
export function chamferFace(b: BodyTopology, edge: number, flip = false): number | undefined {
  const e = b.edges[edge];
  if (!e || e.faces[0] < 0 || e.faces[1] < 0 || e.faces[0] === e.faces[1]) return undefined;
  const [f0, f1] = e.faces;
  const first = (b.faces[f0]?.key ?? '') <= (b.faces[f1]?.key ?? '') ? f0 : f1;
  return flip ? (first === f0 ? f1 : f0) : first;
}

/**
 * The chamfer distance an edge takes on each side (≈): on `face` (where d is measured) and on
 * the other one, or null.
 */
export function chamferLimit(b: BodyTopology, edge: number, face: number | undefined): { own: number; other: number } | null {
  const room = edgeRoom(b, edge);
  if (!room) return null;
  const e = b.edges[edge];
  const k = face === e.faces[1] ? 1 : 0;
  return { own: room.reach[k], other: room.reach[1 - k] };
}

/** A length in a message: "12 mm". */
export const sizeWords = (v: number, unit?: string) => `${+v.toPrecision(4)}${unit ? ` ${unit}` : ''}`;

const CANNOT: Partial<Record<DesignItem['kind'], string>> = {
  fillet: 'round edges', chamfer: 'chamfer edges', shell: 'hollow bodies', draft: 'draft faces', presspull: 'move faces',
};

/** What a feature only the B-rep kernel makes says while the mesh kernel builds the part. */
export function needsBrep(kind: DesignItem['kind']): string {
  return `needs the B-rep kernel: OpenCascade has not loaded, and the mesh kernel cannot ${CANNOT[kind] ?? 'do this'}`;
}
