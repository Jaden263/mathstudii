// The 3-D side of a CAD part in the UI: the kernel, the built design (cached per part)
// and the scene a viewport draws (bodies, sketches, profiles, origin planes).
import { useEffect, useMemo, useState } from 'react';
import earcut from 'earcut';
import type { CadRegion } from '../../model/types';
import type { CadResult } from '../../cad/evaluate';
import {
  activeItems, buildDesign, designOf, isSketch, profileKey, type BuiltDesign, type CadDesign, type DesignNumbers, type DesignSketch,
} from '../../cad/design';
import { findProfiles, loopPolygon, type ProfileRegion, type Vec2 } from '../../cad/profile';
import type { Mesh } from '../../cad/mesh';
import { framePoint, kernel, sectionInPlane, solidMesh, toMat4, type Frame, type M4, type Manifold, type ManifoldToplevel } from '../../cad/solid';
import { loadKernel } from '../../cad/kernelBrowser';
import type { SceneLines, SceneMesh, ScenePlane, Vec3 } from './Scene3D';

/** The solid kernel, once it has loaded. */
export function useKernel(): ManifoldToplevel | null {
  const [k, setK] = useState(kernel);
  useEffect(() => {
    if (k) return;
    let live = true;
    loadKernel().then((m) => live && setK(m)).catch(() => {});
    return () => {
      live = false;
    };
  }, [k]);
  return k;
}

interface CacheEntry {
  design: CadDesign;
  numbers: DesignNumbers;
  built: BuiltDesign;
  meshes: Map<string, Mesh>;
}

/**
 * One built design per part. A new build replaces (and frees) the previous one; nothing
 * is freed on unmount, so React's double rendering never touches freed WASM objects.
 */
const cache = new Map<string, CacheEntry>();

export interface Built {
  built: BuiltDesign;
  /** Display mesh of a body, in component coordinates. */
  mesh(componentId: string, bodyId: string): Mesh | null;
}

export function useBuilt(regionId: string, design: CadDesign, result: CadResult | undefined): Built | null {
  const K = useKernel();
  const numbers = result?.design;
  return useMemo(() => {
    if (!K || !numbers) return null;
    let e = cache.get(regionId);
    if (!e || e.design !== design || e.numbers !== numbers) {
      e?.built.free();
      e = { design, numbers, built: buildDesign(K, design, numbers), meshes: new Map() };
      cache.set(regionId, e);
    }
    const entry = e;
    return {
      built: entry.built,
      mesh(cid, bid) {
        const key = `${cid}/${bid}`;
        let m = entry.meshes.get(key);
        if (!m) {
          const b = entry.built.components.get(cid)?.bodies.find((q) => q.id === bid);
          if (!b || b.solid.isEmpty()) return null;
          m = solidMesh(b.solid);
          entry.meshes.set(key, m);
        }
        return m;
      },
    };
  }, [K, regionId, design, numbers]);
}

// ------------------------------------------------------------ scene pieces

export const PALETTE: [number, number, number][] = [
  [0.64, 0.69, 0.77], [0.83, 0.64, 0.45], [0.56, 0.74, 0.6], [0.74, 0.62, 0.8], [0.84, 0.76, 0.46], [0.5, 0.72, 0.82],
];

export function hexColor(h?: string): [number, number, number] | null {
  const m = h && /^#?([\da-f]{6})$/i.exec(h.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function componentColor(design: CadDesign, cid: string): [number, number, number] {
  const i = design.components.findIndex((c) => c.id === cid);
  return hexColor(design.components[i]?.color) ?? PALETTE[Math.max(0, i) % PALETTE.length];
}

/** The occurrence a component is edited in (its first one). */
export function editOccurrence(design: CadDesign, cid: string) {
  return design.occurrences.find((o) => o.component === cid);
}

/** Flat, two-sided mesh of profile regions in a sketch frame (component coordinates). */
export function profileMesh(regions: ProfileRegion[], f: Frame, lift: number): Mesh {
  const pos: number[] = [], nrm: number[] = [];
  const min: [number, number, number] = [Infinity, Infinity, Infinity], max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const r of regions) {
    const loops = [r.outer, ...r.holes].map((l) => loopPolygon(l, Math.PI / 36));
    const flat: number[] = [], holes: number[] = [];
    const all: Vec2[] = [];
    loops.forEach((pts, k) => {
      if (k) holes.push(all.length);
      for (const p of pts) { flat.push(p.x, p.y); all.push(p); }
    });
    const idx = earcut(flat, holes, 2);
    for (let t = 0; t < idx.length; t += 3) {
      for (const [sign, order] of [[1, [0, 1, 2]], [-1, [0, 2, 1]]] as const) {
        for (const k of order) {
          const q = framePoint(f, all[idx[t + k]], sign * lift);
          pos.push(...q);
          nrm.push(...f.n.map((v) => v * sign));
          for (let d = 0; d < 3; d++) {
            min[d] = Math.min(min[d], q[d]);
            max[d] = Math.max(max[d], q[d]);
          }
        }
      }
    }
  }
  if (!pos.length) min.fill(0), max.fill(0);
  return { positions: new Float32Array(pos), normals: new Float32Array(nrm), edges: new Float32Array(0), bounds: { min, max } };
}

/** Sketch curves as 3-D segments (component coordinates). */
export function sketchSegments(ds: DesignSketch, f: Frame, sol?: { points: Record<string, [number, number]>; radii: Record<string, number> }, construction = false): Float32Array {
  const P = (id: string): Vec2 => {
    const q = sol?.points[id];
    if (q) return { x: q[0], y: q[1] };
    const p = ds.sketch.points.find((x) => x.id === id);
    return p ? { x: p.x, y: p.y } : { x: 0, y: 0 };
  };
  const out: number[] = [];
  const seg = (a: Vec2, b: Vec2) => out.push(...framePoint(f, a), ...framePoint(f, b));
  const arc = (c: Vec2, r: number, a0: number, a1: number) => {
    const n = Math.max(4, Math.ceil(Math.abs(a1 - a0) / (Math.PI / 36)));
    for (let i = 0; i < n; i++) {
      const t0 = a0 + ((a1 - a0) * i) / n, t1 = a0 + ((a1 - a0) * (i + 1)) / n;
      seg({ x: c.x + r * Math.cos(t0), y: c.y + r * Math.sin(t0) }, { x: c.x + r * Math.cos(t1), y: c.y + r * Math.sin(t1) });
    }
  };
  for (const e of ds.sketch.entities) {
    if (!!e.construction !== construction) continue;
    if (e.type === 'line') seg(P(e.p1), P(e.p2));
    else if (e.type === 'circle') arc(P(e.c), Math.abs(sol?.radii[e.id] ?? e.r), 0, 2 * Math.PI);
    else if (e.type === 'arc') {
      const c = P(e.c), a = P(e.p1), b = P(e.p2);
      const a0 = Math.atan2(a.y - c.y, a.x - c.x);
      let a1 = Math.atan2(b.y - c.y, b.x - c.x);
      while (a1 <= a0 + 1e-12) a1 += 2 * Math.PI;
      arc(c, Math.hypot(a.x - c.x, a.y - c.y), a0, a1);
    } else if (e.type === 'point') {
      const p = P(e.p), s = 0.8;
      seg({ x: p.x - s, y: p.y }, { x: p.x + s, y: p.y });
      seg({ x: p.x, y: p.y - s }, { x: p.x, y: p.y + s });
    }
  }
  return new Float32Array(out);
}

export function transformSegments(seg: Float32Array, M: M4): Float32Array {
  const out = new Float32Array(seg.length);
  for (let i = 0; i < seg.length; i += 3) {
    const x = seg[i], y = seg[i + 1], z = seg[i + 2];
    out[i] = M[0] * x + M[4] * y + M[8] * z + M[12];
    out[i + 1] = M[1] * x + M[5] * y + M[9] * z + M[13];
    out[i + 2] = M[2] * x + M[6] * y + M[10] * z + M[14];
  }
  return out;
}

const mapPoint = (M: M4, p: Vec3): Vec3 => [
  M[0] * p[0] + M[4] * p[1] + M[8] * p[2] + M[12], M[1] * p[0] + M[5] * p[1] + M[9] * p[2] + M[13], M[2] * p[0] + M[6] * p[1] + M[10] * p[2] + M[14],
];
const mapDir = (M: M4, p: Vec3): Vec3 => [M[0] * p[0] + M[4] * p[1] + M[8] * p[2], M[1] * p[0] + M[5] * p[1] + M[9] * p[2], M[2] * p[0] + M[6] * p[1] + M[10] * p[2]];

export interface SceneOptions {
  /** Component whose sketches and profiles are shown and pickable. */
  active: string;
  /** Keys of highlighted things (bodies `b:occ:body`, profiles `p:sketch:key`, planes `pl:XY`, sketches `s:id`). */
  highlight: Set<string>;
  showPlanes: boolean;
  /** Profiles are pickable (an extrude / revolve dialog is open). */
  pickProfiles: boolean;
  /** Ghost everything outside the active component. */
  isolate?: boolean;
  /** Feature id the timeline marker sits after (later sketches are hidden). */
  size: number;
  /** Section view: keep what lies on the normal's side of the plane n·x = offset (world). */
  section?: { n: Vec3; offset: number };
}

/** Trimmed bodies and their cut faces, per solid and plane (scenes rebuild on every hover). */
const sectionCache = new WeakMap<Manifold, Map<string, { mesh: Mesh | null; cap: Mesh | null }>>();

function sectionOf(solid: Manifold, M: M4, sec: { n: Vec3; offset: number }, size: number): { mesh: Mesh | null; cap: Mesh | null } {
  const key = `${M.join(',')}|${sec.n.join(',')}|${sec.offset}`;
  let byKey = sectionCache.get(solid);
  if (!byKey) sectionCache.set(solid, (byKey = new Map()));
  const hit = byKey.get(key);
  if (hit) return hit;
  const world = solid.transform(toMat4(M));
  const kept = world.trimByPlane(sec.n, sec.offset);
  const out: { mesh: Mesh | null; cap: Mesh | null } = { mesh: kept.isEmpty() ? null : solidMesh(kept), cap: null };
  // the cut face, a hair in front of the trimmed solid's own face so it shows in colour
  const n = sec.n;
  const u: Vec3 = Math.abs(n[2]) < 0.9 ? normalize(cross(n, [0, 0, 1])) : normalize(cross(n, [1, 0, 0]));
  const v = cross(n, u);
  const lift = -size * 2e-4;
  const f: Frame = { o: [n[0] * (sec.offset + lift), n[1] * (sec.offset + lift), n[2] * (sec.offset + lift)], u, v, n };
  const polys = sectionInPlane(world, { ...f, o: [n[0] * sec.offset, n[1] * sec.offset, n[2] * sec.offset] });
  if (polys.length && K_TRI) {
    const tris = K_TRI(polys.map((p) => p.map((q) => [q.x, q.y] as [number, number])));
    const flat = polys.flat();
    const pos: number[] = [], nrm: number[] = [], edges: number[] = [];
    for (const t of tris) {
      // facing the side that was cut away
      for (const i of [t[0], t[2], t[1]]) {
        const w = framePoint(f, flat[i]);
        pos.push(...w);
        nrm.push(-n[0], -n[1], -n[2]);
      }
    }
    for (const p of polys) {
      for (let i = 0; i < p.length; i++) edges.push(...framePoint(f, p[i]), ...framePoint(f, p[(i + 1) % p.length]));
    }
    const min: [number, number, number] = [Infinity, Infinity, Infinity], max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], pos[i + k]); max[k] = Math.max(max[k], pos[i + k]); }
    out.cap = { positions: new Float32Array(pos), normals: new Float32Array(nrm), edges: new Float32Array(edges), bounds: { min, max } };
  }
  world.delete();
  kept.delete();
  byKey.set(key, out);
  return out;
}

let K_TRI: ((polys: [number, number][][]) => number[][]) | null = null;
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalize = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

export interface Scene {
  meshes: SceneMesh[];
  lines: SceneLines[];
  planes: ScenePlane[];
}

/** Profiles of a sketch from the result (falls back to the stored geometry). */
export function sketchRegions(ds: DesignSketch, result?: CadResult): ProfileRegion[] {
  const sol = result?.design?.sketches[ds.id];
  return sol
    ? findProfiles(ds.sketch, new Map(Object.entries(sol.points).map(([id, [x, y]]) => [id, { x, y }])), new Map(Object.entries(sol.radii))).regions
    : findProfiles(ds.sketch).regions;
}

export function buildScene(region: CadRegion, design: CadDesign, result: CadResult | undefined, built: Built | null, o: SceneOptions): Scene {
  const meshes: SceneMesh[] = [], lines: SceneLines[] = [], planes: ScenePlane[] = [];
  const dr = result?.design;
  for (const occ of design.occurrences) {
    if (occ.hidden) continue;
    const comp = design.components.find((c) => c.id === occ.component);
    const M = built?.built.placements[occ.id]?.matrix ?? dr?.placements[occ.id]?.matrix;
    if (!comp || !M || !built) continue;
    const color = componentColor(design, comp.id);
    for (const b of built.built.components.get(comp.id)?.bodies ?? []) {
      if (comp.hiddenBodies?.includes(b.id)) continue;
      const key = `b:${occ.id}:${b.id}`;
      const look = { color, highlight: o.highlight.has(key) || o.highlight.has(`o:${occ.id}`), ghost: o.isolate && comp.id !== o.active };
      if (o.section && !b.solid.isEmpty()) {
        const K = kernel();
        if (K && !K_TRI) K_TRI = (polys) => K.triangulate(polys) as unknown as number[][];
        const sec = sectionOf(b.solid, M, o.section, o.size);
        if (sec.mesh) meshes.push({ key, mesh: sec.mesh, ...look });
        if (sec.cap) meshes.push({ key: `${key}:cut`, mesh: sec.cap, color: [0.87, 0.42, 0.25], pickable: false });
        continue;
      }
      const mesh = built.mesh(comp.id, b.id);
      if (!mesh) continue;
      meshes.push({ key, mesh, matrix: M, ...look });
    }
  }
  // sketches and profiles of the active component, in its first occurrence
  const comp = design.components.find((c) => c.id === o.active);
  const occ = comp && editOccurrence(design, comp.id);
  const M = (occ && (built?.built.placements[occ.id]?.matrix ?? dr?.placements[occ.id]?.matrix)) || null;
  if (comp && M) {
    const lift = o.size * 2e-4;
    for (const item of activeItems(comp)) {
      if (!isSketch(item) || item.hidden) continue;
      const f = dr?.frames[item.id];
      if (!f) continue;
      const sol = dr?.sketches[item.id];
      const hl = o.highlight.has(`s:${item.id}`);
      lines.push({ key: `s:${item.id}`, segments: transformSegments(sketchSegments(item, f, sol), M), color: [0.18, 0.44, 0.87], highlight: hl, overlay: hl });
      const cons = sketchSegments(item, f, sol, true);
      if (cons.length) lines.push({ key: `sc:${item.id}`, segments: transformSegments(cons, M), color: [0.55, 0.58, 0.64] });
      const regions = sketchRegions(item, result);
      regions.forEach((r) => {
        const key = `p:${item.id}:${profileKey(r)}`;
        const on = o.highlight.has(key);
        meshes.push({
          key, mesh: profileMesh([r], f, lift), color: on ? [0.18, 0.44, 0.87] : [0.47, 0.62, 0.9], matrix: M,
          opacity: on ? 0.55 : o.pickProfiles ? 0.28 : 0.14, pickable: o.pickProfiles, highlight: on,
        });
      });
    }
  }
  if (o.showPlanes && M) {
    const s = Math.max(o.size * 0.35, 10);
    const tint: Record<string, [number, number, number]> = { XY: [0.18, 0.44, 0.87], XZ: [0.18, 0.62, 0.27], YZ: [0.82, 0.22, 0.22] };
    for (const [ref, f] of Object.entries({
      XY: { o: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0] }, XZ: { o: [0, 0, 0], u: [1, 0, 0], v: [0, 0, 1] }, YZ: { o: [0, 0, 0], u: [0, 1, 0], v: [0, 0, 1] },
    } as Record<string, { o: Vec3; u: Vec3; v: Vec3 }>)) {
      planes.push({ key: `pl:${ref}`, origin: mapPoint(M, f.o), u: mapDir(M, f.u), v: mapDir(M, f.v), size: s, color: tint[ref], opacity: 0.1, label: ref, highlight: o.highlight.has(`pl:${ref}`) });
    }
  }
  void region;
  return { meshes, lines, planes };
}

export function designOfRegion(r: CadRegion): CadDesign {
  return designOf(r);
}
