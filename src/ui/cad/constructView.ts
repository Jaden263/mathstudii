// What the 3-D view shows of construction geometry and cosmetic threads, from the display
// data the kernel worker sends: construction planes as orange squares (pickable: a sketch
// goes on them, a plane field takes them), axes as dashed lines, points as small crosses,
// the helix of a path-only coil, and rings round a cosmetic thread's face, a pitch apart.
import type { CadResult } from '../../cad/evaluate';
import { activeItems, type CadComponent, type CadDesign, type Datum } from '../../cad/design';
import type { BodyResult, BuildResult } from '../../cad/buildResult';
import { helixPoint, threadFace } from '../../cad/sweep';
import { resolveRef } from '../../cad/topology';
import { add3, dot3, frameFromNormal, m4Dir, m4Point, norm3, scale3, sub3, type M4, type Vec3 } from '../../cad/solid';
import type { SceneLines, ScenePlane } from './Scene3D';

/** Fusion's construction colour. */
export const CONSTRUCT_COLOR: [number, number, number] = [0.92, 0.55, 0.12];
const THREAD_COLOR: [number, number, number] = [0.28, 0.3, 0.36];

export interface ConstructSceneOptions {
  highlight: Set<string>;
  /** Construction planes take clicks (a sketch or a plane field is waiting for one). */
  pickPlanes: boolean;
  /** Size of the model: how large planes and axes are drawn. */
  size: number;
}

/** The box of a component's bodies (component coordinates): planes and axes are drawn round its middle. */
function boxOf(bodies: BodyResult[]): { min: Vec3; max: Vec3; mid: Vec3 } | null {
  const boxes = bodies.map((b) => b.box).filter((b): b is NonNullable<typeof b> => !!b);
  if (!boxes.length) return null;
  const min = [0, 1, 2].map((k) => Math.min(...boxes.map((b) => b.min[k]))) as Vec3, max = [0, 1, 2].map((k) => Math.max(...boxes.map((b) => b.max[k]))) as Vec3;
  return { min, max, mid: [0, 1, 2].map((k) => (min[k] + max[k]) / 2) as Vec3 };
}

/** Segments of a dashed line from a to b (component coordinates, mapped by M). */
function dashed(M: M4, a: Vec3, b: Vec3, n: number, out: number[]) {
  for (let i = 0; i < n; i++) {
    const p = add3(a, scale3(sub3(b, a), i / n)), q = add3(a, scale3(sub3(b, a), (i + 0.6) / n));
    out.push(...m4Point(M, p), ...m4Point(M, q));
  }
}

/** A circle of radius r about an axis (component coordinates, mapped by M). */
function ring(M: M4, c: Vec3, axis: Vec3, r: number, out: number[]) {
  const f = frameFromNormal(c, axis), n = 48;
  for (let i = 0; i < n; i++) {
    const a0 = (2 * Math.PI * i) / n, a1 = (2 * Math.PI * (i + 1)) / n;
    const p = add3(c, add3(scale3(f.u, r * Math.cos(a0)), scale3(f.v, r * Math.sin(a0))));
    const q = add3(c, add3(scale3(f.u, r * Math.cos(a1)), scale3(f.v, r * Math.sin(a1))));
    out.push(...m4Point(M, p), ...m4Point(M, q));
  }
}

/** One datum drawn in the view: planes (squares), lines (axes, points, a helix). */
function datumPieces(id: string, name: string, d: Datum, M: M4, box: ReturnType<typeof boxOf>, atOrigin: boolean, o: ConstructSceneOptions, planes: ScenePlane[], lines: SceneLines[]) {
  const hl = o.highlight.has(`item:${id}`) || o.highlight.has(`cp:${id}`);
  const color = CONSTRUCT_COLOR;
  const mid = box?.mid ?? [0, 0, 0];
  if (d.kind === 'plane') {
    const f = d.frame;
    // the square round its origin where that is a point of the model (a plane along a path,
    // through points, tangent to a face), else round the middle of the model
    const c = atOrigin ? f.o : sub3(mid, scale3(f.n, dot3(sub3(mid, f.o), f.n)));
    planes.push({ key: `cp:${id}`, origin: m4Point(M, c), u: m4Dir(M, f.u), v: m4Dir(M, f.v), size: Math.max(o.size * 0.15, 5), color, opacity: hl ? 0.22 : 0.12, label: name, highlight: hl, pickable: o.pickPlanes, unframed: true });
    return;
  }
  const seg: number[] = [];
  if (d.kind === 'axis') {
    const u = norm3(d.d), c = add3(d.p, scale3(u, dot3(sub3(mid, d.p), u))), L = Math.max(o.size * 0.7, 10);
    dashed(M, sub3(c, scale3(u, L)), add3(c, scale3(u, L)), 24, seg);
  } else if (d.kind === 'point') {
    const r = Math.max(o.size * 0.018, 0.5);
    for (const k of [0, 1, 2]) {
      const e: Vec3 = [0, 0, 0];
      e[k] = r;
      seg.push(...m4Point(M, sub3(d.p, e)), ...m4Point(M, add3(d.p, e)));
    }
  } else {
    const h = d.helix, n = Math.max(8, Math.ceil(h.turns * 48));
    for (let i = 0; i < n; i++) seg.push(...m4Point(M, helixPoint(h, (2 * Math.PI * h.turns * i) / n)), ...m4Point(M, helixPoint(h, (2 * Math.PI * h.turns * (i + 1)) / n)));
  }
  // a helix is the coil's real path; planes, axes and points do not move the view's framing
  lines.push({ key: `cl:${id}`, segments: new Float32Array(seg), color, highlight: hl, overlay: d.kind !== 'helix', unframed: d.kind !== 'helix' });
}

/** Rings a pitch apart round the faces cosmetic threads (and cosmetically tapped holes) are on. */
function threadRings(comp: CadComponent, dr: CadResult['design'], bodies: BodyResult[], M: M4, out: number[]) {
  for (const item of activeItems(comp)) {
    if (item.suppressed) continue;
    const p = dr?.params[item.id];
    if (!p?.P || dr?.errors[item.id]) continue;
    const faces: { b: BodyResult; index: number; flip?: boolean; length?: number; offset?: number }[] = [];
    if (item.kind === 'thread' && !item.modeled) {
      for (const ref of item.faces) {
        const r = resolveRef(ref, bodies);
        const b = r.ok ? bodies.find((q) => q.id === r.body) : undefined;
        if (b && r.ok) faces.push({ b, index: r.index, flip: item.flip, length: p.length, offset: p.offset });
      }
    } else if (item.kind === 'hole' && item.tap && !item.tap.modeled) {
      // the walls of its holes, threaded from their mouth
      for (const b of bodies) for (const f of b.faces) if (f.type === 'cylinder' && /\/hole\d+:wall/.test(f.key) && f.key.split('+').some((k) => k.startsWith(`${item.id}/hole`))) faces.push({ b, index: f.index, length: p.tdepth });
    }
    for (const q of faces) {
      try {
        const tf = threadFace(q.b, q.b.faces[q.index], q.flip);
        const from = q.offset ?? 0, to = Math.min(tf.length, from + (q.length ?? tf.length));
        const r = tf.radius * (tf.internal ? 0.996 : 1.004);
        for (let z = from + p.P / 2; z < to; z += p.P) ring(M, add3(tf.o, scale3(tf.axis, z)), tf.axis, r, out);
      } catch {
        /* not a cylinder any more: the feature says so */
      }
    }
  }
}

/** Planes and lines of the construction geometry and cosmetic threads of every shown occurrence. */
export function constructScene(design: CadDesign, result: CadResult | undefined, shown: BuildResult, placement: (occ: string) => M4 | undefined, o: ConstructSceneOptions): { planes: ScenePlane[]; lines: SceneLines[] } {
  const planes: ScenePlane[] = [], lines: SceneLines[] = [];
  const done = new Set<string>();
  for (const occ of design.occurrences) {
    const comp = design.components.find((c) => c.id === occ.component);
    const M = placement(occ.id);
    const built = comp && shown.components[comp.id];
    if (occ.hidden || !comp || !M || !built) continue;
    const box = boxOf(built.bodies);
    // construction geometry once per component, in its first occurrence (where it is edited)
    if (!done.has(comp.id)) {
      done.add(comp.id);
      for (const item of activeItems(comp)) {
        const d = built.datums?.[item.id];
        if (!d || ('hidden' in item && item.hidden) || item.suppressed) continue;
        if (d.kind === 'helix' && !(item.kind === 'coil' && item.pathOnly)) continue;
        const atOrigin = item.kind === 'plane' && ['path', 'points', 'tangent'].includes(item.def.type);
        datumPieces(item.id, item.name, d, M, box, atOrigin, o, planes, lines);
      }
    }
    const rings: number[] = [];
    threadRings(comp, result?.design, built.bodies.filter((b) => !comp.hiddenBodies?.includes(b.id)), M, rings);
    if (rings.length) lines.push({ key: `th:${occ.id}`, segments: new Float32Array(rings), color: THREAD_COLOR });
  }
  return { planes, lines };
}

/** The cosmetic threads and tapped holes on a face of a body, as words for the inspector. */
export function threadsOn(design: CadDesign, result: CadResult | undefined, cid: string, b: BodyResult, faceIndex: number): { name: string; size: string; modeled: boolean }[] {
  const comp = design.components.find((c) => c.id === cid);
  const f = b.faces[faceIndex];
  if (!comp || !f) return [];
  const out: { name: string; size: string; modeled: boolean }[] = [];
  for (const item of activeItems(comp)) {
    if (item.suppressed || !result?.design?.params[item.id]?.P) continue;
    const mine = (role: string) => f.key.split('+').some((k) => k.replace(/[#~]\d+$/, '').startsWith(`${item.id}/${role}`));
    if (item.kind === 'thread') {
      const on = item.modeled ? mine('thread') : item.faces.some((ref) => {
        const r = resolveRef(ref, [b]);
        return r.ok && r.index === faceIndex;
      });
      if (on) out.push({ name: item.name, size: item.size, modeled: !!item.modeled });
    } else if (item.kind === 'hole' && item.tap && (mine('hole') && (item.tap.modeled ? /:thread/.test(f.key) : /:wall/.test(f.key)))) {
      out.push({ name: item.name, size: item.tap.size, modeled: !!item.tap.modeled });
    }
  }
  return out;
}

