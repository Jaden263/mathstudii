// The Inspect tab's marks in the 3-D view: the centre of gravity and the principal axes
// of what the mass panel shows, and the analyses' colours on the bodies (draft,
// curvature), made from the display data once per body and setting.
import { useMemo } from 'react';
import type { BodyResult, BuildResult } from '../../cad/buildResult';
import type { CadDesign } from '../../cad/design';
import { curvatureRange, curvatureTint, draftTint } from '../../cad/analysis';
import { displayMesh } from '../../cad/display';
import { m4Point, norm3, type M4, type Vec3 } from '../../cad/solid';
import type { SceneLines, SceneMesh } from './Scene3D';

export type AxisDir = '+X' | '-X' | '+Y' | '-Y' | '+Z' | '-Z';

export const PULL: Record<AxisDir, Vec3> = { '+X': [1, 0, 0], '-X': [-1, 0, 0], '+Y': [0, 1, 0], '-Y': [0, -1, 0], '+Z': [0, 0, 1], '-Z': [0, 0, -1] };

/** What the bodies are painted with besides their appearances. */
export type Analysis =
  | { kind: 'zebra'; stripes: number }
  /** The pull direction (assembly axes) and the least draft wanted, degrees. */
  | { kind: 'draft'; pull: AxisDir; angle: number }
  /** Mean or Gaussian curvature; `range` (1/unit or 1/unit²) the colours span, automatic when missing. */
  | { kind: 'curvature'; which: 'mean' | 'gauss'; range?: number };

/**
 * The centre of gravity as a small sphere of three circles, and the principal axes through
 * it (red, green, blue for the smallest to the largest moment), drawn over everything:
 * the centre usually lies inside the material. M places component coordinates.
 */
export function massGlyph(c: Vec3, axes: [Vec3, Vec3, Vec3] | null, size: number, M?: M4): SceneLines[] {
  const at = (p: Vec3) => (M ? m4Point(M, p) : p);
  const r = size * 0.022, segs: number[] = [];
  const circle = (u: Vec3, v: Vec3) => {
    const n = 32;
    for (let i = 0; i < n; i++) {
      const a0 = (2 * Math.PI * i) / n, a1 = (2 * Math.PI * (i + 1)) / n;
      const p = (a: number): Vec3 => [c[0] + r * (Math.cos(a) * u[0] + Math.sin(a) * v[0]), c[1] + r * (Math.cos(a) * u[1] + Math.sin(a) * v[1]), c[2] + r * (Math.cos(a) * u[2] + Math.sin(a) * v[2])];
      segs.push(...at(p(a0)), ...at(p(a1)));
    }
  };
  const [e1, e2, e3] = axes ?? [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  circle(e1, e2);
  circle(e2, e3);
  circle(e3, e1);
  const out: SceneLines[] = [{ key: 'cog', segments: new Float32Array(segs), color: [0.92, 0.36, 0.08], overlay: true, unframed: true }];
  if (axes) {
    const L = size * 0.3;
    const colours: [number, number, number][] = [[0.88, 0.19, 0.19], [0.18, 0.62, 0.27], [0.11, 0.49, 0.84]];
    axes.forEach((e, k) => {
      const a: Vec3 = [c[0] - L * e[0], c[1] - L * e[1], c[2] - L * e[2]], b: Vec3 = [c[0] + L * e[0], c[1] + L * e[1], c[2] + L * e[2]];
      out.push({ key: `axis${k + 1}`, segments: new Float32Array([...at(a), ...at(b)]), color: colours[k], overlay: true, unframed: true });
    });
  }
  return out;
}

// one tint per body, for the latest setting (the bodies themselves are cached by the display data)
const tints = new WeakMap<BodyResult, { key: string; tint: Float32Array }>();
const tintOf = (b: BodyResult, key: string, make: () => Float32Array) => {
  const hit = tints.get(b);
  if (hit?.key === key) return hit.tint;
  const tint = make();
  tints.set(b, { key, tint });
  return tint;
};

/** The body a scene mesh shows (key `b:occ:body`), unless it shows it cut (a section). */
function bodyOfMesh(sm: SceneMesh, build: BuildResult | null, design: CadDesign): BodyResult | undefined {
  if (!build || !sm.key.startsWith('b:')) return undefined;
  const rest = sm.key.slice(2), i = rest.indexOf(':');
  const occ = design.occurrences.find((o) => o.id === rest.slice(0, i));
  const b = occ ? build.components[occ.component]?.bodies.find((q) => q.id === rest.slice(i + 1)) : undefined;
  return b && sm.mesh === displayMesh(b) ? b : undefined;
}

/** A world direction in a mesh's own coordinates (its matrix rigid, column-major). */
function intoMesh(d: Vec3, m?: ArrayLike<number>): Vec3 {
  if (!m || m.length < 16) return d;
  return norm3([m[0] * d[0] + m[1] * d[1] + m[2] * d[2], m[4] * d[0] + m[5] * d[1] + m[6] * d[2], m[8] * d[0] + m[9] * d[1] + m[10] * d[2]]);
}

/**
 * The scene's bodies painted for a draft or curvature analysis (zebra stripes are the
 * view's shading), and the range a curvature map spans.
 */
export function useAnalysisMeshes(meshes: SceneMesh[], analysis: Analysis | null, build: BuildResult | null, design: CadDesign): { meshes: SceneMesh[]; range?: number } {
  return useMemo(() => {
    if (!analysis || analysis.kind === 'zebra') return { meshes };
    const shown = meshes.map((sm) => ({ sm, b: bodyOfMesh(sm, build, design) }));
    if (analysis.kind === 'draft') {
      const least = (Math.max(0, analysis.angle) * Math.PI) / 180;
      return {
        meshes: shown.map(({ sm, b }) => {
          if (!b) return sm;
          const pull = intoMesh(PULL[analysis.pull], sm.matrix);
          return { ...sm, tint: tintOf(b, `d:${pull.map((x) => x.toFixed(9))}:${least}`, () => draftTint(b, pull, least)) };
        }),
      };
    }
    const which = analysis.which === 'mean' ? 0 : 1;
    const bodies = [...new Set(shown.flatMap(({ b }) => (b ? [b] : [])))];
    const range = analysis.range && analysis.range > 0 ? analysis.range : curvatureRange(bodies, which);
    return { meshes: shown.map(({ sm, b }) => (b ? { ...sm, tint: tintOf(b, `c:${which}:${range}`, () => curvatureTint(b, which, range)) } : sm)), range };
  }, [meshes, analysis, build, design]);
}
