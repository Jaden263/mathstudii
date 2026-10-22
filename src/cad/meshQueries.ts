// Inspect questions about imported mesh bodies, which neither kernel builds: the volume a
// mesh body shares with another occurrence (Manifold's booleans on the closed meshes, the
// other bodies by their display meshes) and a section through one (its facets clipped and
// closed). The kernels answer for their own bodies; these add the pairs and bodies with a
// mesh in them.
import type { BuildResult, BodyResult } from './buildResult';
import type { CadDesign } from './design';
import { clipMesh, type DrawMesh } from './drawing';
import { weldedMesh } from './display';
import { capFaces, planeToLocal, type SectionPlane } from './inspect';
import { triangleParts } from './meshTopology';
import { meshMass } from './meshBody';
import type { Interference, SectionBody } from './occ/query';
import { Arena, frameFromNormal, scale3, type ManifoldToplevel, type Manifold, type M4, type Vec3 } from './solid';

interface Placed {
  occ: string;
  component: string;
  M: M4;
  body: BodyResult;
}

function placedBodies(shown: BuildResult, design: CadDesign): Placed[] {
  const out: Placed[] = [];
  for (const o of design.occurrences) {
    const comp = design.components.find((c) => c.id === o.component);
    const M = shown.placements[o.id]?.matrix;
    if (o.hidden || !comp || !M) continue;
    for (const body of shown.components[comp.id]?.bodies ?? []) {
      if (!comp.hiddenBodies?.includes(body.id) && body.mesh.indices.length) out.push({ occ: o.id, component: comp.id, M, body });
    }
  }
  return out;
}

export const hasMeshBodies = (shown: BuildResult | null) => !!shown && Object.values(shown.components).some((c) => c.bodies.some((b) => b.meshOnly));

const boxOf = (m: DrawMesh) => {
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < m.pos.length; i += 3) for (let k = 0; k < 3; k++) {
    min[k] = Math.min(min[k], m.pos[i + k]);
    max[k] = Math.max(max[k], m.pos[i + k]);
  }
  return { min, max };
};

/**
 * Volumes shared by pairs of occurrences, counting only body pairs with a mesh body in them
 * (the kernel measures the others). Open meshes enclose nothing: they are listed in `open`.
 */
export function meshInterference(K: ManifoldToplevel, shown: BuildResult, design: CadDesign): { rows: Interference[]; open: string[] } {
  const arena = new Arena();
  try {
    const ps = placedBodies(shown, design);
    const open = new Set<string>();
    const solid = new Map<Placed, { m: Manifold; box: { min: Vec3; max: Vec3 } } | null>();
    const solidOf = (p: Placed) => {
      if (solid.has(p)) return solid.get(p)!;
      let s: { m: Manifold; box: { min: Vec3; max: Vec3 } } | null = null;
      if (!p.body.meshOnly || p.body.mass.V > 0) {
        const w = weldedMesh(p.body, p.M);
        try {
          const mesh = new K.Mesh({ numProp: 3, vertProperties: Float32Array.from(w.pos), triVerts: w.tri });
          mesh.merge();
          const m = arena.add(new K.Manifold(mesh));
          if (m.status() === 'NoError' && !m.isEmpty()) s = { m, box: boxOf(w) };
        } catch {
          /* not a closed 2-manifold: no volume to share */
        }
      }
      if (!s && p.body.meshOnly) open.add(p.body.name);
      solid.set(p, s);
      return s;
    };
    const apart = (a: { min: Vec3; max: Vec3 }, b: { min: Vec3; max: Vec3 }) => [0, 1, 2].some((k) => a.max[k] < b.min[k] || b.max[k] < a.min[k]);
    const ids = [...new Set(ps.map((p) => p.occ))];
    const rows: Interference[] = [];
    for (let i = 0; i < ids.length; i++) for (let k = i + 1; k < ids.length; k++) {
      let v = 0;
      for (const a of ps) for (const b of ps) {
        if (a.occ !== ids[i] || b.occ !== ids[k] || !(a.body.meshOnly || b.body.meshOnly)) continue;
        const sa = solidOf(a), sb = solidOf(b);
        if (!sa || !sb || apart(sa.box, sb.box)) continue;
        const c = arena.add(sa.m.intersect(sb.m));
        v += c.volume();
      }
      if (v > 0) rows.push({ a: ids[i], b: ids[k], v });
    }
    return { rows, open: [...open] };
  } finally {
    arena.free();
  }
}

/** Rows of two interference checks added up, pair by pair. */
export function addInterference(a: Interference[], b: Interference[]): Interference[] {
  const out = a.map((r) => ({ ...r }));
  for (const r of b) {
    const hit = out.find((q) => (q.a === r.a && q.b === r.b) || (q.a === r.b && q.b === r.a));
    if (hit) hit.v += r.v;
    else out.push({ ...r });
  }
  return out;
}

/** The mesh bodies cut by a section plane (assembly coordinates): what lies on the normal's side, closed, in component coordinates. */
export function sectionMeshBodies(shown: BuildResult, design: CadDesign, plane: SectionPlane): SectionBody[] {
  const out: SectionBody[] = [];
  for (const p of placedBodies(shown, design)) {
    if (!p.body.meshOnly) continue;
    const local = planeToLocal(p.M, plane);
    const f = frameFromNormal(scale3(local.n, local.offset), local.n);
    const c = clipMesh(weldedMesh(p.body), f.o, f.n, f.u, f.v);
    if (!c) continue;
    const box = boxOf(c.mesh);
    const parts = triangleParts(c.mesh.pos, 3, c.mesh.tri, box);
    const body: BodyResult = { ...p.body, ...parts, mass: meshMass(c.mesh.pos, c.mesh.tri) };
    const size = Math.hypot(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]);
    out.push({ occ: p.occ, component: p.component, body, caps: capFaces(body, local, size) });
  }
  return out;
}
