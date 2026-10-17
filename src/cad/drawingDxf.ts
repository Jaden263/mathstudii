// A drawing sheet as DXF R2000 (AC1015), in sheet millimetres: true CIRCLE, ARC and
// ELLIPSE entities (B-splines as LWPOLYLINEs), one layer per ISO 128 line (VISIBLE,
// HIDDEN, CENTER, TANGENT, THIN, HATCH, DIM, TEXT, BORDER) with its line type and
// lineweight, arrowheads as SOLIDs and text as TEXT. R2000 is the oldest version with
// ellipses and lineweights; it needs handles, owners and subclass markers throughout, and
// the tables, blocks and objects every reader expects.
import { LAYERS, layerStyle, type Layer, type Sheet } from './drawingSheet';
import type { Prim } from './drawing2d';

const DEG = 180 / Math.PI;

/** Up to 10 significant digits as a plain decimal (some readers reject exponents). */
function num(v: number): string {
  if (!Number.isFinite(v)) return '0';
  const r = +v.toPrecision(10);
  let s = String(r);
  if (s.includes('e')) s = Math.abs(r) < 1 ? r.toFixed(12).replace(/\.?0+$/, '') : r.toFixed(0);
  return s === '-0' ? '0' : s;
}

/** Text as DXF writes it: characters past ASCII as \U+XXXX. */
const text = (s: string) => s.replace(/[^\x20-\x7e]/g, (c) => `\\U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`);

/** Degrees in [0, 360). */
const deg = (a: number) => {
  const d = (((a * DEG) % 360) + 360) % 360;
  return d >= 360 - 1e-10 ? 0 : d;
};

/** ACI colours: visible white/black, hidden grey, centre lines red, hatching blue, dimensions green. */
const COLOUR: Record<Layer, number> = { VISIBLE: 7, HIDDEN: 8, CENTER: 1, TANGENT: 9, THIN: 7, HATCH: 5, DIM: 3, TEXT: 7, BORDER: 7 };

/** Lineweights DXF knows (1/100 mm): the nearest at or above a width. */
const WEIGHTS = [0, 5, 9, 13, 15, 18, 20, 25, 30, 35, 40, 50, 53, 60, 70, 80, 90, 100, 106, 120, 140, 158, 200, 211];
export const lineweight = (mm: number) => WEIGHTS.find((w) => w >= Math.round(mm * 100) - 1e-9) ?? 211;

export function sheetDxf(sheet: Sheet): string {
  const out: string[] = [];
  const g = (code: number, value: string | number) => out.push(String(code), typeof value === 'number' ? num(value) : value);
  let next = 0x20;
  const handle = () => (next++).toString(16).toUpperCase();
  const narrow = sheet.group.narrow;
  const dashed = layerStyle('HIDDEN', sheet.group).dash, chain = layerStyle('CENTER', sheet.group).dash;

  // handles of the tables and blocks, known before they are written
  const H = {
    vport: handle(), ltype: handle(), layer: handle(), style: handle(), view: handle(), ucs: handle(), appid: handle(), dimstyle: handle(), brec: handle(),
    model: handle(), modelEnd: handle(), paper: handle(), paperEnd: handle(), dict: handle(), group: handle(),
  };

  // ---- tables
  const tables: string[] = [];
  const t = (code: number, value: string | number) => tables.push(String(code), typeof value === 'number' ? num(value) : value);
  const table = (name: string, h: string, n: number, extra?: () => void) => {
    t(0, 'TABLE'); t(2, name); t(5, h); t(330, '0'); t(100, 'AcDbSymbolTable'); t(70, n);
    extra?.();
  };
  const record = (type: string, table: string, sub: string, name: string, codeOfHandle = 5) => {
    t(0, type); t(codeOfHandle, handle()); t(330, table); t(100, 'AcDbSymbolTableRecord'); t(100, sub); t(2, name); t(70, 0);
  };
  table('VPORT', H.vport, 1);
  record('VPORT', H.vport, 'AcDbViewportTableRecord', '*Active');
  t(10, 0); t(20, 0); t(11, 1); t(21, 1); t(12, sheet.W / 2); t(22, sheet.H / 2); t(13, 0); t(23, 0); t(14, 10); t(24, 10); t(15, 10); t(25, 10);
  t(16, 0); t(26, 0); t(36, 1); t(17, 0); t(27, 0); t(37, 0); t(40, sheet.H * 1.05); t(41, sheet.W / sheet.H); t(42, 50); t(43, 0); t(44, 0); t(50, 0); t(51, 0);
  t(71, 0); t(72, 100); t(73, 1); t(74, 3); t(75, 0); t(76, 0); t(77, 0); t(78, 0);
  t(0, 'ENDTAB');
  table('LTYPE', H.ltype, 5);
  const ltype = (name: string, desc: string, dashes: number[]) => {
    record('LTYPE', H.ltype, 'AcDbLinetypeTableRecord', name);
    // dashes positive, gaps negative; a dot is a dash of length 0
    const els = dashes.map((d, i) => (i % 2 ? -d : d <= narrow * 0.5 + 1e-12 && i ? 0 : d));
    t(3, desc); t(72, 65); t(73, els.length); t(40, els.reduce((a, b) => a + Math.abs(b), 0));
    for (const v of els) {
      t(49, v);
      t(74, 0);
    }
  };
  ltype('ByBlock', '', []);
  ltype('ByLayer', '', []);
  ltype('Continuous', 'Solid line', []);
  ltype('DASHED', 'ISO 128 dashed __ __ __', dashed);
  ltype('CENTER', 'ISO 128 long-dash dotted ____ . ____', chain);
  t(0, 'ENDTAB');
  table('LAYER', H.layer, LAYERS.length + 1);
  const layer = (name: string, colour: number, lt: string, weight: number) => {
    record('LAYER', H.layer, 'AcDbLayerTableRecord', name);
    t(62, colour); t(6, lt); t(370, weight);
  };
  layer('0', 7, 'Continuous', -3);
  for (const L of LAYERS) {
    const st = layerStyle(L, sheet.group);
    layer(L, COLOUR[L], L === 'HIDDEN' ? 'DASHED' : L === 'CENTER' ? 'CENTER' : 'Continuous', lineweight(st.width));
  }
  t(0, 'ENDTAB');
  table('STYLE', H.style, 1);
  record('STYLE', H.style, 'AcDbTextStyleTableRecord', 'Standard');
  t(40, 0); t(41, 1); t(50, 0); t(71, 0); t(42, 2.5); t(3, 'arial.ttf'); t(4, '');
  t(0, 'ENDTAB');
  table('VIEW', H.view, 0);
  t(0, 'ENDTAB');
  table('UCS', H.ucs, 0);
  t(0, 'ENDTAB');
  table('APPID', H.appid, 1);
  record('APPID', H.appid, 'AcDbRegAppTableRecord', 'ACAD');
  t(0, 'ENDTAB');
  table('DIMSTYLE', H.dimstyle, 1, () => t(100, 'AcDbDimStyleTable'));
  record('DIMSTYLE', H.dimstyle, 'AcDbDimStyleTableRecord', 'Standard', 105);
  t(0, 'ENDTAB');
  table('BLOCK_RECORD', H.brec, 2);
  const brecs = { model: handle(), paper: handle() };
  for (const [name, h] of [['*Model_Space', brecs.model], ['*Paper_Space', brecs.paper]]) {
    t(0, 'BLOCK_RECORD'); t(5, h); t(330, H.brec); t(100, 'AcDbSymbolTableRecord'); t(100, 'AcDbBlockTableRecord'); t(2, name);
  }
  t(0, 'ENDTAB');

  // ---- entities
  const ents: string[] = [];
  const e = (code: number, value: string | number) => ents.push(String(code), typeof value === 'number' ? num(value) : value);
  const entity = (type: string, layer: string, sub: string) => {
    e(0, type); e(5, handle()); e(330, brecs.model); e(100, 'AcDbEntity'); e(8, layer); e(100, sub);
  };
  const put = (layer: Layer, p: Prim) => {
    switch (p.k) {
      case 'line':
        entity('LINE', layer, 'AcDbLine');
        e(10, p.x1); e(20, p.y1); e(30, 0); e(11, p.x2); e(21, p.y2); e(31, 0);
        return;
      case 'arc':
        if (p.a1 - p.a0 >= 2 * Math.PI - 1e-9) {
          entity('CIRCLE', layer, 'AcDbCircle');
          e(10, p.cx); e(20, p.cy); e(30, 0); e(40, p.r);
        } else {
          entity('ARC', layer, 'AcDbCircle');
          e(10, p.cx); e(20, p.cy); e(30, 0); e(40, p.r);
          e(100, 'AcDbArc'); e(50, deg(p.a0)); e(51, deg(p.a1));
        }
        return;
      case 'ellipse': {
        // the major axis first: a wider-than-long ellipse turns a quarter and its parameter with it
        const swap = p.ry > p.rx;
        const rot = swap ? p.rot + Math.PI / 2 : p.rot, major = swap ? p.ry : p.rx, minor = swap ? p.rx : p.ry, dt = swap ? Math.PI / 2 : 0;
        entity('ELLIPSE', layer, 'AcDbEllipse');
        e(10, p.cx); e(20, p.cy); e(30, 0);
        e(11, major * Math.cos(rot)); e(21, major * Math.sin(rot)); e(31, 0);
        e(210, 0); e(220, 0); e(230, 1);
        e(40, minor / major);
        // parameters within 0 … 2π, as readers expect them (an end below the start runs on through 0)
        const whole = p.t1 - p.t0 >= 2 * Math.PI - 1e-9;
        const t0 = whole ? 0 : (((p.t0 - dt) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
        const t1 = t0 + (p.t1 - p.t0);
        e(41, t0); e(42, whole ? 2 * Math.PI : t1 > 2 * Math.PI ? t1 - 2 * Math.PI : t1);
        return;
      }
      case 'poly': {
        entity('LWPOLYLINE', layer, 'AcDbPolyline');
        e(90, p.pts.length / 2); e(70, 0); e(43, 0);
        for (let i = 0; i + 1 < p.pts.length; i += 2) {
          e(10, p.pts[i]); e(20, p.pts[i + 1]);
        }
      }
    }
  };
  for (const ink of sheet.inks) put(ink.layer, ink.p);
  for (const f of sheet.fills) {
    entity('SOLID', f.layer, 'AcDbTrace');
    // a triangle repeats its last corner
    const last = f.pts.length / 2 - 1;
    for (let i = 0; i < 4; i++) {
      const c = Math.min(i, last);
      e(10 + i, f.pts[2 * c]); e(20 + i, f.pts[2 * c + 1]); e(30 + i, 0);
    }
  }
  for (const l of sheet.labels) {
    entity('TEXT', l.layer, 'AcDbText');
    e(10, l.x); e(20, l.y); e(30, 0); e(40, l.h); e(1, text(l.text)); e(50, l.rot ?? 0); e(7, 'Standard');
    const hj = l.anchor === 'middle' ? 1 : l.anchor === 'end' ? 2 : 0;
    if (hj) {
      e(72, hj); e(11, l.x); e(21, l.y); e(31, 0);
    }
    e(100, 'AcDbText');
  }

  // ---- the file
  g(0, 'SECTION'); g(2, 'HEADER');
  g(9, '$ACADVER'); g(1, 'AC1015');
  g(9, '$DWGCODEPAGE'); g(3, 'ANSI_1252');
  g(9, '$INSBASE'); g(10, 0); g(20, 0); g(30, 0);
  g(9, '$EXTMIN'); g(10, 0); g(20, 0); g(30, 0);
  g(9, '$EXTMAX'); g(10, sheet.W); g(20, sheet.H); g(30, 0);
  g(9, '$LIMMIN'); g(10, 0); g(20, 0);
  g(9, '$LIMMAX'); g(10, sheet.W); g(20, sheet.H);
  g(9, '$LTSCALE'); g(40, 1);
  g(9, '$INSUNITS'); g(70, 4);
  g(9, '$MEASUREMENT'); g(70, 1);
  g(9, '$LWDISPLAY'); g(290, 1);
  g(9, '$HANDSEED'); g(5, (next + 1).toString(16).toUpperCase());
  g(0, 'ENDSEC');
  g(0, 'SECTION'); g(2, 'CLASSES'); g(0, 'ENDSEC');
  g(0, 'SECTION'); g(2, 'TABLES');
  out.push(...tables);
  g(0, 'ENDSEC');
  g(0, 'SECTION'); g(2, 'BLOCKS');
  for (const [name, h, end, br, paper] of [['*Model_Space', H.model, H.modelEnd, brecs.model, false], ['*Paper_Space', H.paper, H.paperEnd, brecs.paper, true]] as const) {
    g(0, 'BLOCK'); g(5, h); g(330, br); g(100, 'AcDbEntity'); if (paper) g(67, 1); g(8, '0'); g(100, 'AcDbBlockBegin'); g(2, name); g(70, 0); g(10, 0); g(20, 0); g(30, 0); g(3, name); g(1, '');
    g(0, 'ENDBLK'); g(5, end); g(330, br); g(100, 'AcDbEntity'); if (paper) g(67, 1); g(8, '0'); g(100, 'AcDbBlockEnd');
  }
  g(0, 'ENDSEC');
  g(0, 'SECTION'); g(2, 'ENTITIES');
  out.push(...ents);
  g(0, 'ENDSEC');
  g(0, 'SECTION'); g(2, 'OBJECTS');
  g(0, 'DICTIONARY'); g(5, H.dict); g(330, '0'); g(100, 'AcDbDictionary'); g(281, 1); g(3, 'ACAD_GROUP'); g(350, H.group);
  g(0, 'DICTIONARY'); g(5, H.group); g(330, H.dict); g(100, 'AcDbDictionary'); g(281, 1);
  g(0, 'ENDSEC');
  g(0, 'EOF');
  return out.join('\n') + '\n';
}
