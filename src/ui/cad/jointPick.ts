// Joint origins picked on the model, as in Fusion: hovering a face or edge shows its snap
// points (face centres, axes, circle centres, edge midpoints, vertices, and the sketch
// points on a flat face) as small glyphs, the one nearest the pointer marked with its Z
// axis; a click takes that one. Snap points on geometry follow it through rebuilds.
import type { BodyResult } from '../../cad/buildResult';
import { findSketch, isSketch, type CadDesign, type JointOrigin } from '../../cad/design';
import type { DesignResult } from '../../cad/evaluate';
import { snapsOn } from '../../cad/snaps';
import { cross3, dot3, framePoint, frameFromNormal, len3, m4Dir, m4Point, norm3, sub3, type M4, type Vec3 } from '../../cad/solid';
import type { SceneLines } from './Scene3D';

/** A place a joint origin can go: where it is (component coordinates), its Z axis, what it is. */
export interface JointCandidate {
  origin: JointOrigin;
  o: Vec3;
  z: Vec3;
  label: string;
}

/**
 * The joint origins on a face or edge of a body: its snap points, and on a flat face the
 * points and circle centres of the component's sketches that lie in it (Z out of the face).
 */
export function jointCandidates(design: CadDesign, dr: DesignResult | undefined, componentId: string, b: BodyResult, at: { face?: number; edge?: number }, len: (v: number) => string): JointCandidate[] {
  const out: JointCandidate[] = snapsOn(b, at, len).map((s) => ({ origin: { kind: 'snap', ...s }, o: s.o, z: s.z, label: s.label }));
  const f = at.edge === undefined && at.face !== undefined ? b.faces[at.face] : undefined;
  if (!f?.frame || !dr) return out;
  const size = b.box ? len3(sub3(b.box.max, b.box.min)) : 1;
  const comp = design.components.find((c) => c.id === componentId);
  for (const s of comp?.items.filter(isSketch) ?? []) {
    const fr = dr.frames[s.id], sol = dr.sketches[s.id];
    // a sketch in the face's plane, facing the same way: its normal is the joint's Z
    if (!fr || !sol || dot3(fr.n, f.frame.n) < 1 - 1e-9 || Math.abs(dot3(sub3(fr.o, f.frame.o), f.frame.n)) > 1e-6 * size) continue;
    const seen = new Set<string>();
    for (const e of findSketch(design, s.id)!.sketch.entities) {
      const pid = e.type === 'point' ? e.p : e.type === 'circle' || e.type === 'arc' ? e.c : null;
      const q = pid && sol.points[pid];
      if (!pid || !q || seen.has(pid)) continue;
      seen.add(pid);
      out.push({ origin: { kind: 'point', sketch: s.id, point: pid, axis: 'n' }, o: framePoint(fr, { x: q[0], y: q[1] }), z: fr.n, label: `${e.type === 'point' ? 'point' : `${e.type} centre`} of ${s.name}` });
    }
  }
  return out;
}

/** The candidate nearest to a point (component coordinates), or -1. */
export function nearestCandidate(cands: JointCandidate[], p: Vec3): number {
  let best = -1, d = Infinity;
  cands.forEach((c, i) => {
    const q = len3(sub3(c.o, p));
    if (q < d) [best, d] = [i, q];
  });
  return best;
}

/** A circle of radius r about c, square to z, as line segments. */
function ring(c: Vec3, z: Vec3, r: number, n = 20): number[] {
  const f = frameFromNormal(c, z);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n, b = (2 * Math.PI * (i + 1)) / n;
    out.push(...framePoint(f, { x: r * Math.cos(a), y: r * Math.sin(a) }), ...framePoint(f, { x: r * Math.cos(b), y: r * Math.sin(b) }));
  }
  return out;
}

/**
 * The glyphs of the candidates in the assembly (placed by M): small rings, the chosen
 * one larger with a dot and its Z axis, as Fusion draws joint origins.
 */
export function candidateGlyphs(cands: JointCandidate[], best: number, M: M4, size: number): SceneLines[] {
  const r = size * 0.011;
  const others: number[] = [], chosen: number[] = [];
  cands.forEach((c, i) => {
    const o = m4Point(M, c.o), z = norm3(m4Dir(M, c.z));
    if (i !== best) {
      others.push(...ring(o, z, r, 12));
      return;
    }
    chosen.push(...ring(o, z, r * 1.8), ...ring(o, z, r * 0.35, 8));
    // the Z axis, with an arrow head
    const tip: Vec3 = [o[0] + z[0] * size * 0.07, o[1] + z[1] * size * 0.07, o[2] + z[2] * size * 0.07];
    const side = norm3(cross3(z, frameFromNormal(o, z).u));
    const back = (k: number): Vec3 => [tip[0] - z[0] * r * 2 + side[0] * r * k, tip[1] - z[1] * r * 2 + side[1] * r * k, tip[2] - z[2] * r * 2 + side[2] * r * k];
    chosen.push(...o, ...tip, ...tip, ...back(1), ...tip, ...back(-1));
  });
  const out: SceneLines[] = [];
  if (others.length) out.push({ key: 'snaps', segments: new Float32Array(others), color: [0.5, 0.56, 0.66], overlay: true });
  if (chosen.length) out.push({ key: 'snap', segments: new Float32Array(chosen), color: [0.95, 0.6, 0.05], overlay: true });
  return out;
}
