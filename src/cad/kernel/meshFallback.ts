// The kernel requests answered by the mesh kernel (Manifold), for when OpenCascade could
// not load: the same shapes of answers, from triangle meshes (faces and edges are the
// smooth patches and creases of the mesh, distances come from its vertices).
import { meshBody, type BodyResult } from '../buildResult';
import { buildDesign, type Body, type BuiltDesign, type CadDesign, type DesignNumbers } from '../design';
import { capFaces, planeToLocal, type SectionPlane } from '../inspect';
import { designKey } from '../keys';
import type { Vec2 } from '../profile';
import { Arena, boxOf, sectionInPlane, sharedVolume, transformSolid, type Frame, type M4, type ManifoldToplevel } from '../solid';
import { meshToStl } from '../stl';
import type { ExportScope } from '../occ/exchange';
import type { Interference, SectionBody } from '../occ/query';
import type { ExportMesh, ExportModel, ExportPart } from '../meshExport';
import { meshBodyResult } from '../meshBody';

let last: { key: string; built: BuiltDesign } | null = null;

/** The design built by the mesh kernel; the last one is kept for the next request. */
export function meshBuilt(K: ManifoldToplevel, design: CadDesign, numbers: DesignNumbers): BuiltDesign {
  const key = designKey(design, numbers);
  if (last?.key === key) return last.built;
  last?.built.free();
  last = { key, built: buildDesign(K, design, numbers) };
  return last.built;
}

function placed(built: BuiltDesign, design: CadDesign) {
  const out: { occ: string; component: string; M: M4; body: Body }[] = [];
  for (const o of design.occurrences) {
    const comp = design.components.find((c) => c.id === o.component);
    const M = built.placements[o.id]?.matrix;
    if (o.hidden || !comp || !M) continue;
    for (const body of built.components.get(comp.id)?.bodies ?? []) {
      if (!comp.hiddenBodies?.includes(body.id) && !body.solid.isEmpty()) out.push({ occ: o.id, component: comp.id, M, body });
    }
  }
  return out;
}

export function sectionMesh(built: BuiltDesign, design: CadDesign, plane: SectionPlane): SectionBody[] {
  const out: SectionBody[] = [];
  for (const { occ, component, M, body } of placed(built, design)) {
    const p = planeToLocal(M, plane);
    const kept = body.solid.trimByPlane(p.n, p.offset);
    try {
      if (kept.isEmpty()) continue;
      const res: BodyResult = meshBody({ ...body, solid: kept, exact: undefined });
      const bb = body.solid.boundingBox();
      out.push({ occ, component, body: res, caps: capFaces(res, p, Math.hypot(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2])) });
    } finally {
      kept.delete();
    }
  }
  return out;
}

export function outlineMesh(built: BuiltDesign, componentId: string, f: Frame): Vec2[][] {
  const out: Vec2[][] = [];
  for (const b of built.components.get(componentId)?.bodies ?? []) {
    if (!b.solid.isEmpty()) out.push(...sectionInPlane(b.solid, f));
  }
  return out;
}

export function interferenceMesh(built: BuiltDesign, design: CadDesign): Interference[] {
  const arena = new Arena();
  try {
    const ps = placed(built, design).map((p) => ({ ...p, solid: transformSolid(arena, p.body.solid, p.M) }));
    const ids = [...new Set(ps.map((p) => p.occ))];
    const rows: Interference[] = [];
    for (let i = 0; i < ids.length; i++) for (let k = i + 1; k < ids.length; k++) {
      let v = 0;
      for (const a of ps) for (const b of ps) if (a.occ === ids[i] && b.occ === ids[k]) v += sharedVolume(a.solid, b.solid);
      if (v > 0) rows.push({ a: ids[i], b: ids[k], v });
    }
    return rows;
  } finally {
    arena.free();
  }
}

/** A binary STL of the scope from the mesh kernel's triangles, part units times `scale`. */
export function stlMesh(built: BuiltDesign, design: CadDesign, scope: ExportScope, name: string, scale = 1): Uint8Array {
  const arena = new Arena();
  try {
    return stlOf(arena, built, design, scope, name, scale);
  } finally {
    arena.free();
  }
}

function stlOf(arena: Arena, built: BuiltDesign, design: CadDesign, scope: ExportScope, name: string, scale: number): Uint8Array {
  const solids = scope.kind === 'assembly'
    ? placed(built, design).map((p) => transformSolid(arena, p.body.solid, p.M))
    : (built.components.get(scope.component)?.bodies ?? []).filter((b) => !b.solid.isEmpty() && (scope.kind !== 'body' || b.id === scope.body)).map((b) => b.solid);
  if (!solids.length || !boxOf(solids)) throw new Error('there is no solid to export');
  const parts: Float32Array[] = [];
  for (const s of solids) {
    const m = s.getMesh();
    const p = new Float32Array(m.triVerts.length * 3);
    for (let k = 0; k < m.triVerts.length; k++) for (let d = 0; d < 3; d++) p[3 * k + d] = m.vertProperties[m.triVerts[k] * m.numProp + d] * scale;
    parts.push(p);
  }
  const all = new Float32Array(parts.reduce((s, p) => s + p.length, 0));
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.length;
  }
  return meshToStl({ positions: all, normals: all, edges: new Float32Array(0), bounds: { min: [0, 0, 0], max: [0, 0, 0] } }, name);
}

/** The scope as meshes for the mesh formats, from the mesh kernel's solids (and the mesh bodies as they are). */
export function exportModelMesh(built: BuiltDesign, design: CadDesign, scope: ExportScope, o: { name?: string; mm?: number } = {}): ExportModel {
  const parts: ExportPart[] = [];
  const instances: ExportModel['instances'] = [];
  const of = new Map<string, number>();
  const partFor = (cid: string, only?: string) => {
    const key = `${cid}/${only ?? ''}`;
    if (of.has(key)) return of.get(key)!;
    const comp = design.components.find((c) => c.id === cid);
    const cb = built.components.get(cid);
    const shown = (id: string) => (only ? id === only : !comp?.hiddenBodies?.includes(id));
    const meshes: ExportMesh[] = [];
    for (const b of cb?.bodies ?? []) {
      if (!shown(b.id) || b.solid.isEmpty()) continue;
      const m = b.solid.getMesh();
      const positions = new Float32Array(m.vertProperties.length / m.numProp * 3);
      for (let v = 0; v < positions.length / 3; v++) for (let d = 0; d < 3; d++) positions[3 * v + d] = m.vertProperties[v * m.numProp + d];
      meshes.push({ name: b.name, positions, indices: new Uint32Array(m.triVerts) });
    }
    for (const mb of cb?.meshes ?? []) {
      if (!shown(mb.id)) continue;
      const r = meshBodyResult(mb);
      meshes.push({ name: mb.name, positions: r.mesh.positions, normals: r.mesh.normals, indices: r.mesh.indices });
    }
    of.set(key, parts.length);
    parts.push({ name: only ? meshes[0]?.name ?? 'Body' : comp?.name ?? 'Part', ...(comp?.color ? { color: comp.color } : {}), meshes });
    return parts.length - 1;
  };
  if (scope.kind === 'assembly') {
    design.occurrences.forEach((occ, i) => {
      const M = built.placements[occ.id]?.matrix;
      if (occ.hidden || !M) return;
      const name = occ.name?.trim() || `${design.components.find((c) => c.id === occ.component)?.name ?? 'Part'}:${i + 1}`;
      instances.push({ name, part: partFor(occ.component), M });
    });
  } else {
    const p = partFor(scope.component, scope.kind === 'body' ? scope.body : undefined);
    instances.push({ name: parts[p].name, part: p, M: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] });
  }
  if (!instances.some((x) => parts[x.part]?.meshes.some((m) => m.indices.length))) throw new Error('there is nothing to export');
  return { name: o.name?.trim() || (scope.kind === 'assembly' ? 'Assembly' : parts[0]?.name ?? 'Part'), parts, instances, mm: o.mm ?? 1 };
}
