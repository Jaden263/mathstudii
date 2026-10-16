// The B-rep kernel: OpenCascade (OCCT, the WASM build made for replicad, LGPL-2.1).
// Solids are exact boundary representations, so circles stay circles, fillets are
// real rolling-ball surfaces and volumes come from surface integrals, not facets.
//
// The module is large (23 MB, 7 MB compressed), so it loads on demand; until then, or
// if it cannot load, the mesh kernel (Manifold) builds the designs.
//
// Every OCCT object lives in WASM memory and must be deleted. Builds collect what they
// make in an Arena (solid.ts) and free it at the end; short-lived helpers use their own.
import type {
  GProp_GProps, GeomAbs_SurfaceType, NCollection_List_TopoDS_Shape, OpenCascadeInstance, TopAbs_ShapeEnum, TopoDS_Shape, gp_Ax1, gp_Ax2, gp_Ax3, gp_Dir, gp_Pnt, gp_Trsf, gp_Vec,
} from 'replicad-opencascadejs';
import { Arena, norm3, type Frame, type M4, type Vec3 } from '../solid';

export type OC = OpenCascadeInstance;
export type { TopoDS_Shape };

let K: OC | null = null;
let loading: Promise<OC> | null = null;
let renewing: Promise<OC> | null = null;
let url: string | undefined;
let enabled = true;
let failure: string | null = null;

/** The B-rep kernel, or null while it loads, after it failed to, or while switched off. */
export function occ(): OC | null {
  return enabled ? K : null;
}

/** Why the kernel could not load, or null (not tried yet, loading, or loaded). */
export function occFailure(): string | null {
  return failure;
}

/** Switch the B-rep kernel off (the mesh kernel then builds everything) and on again. */
export function setOccEnabled(on: boolean) {
  enabled = on;
}

/**
 * Load the kernel once. Browsers pass the bundled .wasm URL; Node (tests) finds the
 * file next to the package's script.
 */
export function initOcc(wasmUrl?: string): Promise<OC> {
  if (K) return Promise.resolve(K);
  url = wasmUrl;
  loading ??= instantiate().then(
    (m) => (K = m),
    (e) => {
      failure = e instanceof Error ? e.message : String(e);
      throw e;
    },
  );
  return loading;
}

async function instantiate(): Promise<OC> {
  const { default: init } = await import('replicad-opencascadejs');
  // OCCT reports every STEP transfer on stdout; nobody reads it
  const quiet = () => {};
  return init({ ...(url ? { locateFile: () => url } : {}), print: quiet, printErr: quiet });
}

/** Heap size past which the kernel is renewed (see renewOcc). */
const RENEW_BYTES = 768 * 2 ** 20;

/**
 * OCCT itself leaks a little inside some algorithms (in this build about 10 kB per
 * boolean and 50 kB per fillet, with every handle deleted), so a long session slowly
 * fills the WASM heap. Call this between builds: once the heap is past `limit` a fresh
 * instance loads in the background and takes over when it is ready (never in the middle
 * of a build, which is synchronous), and the old one goes with the garbage. Returns the
 * pending renewal, if any.
 */
export function renewOcc(limit = RENEW_BYTES): Promise<OC> | null {
  if (!K || renewing || K.wasmMemory.buffer.byteLength < limit) return renewing;
  renewing = instantiate().then(
    (m) => {
      K = m;
      renewing = null;
      return m;
    },
    (e) => {
      renewing = null;
      throw e;
    },
  );
  return renewing;
}

// ------------------------------------------------------------ errors

/**
 * OCCT failures arrive as WebAssembly exceptions holding a C++ Standard_Failure; turn
 * them into Errors with our message (OCCT's own is kept as the cause) and free them.
 */
export function occError(oc: OC, e: unknown, what: string): Error {
  // a trap (out of memory, a crash inside OCCT) can leave the instance broken: replace it
  // (the swap happens once the new one has loaded, so never in the middle of a build)
  if (typeof WebAssembly !== 'undefined' && e instanceof WebAssembly.RuntimeError) {
    renewOcc(0)?.catch((err) => console.warn('restarting the B-rep kernel failed', err));
    return new Error(`${what} (the B-rep kernel failed and restarts)`, { cause: e });
  }
  if (e instanceof Error) return e;
  let cause = String(e);
  if (typeof WebAssembly !== 'undefined' && 'Exception' in WebAssembly && e instanceof WebAssembly.Exception) {
    try {
      const [type, message] = oc.getExceptionMessage(e);
      cause = `${type}: ${message}`;
      oc.decrementExceptionRefcount(e);
    } catch {
      /* not an OCCT exception */
    }
  }
  return new Error(what, { cause });
}

/** Run an OCCT step; a failure becomes an Error saying `what` went wrong. */
export function guard<T>(oc: OC, what: string, fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    throw occError(oc, e, what);
  }
}

/** Run with a scratch arena that is freed afterwards (whatever fn returns must not live in it). */
export function scratch<T>(fn: (t: Arena) => T): T {
  const t = new Arena();
  try {
    return fn(t);
  } finally {
    t.free();
  }
}

// ------------------------------------------------------------ geometry values

export const pnt = (oc: OC, t: Arena, p: Vec3): gp_Pnt => t.add(new oc.gp_Pnt(p[0], p[1], p[2]));
export const dir = (oc: OC, t: Arena, d: Vec3): gp_Dir => {
  const n = norm3(d);
  return t.add(new oc.gp_Dir(n[0], n[1], n[2]));
};
export const vec = (oc: OC, t: Arena, v: Vec3): gp_Vec => t.add(new oc.gp_Vec(v[0], v[1], v[2]));
export const ax1 = (oc: OC, t: Arena, p: Vec3, d: Vec3): gp_Ax1 => t.add(new oc.gp_Ax1(pnt(oc, t, p), dir(oc, t, d)));
/** Right-handed placement: origin, main (z) direction and x direction. */
export const ax2 = (oc: OC, t: Arena, p: Vec3, z: Vec3, x: Vec3): gp_Ax2 => t.add(new oc.gp_Ax2(pnt(oc, t, p), dir(oc, t, z), dir(oc, t, x)));
/** A sketch frame as an OCCT coordinate system (x → u, z → n). */
export const frameAx3 = (oc: OC, t: Arena, f: Frame): gp_Ax3 => t.add(new oc.gp_Ax3(pnt(oc, t, f.o), dir(oc, t, f.n), dir(oc, t, f.u)));

/** An affine matrix (column-major, rigid or mirroring) as an OCCT transformation. */
export function trsf(oc: OC, t: Arena, M: M4): gp_Trsf {
  const T = t.add(new oc.gp_Trsf());
  T.SetValues(M[0], M[4], M[8], M[12], M[1], M[5], M[9], M[13], M[2], M[6], M[10], M[14]);
  return T;
}

export const xyz = (p: { X(): number; Y(): number; Z(): number }): Vec3 => [p.X(), p.Y(), p.Z()];

export function occBox(oc: OC, shapes: TopoDS_Shape[]): { min: Vec3; max: Vec3 } | null {
  return scratch((t) => {
    const bb = t.add(new oc.Bnd_Box());
    // the optimal box hugs curved faces (the plain one is padded by their control points)
    for (const s of shapes) oc.BRepBndLib.AddOptimal(s, bb, false, false);
    if (bb.IsVoid()) return null;
    return { min: [bb.GetXMin(), bb.GetYMin(), bb.GetZMin()], max: [bb.GetXMax(), bb.GetYMax(), bb.GetZMax()] };
  });
}

// ------------------------------------------------------------ topology

/**
 * Shapes by identity: the same TShape at the same location, in either orientation (what
 * OCCT's shape maps do; this build cannot construct those).
 */
export class ShapeIndex {
  private buckets = new Map<number, number[]>();
  readonly shapes: TopoDS_Shape[] = [];
  constructor(private oc: OC) {}
  private hash(s: TopoDS_Shape) {
    return this.oc.ReplicadShapeHasher.HashCode(s, 2147483647);
  }
  /** Index of the shape, or -1. */
  indexOf(s: TopoDS_Shape): number {
    for (const i of this.buckets.get(this.hash(s)) ?? []) if (this.shapes[i].IsSame(s)) return i;
    return -1;
  }
  has(s: TopoDS_Shape) {
    return this.indexOf(s) >= 0;
  }
  /** Add the shape (kept by reference) unless it is there; returns its index. */
  add(s: TopoDS_Shape): number {
    const h = this.hash(s);
    const b = this.buckets.get(h) ?? [];
    for (const i of b) if (this.shapes[i].IsSame(s)) return i;
    b.push(this.shapes.length);
    this.buckets.set(h, b);
    this.shapes.push(s);
    return this.shapes.length - 1;
  }
}

/** Sub-shapes of a type, each once, in explorer order (owned by the arena). */
export function subShapes(oc: OC, t: Arena, s: TopoDS_Shape, type: TopAbs_ShapeEnum): TopoDS_Shape[] {
  return shapeIndex(oc, t, s, type).shapes;
}

/** Index of the sub-shapes of a type (owned by the arena). */
export function shapeIndex(oc: OC, t: Arena, s: TopoDS_Shape, type: TopAbs_ShapeEnum): ShapeIndex {
  const out = new ShapeIndex(oc);
  const ex = t.add(new oc.TopExp_Explorer(s, type, oc.TopAbs_ShapeEnum.TopAbs_SHAPE));
  for (; ex.More(); ex.Next()) {
    const c = t.add(ex.Current());
    out.add(c);
  }
  return out;
}

/** The shapes of an OCCT list (owned by the arena); the list itself is deleted. */
export function listShapes(t: Arena, list: NCollection_List_TopoDS_Shape): TopoDS_Shape[] {
  const out: TopoDS_Shape[] = [];
  try {
    while (list.Size() > 0) {
      out.push(t.add(list.First()));
      list.RemoveFirst();
    }
  } finally {
    list.delete();
  }
  return out;
}

/**
 * Volume properties into p. OCCT's default integration is exact on planes, cylinders,
 * cones, spheres and tori but not on the faces a spline or an ellipse sweeps when it is
 * extruded or revolved (a spline profile extruded comes out 10⁻⁴ off), so shapes with those
 * go through the adaptive Gauss–Kronrod integration span by span (exact to 10⁻¹²). General
 * B-spline faces (sweeps along curves, lofts) keep the default: there the adaptive one takes
 * minutes, and the default is within about 10⁻⁵.
 */
export function volumeProperties(oc: OC, s: TopoDS_Shape, p: GProp_GProps): void {
  const S = oc.GeomAbs_SurfaceType;
  const analytic: GeomAbs_SurfaceType[] = [S.GeomAbs_Plane, S.GeomAbs_Cylinder, S.GeomAbs_Cone, S.GeomAbs_Sphere, S.GeomAbs_Torus];
  const swept: GeomAbs_SurfaceType[] = [S.GeomAbs_SurfaceOfExtrusion, S.GeomAbs_SurfaceOfRevolution];
  const adaptive = scratch((t) => {
    let any = false;
    const ex = t.add(new oc.TopExp_Explorer(s, oc.TopAbs_ShapeEnum.TopAbs_FACE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE));
    for (; ex.More(); ex.Next()) {
      const ty = t.add(new oc.BRepAdaptor_Surface(t.add(oc.TopoDS.Face(t.add(ex.Current()))), true)).GetType();
      if (analytic.includes(ty)) continue;
      if (!swept.includes(ty)) return false;
      any = true;
    }
    return any;
  });
  if (adaptive) oc.BRepGProp.VolumePropertiesGK(s, p, 1e-12, false, true, true, true, false);
  else oc.BRepGProp.VolumeProperties(s, p, false, false, false);
}

export function hasSolid(oc: OC, s: TopoDS_Shape): boolean {
  return scratch((t) => t.add(new oc.TopExp_Explorer(s, oc.TopAbs_ShapeEnum.TopAbs_SOLID, oc.TopAbs_ShapeEnum.TopAbs_SHAPE)).More());
}

/** A compound of the shapes (a shape as it is when there is one). */
export function compound(oc: OC, arena: Arena, shapes: TopoDS_Shape[]): TopoDS_Shape {
  if (shapes.length === 1) return shapes[0];
  const c = arena.add(new oc.TopoDS_Compound());
  scratch((t) => {
    const b = t.add(new oc.TopoDS_Builder());
    b.MakeCompound(c);
    for (const s of shapes) b.Add(c, s);
  });
  return c;
}
