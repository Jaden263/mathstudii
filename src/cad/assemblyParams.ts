// The numbers of an assembly's motion, from their worksheet expressions: joint values,
// limits and rest values, motion link ratios, motion study keyframes and explode
// distances (radians and part units, like every other parameter of a design); and what
// the worksheet reads back: joints as placed and motion studies' results.
import type { Unit } from 'mathjs';
import { math, isUnit } from '../engine/math';
import { DOF_KEYS, JOINT_DOFS, dofWord, isAngleDof, type DofKey, type MotionStudy } from './assembly';
import { identifier, type CadDesign, type CadJoint, type DesignNumbers, type JointType } from './design';
import { dimensionValue } from './dimension';
import { solveKinematics, type KinState } from './kinematics';
import type { MotionResult } from './motion';

/** An expression → part units ('L') or radians ('A'; bare numbers are degrees). */
export type ValueOf = (src: string | undefined, fallback: string, kind: 'L' | 'A', what: string) => number;

/** A joint's values (angle and offset as always; the other DOFs, limits and rest values when given). */
export function jointParams(j: CadJoint, value: ValueOf): Record<string, number> {
  const p: Record<string, number> = { angle: value(j.angle, '0', 'A', 'angle'), offset: value(j.offset, '0', 'L', 'offset') };
  if (j.x?.trim()) p.x = value(j.x, '0', 'L', dofWord(j.type, 'x'));
  if (j.y?.trim()) p.y = value(j.y, '0', 'L', 'y');
  if (j.angle2?.trim()) p.angle2 = value(j.angle2, '0', 'A', 'pitch');
  if (j.angle3?.trim()) p.angle3 = value(j.angle3, '0', 'A', 'roll');
  for (const k of DOF_KEYS) {
    const d = j.dofs?.[k];
    if (!d || !JOINT_DOFS[j.type].includes(k)) continue;
    const kind = isAngleDof(k) ? 'A' : 'L';
    if (d.min?.trim()) p[`min:${k}`] = value(d.min, '0', kind, `lower limit of the ${dofWord(j.type, k)}`);
    if (d.max?.trim()) p[`max:${k}`] = value(d.max, '0', kind, `upper limit of the ${dofWord(j.type, k)}`);
    if (d.rest?.trim()) p[`rest:${k}`] = value(d.rest, '0', kind, `rest value of the ${dofWord(j.type, k)}`);
    if (p[`min:${k}`] > p[`max:${k}`]) throw new Error(`the lower limit of the ${dofWord(j.type, k)} is above its upper limit`);
  }
  return p;
}

/**
 * How far b moves per unit of a. Two angles or two lengths: a plain number. An angle and a
 * length: a length r, the pitch radius (x = r·θ, θ = x / r), or a unit per unit (mm/deg).
 */
export function linkRatio(v: unknown, unit: string, aAngle: boolean, bAngle: boolean): number {
  if (aAngle === bAngle) {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    throw new Error(`the ratio of two ${aAngle ? 'angles' : 'lengths'} is a plain number (−z₁/z₂ for a pair of gears)`);
  }
  if (!isUnit(v)) throw new Error(`the ratio of ${aAngle ? 'a length to an angle' : 'an angle to a length'} needs a unit: the pitch radius (25 mm) or ${aAngle ? 'mm/deg' : 'deg/mm'}`);
  const u = v as Unit;
  if (u.equalBase(math.unit('m'))) {
    const r = u.toNumeric(unit) as number;
    if (!aAngle && !r) throw new Error('the pitch radius must not be 0');
    return aAngle ? r : 1 / r;
  }
  if (aAngle && u.equalBase(math.unit('m/rad'))) return u.toNumeric(`${unit}/rad`) as number;
  if (!aAngle && u.equalBase(math.unit('rad/m'))) return u.toNumeric(`rad/${unit}`) as number;
  throw new Error(`expected a length (the pitch radius) or ${aAngle ? 'a length per angle' : 'an angle per length'}, got ${u.formatUnits()}`);
}

/**
 * The motion parameters of a design into `params` (and what is wrong with them into
 * `errors`): links, motion studies' keyframe values and explode distances.
 */
export function assemblyParams(design: CadDesign, unit: string, value: ValueOf, evalExpr: (src: string) => unknown, params: DesignNumbers['params'], errors: DesignNumbers['errors']) {
  const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
  const jointOf = (id: string) => design.joints.find((j) => j.id === id);
  for (const l of design.links ?? []) {
    try {
      const A = jointOf(l.a.joint), B = jointOf(l.b.joint);
      if (!A || !B) throw new Error('a joint of the link no longer exists');
      const ratio = linkRatio(evalExpr(l.ratio?.trim() || '1'), unit, isAngleDof(l.a.dof), isAngleDof(l.b.dof));
      const offset = l.offset?.trim() ? value(l.offset, '0', isAngleDof(l.b.dof) ? 'A' : 'L', 'offset') : 0;
      params[l.id] = { ratio, offset };
    } catch (e) {
      errors[l.id] = msg(e);
    }
  }
  for (const m of design.motions ?? []) {
    try {
      const p: Record<string, number> = {};
      m.tracks.forEach((tr, i) => {
        const kind = isAngleDof(tr.dof) ? 'A' : 'L';
        tr.keys.forEach((k, n) => (p[`v:${i}:${n}`] = value(k.v, '0', kind, `value at ${k.t} s`)));
      });
      params[m.id] = p;
    } catch (e) {
      errors[m.id] = msg(e);
    }
  }
  for (const o of design.occurrences) {
    if (!o.explode) continue;
    try {
      params[o.id] = { explode: value(o.explode.d, '0', 'L', 'explode distance') };
    } catch (e) {
      errors[o.id] = msg(e);
    }
  }
}

/** What the worksheet sees of a joint: an angle (revolute), a length (slider), or a record of its DOFs. */
export function jointExport(type: JointType, v: Partial<Record<DofKey, number>>, unit: string): unknown {
  const A = (k: DofKey) => math.unit(((v[k] ?? 0) * 180) / Math.PI, 'deg');
  const L = (k: DofKey) => math.unit(v[k] ?? 0, unit);
  switch (type) {
    case 'revolute': return A('angle');
    case 'slider': return L('offset');
    case 'cylindrical': return { θ: A('angle'), s: L('offset') };
    case 'pinslot': return { θ: A('angle'), x: L('x') };
    case 'planar': return { x: L('x'), y: L('y'), θ: A('angle') };
    // yaw, pitch, roll
    case 'ball': return { ψ: A('angle'), θ: A('angle2'), φ: A('angle3') };
    default: return undefined;
  }
}

/**
 * What the worksheet sees of a motion study: the times `t`, each moving joint's values per
 * frame (as its joint exports them, vectors), the clearance per frame `c` with its least
 * `c_min` (at `t_cmin`) and the volume overlapping parts share `V_int`, all of it as a
 * `table` (t, the joints' DOFs, c), and `of.Joint(x)`: a joint's value with the study's
 * first track at x, solved exactly (not interpolated between frames).
 */
export function motionValue(st: MotionStudy, mr: MotionResult, kin: KinState, unit: string): Record<string, unknown> {
  const vec = (xs: unknown[]) => math.matrix(xs as never);
  const sec = (v: number) => math.unit(v, 's');
  const joints = kin.model.joints.filter((j) => !j.group && JOINT_DOFS[j.type].length && mr.values[j.id]);
  const out: Record<string, unknown> = { t: vec(mr.t.map(sec)) };
  const at = (jid: string, f: number) => Object.fromEntries(Object.entries(mr.values[jid] ?? {}).map(([k, xs]) => [k, xs![f]]));
  const columns: { head: string; cell: (f: number) => unknown }[] = [{ head: 't', cell: (f) => sec(mr.t[f]) }];
  for (const j of joints) {
    const id = identifier(j.name);
    if (!id || id in out) continue;
    const frames = mr.t.map((_, f) => jointExport(j.type, at(j.id, f), unit));
    if (JOINT_DOFS[j.type].length === 1) out[id] = vec(frames);
    else out[id] = Object.fromEntries(Object.keys(frames[0] as object).map((k) => [k, vec(frames.map((x) => (x as Record<string, unknown>)[k]))]));
    for (const k of JOINT_DOFS[j.type]) columns.push({ head: `${id}.${k}`, cell: (f) => {
      const x = jointExport(j.type, at(j.id, f), unit);
      return JOINT_DOFS[j.type].length === 1 ? x : Object.values(x as object)[JOINT_DOFS[j.type].indexOf(k)];
    } });
  }
  if (mr.clearance) {
    const c = mr.clearance.map((x) => (Number.isFinite(x.d) ? x.d : NaN));
    out.c = vec(c.map((v) => math.unit(v, unit)));
    out.V_int = vec(mr.clearance.map((x) => math.unit(x.v, `${unit}^3`)));
    const i = c.reduce((b, v, k) => (v < c[b] ? k : b), 0);
    if (Number.isFinite(c[i])) {
      out.c_min = math.unit(c[i], unit);
      out.t_cmin = sec(mr.t[i]);
    }
    columns.push({ head: 'c', cell: (f) => math.unit(c[f], unit) });
  }
  out.table = math.matrix(mr.t.map((_, f) => columns.map((col) => col.cell(f))) as never);
  // a joint's value as a function of the first track's: solved from the frame nearest that input
  const tr = st.tracks[0];
  const input = tr && mr.values[tr.joint]?.[tr.dof];
  if (tr && input) {
    const of: Record<string, unknown> = {};
    const solveAt = (x: unknown) => {
      const xv = dimensionValue(x, unit, isAngleDof(tr.dof));
      let best = 0;
      input.forEach((v, i) => Math.abs(v - xv) < Math.abs(input[best] - xv) && (best = i));
      const from = Object.fromEntries(Object.keys(mr.values).map((jid) => [jid, at(jid, best)]));
      return solveKinematics(kin.model, { drive: { [tr.joint]: { [tr.dof]: xv } }, from }).values;
    };
    for (const j of joints) {
      const id = identifier(j.name);
      if (id && !(id in of)) of[id] = (x: unknown) => jointExport(j.type, solveAt(x)[j.id] ?? {}, unit);
    }
    out.of = of;
  }
  return out;
}
