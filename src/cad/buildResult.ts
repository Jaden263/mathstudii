// A built design as the display, picking, drawings and exports see it, whichever kernel
// made it: plain objects and typed arrays (safe to postMessage between a worker and the
// UI). Each body has a display mesh whose triangles know their face, a face table, an
// edge table, a vertex table and its mass properties.
//
// The B-rep kernel fills this exactly (occ/result.ts), with persistent names. The mesh
// kernel is the fallback (meshTopology.ts): its "faces" are smooth patches of the triangle
// mesh and its edges the creases between them, so they look right but carry no exact
// geometry beyond planes, and no names.
import { buildDesign, type CadDesign, type Datum, type DesignNumbers, type Placement } from './design';
import { meshBody, polylineMid } from './meshTopology';
import { meshBodyResult } from './meshBody';
import type { Frame, ManifoldToplevel, Mass3, Vec3 } from './solid';
import { edgeKey } from './topology';

export { edgeKey, meshBody, polylineMid };

export type SurfaceKind = 'plane' | 'cylinder' | 'cone' | 'sphere' | 'torus' | 'bspline' | 'other';
export type CurveKind = 'line' | 'circle' | 'ellipse' | 'bspline' | 'other';

export interface FaceInfo {
  index: number;
  /**
   * Persistent name from the feature history (topology.ts), unique in the body:
   * f1/side:l3 (the side swept by sketch line l3), f1/start, f1/end, f2/hole0:wall,
   * f3.2.f2/hole0:wall (a pattern copy), f1/end#2 (a piece of a split face), f1/end+f2/end
   * (merged faces); '' from the mesh kernel.
   */
  key: string;
  /** Feature that made the face ('' when unknown). */
  feature: string;
  type: SurfaceKind;
  area: number;
  /** Centroid of the face (on curved faces it lies off the surface). */
  c: Vec3;
  /** Planar faces: a frame at the face centroid, n pointing out of the material. */
  frame?: Frame;
  /** Cylinders, cones and tori (and spheres, through the centre). */
  axis?: { p: Vec3; d: Vec3 };
  /** Cylinder and sphere radius; a cone's radius where its axis starts; a torus' distance from its axis to the tube's centre. */
  radius?: number;
  /** Torus tube radius. */
  minorRadius?: number;
  /** Cone half angle (radians). */
  angle?: number;
  /** Cylinders and cones: the face looks away from its axis (a shaft) rather than towards it (a hole). */
  outward?: boolean;
}

export interface EdgeInfo {
  index: number;
  /** The keys of the two faces it joins, sorted, as `a|b` (`a|b~2` when they share several edges; '' from the mesh kernel). */
  key: string;
  type: CurveKind;
  /** Polyline for display and picking: x, y, z, x, y, z … */
  points: Float32Array;
  length: number;
  circle?: { c: Vec3; axis: Vec3; r: number };
  line?: { a: Vec3; b: Vec3 };
  /** The faces on either side (-1: none; a seam has the same face twice). */
  faces: [number, number];
  /** The point halfway along the curve. */
  mid: Vec3;
  /** Its end vertices (-1: none; a closed curve has one, twice). */
  v: [number, number];
}

export interface VertexInfo {
  index: number;
  /** The keys of the faces meeting there, sorted, `a|b|c` (with fewer than three faces: of its edges, `e1&e2`). */
  key: string;
  p: Vec3;
  /** The edges that meet there. */
  edges: number[];
}

export interface BodyMesh {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  /** Face index of every triangle. */
  faceOf: Uint32Array;
}

export interface BodyResult {
  id: string;
  name: string;
  feature: string;
  mesh: BodyMesh;
  faces: FaceInfo[];
  edges: EdgeInfo[];
  vertices: VertexInfo[];
  /** Volume properties (component coordinates, part units): exact from the B-rep kernel. */
  mass: Mass3;
  area: number;
  box: { min: Vec3; max: Vec3 } | null;
  /** An imported mesh body (meshBody.ts): no exact faces, not editable by the features. */
  meshOnly?: boolean;
}

export interface BuildResult {
  kernel: 'brep' | 'mesh';
  components: Record<string, {
    bodies: BodyResult[];
    errors: Record<string, string>;
    /** Problems that did not stop a feature (a lost reference). */
    warnings?: Record<string, string>;
    /** Sketch planes as built (a sketch on a face follows it) and construction planes. */
    frames?: Record<string, Frame>;
    /** Construction planes, axes and points and the helices of coils. */
    datums?: Record<string, Datum>;
  }>;
  placements: Record<string, Placement>;
  /** Joint and occurrence problems. */
  errors: Record<string, string>;
  warnings?: Record<string, string>;
}

/** The design built with the mesh kernel, as a BuildResult. */
export function meshBuildResult(K: ManifoldToplevel, design: CadDesign, numbers: DesignNumbers): BuildResult {
  const built = buildDesign(K, design, numbers);
  try {
    const out: BuildResult = { kernel: 'mesh', components: {}, placements: built.placements, errors: built.errors, warnings: built.warnings };
    for (const [cid, cb] of built.components) out.components[cid] = { bodies: [...cb.bodies.map(meshBody), ...(cb.meshes ?? []).map(meshBodyResult)], errors: cb.errors, warnings: cb.warnings, frames: cb.frames, datums: cb.datums };
    return out;
  } finally {
    built.free();
  }
}

