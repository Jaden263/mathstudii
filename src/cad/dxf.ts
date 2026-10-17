// DXF exchange for CAD sketches: ASCII DXF out (R12 entities, which every reader
// understands) and a tolerant reader for the 2-D entities a profile is made of.
//
// Import rebuilds topology: endpoints that coincide become one CadPoint, so outlines
// drawn as separate LINEs/ARCs or as polylines arrive connected, as if sketched here.
import { cadId, entityPoints, pointMap, type CadEntity, type CadPoint, type CadSketch, type CadUnit } from './model';
import { segPolyline } from './profile';
import { entitySegs } from './sketchCurves';

interface Vec {
  x: number;
  y: number;
}

const UNIT_CODE: Record<CadUnit, number> = { in: 1, mm: 4, cm: 5, m: 6 };
const CODE_UNIT: Record<number, CadUnit> = { 1: 'in', 4: 'mm', 5: 'cm', 6: 'm' };
const CONSTRUCTION_LAYER = 'CONSTRUCTION';
const DEG = 180 / Math.PI;

// ------------------------------------------------------------ export

/** Up to 10 significant digits as a plain decimal: some readers reject exponents. */
function fmt(v: number): string {
  if (!Number.isFinite(v)) return '0';
  const r = +v.toPrecision(10);
  let s = String(r);
  if (s.includes('e')) s = Math.abs(r) < 1 ? r.toFixed(15).replace(/\.?0+$/, '') : BigInt(Math.round(r)).toString();
  return s === '-0' ? '0' : s;
}

/** Degrees in [0, 360). */
function angle(c: Vec, p: Vec): number {
  const d = Math.atan2(p.y - c.y, p.x - c.x) * DEG;
  const a = +(((d % 360) + 360) % 360).toPrecision(10);
  return a >= 360 ? 0 : a;
}

/**
 * ASCII DXF of a sketch. `positions` / `radii` override the stored point coordinates
 * and circle radii (solver output). Construction geometry goes on layer CONSTRUCTION.
 */
export function sketchToDxf(
  sketch: CadSketch,
  unit: CadUnit,
  positions?: Map<string, { x: number; y: number }>,
  radii?: Map<string, number>,
): string {
  const stored = pointMap(sketch);
  const P = (id: string): Vec => positions?.get(id) ?? stored.get(id) ?? { x: 0, y: 0 };
  const R = (id: string, r: number) => Math.abs(radii?.get(id) ?? r);
  const out: string[] = [];
  const g = (code: number, value: string | number) => out.push(String(code), typeof value === 'number' ? fmt(value) : value);
  const xy = (code: number, p: Vec) => { g(code, p.x); g(code + 10, p.y); g(code + 20, 0); };

  let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
  const grow = (p: Vec, r = 0) => {
    xmin = Math.min(xmin, p.x - r); xmax = Math.max(xmax, p.x + r);
    ymin = Math.min(ymin, p.y - r); ymax = Math.max(ymax, p.y + r);
  };
  // splines, ellipses and text have no R12 entity: they go out as polylines through their curve
  const polylines = (e: CadEntity) => entitySegs(e, P, (id) => radii?.get(id)).map((sg) => segPolyline(sg, Math.PI / 90));
  for (const e of sketch.entities) {
    if (e.type === 'circle') grow(P(e.c), R(e.id, e.r));
    else if (e.type === 'arc') grow(P(e.c), Math.hypot(P(e.p1).x - P(e.c).x, P(e.p1).y - P(e.c).y));
    else if (e.type === 'line') { grow(P(e.p1)); grow(P(e.p2)); }
    else if (e.type === 'point') grow(P(e.p));
    else for (const pl of polylines(e)) pl.forEach((q) => grow(q));
  }

  g(0, 'SECTION'); g(2, 'HEADER');
  g(9, '$ACADVER'); g(1, 'AC1009');
  g(9, '$INSUNITS'); g(70, UNIT_CODE[unit]);
  if (xmin <= xmax) {
    g(9, '$EXTMIN'); xy(10, { x: xmin, y: ymin });
    g(9, '$EXTMAX'); xy(10, { x: xmax, y: ymax });
  }
  g(0, 'ENDSEC');

  g(0, 'SECTION'); g(2, 'TABLES');
  g(0, 'TABLE'); g(2, 'LTYPE'); g(70, 2);
  g(0, 'LTYPE'); g(2, 'CONTINUOUS'); g(70, 0); g(3, 'Solid line'); g(72, 65); g(73, 0); g(40, 0);
  g(0, 'LTYPE'); g(2, 'DASHED'); g(70, 0); g(3, '__ __ __'); g(72, 65); g(73, 2); g(40, 0.75); g(49, 0.5); g(49, -0.25);
  g(0, 'ENDTAB');
  g(0, 'TABLE'); g(2, 'LAYER'); g(70, 2);
  g(0, 'LAYER'); g(2, '0'); g(70, 0); g(62, 7); g(6, 'CONTINUOUS');
  g(0, 'LAYER'); g(2, CONSTRUCTION_LAYER); g(70, 0); g(62, 8); g(6, 'DASHED');
  g(0, 'ENDTAB');
  g(0, 'ENDSEC');

  g(0, 'SECTION'); g(2, 'ENTITIES');
  for (const e of sketch.entities) {
    const layer = e.construction ? CONSTRUCTION_LAYER : '0';
    switch (e.type) {
      case 'line':
        g(0, 'LINE'); g(8, layer); xy(10, P(e.p1)); xy(11, P(e.p2));
        break;
      case 'circle':
        g(0, 'CIRCLE'); g(8, layer); xy(10, P(e.c)); g(40, R(e.id, e.r));
        break;
      case 'arc': {
        // both are CCW from start to end, so the angles carry over directly
        const c = P(e.c), a = P(e.p1);
        g(0, 'ARC'); g(8, layer); xy(10, c); g(40, Math.hypot(a.x - c.x, a.y - c.y));
        g(50, angle(c, a)); g(51, angle(c, P(e.p2)));
        break;
      }
      case 'point':
        g(0, 'POINT'); g(8, layer); xy(10, P(e.p));
        break;
      default:
        for (const pl of polylines(e)) {
          g(0, 'POLYLINE'); g(8, layer); g(66, 1); xy(10, { x: 0, y: 0 }); g(70, 0);
          for (const q of pl) { g(0, 'VERTEX'); g(8, layer); xy(10, q); }
          g(0, 'SEQEND'); g(8, layer);
        }
    }
  }
  g(0, 'ENDSEC');
  g(0, 'EOF');
  return out.join('\n') + '\n';
}

// ------------------------------------------------------------ import

type Group = [number, string];

interface Rec {
  type: string;
  g: Group[];
}

type Raw =
  | { kind: 'line'; a: Vec; b: Vec; cons: boolean }
  /** CCW from a to b around c. */
  | { kind: 'arc'; c: Vec; a: Vec; b: Vec; cons: boolean }
  | { kind: 'circle'; c: Vec; r: number; cons: boolean }
  | { kind: 'point'; p: Vec; cons: boolean };

const float = (v: string) => {
  const x = parseFloat(v);
  return Number.isFinite(x) ? x : 0;
};

function val(r: Rec, code: number, def = 0): number {
  const hit = r.g.find((x) => x[0] === code);
  return hit ? float(hit[1]) : def;
}

function groups(text: string): Group[] {
  if (text.startsWith('AutoCAD Binary DXF')) throw new Error('Binary DXF is not supported; save as ASCII DXF');
  const lines = text.replace(/^﻿/, '').split(/\r\n|\r|\n/);
  const out: Group[] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = lines[i].trim();
    if (!/^-?\d+$/.test(code)) throw new Error(`DXF line ${i + 1}: expected a group code, found "${code.slice(0, 20)}"`);
    out.push([parseInt(code, 10), lines[i + 1].trim()]);
  }
  return out;
}

/** Segment from a to b of a polyline; bulge = tan(included angle / 4), positive = CCW. */
function bulgeSeg(a: Vec, b: Vec, bulge: number, cons: boolean): Raw {
  if (Math.abs(bulge) < 1e-12) return { kind: 'line', a, b, cons };
  const dx = b.x - a.x, dy = b.y - a.y;
  // centre offset from the chord midpoint, in chord lengths, to the left of a→b
  const h = (1 - bulge * bulge) / (4 * bulge);
  const c = { x: (a.x + b.x) / 2 - h * dy, y: (a.y + b.y) / 2 + h * dx };
  // a clockwise arc is the CCW arc from b back to a
  return bulge > 0 ? { kind: 'arc', c, a, b, cons } : { kind: 'arc', c, a: b, b: a, cons };
}

function polyline(verts: { x: number; y: number; b: number }[], closed: boolean, cons: boolean): Raw[] {
  const out: Raw[] = [];
  for (let i = 0; i + 1 < verts.length; i++) out.push(bulgeSeg(verts[i], verts[i + 1], verts[i].b, cons));
  if (closed && verts.length > 1) out.push(bulgeSeg(verts[verts.length - 1], verts[0], verts[verts.length - 1].b, cons));
  return out;
}

/**
 * Sketch geometry from an ASCII DXF: LINE, CIRCLE, ARC, POINT, LWPOLYLINE and
 * POLYLINE (with bulges) from model space. Layers named like "construction" give
 * construction geometry. No constraints are created.
 */
export function dxfToSketch(text: string): { sketch: CadSketch; unit: CadUnit | null; warnings: string[] } {
  const gs = groups(text);
  const recs: Rec[] = [];
  let unit: CadUnit | null = null;
  let section = '';
  let sawSection = false;
  let cur: Rec | null = null;
  for (let i = 0; i < gs.length; i++) {
    const [c, v] = gs[i];
    if (c === 0 && (v === 'SECTION' || v === 'ENDSEC' || v === 'EOF')) {
      cur = null;
      if (v === 'EOF') break;
      sawSection = true;
      section = v === 'SECTION' && gs[i + 1]?.[0] === 2 ? gs[++i][1].toUpperCase() : '';
      continue;
    }
    if (section === 'HEADER' && c === 9 && v === '$INSUNITS' && gs[i + 1]?.[0] === 70) {
      unit = CODE_UNIT[parseInt(gs[++i][1], 10)] ?? null;
      continue;
    }
    // a bare entity list without sections is read as entities too
    if (section !== 'ENTITIES' && sawSection) continue;
    if (c === 0) recs.push((cur = { type: v.toUpperCase(), g: [] }));
    else cur?.g.push([c, v]);
  }

  const raws: Raw[] = [];
  const skipped = new Map<string, number>();
  const skip = (what: string) => skipped.set(what, (skipped.get(what) ?? 0) + 1);
  let paper = 0;
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i];
    const verts: { x: number; y: number; b: number }[] = [];
    if (r.type === 'POLYLINE') {
      // VERTEX records follow up to SEQEND; spline frame points (flag 16) are not on the curve
      while (recs[i + 1]?.type === 'VERTEX') {
        const v = recs[++i];
        if (!(val(v, 70) & 16)) verts.push({ x: val(v, 10), y: val(v, 20), b: val(v, 42) });
      }
      if (recs[i + 1]?.type === 'SEQEND') i++;
    }
    if (val(r, 67) === 1) { paper++; continue; }
    const layer = r.g.find((x) => x[0] === 8)?.[1] ?? '0';
    const cons = /constr/i.test(layer);
    // circles, arcs and 2-D polylines are in object coordinates; a -Z extrusion mirrors x
    const flip = val(r, 230, 1) < 0;
    const o = (x: number, y: number): Vec => ({ x: flip ? -x : x, y });
    switch (r.type) {
      case 'LINE':
        raws.push({ kind: 'line', a: { x: val(r, 10), y: val(r, 20) }, b: { x: val(r, 11), y: val(r, 21) }, cons });
        break;
      case 'POINT':
        raws.push({ kind: 'point', p: { x: val(r, 10), y: val(r, 20) }, cons });
        break;
      case 'CIRCLE':
        raws.push({ kind: 'circle', c: o(val(r, 10), val(r, 20)), r: Math.abs(val(r, 40)), cons });
        break;
      case 'ARC': {
        const c = o(val(r, 10), val(r, 20)), rad = Math.abs(val(r, 40));
        const s = val(r, 50) / DEG, e = val(r, 51) / DEG;
        const sweep = (((e - s) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
        if (sweep < 1e-12 || 2 * Math.PI - sweep < 1e-12) {
          raws.push({ kind: 'circle', c, r: rad, cons });
          break;
        }
        const ps = o(val(r, 10) + rad * Math.cos(s), val(r, 20) + rad * Math.sin(s));
        const pe = o(val(r, 10) + rad * Math.cos(e), val(r, 20) + rad * Math.sin(e));
        raws.push(flip ? { kind: 'arc', c, a: pe, b: ps, cons } : { kind: 'arc', c, a: ps, b: pe, cons });
        break;
      }
      case 'LWPOLYLINE':
      case 'POLYLINE': {
        if (r.type === 'LWPOLYLINE') {
          for (const [c, v] of r.g) {
            if (c === 10) verts.push({ x: float(v), y: 0, b: 0 });
            else if (c === 20 && verts.length) verts[verts.length - 1].y = float(v);
            else if (c === 42 && verts.length) verts[verts.length - 1].b = float(v);
          }
        }
        const flags = val(r, 70);
        if (flags & (16 | 64)) { skip('POLYLINE mesh'); break; }
        const mirror = flip && !(flags & 8); // 3-D polylines are already in world coordinates
        const vs = mirror ? verts.map((v) => ({ x: -v.x, y: v.y, b: -v.b })) : verts;
        raws.push(...polyline(vs, (flags & 1) === 1, cons));
        break;
      }
      default:
        skip(r.type);
    }
  }

  // shared points: coincident within 1e-9 of the drawing size, found through a grid
  let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
  const grow = (p: Vec, r = 0) => {
    xmin = Math.min(xmin, p.x - r); xmax = Math.max(xmax, p.x + r);
    ymin = Math.min(ymin, p.y - r); ymax = Math.max(ymax, p.y + r);
  };
  for (const w of raws) {
    if (w.kind === 'line') { grow(w.a); grow(w.b); }
    else if (w.kind === 'arc') { grow(w.c); grow(w.a); grow(w.b); }
    else if (w.kind === 'circle') grow(w.c, w.r);
    else grow(w.p);
  }
  const tol = raws.length ? 1e-9 * Math.max(xmax - xmin, ymax - ymin) : 0;
  const cell = tol > 0 ? tol : 1;
  const points: CadPoint[] = [];
  const grid = new Map<string, CadPoint[]>();
  const pt = (v: Vec): string => {
    const i = Math.floor(v.x / cell), j = Math.floor(v.y / cell);
    for (let di = -1; di <= 1; di++) {
      for (let dj = -1; dj <= 1; dj++) {
        for (const p of grid.get(`${i + di},${j + dj}`) ?? []) if (Math.hypot(p.x - v.x, p.y - v.y) <= tol) return p.id;
      }
    }
    const p = { id: cadId('p'), x: v.x, y: v.y };
    points.push(p);
    const key = `${i},${j}`;
    grid.set(key, [...(grid.get(key) ?? []), p]);
    return p.id;
  };

  // zero-length pieces (repeated polyline vertices, dots drawn as lines) are dropped quietly
  const entities: CadEntity[] = [];
  const flag = (cons: boolean) => (cons ? { construction: true } : {});
  for (const w of raws) {
    if (w.kind === 'line') {
      const p1 = pt(w.a), p2 = pt(w.b);
      if (p1 !== p2) entities.push({ id: cadId('e'), type: 'line', p1, p2, ...flag(w.cons) });
    } else if (w.kind === 'arc') {
      const p1 = pt(w.a), p2 = pt(w.b);
      if (p1 !== p2) entities.push({ id: cadId('e'), type: 'arc', c: pt(w.c), p1, p2, ...flag(w.cons) });
    } else if (w.kind === 'circle') {
      if (w.r > tol) entities.push({ id: cadId('e'), type: 'circle', c: pt(w.c), r: w.r, ...flag(w.cons) });
    } else {
      entities.push({ id: cadId('e'), type: 'point', p: pt(w.p), ...flag(w.cons) });
    }
  }
  // points made for dropped pieces would be orphans
  const used = new Set(entities.flatMap(entityPoints));

  const warnings: string[] = [];
  if (skipped.size) warnings.push('Skipped ' + [...skipped].map(([t, k]) => `${k} ${t}`).join(', '));
  if (paper) warnings.push(`Skipped ${paper} paper-space entit${paper > 1 ? 'ies' : 'y'}`);
  return { sketch: { points: points.filter((p) => used.has(p.id)), entities, constraints: [] }, unit, warnings };
}
