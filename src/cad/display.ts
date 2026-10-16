// Display data of a body for the 3-D view and the drawings, made from its BuildResult
// on the UI side: triangles sorted by face (a face is one contiguous run, so it can be
// drawn on its own to highlight it), B-rep edges as line segments with the run of every
// edge, and a welded mesh for the hidden-line drawings.
import type { BodyResult, BuildResult } from './buildResult';
import type { CadDesign } from './design';
import type { DrawMesh } from './drawing';
import type { M4, Vec3 } from './solid';

export interface DisplayMesh {
  positions: Float32Array;
  normals: Float32Array;
  /** Triangles sorted by face: face f owns triangles faceStart[f] … faceStart[f + 1] − 1. */
  indices: Uint32Array;
  faceStart: Uint32Array;
  /** Face of every triangle (in the sorted order). */
  faceOf: Uint32Array;
  /** Edges as line segments (x, y, z pairs): edge e owns segments edgeStart[e] … edgeStart[e + 1] − 1 (none for a seam). */
  lines: Float32Array;
  edgeStart: Uint32Array;
  bounds: { min: Vec3; max: Vec3 };
}

const cache = new WeakMap<BodyResult, DisplayMesh>();

/** Display mesh of a body (made once per BodyResult). */
export function displayMesh(b: BodyResult): DisplayMesh {
  let d = cache.get(b);
  if (!d) cache.set(b, (d = makeDisplay(b)));
  return d;
}

function makeDisplay(b: BodyResult): DisplayMesh {
  const { positions, normals, indices, faceOf } = b.mesh;
  const nt = faceOf.length;
  // counting sort of the triangles by face (stable, so a face keeps OCCT's order)
  let faces = b.faces.length;
  for (let t = 0; t < nt; t++) faces = Math.max(faces, faceOf[t] + 1);
  const faceStart = new Uint32Array(faces + 1);
  for (let t = 0; t < nt; t++) faceStart[faceOf[t] + 1]++;
  for (let f = 0; f < faces; f++) faceStart[f + 1] += faceStart[f];
  const fill = faceStart.slice(0, faces);
  const sorted = new Uint32Array(indices.length), sortedFace = new Uint32Array(nt);
  for (let t = 0; t < nt; t++) {
    const at = fill[faceOf[t]]++;
    sorted.set(indices.subarray(3 * t, 3 * t + 3), 3 * at);
    sortedFace[at] = faceOf[t];
  }
  // edge polylines → segments; seams (a closed surface meeting itself) are not drawn
  const drawn = (e: BodyResult['edges'][number]) => e.faces[0] !== e.faces[1];
  const edgeStart = new Uint32Array(b.edges.length + 1);
  let segs = 0;
  b.edges.forEach((e, i) => {
    if (drawn(e)) segs += Math.max(0, e.points.length / 3 - 1);
    edgeStart[i + 1] = segs;
  });
  const lines = new Float32Array(segs * 6);
  let o = 0;
  for (const e of b.edges) {
    if (!drawn(e)) continue;
    const p = e.points;
    for (let i = 3; i + 2 < p.length; i += 3) {
      lines.set(p.subarray(i - 3, i + 3), o);
      o += 6;
    }
  }
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 2 < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      if (positions[i + k] < min[k]) min[k] = positions[i + k];
      if (positions[i + k] > max[k]) max[k] = positions[i + k];
    }
  }
  if (!(min[0] <= max[0])) min.fill(0), max.fill(0);
  return { positions, normals, indices: sorted, faceStart, faceOf: sortedFace, lines, edgeStart, bounds: { min, max } };
}

/**
 * The body's triangles with vertices shared wherever positions coincide (faces meet along
 * edges tessellated once, so their vertices are the same), moved by a placement: what
 * the hidden-line drawing needs to tell creases from smooth seams.
 */
export function weldedMesh(b: BodyResult, M?: M4): DrawMesh {
  const { positions: P, indices: I } = b.mesh;
  const index = new Map<string, number>();
  const map = new Uint32Array(P.length / 3);
  const pos: number[] = [];
  for (let v = 0; v < map.length; v++) {
    const x = P[3 * v], y = P[3 * v + 1], z = P[3 * v + 2];
    const k = `${x},${y},${z}`;
    let i = index.get(k);
    if (i === undefined) {
      i = pos.length / 3;
      index.set(k, i);
      if (M) pos.push(M[0] * x + M[4] * y + M[8] * z + M[12], M[1] * x + M[5] * y + M[9] * z + M[13], M[2] * x + M[6] * y + M[10] * z + M[14]);
      else pos.push(x, y, z);
    }
    map[v] = i;
  }
  const tri = new Uint32Array(I.length);
  for (let k = 0; k < I.length; k++) tri[k] = map[I[k]];
  return { pos: new Float64Array(pos), tri };
}

/** Welded meshes of every visible body, placed in the assembly (what a drawing shows). */
export function drawMeshes(build: BuildResult, design: CadDesign): DrawMesh[] {
  const out: DrawMesh[] = [];
  for (const occ of design.occurrences) {
    const comp = design.components.find((c) => c.id === occ.component);
    const M = build.placements[occ.id]?.matrix;
    if (occ.hidden || !comp || !M) continue;
    for (const b of build.components[comp.id]?.bodies ?? []) {
      if (!comp.hiddenBodies?.includes(b.id) && b.mesh.indices.length) out.push(weldedMesh(b, M));
    }
  }
  return out;
}
