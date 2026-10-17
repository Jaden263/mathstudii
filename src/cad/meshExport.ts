// Triangle-mesh exports of a part or an assembly: 3MF (core specification 1.3: millimetres,
// an object per component with its colour as a base material, a build item per occurrence
// with its placement), OBJ with an MTL of the colours (the assembly flattened, in
// millimetres), glTF 2.0 binary (.glb: a node per occurrence under one that turns Z up
// into glTF's Y up and part units into metres, PBR base colours) and binary STL.
//
// The model they write: each part's meshes once (part units) and the instances placing
// them; the kernels fill it from their tessellations (occ/exchange.ts, kernel/meshFallback.ts).
import { strToU8, zipSync } from 'fflate';
import type { M4 } from './solid';
import { meshToStl } from './stl';

/** sRGB (what #rrggbb means) to linear RGB (glTF's base colours, OCCT's colours). */
export const linearRgb = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

export interface ExportMesh {
  name: string;
  /** x, y, z per vertex (part units). */
  positions: Float32Array;
  /** Unit normals per vertex, when the tessellation has them. */
  normals?: Float32Array;
  indices: Uint32Array;
}

export interface ExportPart {
  name: string;
  /** #rrggbb */
  color?: string;
  meshes: ExportMesh[];
}

export interface ExportModel {
  name: string;
  parts: ExportPart[];
  /** The parts placed (part units, column-major); a part's own coordinates for one part. */
  instances: { name: string; part: number; M: M4 }[];
  /** Millimetres per part unit. */
  mm: number;
}

/** Up to 9 significant digits (a float32 holds about 7½), no trailing zeros. */
const num = (v: number) => {
  const s = String(+v.toPrecision(9));
  return s === '-0' ? '0' : s;
};

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A part's meshes as one welded mesh (vertices with the same coordinates made one): what 3MF and OBJ want. */
export function weldedPart(p: ExportPart): { positions: number[]; indices: number[] } {
  const index = new Map<string, number>();
  const positions: number[] = [], indices: number[] = [];
  for (const m of p.meshes) {
    const map = new Uint32Array(m.positions.length / 3);
    for (let v = 0; v < map.length; v++) {
      const x = m.positions[3 * v], y = m.positions[3 * v + 1], z = m.positions[3 * v + 2];
      const k = `${x},${y},${z}`;
      let i = index.get(k);
      if (i === undefined) {
        i = positions.length / 3;
        index.set(k, i);
        positions.push(x, y, z);
      }
      map[v] = i;
    }
    for (let t = 0; t + 2 < m.indices.length; t += 3) {
      const a = map[m.indices[t]], b = map[m.indices[t + 1]], c = map[m.indices[t + 2]];
      if (a !== b && b !== c && c !== a) indices.push(a, b, c);
    }
  }
  return { positions, indices };
}

// ------------------------------------------------------------ 3MF

/** The 3MF row-vector transform "m00 m01 m02 m10 … m32" of a placement, its translation in millimetres. */
export function transformOf3mf(M: M4, mm: number): string {
  return [M[0], M[1], M[2], M[4], M[5], M[6], M[8], M[9], M[10], M[12] * mm, M[13] * mm, M[14] * mm].map(num).join(' ');
}

export function threeMF(model: ExportModel): Uint8Array {
  const used = model.parts.map((_, i) => model.instances.some((x) => x.part === i));
  const colours = [...new Set(model.parts.filter((p, i) => used[i] && p.color).map((p) => p.color!.toUpperCase()))];
  const out: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">',
    ` <metadata name="Title">${xml(model.name)}</metadata>`,
    ' <metadata name="Application">mathstudii</metadata>',
    ' <resources>',
  ];
  if (colours.length) {
    out.push('  <basematerials id="1">');
    for (const c of colours) out.push(`   <base name="${c}" displaycolor="${c}"/>`);
    out.push('  </basematerials>');
  }
  const ids = new Map<number, number>();
  model.parts.forEach((p, i) => {
    if (!used[i]) return;
    const id = ids.size + 2;
    ids.set(i, id);
    const w = weldedPart(p);
    const colour = p.color ? colours.indexOf(p.color.toUpperCase()) : -1;
    out.push(`  <object id="${id}" type="model" name="${xml(p.name)}"${colour >= 0 ? ` pid="1" pindex="${colour}"` : ''}>`, '   <mesh>', '    <vertices>');
    for (let v = 0; v < w.positions.length; v += 3) out.push(`     <vertex x="${num(w.positions[v] * model.mm)}" y="${num(w.positions[v + 1] * model.mm)}" z="${num(w.positions[v + 2] * model.mm)}"/>`);
    out.push('    </vertices>', '    <triangles>');
    for (let t = 0; t < w.indices.length; t += 3) out.push(`     <triangle v1="${w.indices[t]}" v2="${w.indices[t + 1]}" v3="${w.indices[t + 2]}"/>`);
    out.push('    </triangles>', '   </mesh>', '  </object>');
  });
  out.push(' </resources>', ' <build>');
  for (const x of model.instances) {
    const id = ids.get(x.part);
    if (id !== undefined) out.push(`  <item objectid="${id}" transform="${transformOf3mf(x.M, model.mm)}"/>`);
  }
  out.push(' </build>', '</model>');
  return zipSync({
    '[Content_Types].xml': strToU8([
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
      ' <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
      ' <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>',
      '</Types>',
    ].join('\n')),
    '_rels/.rels': strToU8([
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
      ' <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>',
      '</Relationships>',
    ].join('\n')),
    '3D/3dmodel.model': strToU8(out.join('\n')),
  }, { level: 6 });
}

// ------------------------------------------------------------ OBJ + MTL

const hexRgb = (hex?: string): [number, number, number] => {
  const m = hex && /^#?([\da-f]{6})$/i.exec(hex.trim());
  const n = m ? parseInt(m[1], 16) : 0xb4b4b4;
  return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};

/**
 * OBJ of every instance placed (OBJ has no instancing), in millimetres, with smooth normals
 * where the tessellation has them; the MTL file holds a material per colour (its Kd).
 */
export function objFile(model: ExportModel, mtlName: string): { obj: string; mtl: string } {
  const lines = [`# ${model.name} - mathstudii, millimetres`, `mtllib ${mtlName}`];
  const materials = new Map<string, string>();
  const matOf = (p: ExportPart) => {
    const key = (p.color ?? '#b4b4b4').toLowerCase();
    if (!materials.has(key)) materials.set(key, `colour_${key.slice(1)}`);
    return materials.get(key)!;
  };
  let nv = 0, nn = 0;
  const used = new Map<string, number>();
  for (const x of model.instances) {
    const p = model.parts[x.part];
    if (!p) continue;
    const M = x.M, s = model.mm;
    const k = (used.get(x.name) ?? 0) + 1;
    used.set(x.name, k);
    lines.push(`o ${(k > 1 ? `${x.name} ${k}` : x.name).replace(/\s+/g, '_')}`, `usemtl ${matOf(p)}`);
    const w = weldedPart(p);
    for (let v = 0; v < w.positions.length; v += 3) {
      const [a, b, c] = [w.positions[v], w.positions[v + 1], w.positions[v + 2]];
      lines.push(`v ${num((M[0] * a + M[4] * b + M[8] * c + M[12]) * s)} ${num((M[1] * a + M[5] * b + M[9] * c + M[13]) * s)} ${num((M[2] * a + M[6] * b + M[10] * c + M[14]) * s)}`);
    }
    // normals: each mesh's own, turned with the placement; faces name a welded vertex and its mesh's normal
    const hasNormals = p.meshes.every((m) => m.normals?.length === m.positions.length);
    if (hasNormals) {
      const index = new Map<string, number>();
      w.positions.forEach((_, i) => i % 3 === 0 && index.set(`${w.positions[i]},${w.positions[i + 1]},${w.positions[i + 2]}`, i / 3));
      for (const m of p.meshes) {
        for (let v = 0; v < m.normals!.length; v += 3) {
          const [a, b, c] = [m.normals![v], m.normals![v + 1], m.normals![v + 2]];
          lines.push(`vn ${num(M[0] * a + M[4] * b + M[8] * c)} ${num(M[1] * a + M[5] * b + M[9] * c)} ${num(M[2] * a + M[6] * b + M[10] * c)}`);
        }
        for (let t = 0; t + 2 < m.indices.length; t += 3) {
          const vs = [m.indices[t], m.indices[t + 1], m.indices[t + 2]];
          const ws = vs.map((q) => index.get(`${m.positions[3 * q]},${m.positions[3 * q + 1]},${m.positions[3 * q + 2]}`)!);
          if (ws[0] === ws[1] || ws[1] === ws[2] || ws[2] === ws[0]) continue;
          lines.push(`f ${vs.map((q, i) => `${nv + ws[i] + 1}//${nn + q + 1}`).join(' ')}`);
        }
        nn += m.normals!.length / 3;
      }
    } else {
      for (let t = 0; t < w.indices.length; t += 3) lines.push(`f ${nv + w.indices[t] + 1} ${nv + w.indices[t + 1] + 1} ${nv + w.indices[t + 2] + 1}`);
    }
    nv += w.positions.length / 3;
  }
  const mtl = [`# ${model.name} - mathstudii`];
  for (const [hex, name] of materials) {
    const [r, g, b] = hexRgb(hex);
    mtl.push('', `newmtl ${name}`, `Kd ${num(r)} ${num(g)} ${num(b)}`, 'Ka 0 0 0', 'Ks 0.25 0.25 0.25', 'Ns 50', 'd 1', 'illum 2');
  }
  return { obj: `${lines.join('\n')}\n`, mtl: `${mtl.join('\n')}\n` };
}

// ------------------------------------------------------------ glTF 2.0 binary

const pad4 = (n: number) => (n + 3) & ~3;

/** glTF 2.0 binary: a node per instance under a root that makes Z-up part units Y-up metres. */
export function glbFile(model: ExportModel): Uint8Array {
  const chunks: Uint8Array[] = [];
  let length = 0;
  const bufferViews: Record<string, unknown>[] = [], accessors: Record<string, unknown>[] = [];
  /** A typed array into the binary chunk, with its view and accessor; returns the accessor. */
  const add = (data: Float32Array | Uint32Array, type: 'VEC3' | 'SCALAR', target: number, minmax = false) => {
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const offset = length;
    chunks.push(bytes);
    length += bytes.length;
    const padded = pad4(length);
    if (padded > length) {
      chunks.push(new Uint8Array(padded - length));
      length = padded;
    }
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length, target });
    const acc: Record<string, unknown> = { bufferView: bufferViews.length - 1, componentType: data instanceof Float32Array ? 5126 : 5125, count: type === 'VEC3' ? data.length / 3 : data.length, type };
    if (minmax) {
      const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < data.length; i += 3) for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k], data[i + k]);
        max[k] = Math.max(max[k], data[i + k]);
      }
      Object.assign(acc, { min, max });
    }
    accessors.push(acc);
    return accessors.length - 1;
  };
  const materials = model.parts.map((p) => {
    const [r, g, b] = hexRgb(p.color);
    // glTF base colours are linear
    return { name: p.name, pbrMetallicRoughness: { baseColorFactor: [linearRgb(r), linearRgb(g), linearRgb(b), 1], metallicFactor: 0.2, roughnessFactor: 0.55 }, doubleSided: false };
  });
  const meshes = model.parts.map((p, i) => ({
    name: p.name,
    primitives: p.meshes.filter((m) => m.indices.length).map((m) => ({
      attributes: { POSITION: add(m.positions, 'VEC3', 34962, true), ...(m.normals?.length === m.positions.length ? { NORMAL: add(m.normals, 'VEC3', 34962) } : {}) },
      indices: add(m.indices, 'SCALAR', 34963),
      material: i,
      mode: 4,
    })),
  }));
  // a glTF mesh needs a primitive: parts without triangles are left out, and the others renumbered
  const keep = meshes.map((_, i) => i).filter((i) => meshes[i].primitives.length > 0);
  const s = model.mm / 1000;
  const children = model.instances.filter((x) => keep.includes(x.part)).map((x) => ({ name: x.name, mesh: keep.indexOf(x.part), matrix: x.M.map((v) => +v.toPrecision(15)) }));
  const nodes = [
    // Z up to Y up ((x, y, z) → (x, z, −y)), part units to metres
    { name: model.name, matrix: [s, 0, 0, 0, 0, 0, -s, 0, 0, s, 0, 0, 0, 0, 0, 1], children: children.map((_, i) => i + 1) },
    ...children,
  ];
  const json = {
    asset: { version: '2.0', generator: 'mathstudii' },
    scene: 0,
    scenes: [{ name: model.name, nodes: [0] }],
    nodes,
    meshes: keep.map((i) => meshes[i]),
    materials,
    accessors,
    bufferViews,
    buffers: [{ byteLength: length }],
  };
  const text = strToU8(JSON.stringify(json));
  const jsonLen = pad4(text.length);
  const total = 12 + 8 + jsonLen + 8 + length;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); // 'glTF'
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonLen, true);
  dv.setUint32(16, 0x4e4f534a, true); // 'JSON'
  out.set(text, 20);
  out.fill(0x20, 20 + text.length, 20 + jsonLen);
  dv.setUint32(20 + jsonLen, length, true);
  dv.setUint32(24 + jsonLen, 0x004e4942, true); // 'BIN'
  let at = 28 + jsonLen;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

// ------------------------------------------------------------ STL

/** A binary STL of every instance placed, in millimetres (slicers read STL as millimetres). */
export function stlOfModel(model: ExportModel): Uint8Array {
  let n = 0;
  for (const x of model.instances) for (const m of model.parts[x.part]?.meshes ?? []) n += m.indices.length;
  const all = new Float32Array(3 * n);
  let at = 0;
  for (const x of model.instances) {
    const M = x.M, s = model.mm;
    for (const m of model.parts[x.part]?.meshes ?? []) {
      for (let k = 0; k < m.indices.length; k++) {
        const i = 3 * m.indices[k];
        const a = m.positions[i], b = m.positions[i + 1], c = m.positions[i + 2];
        all[at++] = (M[0] * a + M[4] * b + M[8] * c + M[12]) * s;
        all[at++] = (M[1] * a + M[5] * b + M[9] * c + M[13]) * s;
        all[at++] = (M[2] * a + M[6] * b + M[10] * c + M[14]) * s;
      }
    }
  }
  return meshToStl({ positions: all, normals: all, edges: new Float32Array(0), bounds: { min: [0, 0, 0], max: [0, 0, 0] } }, model.name);
}
