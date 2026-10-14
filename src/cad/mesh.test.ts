import { describe, it, expect } from 'vitest';
import { extrudeMesh, revolveMesh, type Mesh } from './mesh';
import { meshToStl } from './stl';
import type { Loop, ProfileRegion, Seg, Vec2 } from './profile';

const v = (x: number, y: number): Vec2 => ({ x, y });

function poly(pts: Vec2[]): Loop {
  const segs: Seg[] = pts.map((a, i) => ({ kind: 'line', a, b: pts[(i + 1) % pts.length] }));
  return { segs, entities: segs.map((_, i) => `l${i}`) };
}
const rect = (x0: number, y0: number, x1: number, y1: number) => poly([v(x0, y0), v(x1, y0), v(x1, y1), v(x0, y1)]);
const circle = (c: Vec2, r: number, cw = false): Loop => ({
  segs: [{ kind: 'arc', c, r, a0: cw ? 2 * Math.PI : 0, a1: cw ? 0 : 2 * Math.PI }],
  entities: ['c'],
});

const triCount = (m: Mesh) => m.positions.length / 9;

function volume(m: Mesh): number {
  const p = m.positions;
  let s = 0;
  for (let i = 0; i < p.length; i += 9) {
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = p.subarray(i, i + 9);
    s += ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx);
  }
  return s / 6;
}

/** Every undirected edge (after welding by position) is shared by exactly two triangles, in opposite directions. */
function expectWatertight(m: Mesh) {
  const p = m.positions;
  const tol = 1e-3;
  const ids = new Map<string, number>();
  const id = (i: number) => {
    const key = [p[i], p[i + 1], p[i + 2]].map((c) => Math.round(c / tol)).join(',');
    if (!ids.has(key)) ids.set(key, ids.size);
    return ids.get(key)!;
  };
  const directed = new Map<string, number>();
  for (let t = 0; t < p.length; t += 9) {
    const vs = [id(t), id(t + 3), id(t + 6)];
    for (let k = 0; k < 3; k++) {
      const key = `${vs[k]}>${vs[(k + 1) % 3]}`;
      directed.set(key, (directed.get(key) ?? 0) + 1);
    }
  }
  const bad: string[] = [];
  for (const [key, n] of directed) {
    const [a, b] = key.split('>');
    if (n !== 1 || directed.get(`${b}>${a}`) !== 1) bad.push(key);
  }
  expect(bad.slice(0, 5)).toEqual([]);
}

function expectBasics(m: Mesh) {
  expect(triCount(m)).toBeGreaterThan(0);
  expect(m.positions.length % 9).toBe(0);
  expect(m.normals.length).toBe(m.positions.length);
  expect(m.edges.length % 6).toBe(0);
  for (let i = 0; i < m.normals.length; i += 3) {
    expect(Math.abs(Math.hypot(m.normals[i], m.normals[i + 1], m.normals[i + 2]) - 1)).toBeLessThan(1e-5);
  }
}

const plate: ProfileRegion[] = [{ outer: rect(0, 0, 100, 50), holes: [] }];
const holed: ProfileRegion[] = [{ outer: rect(0, 0, 100, 50), holes: [circle(v(50, 25), 10, true)] }];

describe('extrudeMesh', () => {
  it('extrudes a rectangle exactly', () => {
    const m = extrudeMesh(plate, 20);
    expectBasics(m);
    expectWatertight(m);
    expect(triCount(m)).toBe(12);
    expect(volume(m)).toBeCloseTo(100 * 50 * 20, 6);
    expect(m.bounds).toEqual({ min: [0, 0, 0], max: [100, 50, 20] });
    // 4 outline segments top and bottom, 4 vertical corners
    expect(m.edges.length / 6).toBe(12);
  });

  it('centres a symmetric extrusion', () => {
    const m = extrudeMesh(plate, 20, true);
    expect(m.bounds.min[2]).toBe(-10);
    expect(m.bounds.max[2]).toBe(10);
    expect(volume(m)).toBeCloseTo(100000, 6);
  });

  it('extrudes a plate with a hole', () => {
    const m = extrudeMesh(holed, 20);
    expectBasics(m);
    expectWatertight(m);
    const exact = (5000 - Math.PI * 100) * 20;
    expect(Math.abs(volume(m) / exact - 1)).toBeLessThan(0.005);
    // the hole is smooth: only the rectangle's corners get vertical edges
    const vertical = Array.from({ length: m.edges.length / 6 }, (_, i) => m.edges.subarray(i * 6, i * 6 + 6)).filter((e) => e[2] !== e[5]);
    expect(vertical.length).toBe(4);
  });

  it('accepts a hole given counter-clockwise and a lone circle', () => {
    const m = extrudeMesh([{ outer: rect(0, 0, 100, 50), holes: [circle(v(50, 25), 10)] }], 20);
    expectWatertight(m);
    expect(volume(m)).toBeGreaterThan(0);
    const disc = extrudeMesh([{ outer: circle(v(0, 0), 10), holes: [] }], 5);
    expectWatertight(disc);
    expect(Math.abs(volume(disc) / (Math.PI * 100 * 5) - 1)).toBeLessThan(0.005);
  });

  it('returns an empty mesh for nothing', () => {
    expect(triCount(extrudeMesh([], 10))).toBe(0);
    expect(triCount(extrudeMesh(plate, 0))).toBe(0);
  });
});

describe('revolveMesh', () => {
  const ring: ProfileRegion[] = [{ outer: rect(10, 0, 20, 30), holes: [] }];
  const yAxis = { p: v(0, 0), d: v(0, 1) };
  const tube = Math.PI * (20 ** 2 - 10 ** 2) * 30;

  it('revolves a full turn', () => {
    const m = revolveMesh(ring, yAxis, 2 * Math.PI);
    expectBasics(m);
    expectWatertight(m);
    expect(Math.abs(volume(m) / tube - 1)).toBeLessThan(0.005);
    expect(m.bounds.max[0]).toBeCloseTo(20, 4);
    expect(m.bounds.min[2]).toBeCloseTo(-20, 4);
  });

  it('revolves half a turn with end caps', () => {
    const m = revolveMesh(ring, yAxis, Math.PI);
    expectBasics(m);
    expectWatertight(m);
    expect(Math.abs(volume(m) / (tube / 2) - 1)).toBeLessThan(0.005);
    // right-hand rule about +y takes +x towards −z
    expect(m.bounds.max[2]).toBeCloseTo(0, 4);
    expect(m.bounds.min[2]).toBeCloseTo(-20, 4);
  });

  it('is outward-oriented on the other side of the axis and for a reversed axis', () => {
    const left: ProfileRegion[] = [{ outer: rect(-20, 0, -10, 30), holes: [] }];
    for (const m of [revolveMesh(left, yAxis, Math.PI / 2), revolveMesh(ring, { p: v(0, 5), d: v(0, -3) }, 1.5)]) {
      expectWatertight(m);
      expect(volume(m)).toBeGreaterThan(0);
    }
    const quarter = revolveMesh(left, yAxis, Math.PI / 2);
    expect(Math.abs(volume(quarter) / (tube / 4) - 1)).toBeLessThan(0.005);
  });

  it('closes a profile touching the axis (solid cylinder with a hole)', () => {
    const m = revolveMesh([{ outer: rect(0, 0, 20, 30), holes: [rect(5, 10, 10, 20)] }], yAxis, 2 * Math.PI);
    expectBasics(m);
    expectWatertight(m);
    const exact = Math.PI * 400 * 30 - Math.PI * (100 - 25) * 10;
    expect(Math.abs(volume(m) / exact - 1)).toBeLessThan(0.005);
  });

  it('revolves about a slanted axis', () => {
    const d = v(1, 1);
    const m = revolveMesh([{ outer: circle(v(30, 0), 5), holes: [] }], { p: v(0, 0), d }, 2 * Math.PI);
    expectWatertight(m);
    // torus: centre distance from the line y = x is 30/√2
    const exact = 2 * Math.PI * (30 / Math.SQRT2) * Math.PI * 25;
    expect(Math.abs(volume(m) / exact - 1)).toBeLessThan(0.005);
  });
});

describe('meshToStl', () => {
  it('writes binary STL', () => {
    const m = extrudeMesh(holed, 20);
    const stl = meshToStl(m, 'part');
    const n = triCount(m);
    expect(stl.length).toBe(84 + 50 * n);
    const dv = new DataView(stl.buffer, stl.byteOffset, stl.byteLength);
    expect(dv.getUint32(80, true)).toBe(n);
    expect(String.fromCharCode(...stl.subarray(0, 5))).not.toBe('solid');
    // first facet: unit normal, vertices as in the mesh
    expect(Math.hypot(dv.getFloat32(84, true), dv.getFloat32(88, true), dv.getFloat32(92, true))).toBeCloseTo(1, 5);
    expect(dv.getFloat32(96, true)).toBe(m.positions[0]);
    expect(dv.getUint16(84 + 48, true)).toBe(0);
  });
});
