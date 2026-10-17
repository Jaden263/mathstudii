// Triangle meshes read from STL (binary and ASCII), OBJ and 3MF files: the meshes, their
// names and colours, and (3MF) the objects placed by the build items. They become mesh
// bodies (meshBody.ts), one component per 3MF object.
//
// Units: STL and OBJ have none (millimetres are assumed, as slicers do; the import feature
// can say otherwise); a 3MF model names its unit.
import { strFromU8, unzipSync } from 'fflate';
import { IDENTITY, m4Mul, type M4 } from './solid';
import type { TriMesh } from './meshBody';

/** Millimetres per unit of a 3MF model (core specification, §3.4). */
const UNIT_3MF: Record<string, number> = { micron: 1e-3, millimeter: 1, centimeter: 10, inch: 25.4, foot: 304.8, meter: 1000 };

/** What a mesh file holds: its parts (meshes, or several bodies of one part) and where the file places them. */
export interface MeshFile {
  /** Each part is a component; its meshes are its bodies. */
  parts: { key: string; name: string; color?: string; meshes: TriMesh[] }[];
  /** Placements of the parts (millimetres); a file without any places each part once at the origin. */
  instances: { part: number; path: string; name: string; M: M4 }[];
  /** Millimetres per unit of the file's numbers; null when the file does not say. */
  unit: number | null;
  warnings: string[];
}

// ------------------------------------------------------------ STL

/** A binary STL is 84 bytes and 50 per facet; an ASCII one starts with "solid" and has "facet" in it. */
export function isAsciiStl(b: Uint8Array): boolean {
  if (b.length >= 84) {
    const n = new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(80, true);
    if (84 + 50 * n === b.length) return false;
  }
  const head = strFromU8(b.subarray(0, Math.min(b.length, 1024)), true);
  return /^\s*solid/i.test(head) && /facet|endsolid/i.test(strFromU8(b.subarray(0, Math.min(b.length, 4096)), true));
}

export function readStl(b: Uint8Array, name = 'Mesh'): MeshFile {
  const meshes: TriMesh[] = [];
  if (!isAsciiStl(b)) {
    if (b.length < 84) throw new Error('the STL file is too short');
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const n = dv.getUint32(80, true);
    if (84 + 50 * n > b.length) throw new Error(`the STL file says it has ${n} triangles but is too short for them`);
    const positions = new Float32Array(9 * n);
    for (let t = 0; t < n; t++) for (let k = 0; k < 9; k++) positions[9 * t + k] = dv.getFloat32(84 + 50 * t + 12 + 4 * k, true);
    meshes.push({ name, positions, indices: sequence(3 * n) });
  } else {
    // solid name … facet normal … outer loop vertex x y z ×3 endloop endfacet … endsolid; several solids possible
    const text = strFromU8(b, true);
    const solid = /solid[ \t]*([^\r\n]*)([\s\S]*?)endsolid/gi;
    let m: RegExpExecArray | null;
    while ((m = solid.exec(text))) {
      const pts: number[] = [];
      const vertex = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/gi;
      let v: RegExpExecArray | null;
      while ((v = vertex.exec(m[2]))) pts.push(+v[1], +v[2], +v[3]);
      if (pts.some((x) => !Number.isFinite(x))) throw new Error('the ASCII STL file has a vertex that is not a number');
      const n = Math.floor(pts.length / 9);
      if (n) meshes.push({ name: m[1].trim() || name, positions: new Float32Array(pts.slice(0, 9 * n)), indices: sequence(3 * n) });
    }
    if (!meshes.length) throw new Error('the ASCII STL file has no facets');
  }
  return single(name, meshes, null);
}

const sequence = (n: number) => {
  const out = new Uint32Array(n);
  for (let i = 0; i < n; i++) out[i] = i;
  return out;
};

/** One part with every mesh of the file as one of its bodies, placed once. */
const single = (name: string, meshes: TriMesh[], unit: number | null, color?: string): MeshFile => ({
  parts: [{ key: '', name, ...(color ? { color } : {}), meshes }],
  instances: [{ part: 0, path: '', name, M: IDENTITY }],
  unit,
  warnings: [],
});

// ------------------------------------------------------------ OBJ

/** The colours (Kd, diffuse) of the materials of an MTL file. */
export function readMtl(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  let cur = '';
  for (const line of text.split(/\r?\n/)) {
    const w = line.trim().split(/\s+/);
    if (w[0] === 'newmtl') cur = w.slice(1).join(' ');
    else if (w[0] === 'Kd' && cur) out[cur] = hex(+w[1], +w[2], +w[3]);
  }
  return out;
}

const hex = (r: number, g: number, b: number) => `#${[r, g, b].map((v) => Math.round(Math.min(1, Math.max(0, v || 0)) * 255).toString(16).padStart(2, '0')).join('')}`;

/**
 * An OBJ's objects (o) or, without them, its groups (g) as bodies of one part; polygons are
 * fanned into triangles; negative indices count back from the end. `materials` gives the
 * colours of an MTL file read with it.
 */
export function readObj(text: string, name = 'Mesh', materials: Record<string, string> = {}): MeshFile {
  const v: number[] = [];
  type Acc = { name: string; tri: number[]; material?: string };
  const out: Acc[] = [];
  let cur: Acc | null = null;
  let material: string | undefined;
  const hasObjects = /^\s*o\s/m.test(text);
  const start = (n: string) => {
    cur = { name: n, tri: [], ...(material ? { material } : {}) };
    out.push(cur);
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line[0] === '#') continue;
    const sp = line.indexOf(' ');
    const key = sp < 0 ? line : line.slice(0, sp);
    const rest = sp < 0 ? '' : line.slice(sp + 1).trim();
    if (key === 'v') {
      const [x, y, z] = rest.split(/\s+/).map(Number);
      v.push(x, y, z);
    } else if (key === 'o' || (key === 'g' && !hasObjects)) start(rest || `${name}${out.length + 1}`);
    else if (key === 'usemtl') {
      material = rest;
      if (cur && !(cur as Acc).material) (cur as Acc).material = rest;
    } else if (key === 'f') {
      if (!cur) start(name);
      const nv = v.length / 3;
      const idx = rest.split(/\s+/).map((w) => {
        const i = parseInt(w.split('/')[0], 10);
        return i < 0 ? nv + i : i - 1;
      });
      if (idx.some((i) => !(i >= 0 && i < nv))) throw new Error('the OBJ file has a face with a vertex that does not exist');
      for (let k = 1; k + 1 < idx.length; k++) (cur as unknown as Acc).tri.push(idx[0], idx[k], idx[k + 1]);
    }
  }
  const positions = new Float64Array(v);
  const meshes: TriMesh[] = out.filter((a) => a.tri.length).map((a) => ({
    name: a.name, positions, indices: new Uint32Array(a.tri), ...(a.material && materials[a.material] ? { color: materials[a.material] } : {}),
  }));
  if (!meshes.length) throw new Error('the OBJ file has no faces');
  return single(name, meshes, null, meshes.find((m) => m.color)?.color);
}

// ------------------------------------------------------------ 3MF

const attrs = (s: string): Record<string, string> => {
  const out: Record<string, string> = {};
  const re = /([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out[m[1].replace(/^\w+:/, '')] = m[3] ?? m[4];
  return out;
};

/** A 3MF transform, "m00 m01 m02 m10 m11 m12 m20 m21 m22 m30 m31 m32" (row vectors, §3.3): column-major M4. */
export function transform3mf(s: string | undefined, mm = 1): M4 {
  if (!s?.trim()) return IDENTITY;
  const m = s.trim().split(/\s+/).map(Number);
  if (m.length !== 12 || m.some((x) => !Number.isFinite(x))) throw new Error(`a 3MF transform is not 12 numbers: "${s}"`);
  // p' = p · M (row vector): x' = m00 x + m10 y + m20 z + m30
  return [m[0], m[1], m[2], 0, m[3], m[4], m[5], 0, m[6], m[7], m[8], 0, m[9] * mm, m[10] * mm, m[11] * mm, 1];
}

/** The model part of a 3MF package: the one the package's relationships point to, else 3D/3dmodel.model. */
function modelPart(files: Record<string, Uint8Array>): string {
  const rels = files['_rels/.rels'];
  if (rels) {
    const re = /<Relationship\b([^>]*)\/?>/g;
    let m: RegExpExecArray | null;
    const text = strFromU8(rels);
    while ((m = re.exec(text))) {
      const a = attrs(m[1]);
      if (/3dmodel$/.test(a.Type ?? '') && a.Target) return a.Target.replace(/^\//, '');
    }
  }
  const any = Object.keys(files).find((k) => /\.model$/i.test(k));
  if (!any) throw new Error('the 3MF package has no 3-D model');
  return any;
}

export function read3mf(b: Uint8Array, name = 'Model'): MeshFile {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(b);
  } catch {
    throw new Error('the 3MF file is not a zip package');
  }
  const part = modelPart(files);
  const xml = strFromU8(files[part] ?? files[Object.keys(files).find((k) => k.toLowerCase() === part.toLowerCase()) ?? '']);
  if (!xml) throw new Error('the 3MF package has no 3-D model');
  const model = attrs(/<(?:\w+:)?model\b([^>]*)>/.exec(xml)?.[1] ?? '');
  const mm = UNIT_3MF[model.unit ?? 'millimeter'];
  if (!mm) throw new Error(`the 3MF unit "${model.unit}" is not one of the specification's`);
  const warnings: string[] = [];
  // materials: basematerials groups of display colours (#RRGGBB or #RRGGBBAA)
  const colours = new Map<string, string[]>();
  const groups = /<(?:\w+:)?basematerials\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?basematerials>/g;
  let g: RegExpExecArray | null;
  while ((g = groups.exec(xml))) {
    const list: string[] = [];
    const base = /<(?:\w+:)?base\b([^>]*)\/?>/g;
    let m: RegExpExecArray | null;
    while ((m = base.exec(g[2]))) list.push((attrs(m[1]).displaycolor ?? '').slice(0, 7).toLowerCase());
    colours.set(attrs(g[1]).id, list);
  }
  // objects: a mesh, or components placing other objects
  interface Obj { id: string; name: string; color?: string; mesh?: TriMesh; components: { id: string; M: M4 }[] }
  const objects = new Map<string, Obj>();
  const objRe = /<(?:\w+:)?object\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?object>/g;
  let o: RegExpExecArray | null;
  while ((o = objRe.exec(xml))) {
    const a = attrs(o[1]);
    const body = o[2];
    const ob: Obj = { id: a.id, name: a.name?.trim() || `${name} ${a.id}`, components: [] };
    const colour = (pid?: string, pindex?: string) => (pid !== undefined ? colours.get(pid)?.[+(pindex ?? 0)] : undefined);
    if (/<(?:\w+:)?mesh\b/.test(body)) {
      const v: number[] = [];
      const vre = /<(?:\w+:)?vertex\b([^>]*)\/?>/g;
      let m: RegExpExecArray | null;
      while ((m = vre.exec(body))) {
        const q = attrs(m[1]);
        v.push(+q.x, +q.y, +q.z);
      }
      const tri: number[] = [];
      const tre = /<(?:\w+:)?triangle\b([^>]*)\/?>/g;
      let first: Record<string, string> | null = null;
      while ((m = tre.exec(body))) {
        const q = attrs(m[1]);
        first ??= q;
        tri.push(+q.v1, +q.v2, +q.v3);
      }
      const nv = v.length / 3;
      if (v.some((x) => !Number.isFinite(x)) || tri.some((i) => !(Number.isInteger(i) && i >= 0 && i < nv))) throw new Error(`the mesh of 3MF object ${ob.name} is damaged`);
      // the object's material, else that of its first triangle
      ob.color = colour(a.pid, a.pindex) ?? colour(first?.pid, first?.p1);
      ob.mesh = { name: ob.name, positions: new Float64Array(v), indices: new Uint32Array(tri), ...(ob.color ? { color: ob.color } : {}) };
    }
    const cre = /<(?:\w+:)?component\b([^>]*)\/?>/g;
    let c: RegExpExecArray | null;
    while ((c = cre.exec(body))) {
      const q = attrs(c[1]);
      if (q.path) warnings.push(`a component of ${ob.name} is in another part of the package (${q.path}), which is not read`);
      else ob.components.push({ id: q.objectid, M: transform3mf(q.transform, mm) });
    }
    objects.set(ob.id, ob);
  }
  // parts: the mesh objects; instances: the build items, components followed down to the meshes
  const parts: MeshFile['parts'] = [];
  const partOf = new Map<string, number>();
  for (const ob of objects.values()) {
    if (!ob.mesh) continue;
    partOf.set(ob.id, parts.length);
    parts.push({ key: ob.id, name: ob.name, ...(ob.color ? { color: ob.color } : {}), meshes: [ob.mesh] });
  }
  const instances: MeshFile['instances'] = [];
  const counts = new Map<number, number>();
  const place = (id: string, M: M4, path: string[], depth: number) => {
    const ob = objects.get(id);
    if (!ob || depth > 16) return;
    const pi = partOf.get(id);
    if (pi !== undefined) {
      const k = (counts.get(pi) ?? 0) + 1;
      counts.set(pi, k);
      instances.push({ part: pi, path: [...path, id].join('/'), name: `${parts[pi].name}:${k}`, M });
    }
    ob.components.forEach((c, i) => place(c.id, m4Mul(M, c.M), [...path, `${id}.${i + 1}`], depth + 1));
  };
  const build = /<(?:\w+:)?build\b[^>]*>([\s\S]*?)<\/(?:\w+:)?build>/.exec(xml)?.[1] ?? '';
  const ire = /<(?:\w+:)?item\b([^>]*)\/?>/g;
  let it: RegExpExecArray | null, n = 0;
  while ((it = ire.exec(build))) {
    const q = attrs(it[1]);
    place(q.objectid, transform3mf(q.transform, mm), [`item${++n}`], 0);
  }
  if (!parts.length) throw new Error('the 3MF model has no mesh');
  // a model without build items: every mesh once where it is
  if (!instances.length) parts.forEach((p, i) => instances.push({ part: i, path: p.key, name: p.name, M: IDENTITY }));
  return { parts, instances, unit: mm, warnings };
}

/** Read a mesh file by its format. */
export function readMeshFile(format: 'stl' | 'obj' | '3mf', bytes: Uint8Array, name: string, materials?: Record<string, string>): MeshFile {
  if (format === 'stl') return readStl(bytes, name);
  if (format === 'obj') return readObj(strFromU8(bytes), name, materials);
  return read3mf(bytes, name);
}
