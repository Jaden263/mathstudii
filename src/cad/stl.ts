// Binary STL export. Facet normals come from the winding (counter-clockwise from
// outside), not the smoothed vertex normals, which is what slicers expect.
import type { Mesh } from './mesh';

export function meshToStl(mesh: Mesh, name = 'mathstudii'): Uint8Array {
  const p = mesh.positions;
  const count = Math.floor(p.length / 9);
  const out = new Uint8Array(84 + 50 * count);
  const dv = new DataView(out.buffer);
  // header: ASCII only, and must not start with "solid" (some readers then parse it as text STL)
  const header = `binary STL ${name}`.replace(/[^\x20-\x7e]/g, '?').slice(0, 80);
  for (let i = 0; i < header.length; i++) out[i] = header.charCodeAt(i);
  dv.setUint32(80, count, true);
  let o = 84;
  for (let t = 0; t < count; t++) {
    const i = t * 9;
    const ux = p[i + 3] - p[i], uy = p[i + 4] - p[i + 1], uz = p[i + 5] - p[i + 2];
    const vx = p[i + 6] - p[i], vy = p[i + 7] - p[i + 1], vz = p[i + 8] - p[i + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    if (l > 0) {
      nx /= l;
      ny /= l;
      nz /= l;
    }
    const vals = [nx, ny, nz, ...p.subarray(i, i + 9)];
    for (let k = 0; k < 12; k++) dv.setFloat32(o + 4 * k, vals[k], true);
    dv.setUint16(o + 48, 0, true);
    o += 50;
  }
  return out;
}
