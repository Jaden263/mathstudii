// The 3-D solid kernel: sketch profiles become Manifold solids (extrude, revolve, hole
// tools), bodies combine by exact mesh booleans, and the results come back as display
// meshes and mass properties.
//
// Manifold (WASM) keeps every solid a closed, oriented 2-manifold, so booleans never
// leave holes or slivers behind. Curves are polygons: arcs get a vertex every 2°,
// which puts mesh-based volumes within ~2·10⁻⁴ of the true curved solid. Bodies made
// by a single extrude or revolve keep their exact profile-integral properties.
import type { CrossSection, Manifold, ManifoldToplevel, Mat4 } from 'manifold-3d';
import { loopPolygon, type ProfileRegion, type Vec2 } from './profile';
import type { Mesh } from './mesh';
import type { MassProps } from './features';

export type { Manifold, CrossSection, ManifoldToplevel };
export type Vec3 = [number, number, number];

/** Arc discretisation of the solids (radians per polygon edge). */
export const ARC_STEP = Math.PI / 90;
/** Segments of a full circle (holes, revolves). */
export const CIRCLE_SEGMENTS = 180;

// ------------------------------------------------------------ loading

let K: ManifoldToplevel | null = null;
let loading: Promise<ManifoldToplevel> | null = null;

/** The kernel, or null while it is still loading (or failed to load). */
export function kernel(): ManifoldToplevel | null {
  return K;
}

/**
 * Load the WASM kernel once. Browsers pass the bundled .wasm URL; Node (tests) finds
 * the file next to the package's own script.
 */
export function initKernel(wasmUrl?: string): Promise<ManifoldToplevel> {
  if (K) return Promise.resolve(K);
  loading ??= import('manifold-3d').then(async ({ default: Module }) => {
    const m = await Module(wasmUrl ? { locateFile: () => wasmUrl } : undefined);
    m.setup();
    K = m;
    return m;
  });
  return loading;
}

// ------------------------------------------------------------ vectors and matrices

export const add3 = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub3 = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale3 = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
export const dot3 = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross3 = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const len3 = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
export const norm3 = (a: Vec3): Vec3 => {
  const l = len3(a);
  return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 1];
};

/** 4×4 affine matrix, column-major (as Manifold and WebGL use). */
export type M4 = number[];

export const IDENTITY: M4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** Matrix whose columns are the axes x, y, z and the origin o. */
export function m4Frame(o: Vec3, x: Vec3, y: Vec3, z: Vec3): M4 {
  return [x[0], x[1], x[2], 0, y[0], y[1], y[2], 0, z[0], z[1], z[2], 0, o[0], o[1], o[2], 1];
}

export function m4Mul(a: M4, b: M4): M4 {
  const r = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++) for (let rr = 0; rr < 4; rr++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + rr] * b[c * 4 + k];
    r[c * 4 + rr] = s;
  }
  return r;
}

/** Inverse of an affine matrix (general 3×3 part). */
export function m4Inv(m: M4): M4 {
  const [a, b, c, , d, e, f, , g, h, i] = m; // columns: (a b c) (d e f) (g h i)
  const A = e * i - f * h, B = -(b * i - c * h), C = b * f - c * e;
  const det = a * A + d * B + g * C;
  const k = 1 / det;
  // rows of the inverse
  const r00 = A * k, r01 = -(d * i - g * f) * k, r02 = (d * h - g * e) * k;
  const r10 = B * k, r11 = (a * i - g * c) * k, r12 = -(a * h - g * b) * k;
  const r20 = C * k, r21 = -(a * f - d * c) * k, r22 = (a * e - d * b) * k;
  const t = [m[12], m[13], m[14]];
  const tx = -(r00 * t[0] + r01 * t[1] + r02 * t[2]);
  const ty = -(r10 * t[0] + r11 * t[1] + r12 * t[2]);
  const tz = -(r20 * t[0] + r21 * t[1] + r22 * t[2]);
  return [r00, r10, r20, 0, r01, r11, r21, 0, r02, r12, r22, 0, tx, ty, tz, 1];
}

export function m4Point(m: M4, p: Vec3): Vec3 {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  ];
}

export function m4Dir(m: M4, d: Vec3): Vec3 {
  return [m[0] * d[0] + m[4] * d[1] + m[8] * d[2], m[1] * d[0] + m[5] * d[1] + m[9] * d[2], m[2] * d[0] + m[6] * d[1] + m[10] * d[2]];
}

export function m4Translate(t: Vec3): M4 {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, t[0], t[1], t[2], 1];
}

/** Rotation by `angle` radians about the axis through p with direction d (right-hand rule). */
export function m4Rotate(p: Vec3, d: Vec3, angle: number): M4 {
  const [x, y, z] = norm3(d);
  const c = Math.cos(angle), s = Math.sin(angle), t = 1 - c;
  const R: M4 = [
    t * x * x + c, t * x * y + s * z, t * x * z - s * y, 0,
    t * x * y - s * z, t * y * y + c, t * y * z + s * x, 0,
    t * x * z + s * y, t * y * z - s * x, t * z * z + c, 0,
    0, 0, 0, 1,
  ];
  return m4Mul(m4Translate(p), m4Mul(R, m4Translate([-p[0], -p[1], -p[2]])));
}

/** Reflection in the plane through p with normal n. */
export function m4Mirror(p: Vec3, n: Vec3): M4 {
  const [a, b, c] = norm3(n);
  const R: M4 = [1 - 2 * a * a, -2 * a * b, -2 * a * c, 0, -2 * a * b, 1 - 2 * b * b, -2 * b * c, 0, -2 * a * c, -2 * b * c, 1 - 2 * c * c, 0, 0, 0, 0, 1];
  return m4Mul(m4Translate(p), m4Mul(R, m4Translate([-p[0], -p[1], -p[2]])));
}

/** Rotation from XYZ Euler angles in degrees (about X, then Y, then Z, fixed axes) plus a translation. */
export function m4Pose(pos: Vec3 = [0, 0, 0], rotDeg: Vec3 = [0, 0, 0]): M4 {
  const o: Vec3 = [0, 0, 0], r = (v: number) => (v * Math.PI) / 180;
  const R = m4Mul(m4Rotate(o, [0, 0, 1], r(rotDeg[2])), m4Mul(m4Rotate(o, [0, 1, 0], r(rotDeg[1])), m4Rotate(o, [1, 0, 0], r(rotDeg[0]))));
  return m4Mul(m4Translate(pos), R);
}

const toMat4 = (m: M4) => m as unknown as Mat4;

// ------------------------------------------------------------ sketch frames

/** A sketch plane: sketch x → u, sketch y → v, the normal n = u × v. */
export interface Frame {
  o: Vec3;
  u: Vec3;
  v: Vec3;
  n: Vec3;
}

export function frameMatrix(f: Frame): M4 {
  return m4Frame(f.o, f.u, f.v, f.n);
}

export function framePoint(f: Frame, p: Vec2, z = 0): Vec3 {
  return [f.o[0] + f.u[0] * p.x + f.v[0] * p.y + f.n[0] * z, f.o[1] + f.u[1] * p.x + f.v[1] * p.y + f.n[1] * z, f.o[2] + f.u[2] * p.x + f.v[2] * p.y + f.n[2] * z];
}

export function frameDir(f: Frame, d: Vec2): Vec3 {
  return [f.u[0] * d.x + f.v[0] * d.y, f.u[1] * d.x + f.v[1] * d.y, f.u[2] * d.x + f.v[2] * d.y];
}

/** Frame of a plane through `o` with normal `n`, its x axis kept as level as possible (Z up). */
export function frameFromNormal(o: Vec3, n: Vec3): Frame {
  const z = norm3(n);
  const u = Math.abs(z[2]) < 0.9 ? norm3(cross3([0, 0, 1], z)) : [1, 0, 0] as Vec3;
  const v = cross3(z, u);
  return { o, u, v, n: z };
}

// ------------------------------------------------------------ memory

/**
 * Manifold objects live in WASM memory and must be freed explicitly. An arena
 * collects everything made during a build; `free` releases all but the kept ones.
 */
export class Arena {
  private items = new Set<{ delete(): void }>();
  add<T extends { delete(): void }>(x: T): T {
    this.items.add(x);
    return x;
  }
  release(x: { delete(): void }) {
    this.items.delete(x);
  }
  free() {
    for (const x of this.items) {
      try {
        x.delete();
      } catch {
        /* already freed */
      }
    }
    this.items.clear();
  }
}

// ------------------------------------------------------------ profile → solid

function signedArea(p: [number, number][]): number {
  let a = 0;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) a += p[j][0] * p[i][1] - p[i][0] * p[j][1];
  return a / 2;
}

/** Polygons of the regions (outer counter-clockwise, holes clockwise), optionally mapped. */
export function regionPolygons(regions: ProfileRegion[], map?: (p: Vec2) => [number, number]): [number, number][][] {
  const polys: [number, number][][] = [];
  const m = map ?? ((p: Vec2) => [p.x, p.y] as [number, number]);
  let flipped: boolean | null = null;
  for (const r of regions) {
    for (const [k, loop] of [r.outer, ...r.holes].entries()) {
      const pts = loopPolygon(loop, ARC_STEP).map(m);
      if (pts.length < 3) continue;
      if (flipped === null && k === 0) flipped = signedArea(pts) < 0;
      polys.push(pts);
    }
  }
  // a mirroring map reverses every loop; turn them back
  if (flipped) polys.forEach((p) => p.reverse());
  return polys;
}

export function crossSection(Kx: ManifoldToplevel, arena: Arena, polys: [number, number][][]): CrossSection {
  return arena.add(Kx.CrossSection.ofPolygons(polys, 'Positive'));
}

/** Prism of the regions between z0 and z1 along the frame normal. */
export function extrudeSolid(Kx: ManifoldToplevel, arena: Arena, regions: ProfileRegion[], f: Frame, z0: number, z1: number): Manifold {
  const cs = crossSection(Kx, arena, regionPolygons(regions));
  if (cs.isEmpty()) throw new Error('the profile is empty');
  const h = z1 - z0;
  if (!(h > 0)) throw new Error('the extent must be positive');
  const prism = arena.add(Kx.Manifold.extrude(cs, h));
  return arena.add(prism.transform(toMat4(m4Mul(frameMatrix(f), m4Translate([0, 0, z0])))));
}

/**
 * Solid of revolution of the regions about the in-plane axis through p along d, turned
 * by `angle` radians with the right-hand rule about d. The profile must stay on one side.
 */
export function revolveSolid(Kx: ManifoldToplevel, arena: Arena, regions: ProfileRegion[], f: Frame, axis: { p: Vec2; d: Vec2 }, angle: number): Manifold {
  const l = Math.hypot(axis.d.x, axis.d.y);
  const a = { x: axis.d.x / l, y: axis.d.y / l };
  // distance from the axis on the left (w) side, and along it (s)
  const w = (p: Vec2) => -(p.x - axis.p.x) * a.y + (p.y - axis.p.y) * a.x;
  const s = (p: Vec2) => (p.x - axis.p.x) * a.x + (p.y - axis.p.y) * a.y;
  let wMin = Infinity, wMax = -Infinity, size = 0;
  for (const r of regions) for (const loop of [r.outer, ...r.holes]) for (const p of loopPolygon(loop, ARC_STEP)) {
    const q = w(p);
    wMin = Math.min(wMin, q);
    wMax = Math.max(wMax, q);
    size = Math.max(size, Math.abs(q), Math.abs(s(p)));
  }
  const tol = 1e-7 * Math.max(size, 1e-30);
  if (wMin < -tol && wMax > tol) throw new Error('The profile crosses the axis of revolution');
  if (wMax <= tol && wMin >= -tol) throw new Error('The profile lies on the axis of revolution');
  const side = wMax > tol ? 1 : -1;
  // revolve frame: X = towards the profile (e1), Z = along the axis, Y = Z × X
  const polys = regionPolygons(regions, (p) => [Math.max(0, side * w(p)), s(p)]);
  const cs = crossSection(Kx, arena, polys);
  const deg = (Math.min(angle, 2 * Math.PI) * 180) / Math.PI;
  const segs = Math.max(3, Math.ceil((CIRCLE_SEGMENTS * deg) / 360));
  const solid = arena.add(Kx.Manifold.revolve(cs, deg >= 360 - 1e-9 ? CIRCLE_SEGMENTS : segs, deg >= 360 - 1e-9 ? 360 : deg));
  const e1 = { x: -a.y * side, y: a.x * side };
  const X = frameDir(f, e1), Z = frameDir(f, a), Y = cross3(Z, X);
  return arena.add(solid.transform(toMat4(m4Frame(framePoint(f, axis.p), X, Y, Z))));
}

/**
 * Hole tool at a point: a cylinder (and counterbore or countersink) from the surface
 * at p into the material along `dir`, `depth` deep.
 */
export function holeTool(
  Kx: ManifoldToplevel, arena: Arena, p: Vec3, dir: Vec3,
  o: { d: number; depth: number; style: 'simple' | 'counterbore' | 'countersink'; cbD?: number; cbDepth?: number; csD?: number; csAngle?: number },
): Manifold {
  const z = norm3(dir);
  const fr = frameFromNormal(p, z);
  const back = Math.max(o.d, o.cbD ?? 0, o.csD ?? 0) * 1e-3; // start just above the surface
  const parts: Manifold[] = [arena.add(Kx.Manifold.cylinder(o.depth + back, o.d / 2, o.d / 2, CIRCLE_SEGMENTS).translate([0, 0, -back]))];
  if (o.style === 'counterbore' && o.cbD && o.cbDepth && o.cbD > o.d) {
    parts.push(arena.add(Kx.Manifold.cylinder(o.cbDepth + back, o.cbD / 2, o.cbD / 2, CIRCLE_SEGMENTS).translate([0, 0, -back])));
  }
  if (o.style === 'countersink' && o.csD && o.csD > o.d && o.csAngle) {
    const h = (o.csD - o.d) / 2 / Math.tan(o.csAngle / 2);
    parts.push(arena.add(Kx.Manifold.cylinder(h, o.csD / 2, o.d / 2, CIRCLE_SEGMENTS)));
    parts.push(arena.add(Kx.Manifold.cylinder(back, o.csD / 2, o.csD / 2, CIRCLE_SEGMENTS).translate([0, 0, -back])));
  }
  const tool = parts.length > 1 ? arena.add(Kx.Manifold.union(parts)) : parts[0];
  // local z points into the material
  return arena.add(tool.transform(toMat4(m4Frame(p, fr.u, fr.v, z))));
}

export function transformSolid(arena: Arena, m: Manifold, M: M4): Manifold {
  return arena.add(m.transform(toMat4(M)));
}

// ------------------------------------------------------------ meshes

const SMOOTH = Math.cos((25 * Math.PI) / 180);

/** Display mesh: flat faces, smooth curved walls, feature edges where faces meet at an angle. */
export function solidMesh(m: Manifold): Mesh {
  const mesh = m.getMesh();
  const np = mesh.numProp;
  const vp = mesh.vertProperties, tv = mesh.triVerts;
  const nt = tv.length / 3, nv = vp.length / np;
  const fn = new Float64Array(nt * 3), fa = new Float64Array(nt);
  const P = (i: number): Vec3 => [vp[i * np], vp[i * np + 1], vp[i * np + 2]];
  for (let t = 0; t < nt; t++) {
    const a = P(tv[3 * t]), b = P(tv[3 * t + 1]), c = P(tv[3 * t + 2]);
    const n = cross3(sub3(b, a), sub3(c, a));
    const l = len3(n);
    fa[t] = l / 2;
    if (l > 0) fn.set([n[0] / l, n[1] / l, n[2] / l], 3 * t);
  }
  // triangles around each vertex
  const count = new Uint32Array(nv + 1);
  for (let k = 0; k < tv.length; k++) count[tv[k] + 1]++;
  for (let i = 0; i < nv; i++) count[i + 1] += count[i];
  const fill = count.slice(0, nv);
  const around = new Uint32Array(tv.length);
  for (let k = 0; k < tv.length; k++) around[fill[tv[k]]++] = (k / 3) | 0;

  const positions = new Float32Array(nt * 9), normals = new Float32Array(nt * 9);
  const min: [number, number, number] = [Infinity, Infinity, Infinity], max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let t = 0; t < nt; t++) {
    for (let k = 0; k < 3; k++) {
      const v = tv[3 * t + k];
      let x = 0, y = 0, z = 0;
      for (let q = count[v]; q < count[v + 1]; q++) {
        const s = around[q];
        if (fn[3 * s] * fn[3 * t] + fn[3 * s + 1] * fn[3 * t + 1] + fn[3 * s + 2] * fn[3 * t + 2] < SMOOTH) continue;
        x += fn[3 * s] * fa[s]; y += fn[3 * s + 1] * fa[s]; z += fn[3 * s + 2] * fa[s];
      }
      const l = Math.hypot(x, y, z) || 1;
      const o = 9 * t + 3 * k;
      for (let d = 0; d < 3; d++) {
        const c = vp[v * np + d];
        positions[o + d] = c;
        if (c < min[d]) min[d] = c;
        if (c > max[d]) max[d] = c;
      }
      normals[o] = x / l; normals[o + 1] = y / l; normals[o + 2] = z / l;
    }
  }
  // feature edges: shared by two triangles whose normals differ
  const edgeTri = new Map<number, number>();
  const edges: number[] = [];
  for (let t = 0; t < nt; t++) {
    for (let k = 0; k < 3; k++) {
      const a = tv[3 * t + k], b = tv[3 * t + ((k + 1) % 3)];
      const key = a < b ? a * nv + b : b * nv + a;
      const o = edgeTri.get(key);
      if (o === undefined) {
        edgeTri.set(key, t);
        continue;
      }
      edgeTri.delete(key);
      if (fn[3 * o] * fn[3 * t] + fn[3 * o + 1] * fn[3 * t + 1] + fn[3 * o + 2] * fn[3 * t + 2] < SMOOTH) edges.push(...P(a), ...P(b));
    }
  }
  if (!nt) min.fill(0), max.fill(0);
  return { positions, normals, edges: new Float32Array(edges), bounds: { min, max } };
}

// ------------------------------------------------------------ mass properties

/** Volume, centroid and covariance ∫(x−c)(x−c)ᵀ dV (row-major 3×3). */
export interface Mass3 {
  V: number;
  c: Vec3;
  C: number[];
}

/** Exact divergence-theorem integrals over the closed triangle mesh. */
export function solidMass(m: Manifold): Mass3 {
  const mesh = m.getMesh();
  const np = mesh.numProp, vp = mesh.vertProperties, tv = mesh.triVerts;
  const bb = m.boundingBox();
  const r: Vec3 = [(bb.min[0] + bb.max[0]) / 2, (bb.min[1] + bb.max[1]) / 2, (bb.min[2] + bb.max[2]) / 2];
  let V = 0;
  const F = [0, 0, 0];
  const S = new Array<number>(9).fill(0);
  for (let t = 0; t < tv.length; t += 3) {
    const v = [0, 1, 2].map((k) => {
      const i = tv[t + k] * np;
      return [vp[i] - r[0], vp[i + 1] - r[1], vp[i + 2] - r[2]];
    });
    const [a, b, c] = v;
    const det = a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
    V += det / 6;
    const sum = [a[0] + b[0] + c[0], a[1] + b[1] + c[1], a[2] + b[2] + c[2]];
    for (let i = 0; i < 3; i++) {
      F[i] += (det / 24) * sum[i];
      for (let j = 0; j < 3; j++) S[3 * i + j] += (det / 120) * (a[i] * a[j] + b[i] * b[j] + c[i] * c[j] + sum[i] * sum[j]);
    }
  }
  if (!(Math.abs(V) > 0)) return { V: 0, c: r, C: new Array(9).fill(0) };
  const g = [F[0] / V, F[1] / V, F[2] / V];
  const C = S.map((s, k) => s - V * g[(k / 3) | 0] * g[k % 3]);
  return { V, c: [r[0] + g[0], r[1] + g[1], r[2] + g[2]], C };
}

export function massFromProps(p: MassProps): Mass3 {
  const xx = (p.Iyy + p.Izz - p.Ixx) / 2, yy = (p.Ixx + p.Izz - p.Iyy) / 2, zz = (p.Ixx + p.Iyy - p.Izz) / 2;
  return { V: p.V, c: [p.xg, p.yg, p.zg], C: [xx, p.Pxy, p.Pxz, p.Pxy, yy, p.Pyz, p.Pxz, p.Pyz, zz] };
}

export function propsFromMass(m: Mass3): MassProps {
  const C = m.C;
  const scale = Math.abs(C[0]) + Math.abs(C[4]) + Math.abs(C[8]);
  const clean = (v: number) => (Math.abs(v) < 1e-9 * scale ? 0 : v);
  return {
    V: m.V, xg: m.c[0], yg: m.c[1], zg: m.c[2],
    Ixx: C[4] + C[8], Iyy: C[0] + C[8], Izz: C[0] + C[4],
    Pxy: clean(C[1]), Pxz: clean(C[2]), Pyz: clean(C[5]),
  };
}

/** Mass properties moved by a rigid (or mirroring) transform. */
export function transformMass(m: Mass3, M: M4): Mass3 {
  const A = [M[0], M[4], M[8], M[1], M[5], M[9], M[2], M[6], M[10]];
  const C = m.C;
  // A C Aᵀ
  const AC = new Array<number>(9).fill(0), out = new Array<number>(9).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) AC[3 * i + j] += A[3 * i + k] * C[3 * k + j];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) out[3 * i + j] += AC[3 * i + k] * A[3 * j + k];
  return { V: m.V, c: m4Point(M, m.c), C: out };
}

/** Combined properties of several solids; `w` weights each (density) — 1 for volume properties. */
export function combineMass(items: { m: Mass3; w: number }[]): { W: number; c: Vec3; C: number[] } {
  let W = 0;
  const c: Vec3 = [0, 0, 0];
  for (const { m, w } of items) {
    W += w * m.V;
    for (let i = 0; i < 3; i++) c[i] += w * m.V * m.c[i];
  }
  if (!(W > 0)) return { W: 0, c: [0, 0, 0], C: new Array(9).fill(0) };
  for (let i = 0; i < 3; i++) c[i] /= W;
  const C = new Array<number>(9).fill(0);
  for (const { m, w } of items) {
    const d = sub3(m.c, c);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) C[3 * i + j] += w * (m.C[3 * i + j] + m.V * d[i] * d[j]);
  }
  return { W, c, C };
}

// ------------------------------------------------------------ queries

/** Outline of a solid in a sketch plane (sketch coordinates), for reference geometry. */
export function sectionInPlane(m: Manifold, f: Frame): Vec2[][] {
  const inv = m4Inv(frameMatrix(f));
  const local = m.transform(toMat4(inv));
  try {
    const bb = local.boundingBox();
    const size = Math.max(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2], 1e-9);
    const eps = 1e-5 * size;
    for (const h of [-eps, eps]) {
      if (bb.min[2] > h || bb.max[2] < h) continue;
      const raw = local.slice(h);
      const cs = raw.simplify(eps);
      raw.delete();
      try {
        const polys = cs.toPolygons().map((p) => p.map(([x, y]) => ({ x, y })));
        if (polys.length) return polys;
      } finally {
        cs.delete();
      }
    }
    return [];
  } finally {
    local.delete();
  }
}

/** Volume shared by two solids (interference). */
export function sharedVolume(a: Manifold, b: Manifold): number {
  const i = a.intersect(b);
  try {
    return i.isEmpty() ? 0 : i.volume();
  } finally {
    i.delete();
  }
}

export function boxOf(ms: Manifold[]): { min: Vec3; max: Vec3 } | null {
  let box: { min: Vec3; max: Vec3 } | null = null;
  for (const m of ms) {
    if (m.isEmpty()) continue;
    const b = m.boundingBox();
    if (!box) box = { min: [...b.min] as Vec3, max: [...b.max] as Vec3 };
    else for (let i = 0; i < 3; i++) {
      box.min[i] = Math.min(box.min[i], b.min[i]);
      box.max[i] = Math.max(box.max[i], b.max[i]);
    }
  }
  return box;
}
