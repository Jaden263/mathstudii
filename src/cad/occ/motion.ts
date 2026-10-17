// Clearance through a motion study: for every frame the smallest distance between the
// bodies of any two occurrences, and the volume overlapping pairs share. Every frame is
// measured on the bodies' tessellation first (clearance.ts: a few hundred triangles a body,
// within 5·10⁻⁴ of its size of the exact faces); the frames that come within that of the
// least clearance, and every pair that touches, are measured again on the exact shapes
// (BRepExtrema, the shapes moved into the frame's place by their location only) and the
// volume shared by BRepAlgoAPI_Common. The worksheet's results of a study are kept, so
// recalculating the worksheet measures nothing again.
import type { TopoDS_Shape } from 'replicad-opencascadejs';
import type { MotionStudy } from '../assembly';
import { meshDistance, meshTree, type MeshTree } from '../clearance';
import type { CadDesign, DesignNumbers } from '../design';
import type { KinState } from '../kinematics';
import { hashString } from '../keys';
import { joinedPairs, motionResult, runMotion, type FrameClearance, type MotionFrame, type MotionResult } from '../motion';
import { m4Point, type M4, type Vec3 } from '../solid';
import { buildDesignCached, type OccBuiltDesign } from './build';
import { guard, hasSolid, scratch, trsf, type OC } from './kernel';
import { shapeVolume } from './ops';
import { common, placedBodies } from './query';
import { cachedResultOcc } from './result';

/** Closer than this (part units) counts as touching: the volume they share is measured. */
const TOUCH = 1e-7;
/** How far the display tessellation may stray from the exact faces, relative to a body's size (result.ts). */
const FACETED = 5e-4;

const trees = new WeakMap<Float32Array, MeshTree>();

/** The smallest clearance and the interference of every frame (pairs in `skip`, `a|b` sorted, are left out). */
export function clearanceOcc(oc: OC, built: OccBuiltDesign, design: CadDesign, frames: { placements: Record<string, M4> }[], skip: Set<string> = new Set()): FrameClearance[] {
  const shown = cachedResultOcc(oc, built);
  const bodies = placedBodies(built, design).filter((pb) => hasSolid(oc, pb.shape)).flatMap((pb) => {
    const r = shown.components[pb.component]?.bodies.find((b) => b.id === pb.id);
    if (!r?.box || !r.mesh.indices.length) return [];
    const size = Math.hypot(r.box.max[0] - r.box.min[0], r.box.max[1] - r.box.min[1], r.box.max[2] - r.box.min[2]);
    let tree = trees.get(r.mesh.positions);
    if (!tree) trees.set(r.mesh.positions, (tree = meshTree(r.mesh.positions, r.mesh.indices)));
    return [{ occ: pb.occ, shape: pb.shape, tree, box: r.box, err: FACETED * size }];
  });
  const pairs: [number, number][] = [];
  bodies.forEach((x, i) => bodies.forEach((y, k) => {
    if (k <= i || x.occ === y.occ || skip.has([x.occ, y.occ].sort().join('|'))) return;
    pairs.push([i, k]);
  }));
  const placedBox = (b: { min: Vec3; max: Vec3 }, M: M4) => {
    const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (let c = 0; c < 8; c++) {
      const p = m4Point(M, [c & 1 ? b.max[0] : b.min[0], c & 2 ? b.max[1] : b.min[1], c & 4 ? b.max[2] : b.min[2]]);
      for (let i = 0; i < 3; i++) [min[i], max[i]] = [Math.min(min[i], p[i]), Math.max(max[i], p[i])];
    }
    return { min, max };
  };
  const gap = (p: { min: Vec3; max: Vec3 }, q: { min: Vec3; max: Vec3 }) => Math.hypot(...[0, 1, 2].map((k) => Math.max(0, p.min[k] - q.max[k], q.min[k] - p.max[k])));
  // every frame on the facets: the body pairs that may be the closest (within the facets' error of it)
  const faceted = frames.map((f) => {
    const boxes = bodies.map((b) => (f.placements[b.occ] ? placedBox(b.box, f.placements[b.occ]) : null));
    const order = pairs.filter(([i, k]) => boxes[i] && boxes[k]).map(([i, k]) => ({ i, k, g: gap(boxes[i]!, boxes[k]!), err: bodies[i].err + bodies[k].err })).sort((p, q) => p.g - q.g);
    let best = Infinity;
    const near: { i: number; k: number; d: number; err: number }[] = [];
    for (const p of order) {
      if (p.g > best + 2 * p.err) break;
      // no need to know how far a pair is that cannot be the closest
      const d = meshDistance(bodies[p.i].tree, f.placements[bodies[p.i].occ], bodies[p.k].tree, f.placements[bodies[p.k].occ], best + 2 * p.err);
      if (!Number.isFinite(d)) continue;
      near.push({ ...p, d });
      best = Math.min(best, d);
    }
    return { best, near };
  });
  const least = Math.min(...faceted.map((f) => f.best));
  return frames.map((f, n) => {
    const { best, near } = faceted[n];
    const out: FrameClearance = { d: best, v: 0, hits: [] };
    const top = near.filter((p) => p.d <= best + 2 * p.err).sort((p, q) => p.d - q.d)[0];
    if (top) out.pair = [bodies[top.i].occ, bodies[top.k].occ].sort() as [string, string];
    // near the least clearance, or touching: again on the exact shapes
    const exact = near.filter((p) => p.d <= TOUCH + 2 * p.err || (best <= least + 2 * p.err && p.d <= best + 2 * p.err));
    if (!exact.length) return out;
    return scratch((t) => {
      const moved = new Map<number, TopoDS_Shape>();
      const at = (i: number) => {
        let s = moved.get(i);
        if (!s) moved.set(i, (s = t.add(bodies[i].shape.Moved(t.add(new oc.TopLoc_Location(trsf(oc, t, f.placements[bodies[i].occ]))), false))));
        return s;
      };
      const shared = new Map<string, number>();
      let d = Infinity, pair = out.pair;
      for (const p of exact) {
        const ext = t.add(new oc.BRepExtrema_DistShapeShape(at(p.i), at(p.k)));
        if (!guard(oc, 'the clearance could not be measured', () => ext.IsDone()) || ext.NbSolution() < 1) continue;
        // one solid inside the other: no boundary to measure between, they overlap
        const dd = ext.InnerSolution() ? 0 : ext.Value();
        const key = [bodies[p.i].occ, bodies[p.k].occ].sort().join('|');
        if (dd < d) [d, pair] = [dd, key.split('|') as [string, string]];
        if (dd <= TOUCH) {
          const s = common(oc, t, at(p.i), at(p.k), 'the interference check failed');
          const v = s ? shapeVolume(oc, s) : 0;
          if (v > 0) shared.set(key, (shared.get(key) ?? 0) + v);
        }
      }
      // the exact distance of the pairs measured again, unless a facet pair not measured is closer still
      const rest = near.filter((p) => !exact.includes(p)).reduce((m, p) => Math.min(m, p.d), Infinity);
      if (rest < d) out.d = rest;
      else if (Number.isFinite(d)) [out.d, out.pair] = [d, pair];
      for (const [k, v] of shared) {
        out.v += v;
        out.hits.push(k.split('|') as [string, string]);
      }
      return out;
    });
  });
}

// frames by what they are solved from, and clearances by the shapes and where the frames put them
const framesOf = new Map<string, MotionFrame[]>();
const clearances = new Map<string, FrameClearance[]>();
const KEPT = 24;
let keptBy: OC | null = null;
/** Each shape a number, the same for as long as the timeline cache keeps it (unchanged bodies keep their shapes). */
const shapeIds = new WeakMap<TopoDS_Shape, number>();
let nextShape = 0;

function remember<T>(m: Map<string, T>, key: string, v: T): T {
  m.set(key, v);
  if (m.size > KEPT) m.delete(m.keys().next().value!);
  return v;
}

/**
 * A study's results for the worksheet: its frames, and with the B-rep kernel their
 * clearance. A worksheet change that moves nothing (a value the study drives over anyway,
 * the density) finds both again.
 */
export function studyResult(oc: OC | null, design: CadDesign, numbers: DesignNumbers, study: MotionStudy, kin: KinState): MotionResult {
  if (oc !== keptBy) {
    clearances.clear();
    keptBy = oc;
  }
  const fk = hashString(JSON.stringify([kin.model, study, numbers.params[study.id] ?? null]));
  const frames = framesOf.get(fk) ?? remember(framesOf, fk, runMotion(kin, study, numbers.params));
  const skip = study.skipJoined === false ? new Set<string>() : joinedPairs(kin);
  const measure = (fs: MotionFrame[]): FrameClearance[] => {
    if (!oc) throw new Error('the clearance is measured on the exact shapes, by the B-rep kernel (it has not loaded)');
    const built = buildDesignCached(oc, design, numbers);
    const shapes = placedBodies(built, design).map((pb) => {
      if (!shapeIds.has(pb.shape)) shapeIds.set(pb.shape, ++nextShape);
      return `${pb.occ}:${shapeIds.get(pb.shape)}`;
    });
    const where = fs.map((f) => Object.entries(f.placements).map(([id, M]) => `${id}:${M.map((v) => v.toPrecision(12)).join(',')}`).join(';'));
    const ck = hashString(JSON.stringify([shapes, where, [...skip]]));
    return structuredClone(clearances.get(ck) ?? remember(clearances, ck, clearanceOcc(oc, built, design, fs, skip)));
  };
  return motionResult(kin, study, frames, measure);
}
