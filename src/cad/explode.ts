// Exploded views. Each occurrence moves out by its own offset (a direction and a distance)
// plus the offsets of the occurrences the joint tree hangs it on, so what a joint carries
// goes out with it. Auto explode gives every occurrence a joint placed an offset along
// that joint's axis, away from its parent, far enough for the two to come apart.
import type { ExplodeOffset } from './assembly';
import type { BuildResult } from './buildResult';
import type { CadDesign, DesignNumbers, Placement } from './design';
import type { KinState } from './kinematics';
import { m4Mul, m4Point, m4Translate, norm3, type M4, type Vec3 } from './solid';

/** How far each occurrence moves out (assembly coordinates), `k` of the way (0: assembled, 1: exploded). */
export function explodeShifts(design: CadDesign, parent: KinState['parent'] | undefined, params: DesignNumbers['params'], k = 1): Record<string, Vec3> {
  const own = (id: string): Vec3 => {
    const o = design.occurrences.find((q) => q.id === id)?.explode;
    const d = params[id]?.explode;
    if (!o || !Number.isFinite(d)) return [0, 0, 0];
    const u = norm3(o.dir);
    return [u[0] * d * k, u[1] * d * k, u[2] * d * k];
  };
  const out: Record<string, Vec3> = {};
  const total = (id: string, seen: Set<string>): Vec3 => {
    if (out[id]) return out[id];
    const p = parent?.[id]?.occ;
    const up = p && !seen.has(p) ? total(p, seen.add(id)) : [0, 0, 0];
    const s = own(id);
    return (out[id] = [s[0] + up[0], s[1] + up[1], s[2] + up[2]]);
  };
  for (const o of design.occurrences) total(o.id, new Set());
  return out;
}

/** The placements moved out by the shifts. */
export function explodedPlacements(placements: Record<string, Placement>, shifts: Record<string, Vec3>): Record<string, Placement> {
  const out: Record<string, Placement> = {};
  for (const [id, p] of Object.entries(placements)) {
    const s = shifts[id];
    out[id] = s && (s[0] || s[1] || s[2]) ? { ...p, matrix: m4Mul(m4Translate(s), p.matrix) } : p;
  }
  return out;
}

/** The box of an occurrence's bodies in the assembly (the corners of each body's box placed). */
export function occurrenceBox(build: BuildResult, design: CadDesign, occ: string, M: M4): { min: Vec3; max: Vec3 } | null {
  const o = design.occurrences.find((q) => q.id === occ);
  const bodies = (o && build.components[o.component]?.bodies) ?? [];
  let box: { min: Vec3; max: Vec3 } | null = null;
  for (const b of bodies) {
    if (!b.box) continue;
    for (let c = 0; c < 8; c++) {
      const p = m4Point(M, [c & 1 ? b.box.max[0] : b.box.min[0], c & 2 ? b.box.max[1] : b.box.min[1], c & 4 ? b.box.max[2] : b.box.min[2]]);
      if (!box) box = { min: [...p], max: [...p] };
      for (let i = 0; i < 3; i++) {
        box.min[i] = Math.min(box.min[i], p[i]);
        box.max[i] = Math.max(box.max[i], p[i]);
      }
    }
  }
  return box;
}

const centre = (b: { min: Vec3; max: Vec3 }): Vec3 => [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
/** Half the extent of a box along a unit direction. */
const half = (b: { min: Vec3; max: Vec3 }, u: Vec3) => [0, 1, 2].reduce((s, i) => s + (Math.abs(u[i]) * (b.max[i] - b.min[i])) / 2, 0);
const nice = (v: number) => +v.toPrecision(2);

/**
 * Offsets that explode an assembly along its joints: every occurrence a joint placed moves
 * along the joint's Z axis, away from its parent, until the two stand apart with a gap of
 * a fifth of their sizes along it.
 */
export function autoExplode(design: CadDesign, build: BuildResult, kin: KinState): Record<string, ExplodeOffset> {
  const out: Record<string, ExplodeOffset> = {};
  for (const o of design.occurrences) {
    const up = kin.parent[o.id];
    const j = up && kin.model.joints.find((q) => q.id === up.joint);
    const Mc = build.placements[o.id]?.matrix, Mp = up && build.placements[up.occ]?.matrix;
    if (!up || !j || !Mc || !Mp) continue;
    // the joint's Z on the parent's side, in the assembly
    const F = m4Mul(Mp, up.occ === j.a ? j.Fa : j.Fb);
    let u = norm3([F[8], F[9], F[10]]);
    const bc = occurrenceBox(build, design, o.id, Mc), bp = occurrenceBox(build, design, up.occ, Mp);
    if (!bc || !bp) continue;
    const cc = centre(bc), cp = centre(bp);
    const sep = (cc[0] - cp[0]) * u[0] + (cc[1] - cp[1]) * u[1] + (cc[2] - cp[2]) * u[2];
    if (sep < 0) u = [-u[0], -u[1], -u[2]];
    const S = half(bc, u) + half(bp, u);
    if (!(S > 0)) continue;
    out[o.id] = { dir: u.map((v) => +v.toFixed(9)) as Vec3, d: String(nice(Math.max(0.2 * S, 1.2 * S - Math.abs(sep)))) };
  }
  return out;
}

/** Trails: from where each moved occurrence's centre is assembled to where it is exploded. */
export function explodeTrails(build: BuildResult, design: CadDesign, placements: Record<string, Placement>, shifts: Record<string, Vec3>): Float32Array {
  const out: number[] = [];
  for (const o of design.occurrences) {
    const s = shifts[o.id], M = placements[o.id]?.matrix;
    if (o.hidden || !s || !M || Math.hypot(...s) === 0) continue;
    const b = occurrenceBox(build, design, o.id, M);
    if (!b) continue;
    const c = centre(b);
    out.push(...c, c[0] + s[0], c[1] + s[1], c[2] + s[2]);
  }
  return new Float32Array(out);
}
