// What the 3-D view shows of an assembly in motion, without touching the document: the
// placements while a joint is driven by hand or a motion study plays (the kinematics solved
// in the page, from the model the build came with, each frame going on from the last), the
// exploded view on top of either, the selected joint's glyph, the explode trails and the
// parts a study finds overlapping at that moment.
import { useMemo, useRef } from 'react';
import type { DofKey, MotionStudy } from '../../cad/assembly';
import type { BuildResult } from '../../cad/buildResult';
import type { CadDesign, Placement } from '../../cad/design';
import type { DesignResult } from '../../cad/evaluate';
import { explodeShifts, explodeTrails, explodedPlacements } from '../../cad/explode';
import { solveKinematics, type DofValues, type KinSolution, type KinState } from '../../cad/kinematics';
import { driveAt, type MotionResult } from '../../cad/motion';
import type { SceneLines, SceneMesh } from './Scene3D';
import { jointGlyph } from './jointGlyph';

export interface AssemblyViewInput {
  design: CadDesign;
  build: BuildResult | null;
  dr?: DesignResult;
  size: number;
  /** A DOF driven by hand. */
  drive?: { joint: string; dof: DofKey; value: number } | null;
  /** A study played at time t. */
  motion?: { study: MotionStudy; t: number } | null;
  /** The exploded view, k of the way out (0…1). */
  explode?: number | null;
  trails?: boolean;
  /** Joints whose glyph shows. */
  glyphs?: string[];
}

export interface AssemblyView {
  /** The build with the placements shown (the same object when nothing moves). */
  shown: BuildResult | null;
  /** The solution of the drive or the frame, with its problems. */
  solution: KinSolution | null;
  lines: SceneLines[];
  /** Occurrences overlapping in the study's frame nearest to now. */
  hits: Set<string>;
}

const RED: [number, number, number] = [0.86, 0.15, 0.15];

/** The bodies of overlapping occurrences painted red. */
export function paintHits(meshes: SceneMesh[], hits: Set<string>, build: BuildResult | null, design: CadDesign): SceneMesh[] {
  if (!hits.size || !build) return meshes;
  return meshes.map((m) => {
    if (!m.key.startsWith('b:')) return m;
    const rest = m.key.slice(2), i = rest.indexOf(':');
    const occ = rest.slice(0, i), body = rest.slice(i + 1);
    if (!hits.has(occ)) return m;
    const cid = design.occurrences.find((o) => o.id === occ)?.component;
    const b = cid ? build.components[cid]?.bodies.find((q) => q.id === body) : undefined;
    return b ? { ...m, paint: { faces: b.faces.map((f) => f.index), color: RED } } : m;
  });
}

/** The frame of a study's results nearest to t. */
function nearestFrame(result: MotionResult | undefined, t: number): number {
  if (!result?.t.length) return -1;
  let best = 0;
  result.t.forEach((s, i) => Math.abs(s - t) < Math.abs(result.t[best] - t) && (best = i));
  return best;
}

export function useAssemblyView(o: AssemblyViewInput): AssemblyView {
  const kin: KinState | undefined = o.build?.kin ?? o.dr?.kin;
  // a drive or a playing study goes on from the configuration it showed last
  const last = useRef<{ key: string; values: Record<string, DofValues> } | null>(null);
  const moving = o.drive ? `d:${o.drive.joint}/${o.drive.dof}` : o.motion ? `m:${o.motion.study.id}` : '';
  const solution = useMemo(() => {
    if (!kin || !moving) return null;
    const drive: Record<string, DofValues> = o.drive ? { [o.drive.joint]: { [o.drive.dof]: o.drive.value } } : driveAt(o.motion!.study, o.dr?.params ?? {}, o.motion!.t);
    // a drive starts from the configuration shown (a solved DOF driven turns what drove its loop)
    const from = (last.current?.key === moving ? last.current.values : undefined) ?? (o.drive ? kin.values : undefined);
    const sol = solveKinematics(kin.model, { drive, ...(from ? { from } : {}) });
    last.current = { key: moving, values: sol.values };
    return sol;
    // the drive's value and the frame's time are what change
  }, [kin, moving, o.drive?.value, o.motion?.t, o.motion?.study, o.dr?.params]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!moving && last.current) last.current = null;

  return useMemo(() => {
    const base: Record<string, Placement> | undefined = solution?.placements ?? o.build?.placements;
    let placements = base;
    const lines: SceneLines[] = [];
    if (base && o.explode != null && o.explode > 0 && kin) {
      const shifts = explodeShifts(o.design, kin.parent, o.dr?.params ?? {}, o.explode);
      placements = explodedPlacements(base, shifts);
      if (o.trails && o.build) {
        const segments = explodeTrails(o.build, o.design, base, shifts);
        if (segments.length) lines.push({ key: 'trails', segments, color: [0.45, 0.5, 0.6], overlay: true, unframed: true });
      }
    }
    const values = solution?.values ?? kin?.values ?? {};
    for (const id of o.glyphs ?? []) {
      const j = kin?.model.joints.find((q) => q.id === id);
      const P = j && placements?.[j.a]?.matrix;
      if (j && P) lines.push(...jointGlyph(j, P, values[j.id] ?? {}, o.size));
    }
    const hits = new Set<string>();
    if (o.motion) {
      const r = o.dr?.motions?.[o.motion.study.id];
      const f = nearestFrame(r, o.motion.t);
      for (const [a, b] of (f >= 0 && r?.clearance?.[f]?.hits) || []) hits.add(a).add(b);
    }
    const shown = o.build && placements && placements !== o.build.placements ? { ...o.build, placements } : o.build;
    return { shown, solution, lines, hits };
  }, [solution, o.build, o.explode, o.trails, o.design, o.dr, o.glyphs, o.size, o.motion, kin]);
}
