// Where the joints put the occurrences. Each joint lets its moving side turn and slide on
// the parent's joint frame by the DOFs of its type (assembly.ts); a DOF is driven (its
// value is a worksheet expression) or solved by the assembly. Motion links make one DOF
// follow another, limits stop a DOF, rigid groups lock occurrences together.
//
// The joints form a graph over the occurrences. A spanning tree from the grounded ones
// carries the placements along, joint after joint, exactly as before there were loops: an
// assembly without loops places its parts the way it always has. Every joint left over
// closes a loop (a four-bar linkage, a slider-crank). How far its two frames are from where
// its motion wants them is its residual, driven to zero by damped Gauss–Newton
// (Levenberg–Marquardt) on the solved DOFs of the loop. The solve follows the mechanism in
// small steps from where it was assembled (or from the previous frame of a motion) to the
// driven values, so it stays on its branch: a four-bar does not snap from open to crossed.
import type { CadDesign, DesignNumbers, JointType, Placement } from './design';
import { JOINT_DOFS, dofWord, isAngleDof, type DofKey } from './assembly';
import { IDENTITY, m4Inv, m4Mul, m4Pose, m4Rotate, m4Translate, type M4, type Vec3 } from './solid';

export type DofValues = Partial<Record<DofKey, number>>;

/** A joint as the solver sees it: its frames on both sides and its values. */
export interface KinJoint {
  id: string;
  name: string;
  type: JointType;
  /** Occurrences: the parent side and the side that moves onto it. */
  a: string;
  b: string;
  Fa: M4;
  Fb: M4;
  flip?: boolean;
  /** Every value (radians, part units), as the worksheet gives it. */
  q: Record<DofKey, number>;
  /** Motion DOFs the assembly solves. */
  free: DofKey[];
  min: DofValues;
  max: DofValues;
  rest: DofValues;
  /** A member of a rigid group (its problems are the group's). */
  group?: string;
}

/** b = ratio · a + offset (radians and part units). */
export interface KinLink {
  id: string;
  name: string;
  a: { joint: string; dof: DofKey };
  b: { joint: string; dof: DofKey };
  ratio: number;
  offset: number;
}

/** Everything the placement needs, as plain numbers (it travels between windows). */
export interface KinModel {
  occs: { id: string; pose: M4; grounded?: boolean }[];
  joints: KinJoint[];
  links: KinLink[];
  /** A length of the assembly's size: tolerances and steps are relative to it. */
  size: number;
  unit?: string;
}

export interface KinSolution {
  placements: Record<string, Placement>;
  /** The motion DOFs of every joint as placed (solved ones as found, driven ones where they stopped). */
  values: Record<string, DofValues>;
  errors: Record<string, string>;
  warnings: Record<string, string>;
  /** For each occurrence a joint placed: that joint and the occurrence on its other side. */
  parent: Record<string, { occ: string; joint: string }>;
  /** DOFs the closed loops leave undetermined (they stay where they started). */
  mobility: number;
}

/** A placement and the model it came from (UI drives, motion studies and exploded views solve it again). */
export interface KinState {
  model: KinModel;
  values: Record<string, DofValues>;
  parent: Record<string, { occ: string; joint: string }>;
  mobility: number;
}

export interface SolveOptions {
  /** Driven values instead of the document's (a drive dialog, a frame of a motion study). */
  drive?: Record<string, DofValues>;
  /** The configuration to go on from (the previous frame): driven and solved values. */
  from?: Record<string, DofValues>;
}

const ZERO: Record<DofKey, number> = { angle: 0, angle2: 0, angle3: 0, offset: 0, x: 0, y: 0 };
const ORIGIN: Vec3 = [0, 0, 0];

/**
 * A joint's motion in the parent's joint frame: to (x, y, offset), turned about Z by the
 * angle, then about the turned Y and X (a ball's pitch and roll); flipped, turned over.
 */
export function motionMatrix(q: DofValues, flip?: boolean): M4 {
  let M = m4Mul(m4Translate([q.x ?? 0, q.y ?? 0, q.offset ?? 0]), m4Rotate(ORIGIN, [0, 0, 1], q.angle ?? 0));
  // left out when 0, so joints of the first four types place exactly as they always have
  if (q.angle2) M = m4Mul(M, m4Rotate(ORIGIN, [0, 1, 0], q.angle2));
  if (q.angle3) M = m4Mul(M, m4Rotate(ORIGIN, [1, 0, 0], q.angle3));
  if (flip) M = m4Mul(M, m4Rotate(ORIGIN, [1, 0, 0], Math.PI));
  return M;
}

/**
 * An as-built joint's origin on the far occurrence: where the picked origin (frame F on the
 * occurrence placed by Mpick) is now, in the far occurrence's coordinates (placed by Mfar).
 * With every value 0 the joint then holds the two as they stand.
 */
export function asBuiltOrigin(Mfar: M4, Mpick: M4, F: M4): { kind: 'frame'; o: Vec3; z: Vec3; x: Vec3 } {
  const L = m4Mul(m4Inv(Mfar), m4Mul(Mpick, F));
  return { kind: 'frame', o: [L[12], L[13], L[14]], z: [L[8], L[9], L[10]], x: [L[0], L[1], L[2]] };
}

/** Angle of the rotation between two frames (radians). */
function rotationGap(T: M4, W: M4): number {
  // trace of Wᵀ·T = 1 + 2 cos α
  let tr = 0;
  for (let i = 0; i < 3; i++) for (let k = 0; k < 3; k++) tr += W[4 * i + k] * T[4 * i + k];
  return Math.acos(Math.max(-1, Math.min(1, (tr - 1) / 2)));
}

// ------------------------------------------------------------ small dense linear algebra

/** x with A·x = b (Gaussian elimination, partial pivoting); null when A is singular. */
function solveLinear(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (!(Math.abs(M[p][c]) > 1e-300)) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / M[c][c];
      if (f) for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / M[r][r];
  }
  return x;
}

/** Rank of a matrix (m rows of n), by elimination with complete pivoting. */
export function rankOf(J: number[][], tol = 1e-8): number {
  const A = J.map((r) => [...r]);
  const m = A.length, n = m ? A[0].length : 0;
  const big = Math.max(0, ...A.flat().map(Math.abs));
  let rank = 0;
  const usedR = new Set<number>(), usedC = new Set<number>();
  for (;;) {
    let best = 0, br = -1, bc = -1;
    for (let r = 0; r < m; r++) if (!usedR.has(r)) for (let c = 0; c < n; c++) if (!usedC.has(c) && Math.abs(A[r][c]) > best) [best, br, bc] = [Math.abs(A[r][c]), r, c];
    if (br < 0 || best <= tol * Math.max(big, 1e-300)) return rank;
    usedR.add(br);
    usedC.add(bc);
    rank++;
    for (let r = 0; r < m; r++) {
      if (usedR.has(r)) continue;
      const f = A[r][bc] / A[br][bc];
      if (f) for (let c = 0; c < n; c++) A[r][c] -= f * A[br][c];
    }
  }
}

/** Central-difference Jacobian of f at x (unknowns of size about 1). */
function jacobian(f: (x: number[]) => number[], x: number[], m: number): number[][] {
  const J = Array.from({ length: m }, () => new Array<number>(x.length).fill(0));
  const h = 1e-6;
  for (let i = 0; i < x.length; i++) {
    const xp = [...x], xm = [...x];
    xp[i] += h;
    xm[i] -= h;
    const rp = f(xp), rm = f(xm);
    for (let k = 0; k < m; k++) J[k][i] = (rp[k] - rm[k]) / (2 * h);
  }
  return J;
}

const normInf = (r: number[]) => r.reduce((s, v) => Math.max(s, Math.abs(v)), 0);

/**
 * Levenberg–Marquardt on r(x) = 0 (Nielsen's damping update). Rank-deficient problems
 * (a planar linkage's redundant constraints in space) take the damped step, which leaves
 * the undetermined directions alone.
 */
export function levenbergMarquardt(f: (x: number[]) => number[], x0: number[], tol = 1e-13, maxIt = 80): { x: number[]; r: number[]; it: number } {
  let x = [...x0], r = f(x);
  if (!x.length || normInf(r) < tol) return { x, r, it: 0 };
  let cost = r.reduce((s, v) => s + v * v, 0) / 2;
  let mu = -1, nu = 2;
  let it = 0;
  for (; it < maxIt; it++) {
    const J = jacobian(f, x, r.length);
    const n = x.length;
    const A = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, k) => J.reduce((s, row) => s + row[i] * row[k], 0)));
    const g = Array.from({ length: n }, (_, i) => J.reduce((s, row, q) => s + row[i] * r[q], 0));
    if (mu < 0) mu = 1e-3 * Math.max(1e-12, ...A.map((row, i) => row[i]));
    if (normInf(g) < 1e-300) break;
    let accepted = false;
    for (let tries = 0; tries < 30 && !accepted; tries++) {
      const d = solveLinear(A.map((row, i) => row.map((v, k) => (i === k ? v + mu : v))), g.map((v) => -v));
      if (!d) {
        mu *= nu;
        nu *= 2;
        continue;
      }
      const xn = x.map((v, i) => v + d[i]);
      const rn = f(xn);
      const cn = rn.reduce((s, v) => s + v * v, 0) / 2;
      const pred = d.reduce((s, v, i) => s + v * (mu * v - g[i]), 0) / 2;
      const rho = pred > 0 ? (cost - cn) / pred : -1;
      if (rho > 0 && Number.isFinite(cn)) {
        const small = Math.sqrt(d.reduce((s, v) => s + v * v, 0)) < 1e-15 * (1 + Math.sqrt(x.reduce((s, v) => s + v * v, 0)));
        x = xn;
        r = rn;
        cost = cn;
        mu *= Math.max(1 / 3, 1 - (2 * rho - 1) ** 3);
        nu = 2;
        accepted = true;
        if (small) return { x, r, it };
      } else {
        mu *= nu;
        nu *= 2;
      }
    }
    if (!accepted || normInf(r) < tol) break;
  }
  return { x, r, it };
}

// ------------------------------------------------------------ the model of a design

/**
 * The solver's model of a design: the occurrences' own poses, every live joint with its
 * frames (found on the geometry by the caller) and values, the rigid groups as rigid
 * joints from their first member, and the motion links.
 */
export function kinModel(design: CadDesign, numbers: DesignNumbers, frames: Map<string, { Fa: M4; Fb: M4 }>, errors: Record<string, string> = {}): KinModel {
  const occs = design.occurrences.map((o) => ({ id: o.id, pose: m4Pose(o.pos, o.rot), ...(o.grounded ? { grounded: true } : {}) }));
  const joints: KinJoint[] = [];
  for (const j of design.joints) {
    const fr = frames.get(j.id);
    if (j.suppressed || !fr) continue;
    const p = numbers.params[j.id] ?? {};
    const q: Record<DofKey, number> = { ...ZERO };
    for (const k of Object.keys(ZERO) as DofKey[]) if (Number.isFinite(p[k])) q[k] = p[k];
    const pick = (what: 'min' | 'max' | 'rest'): DofValues => Object.fromEntries(JOINT_DOFS[j.type].filter((k) => Number.isFinite(p[`${what}:${k}`])).map((k) => [k, p[`${what}:${k}`]]));
    joints.push({
      id: j.id, name: j.name, type: j.type, a: j.a.occ, b: j.b.occ, Fa: fr.Fa, Fb: fr.Fb, ...(j.flip ? { flip: true } : {}), q,
      free: JOINT_DOFS[j.type].filter((k) => j.dofs?.[k]?.free), min: pick('min'), max: pick('max'), rest: pick('rest'),
    });
  }
  for (const g of design.groups ?? []) {
    if (g.suppressed) continue;
    const members = g.occs.filter((id) => design.occurrences.some((o) => o.id === id));
    if (members.length < g.occs.length) errors[g.id] = 'an occurrence of the group no longer exists';
    for (const m of members.slice(1)) {
      const rel = g.rel[m];
      if (!rel || rel.length !== 16) {
        errors[g.id] = 'the group does not know where one of its occurrences was: group them again';
        continue;
      }
      joints.push({ id: `${g.id}/${m}`, name: g.name, type: 'rigid', a: members[0], b: m, Fa: rel, Fb: IDENTITY, q: { ...ZERO }, free: [], min: {}, max: {}, rest: {}, group: g.id });
    }
  }
  const links: KinLink[] = [];
  for (const l of design.links ?? []) {
    const p = numbers.params[l.id];
    if (l.suppressed || !p || numbers.errors[l.id]) continue;
    links.push({ id: l.id, name: l.name, a: l.a, b: l.b, ratio: p.ratio ?? 1, offset: p.offset ?? 0 });
  }
  let size = 1;
  const reach = (M: M4) => (size = Math.max(size, Math.hypot(M[12], M[13], M[14])));
  occs.forEach((o) => reach(o.pose));
  joints.forEach((j) => (reach(j.Fa), reach(j.Fb)));
  return { occs, joints, links, size, ...(numbers.unit ? { unit: numbers.unit } : {}) };
}

// ------------------------------------------------------------ solving

const deg = (r: number) => (r * 180) / Math.PI;
const tidy = (v: number) => String(+v.toPrecision(6));

/** Place the occurrences of a model. */
export function solveKinematics(model: KinModel, o: SolveOptions = {}): KinSolution {
  const errors: Record<string, string> = {};
  const warnings: Record<string, string> = {};
  const unit = model.unit ?? '';
  const say = (k: DofKey, v: number) => (isAngleDof(k) ? `${tidy(deg(v))}°` : `${tidy(v)}${unit ? ` ${unit}` : ''}`);
  const S = model.size || 1;
  const joints = model.joints;
  const byId = new Map(joints.map((j) => [j.id, j]));
  const report = (j: KinJoint) => j.group ?? j.id;
  const label = (j: KinJoint, k: DofKey) => `the ${dofWord(j.type, k)}`;

  // ---- what drives what
  const free = new Map<string, Set<DofKey>>();
  const target = new Map<string, Record<DofKey, number>>();
  for (const j of joints) {
    const v = { ...j.q };
    const fr = new Set(j.free);
    for (const [k, x] of Object.entries(o.drive?.[j.id] ?? {}) as [DofKey, number][]) {
      if (!JOINT_DOFS[j.type].includes(k) || !Number.isFinite(x)) continue;
      v[k] = x;
      fr.delete(k);
    }
    for (const k of fr) v[k] = j.rest[k] ?? 0;
    free.set(j.id, fr);
    target.set(j.id, v);
  }
  // motion links, in the order their leaders are known (a link onto a link's follower comes after it)
  const follows = new Map<string, KinLink>();
  const key = (joint: string, dof: DofKey) => `${joint}/${dof}`;
  for (const l of model.links) {
    const A = byId.get(l.a.joint), B = byId.get(l.b.joint);
    if (!A || !B) {
      errors[l.id] = 'a joint of the link no longer exists (or does not place anything)';
      continue;
    }
    if (!JOINT_DOFS[A.type].includes(l.a.dof) || !JOINT_DOFS[B.type].includes(l.b.dof)) {
      errors[l.id] = `${A.name} or ${B.name} has no such motion: pick the DOFs again`;
      continue;
    }
    if (l.a.joint === l.b.joint && l.a.dof === l.b.dof) {
      errors[l.id] = 'a link needs two different DOFs';
      continue;
    }
    if (follows.has(key(l.b.joint, l.b.dof))) {
      errors[l.id] = `${B.name} already follows another link`;
      continue;
    }
    follows.set(key(l.b.joint, l.b.dof), l);
  }
  const order: KinLink[] = [];
  {
    const state = new Map<string, 'busy' | 'done'>();
    const visit = (l: KinLink): boolean => {
      const k = key(l.b.joint, l.b.dof);
      if (state.get(k) === 'done') return true;
      if (state.get(k) === 'busy') return false;
      state.set(k, 'busy');
      const lead = follows.get(key(l.a.joint, l.a.dof));
      const ok = !lead || visit(lead);
      state.set(k, 'done');
      if (ok) order.push(l);
      return ok;
    };
    for (const l of follows.values()) {
      if (!visit(l)) {
        errors[l.id] = 'the links go round in a circle';
        follows.delete(key(l.b.joint, l.b.dof));
      }
    }
  }
  const links = order.filter((l) => follows.get(key(l.b.joint, l.b.dof)) === l);
  for (const l of links) free.get(l.b.joint)!.delete(l.b.dof);
  const applyLinks = (q: Map<string, Record<DofKey, number>>) => {
    for (const l of links) q.get(l.b.joint)![l.b.dof] = l.ratio * q.get(l.a.joint)![l.a.dof] + l.offset;
  };

  // driven values past their limits stop there
  for (const j of joints) {
    const v = target.get(j.id)!;
    for (const k of JOINT_DOFS[j.type]) {
      if (free.get(j.id)!.has(k) || follows.has(key(j.id, k))) continue;
      const lo = j.min[k], hi = j.max[k];
      if (lo !== undefined && v[k] < lo - 1e-12 * (1 + Math.abs(lo))) {
        warnings[report(j)] ??= `${label(j, k)} ${say(k, v[k])} is past its limit (min ${say(k, lo)}): the joint stops there`;
        v[k] = lo;
      } else if (hi !== undefined && v[k] > hi + 1e-12 * (1 + Math.abs(hi))) {
        warnings[report(j)] ??= `${label(j, k)} ${say(k, v[k])} is past its limit (max ${say(k, hi)}): the joint stops there`;
        v[k] = hi;
      }
    }
  }

  // ---- the spanning tree: joint after joint from the grounded occurrences, as placements always went
  const occs = model.occs;
  const roots = new Set(occs.filter((q) => q.grounded).map((q) => q.id));
  if (!roots.size && occs.length) roots.add(occs[0].id);
  const placed = new Set(roots);
  const tree: { j: KinJoint; forward: boolean }[] = [];
  const closing: KinJoint[] = [];
  const parent: Record<string, { occ: string; joint: string }> = {};
  const via = new Map<string, KinJoint>();
  {
    const done = new Set<string>();
    let progress = true;
    while (progress) {
      progress = false;
      for (const j of joints) {
        if (done.has(j.id)) continue;
        const A = placed.has(j.a), B = placed.has(j.b);
        if (A && B) {
          done.add(j.id);
          closing.push(j);
          continue;
        }
        if (!A && !B) continue;
        const child = A ? j.b : j.a;
        tree.push({ j, forward: A });
        placed.add(child);
        parent[child] = { occ: A ? j.a : j.b, joint: j.id };
        via.set(child, j);
        done.add(j.id);
        progress = true;
      }
    }
  }
  const poseOf = new Map(occs.map((q) => [q.id, q.pose]));
  const place = (q: Map<string, Record<DofKey, number>>): Map<string, M4> => {
    const P = new Map<string, M4>();
    for (const r of roots) P.set(r, poseOf.get(r)!);
    for (const { j, forward } of tree) {
      const M = motionMatrix(q.get(j.id)!, j.flip);
      if (forward) P.set(j.b, m4Mul(m4Mul(m4Mul(P.get(j.a)!, j.Fa), M), m4Inv(j.Fb)));
      else P.set(j.a, m4Mul(m4Mul(m4Mul(P.get(j.b)!, j.Fb), m4Inv(M)), m4Inv(j.Fa)));
    }
    return P;
  };

  // ---- the loops: the tree joints between a closing joint's two sides, and the DOFs that move them
  const pathToRoot = (occ: string): string[] => {
    const out: string[] = [];
    for (let at = occ; parent[at]; at = parent[at].occ) out.push(parent[at].joint);
    return out;
  };
  const loopOf = new Map<string, Set<string>>();
  for (const c of closing) {
    const pa = pathToRoot(c.a), pb = pathToRoot(c.b);
    const sa = new Set(pa), sb = new Set(pb);
    // from the root outwards on either side, the closing joint last
    loopOf.set(c.id, new Set([...pa.filter((x) => !sb.has(x)).reverse(), ...pb.filter((x) => !sa.has(x)).reverse(), c.id]));
  }
  // a DOF moves a loop when it is on one, or leads a link onto one
  const onLoop = new Set<string>();
  for (const s of loopOf.values()) for (const id of s) for (const k of JOINT_DOFS[byId.get(id)!.type]) onLoop.add(key(id, k));
  for (const l of [...links].reverse()) if (onLoop.has(key(l.b.joint, l.b.dof))) onLoop.add(key(l.a.joint, l.a.dof));
  const unknowns: { j: KinJoint; k: DofKey }[] = [];
  for (const j of joints) for (const k of JOINT_DOFS[j.type]) if (free.get(j.id)!.has(k) && onLoop.has(key(j.id, k))) unknowns.push({ j, k });
  const isUnknown = new Set(unknowns.map((u) => key(u.j.id, u.k)));
  const moves = (id: string, k: DofKey): boolean => {
    if (isUnknown.has(key(id, k))) return true;
    const l = follows.get(key(id, k));
    return !!l && links.includes(l) && moves(l.a.joint, l.a.dof);
  };
  const movable = (c: KinJoint) => [...loopOf.get(c.id)!].some((id) => JOINT_DOFS[byId.get(id)!.type].some((k) => moves(id, k)));
  const solved = closing.filter(movable);
  const scaleOf = (k: DofKey) => (isAngleDof(k) ? 1 : S);

  const values = (): Map<string, Record<DofKey, number>> => new Map([...target].map(([id, v]) => [id, { ...v }]));
  const withX = (base: Map<string, Record<DofKey, number>>, x: number[]) => {
    const q = new Map([...base].map(([id, v]) => [id, { ...v }]));
    unknowns.forEach((u, i) => (q.get(u.j.id)![u.k] = x[i] * scaleOf(u.k)));
    applyLinks(q);
    return q;
  };
  const residual = (q: Map<string, Record<DofKey, number>>): number[] => {
    const P = place(q);
    const r: number[] = [];
    for (const c of solved) {
      const T = m4Mul(m4Inv(m4Mul(P.get(c.a)!, c.Fa)), m4Mul(P.get(c.b)!, c.Fb));
      const W = motionMatrix(q.get(c.id)!, c.flip);
      for (const i of [12, 13, 14]) r.push((T[i] - W[i]) / S);
      for (const i of [0, 1, 2, 4, 5, 6, 8, 9, 10]) r.push(T[i] - W[i]);
    }
    return r;
  };
  const CLOSED = 1e-9;
  let mobility = 0;
  let q = values();
  applyLinks(q);

  if (solved.length && unknowns.length) {
    // driven DOFs of the loops go from where the mechanism was assembled (or the previous frame) to their values
    const drivers: { j: KinJoint; k: DofKey; from: number; to: number }[] = [];
    for (const j of joints) for (const k of JOINT_DOFS[j.type]) {
      if (free.get(j.id)!.has(k) || follows.has(key(j.id, k)) || !onLoop.has(key(j.id, k))) continue;
      const to = target.get(j.id)![k];
      const from = o.from?.[j.id]?.[k] ?? j.rest[k] ?? 0;
      if (Math.abs(to - from) > 1e-12 * (1 + Math.abs(to))) drivers.push({ j, k, from, to });
    }
    const at = (t: number) => {
      const base = values();
      for (const d of drivers) base.get(d.j.id)![d.k] = d.from + t * (d.to - d.from);
      return base;
    };
    const x0 = unknowns.map((u) => (o.from?.[u.j.id]?.[u.k] ?? u.j.rest[u.k] ?? 0) / scaleOf(u.k));
    const solveAt = (t: number, from: number[]) => {
      const base = at(t);
      const res = levenbergMarquardt((x) => residual(withX(base, x)), from);
      return { x: res.x, ok: normInf(res.r) < CLOSED, base };
    };
    // a solved DOF (or a link's follower) past its limit stops the mechanism where it gets there
    const watched = joints.flatMap((j) => JOINT_DOFS[j.type].filter((k) => (free.get(j.id)!.has(k) || follows.has(key(j.id, k))) && (j.min[k] !== undefined || j.max[k] !== undefined)).map((k) => ({ j, k })));
    const within = (qq: Map<string, Record<DofKey, number>>) => watched.find(({ j, k }) => {
      const v = qq.get(j.id)![k];
      return (j.min[k] !== undefined && v < j.min[k]! - 1e-9 * scaleOf(k)) || (j.max[k] !== undefined && v > j.max[k]! + 1e-9 * scaleOf(k));
    });
    let x = x0, t = 0, ok = false, stop: string | null = null;
    // a start in line (every solved angle 0, the links straight out) can be a saddle the loop
    // never leaves: nudge the solved angles one way, then the other
    const nudged = (k: number) => x0.map((v, i) => (isAngleDof(unknowns[i].k) ? v + k * 0.5 : v));
    let start = solveAt(0, x0);
    for (const k of [1, -1]) if (!start.ok) start = solveAt(0, nudged(k));
    if (start.ok) {
      x = start.x;
      ok = true;
      const span = Math.max(0, ...drivers.map((d) => Math.abs(d.to - d.from) / (isAngleDof(d.k) ? Math.PI / 36 : S / 20)));
      const n = Math.min(720, Math.max(1, Math.ceil(span)));
      for (let s = 1; s <= n && !stop; s++) {
        const tn = s / n;
        const step = solveAt(tn, x);
        const past = step.ok ? within(withX(step.base, step.x)) : undefined;
        if (step.ok && !past) {
          x = step.x;
          t = tn;
          continue;
        }
        // bisect for where it stops: the last place the loop closes within the limits. A
        // mechanism that cannot move at all (locked by another loop, or at a stop already)
        // fails a millionth of the step on: no need to bisect
        let lo = t, hi = tn, xl = x;
        const goes = (to: number) => {
          const m = solveAt(to, xl);
          if (!m.ok || within(withX(m.base, m.x))) return false;
          [lo, xl] = [to, m.x];
          return true;
        };
        if (!goes(lo + (hi - lo) * 1e-6)) hi = lo + (hi - lo) * 1e-6;
        else for (let b = 0; b < 30; b++) {
          const mid = (lo + hi) / 2;
          if (!goes(mid)) hi = mid;
        }
        x = xl;
        t = lo;
        // why: a limit (the loop still closes just past it) or the loop itself
        const after = solveAt(hi, xl);
        const hit = after.ok ? within(withX(after.base, after.x)) : undefined;
        const reached = drivers.map((d) => `${d.j.name} = ${say(d.k, d.from + t * (d.to - d.from))}`).join(', ');
        if (hit) {
          const lim = withX(at(t), x).get(hit.j.id)![hit.k];
          warnings[report(hit.j)] ??= `${label(hit.j, hit.k)} reaches its limit ${say(hit.k, lim)} at ${reached}: the mechanism stops there`;
          stop = `stops at ${reached}: ${hit.j.name} reaches its limit`;
        } else {
          stop = `stops at ${reached}: the loop cannot close beyond (a dead point, or out of reach)`;
        }
        for (const d of drivers) warnings[report(d.j)] ??= `${label(d.j, d.k)} ${stop}`;
      }
    } else {
      // it does not close where it was assembled: try the driven values straight away
      const direct = solveAt(1, x0);
      if (direct.ok) {
        x = direct.x;
        t = 1;
        ok = true;
      }
    }
    q = withX(at(t), x);
    if (!ok) {
      const P = place(q);
      for (const c of solved) {
        const T = m4Mul(m4Inv(m4Mul(P.get(c.a)!, c.Fa)), m4Mul(P.get(c.b)!, c.Fb));
        const W = motionMatrix(q.get(c.id)!, c.flip);
        const gap = Math.hypot(T[12] - W[12], T[13] - W[13], T[14] - W[14]), turn = rotationGap(T, W);
        if (gap < CLOSED * S && turn < CLOSED) continue;
        const names = [...loopOf.get(c.id)!].map((id) => byId.get(id)!.name).filter((n, i, a) => a.indexOf(n) === i);
        const apart = [gap >= CLOSED * S ? `${tidy(gap)}${unit ? ` ${unit}` : ''}` : '', turn >= CLOSED ? `${tidy(deg(turn))}°` : ''].filter(Boolean).join(' and ');
        errors[report(c)] = `the loop through ${names.join(', ')} cannot close: it stays ${apart} apart (over-constrained, or the driven values put it out of reach)`;
      }
    }
    // what the loops leave free stays where it started
    const J = jacobian((xx) => residual(withX(at(t), xx)), x, residual(q).length);
    mobility = unknowns.length - rankOf(J, 1e-7);
  }

  // ---- placements, and the loops nothing solves: they fit or are reported, as always
  const P = place(q);
  for (const c of closing) {
    if (solved.includes(c)) continue;
    const want = m4Mul(m4Mul(m4Mul(P.get(c.a)!, c.Fa), motionMatrix(q.get(c.id)!, c.flip)), m4Inv(c.Fb));
    const B = P.get(c.b)!;
    const err = Math.max(...want.map((v, k) => Math.abs(v - B[k]) / (k >= 12 ? 1 + Math.abs(v) : 1)));
    if (err > 1e-6) {
      const hint = JOINT_DOFS[c.type].length || [...(loopOf.get(c.id) ?? [])].some((id) => JOINT_DOFS[byId.get(id)!.type].length)
        ? ' (to let the loop move, set the DOFs it should find to Solved)' : '';
      errors[report(c)] = `this joint closes a loop that does not fit — it is ignored${hint}`;
    }
  }
  // driven values a follower is pushed past by its link: the follower stops (outside loops it does not hold the leader back)
  for (const l of links) {
    const j = byId.get(l.b.joint)!, v = q.get(j.id)!;
    const lo = j.min[l.b.dof], hi = j.max[l.b.dof];
    const past = (lo !== undefined && v[l.b.dof] < lo - 1e-9 * scaleOf(l.b.dof)) ? lo : (hi !== undefined && v[l.b.dof] > hi + 1e-9 * scaleOf(l.b.dof)) ? hi : undefined;
    if (past === undefined || onLoop.has(key(j.id, l.b.dof))) continue;
    warnings[report(j)] ??= `the link ${l.name} takes ${label(j, l.b.dof)} to ${say(l.b.dof, v[l.b.dof])}, past its limit ${say(l.b.dof, past)}: it stops there`;
    v[l.b.dof] = past;
  }
  const finalP = links.length ? place(q) : P;
  const placements: Record<string, Placement> = {};
  for (const r of roots) placements[r] = { matrix: finalP.get(r)!, by: 'ground' };
  for (const { j, forward } of tree) placements[forward ? j.b : j.a] = { matrix: finalP.get(forward ? j.b : j.a)!, by: 'joint' };
  for (const oc of occs) placements[oc.id] ??= { matrix: oc.pose, by: 'free' };
  const out: Record<string, DofValues> = {};
  for (const j of joints) {
    if (j.group) continue;
    const v = q.get(j.id)!;
    out[j.id] = Object.fromEntries(JOINT_DOFS[j.type].map((k) => {
      let x = v[k];
      // a solved angle without limits reads between −180° and 180°
      if (isAngleDof(k) && free.get(j.id)!.has(k) && j.min[k] === undefined && j.max[k] === undefined) x = Math.atan2(Math.sin(x), Math.cos(x));
      return [k, x];
    }));
  }
  return { placements, values: out, errors, warnings, parent, mobility: Math.max(0, mobility) };
}
