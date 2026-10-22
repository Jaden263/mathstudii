// Motion studies: keyframes of joint DOFs over time, interpolated and played through the
// kinematics frame by frame. Each frame goes on from the one before it, so a mechanism
// keeps its branch all the way through. The sampled frames are what the worksheet reads
// (times, every joint's values, the smallest clearance per frame) and what the workspace
// plays back.
import { JOINT_DOFS, type DofKey, type MotionStudy } from './assembly';
import type { DesignNumbers } from './design';
import { solveKinematics, type DofValues, type KinState } from './kinematics';
import type { M4 } from './solid';

/**
 * Value at t between keys (ts ascending): straight lines, or smooth: a monotone cubic
 * through the keys (Fritsch–Carlson slopes, weighted as in Fritsch & Butland 1984) that
 * starts and stops with zero slope, so a motion eases in and out and never overshoots a
 * key. Before the first key and after the last the value holds.
 */
export function interpolate(ts: number[], vs: number[], t: number, smooth: boolean): number {
  const n = ts.length;
  if (!n) return 0;
  if (t <= ts[0] || n === 1) return vs[0];
  if (t >= ts[n - 1]) return vs[n - 1];
  let k = 0;
  while (k < n - 2 && t > ts[k + 1]) k++;
  const h = ts[k + 1] - ts[k];
  if (!(h > 0)) return vs[k + 1];
  const s = (t - ts[k]) / h;
  if (!smooth) return vs[k] + s * (vs[k + 1] - vs[k]);
  const slope = (i: number) => {
    if (i <= 0 || i >= n - 1) return 0;
    const h0 = ts[i] - ts[i - 1], h1 = ts[i + 1] - ts[i];
    const d0 = (vs[i] - vs[i - 1]) / h0, d1 = (vs[i + 1] - vs[i]) / h1;
    if (d0 * d1 <= 0) return 0;
    const w1 = 2 * h1 + h0, w2 = h1 + 2 * h0;
    return (w1 + w2) / (w1 / d0 + w2 / d1);
  };
  const s2 = s * s, s3 = s2 * s;
  return (2 * s3 - 3 * s2 + 1) * vs[k] + (s3 - 2 * s2 + s) * h * slope(k) + (-2 * s3 + 3 * s2) * vs[k + 1] + (s3 - s2) * h * slope(k + 1);
}

/** The times a study is sampled at: steps + 1 frames from 0 to its duration. */
export function sampleTimes(study: MotionStudy): number[] {
  const n = Math.max(1, Math.min(2000, Math.round(study.steps ?? 36)));
  const T = Math.max(0, study.duration);
  return Array.from({ length: n + 1 }, (_, i) => (T * i) / n);
}

/** The DOFs a study drives at time t (radians, part units): its tracks' keys interpolated. */
export function driveAt(study: MotionStudy, params: DesignNumbers['params'], t: number): Record<string, DofValues> {
  const p = params[study.id] ?? {};
  const out: Record<string, DofValues> = {};
  study.tracks.forEach((tr, i) => {
    const keys = tr.keys.map((k, n) => ({ t: k.t, v: p[`v:${i}:${n}`] })).filter((k) => Number.isFinite(k.v) && Number.isFinite(k.t)).sort((a, b) => a.t - b.t);
    if (!keys.length) return;
    (out[tr.joint] ??= {})[tr.dof] = interpolate(keys.map((k) => k.t), keys.map((k) => k.v), t, study.interp === 'smooth');
  });
  return out;
}

export interface MotionFrame {
  t: number;
  placements: Record<string, M4>;
  values: Record<string, DofValues>;
  /** The first problem of this frame (a limit reached, a loop that cannot close). */
  warning?: string;
  error?: string;
}

/** Play a study through the kinematics at the given times (each frame from the one before). */
export function runMotion(kin: KinState, study: MotionStudy, params: DesignNumbers['params'], times = sampleTimes(study)): MotionFrame[] {
  const frames: MotionFrame[] = [];
  let from: Record<string, DofValues> | undefined;
  for (const t of times) {
    const sol = solveKinematics(kin.model, { drive: driveAt(study, params, t), ...(from ? { from } : {}) });
    from = sol.values;
    const placements: Record<string, M4> = {};
    for (const [id, p] of Object.entries(sol.placements)) placements[id] = p.matrix;
    const name = (id: string) => kin.model.joints.find((j) => j.id === id)?.name ?? id;
    const first = (r: Record<string, string>) => Object.entries(r).map(([id, w]) => `${name(id)}: ${w}`)[0];
    frames.push({ t, placements, values: sol.values, ...(first(sol.warnings) ? { warning: first(sol.warnings) } : {}), ...(first(sol.errors) ? { error: first(sol.errors) } : {}) });
  }
  return frames;
}

/** The clearance of one frame: the closest pair of occurrences, how far apart, and the volume overlapping ones share. */
export interface FrameClearance {
  d: number;
  pair?: [string, string];
  /** Shared volume (part units³) of all pairs that overlap. */
  v: number;
  /** The pairs that overlap. */
  hits: [string, string][];
}

/** What a study gives the worksheet and the workspace (plain numbers). */
export interface MotionResult {
  t: number[];
  /** Joint id → DOF → value per frame (radians, part units). */
  values: Record<string, Partial<Record<DofKey, number[]>>>;
  clearance?: FrameClearance[];
  /** Why the clearance is missing (the mesh kernel cannot measure it). */
  clearanceError?: string;
  /** The first warning and error over the frames, with the time it came at. */
  warning?: string;
  error?: string;
}

/** The results of a study from its frames; `clearance` measures them when the study asks for it. */
export function motionResult(kin: KinState, study: MotionStudy, frames: MotionFrame[], clearance?: (frames: MotionFrame[]) => FrameClearance[]): MotionResult {
  const values: MotionResult['values'] = {};
  for (const j of kin.model.joints) {
    if (j.group || !JOINT_DOFS[j.type].length) continue;
    values[j.id] = Object.fromEntries(JOINT_DOFS[j.type].map((k) => [k, frames.map((f) => f.values[j.id]?.[k] ?? 0)]));
  }
  const out: MotionResult = { t: frames.map((f) => f.t), values };
  const w = frames.find((f) => f.warning), e = frames.find((f) => f.error);
  if (w) out.warning = `at ${+w.t.toPrecision(4)} s: ${w.warning}`;
  if (e) out.error = `at ${+e.t.toPrecision(4)} s: ${e.error}`;
  if (study.clearance && clearance) {
    try {
      out.clearance = clearance(frames);
    } catch (err) {
      out.clearanceError = err instanceof Error ? err.message : String(err);
    }
  }
  return out;
}

/** Pairs of occurrences a joint joins directly (key `a|b`, sorted). */
export function joinedPairs(kin: KinState): Set<string> {
  return new Set(kin.model.joints.map((j) => [j.a, j.b].sort().join('|')));
}
