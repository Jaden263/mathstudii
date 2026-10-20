// What a drawing says besides its views: dimensions with tolerances and fits, notes and
// hole callouts, GD&T feature control frames (ISO 1101), datum feature symbols (ISO 5459),
// surface texture symbols (ISO 1302 / ISO 21920-1), centre marks and the balloons of a
// parts list (ISO 6433, ISO 7573), with the title block's fields (ISO 7200).
//
// Annotations sit on a view and pick its geometry: a pick names a face, edge or vertex
// of an occurrence by its persistent name (topology.ts), so a dimension follows the part
// through edits and is flagged when what it measures is gone. Positions are view
// coordinates (model units on the paper of the view), so they move with the view, and are
// kept beside their geometry as it changes (drawingRefs.ts followText, followPoint).
import type { CadComponent, HoleFeature, CadDesign, ThreadFeature } from './design';
import { baseName, type TopoRef } from './topology';
import { MATERIALS } from './model';
import { parseThread } from './threads';
import { fitDeviations, parseFit } from './fits';
import { materialOfBody } from './materials';

/** A view-coordinate point. */
export type XY = [number, number];

/** The geometry of a model entity on the paper of a view (view coordinates). */
export type Shape2 =
  | { k: 'point'; x: number; y: number }
  | { k: 'line'; x1: number; y1: number; x2: number; y2: number }
  /** An edge seen end-on: a circle (a1 − a0 = 2π) or an arc, counter-clockwise from a0 to a1. */
  | { k: 'circle'; cx: number; cy: number; r: number; a0: number; a1: number }
  /** A cylinder seen side-on: its axis from (x1, y1) to (x2, y2), outlines at ±r square to it. */
  | { k: 'cyl'; x1: number; y1: number; x2: number; y2: number; r: number };

/**
 * What of an entity a pick takes: a vertex; the middle, the centre or a quadrant (0°, 90°,
 * 180°, 270° on the paper) of an edge; a whole line, circle or arc; the outlines of a
 * cylinder seen side-on; where an edge goes through a section's plane (its first or
 * second crossing: a corner of the cut face).
 */
export type PickSnap = 'vertex' | 'mid' | 'end0' | 'end1' | 'centre' | 'q0' | 'q1' | 'q2' | 'q3' | 'line' | 'circle' | 'cyl' | 'cut0' | 'cut1';

/**
 * A pick on a view: a face, edge or vertex of an occurrence (it follows the model), or a
 * fixed point of the view (`snap: 'free'`, for line work that is not a model entity, such
 * as a cut face's outline). `shape` is what it was when picked: a fixed point's place,
 * and where a pick that lost its entity is drawn.
 */
export interface DrawPick {
  occ?: string;
  ref?: TopoRef;
  snap: PickSnap | 'free';
  shape: Shape2;
}

/** Tolerances of a size (values in part units; a fit's come from ISO 286). */
export type Tolerance =
  /** ±t */
  | { kind: 'sym'; t: number }
  /** Upper and lower deviation, e.g. +0.1 / −0.05 */
  | { kind: 'dev'; upper: number; lower: number }
  /** The limits of size from the deviations, upper above lower */
  | { kind: 'limits'; upper: number; lower: number }
  /** An ISO 286 class or fit ("H7", "g6", "H7/g6"), optionally with its deviations or limits in parentheses */
  | { kind: 'fit'; code: string; show?: 'code' | 'dev' | 'limits' };

interface Base {
  id: string;
  /** The placed view it is on: 'front', 'top', 'side', 'iso', `sec:${id}`, `det:${id}`. */
  view: string;
  /**
   * Paper millimetres per model unit of its view when it was placed: should the view's
   * scale change, its distances from its geometry stay the same on the paper.
   */
  k?: number;
}

export interface DimAnnotation extends Base {
  kind: 'dim';
  /**
   * Linear (horizontal, vertical or aligned), radius, diameter, angle between two lines,
   * arc length, or the diameter of a pitch circle (a hole's centre `a` round the centre `b`).
   */
  type: 'linear' | 'radius' | 'diameter' | 'angle' | 'arc' | 'pitch';
  orient?: 'h' | 'v' | 'aligned';
  a: DrawPick;
  b?: DrawPick;
  /** Where the value sits; the dimension line (or arc) runs through it. */
  text: XY;
  tol?: Tolerance;
  /** Decimals of this value (missing: the drawing's). */
  decimals?: number;
  /** Before the value: "4×", "2× 45°"; the symbol Ø or R is added by the type. */
  prefix?: string;
  suffix?: string;
  /** Text in place of the value: <> stands for it. */
  override?: string;
  /** Auxiliary (reference) dimension, in parentheses (ISO 129-1). */
  reference?: boolean;
  /** Theoretically exact dimension, framed (ISO 1101, ISO 5458). */
  basic?: boolean;
}

export interface NoteAnnotation extends Base {
  kind: 'note';
  text: string;
  /** Start of the first line's baseline. */
  at: XY;
  leader?: DrawPick;
}

/** A hole callout: the text comes from the hole feature that made the picked hole (ISO 15786 symbols). */
export interface HoleAnnotation extends Base {
  kind: 'hole';
  a: DrawPick;
  at: XY;
  /** Thread tolerance class (ISO 965-1; missing: the medium classes, 6H inside, 6g outside). */
  cls?: string;
  /** Text in place of the generated one (<> stands for it). */
  override?: string;
}

export const GDT_CHARS = [
  'straightness', 'flatness', 'circularity', 'cylindricity', 'lineProfile', 'surfaceProfile',
  'parallelism', 'perpendicularity', 'angularity', 'position', 'coaxiality', 'concentricity', 'symmetry', 'circularRunout', 'totalRunout',
] as const;
export type GdtChar = (typeof GDT_CHARS)[number];

/** ISO 1101 names and whether a datum belongs to the characteristic (form tolerances have none). */
export const GDT_INFO: Record<GdtChar, { name: string; datum: 'none' | 'optional' | 'required'; dia?: boolean }> = {
  straightness: { name: 'Straightness', datum: 'none', dia: true },
  flatness: { name: 'Flatness', datum: 'none' },
  circularity: { name: 'Roundness', datum: 'none' },
  cylindricity: { name: 'Cylindricity', datum: 'none' },
  lineProfile: { name: 'Profile of a line', datum: 'optional' },
  surfaceProfile: { name: 'Profile of a surface', datum: 'optional' },
  parallelism: { name: 'Parallelism', datum: 'required', dia: true },
  perpendicularity: { name: 'Perpendicularity', datum: 'required', dia: true },
  angularity: { name: 'Angularity', datum: 'required', dia: true },
  position: { name: 'Position', datum: 'optional', dia: true },
  coaxiality: { name: 'Coaxiality', datum: 'required', dia: true },
  concentricity: { name: 'Concentricity', datum: 'required', dia: true },
  symmetry: { name: 'Symmetry', datum: 'required' },
  circularRunout: { name: 'Circular run-out', datum: 'required' },
  totalRunout: { name: 'Total run-out', datum: 'required' },
};

/** Modifiers: maximum and least material requirement, projected tolerance zone. */
export type GdtModifier = 'M' | 'L' | 'P';

export interface GdtAnnotation extends Base {
  kind: 'gdt';
  char: GdtChar;
  /** Tolerance value (part units). */
  tol: number;
  /** A cylindrical zone: Ø before the value. */
  dia?: boolean;
  mod?: GdtModifier;
  /** Up to three datum references (primary, secondary, tertiary): "A", "B", "A-B". */
  datums?: { letter: string; mod?: 'M' | 'L' }[];
  /** Left end, middle of the frame's height. */
  at: XY;
  /** A leader to the toleranced feature (missing: under a dimension or free). */
  leader?: DrawPick;
  /** Under this dimension's value (the tolerance of a feature of size: its axis or median plane). */
  dim?: string;
}

export interface DatumAnnotation extends Base {
  kind: 'datum';
  letter: string;
  /** Centre of the letter's frame. */
  at: XY;
  /** The datum feature: the triangle stands on it. */
  leader: DrawPick;
  /** A feature of size (its axis or median plane): the triangle at the end of this dimension's line instead (ISO 5459). */
  dim?: string;
}

/** Lay of the surface pattern (ISO 1302 Table 2). */
export type Lay = '=' | '⊥' | 'X' | 'M' | 'C' | 'R' | 'P';

export interface SurfaceAnnotation extends Base {
  kind: 'surface';
  param: 'Ra' | 'Rz';
  /** µm */
  value: number;
  /** Any process, material removal required, or removal not permitted. */
  process: 'any' | 'removal' | 'noremoval';
  lay?: Lay;
  /** Manufacturing method (position c: "ground", "milled"). */
  method?: string;
  /** Where the symbol's point touches (the surface, or the end of its leader). */
  at: XY;
  leader?: DrawPick;
}

/** A centre mark added to a circle or arc, or (hide) one of the automatic ones taken away. */
export interface CentreAnnotation extends Base {
  kind: 'centre';
  a: DrawPick;
  hide?: boolean;
  /** How far the lines run past the circle (paper mm; missing: 3, ISO 128-24). */
  ext?: number;
}

/** A balloon with the item number of a part of the parts list, its leader on the part. */
export interface BalloonAnnotation extends Base {
  kind: 'balloon';
  occ: string;
  a: DrawPick;
  /** Centre of the balloon. */
  at: XY;
}

export type Annotation = DimAnnotation | NoteAnnotation | HoleAnnotation | GdtAnnotation | DatumAnnotation | SurfaceAnnotation | CentreAnnotation | BalloonAnnotation;

/** ISO 7200 fields of the title block beyond the drawing's own (title, part no., material, drawn by, date). */
export interface TitleFields {
  owner?: string;
  docType?: string;
  checkedBy?: string;
  approvedBy?: string;
  revision?: string;
  /** Sheet n of m (missing: 1 of 1). */
  sheet?: number;
  sheets?: number;
  /** Mass as written (missing: from the part). */
  mass?: string;
  /** Show the revision table. */
  revisions?: boolean;
}

export interface Revision {
  rev: string;
  text: string;
  date: string;
  by: string;
}

/** The parts list on the sheet. */
export interface BomSettings {
  show: boolean;
  /** Material and name per component, where the drawing says otherwise. */
  rows?: Record<string, { name?: string; material?: string }>;
}

// ------------------------------------------------------------ numbers

/** Decimals a part unit shows when the drawing does not say: up to 2 in mm, more in larger units. */
const AUTO_DECIMALS: Record<string, number> = { mm: 2, cm: 3, m: 4, in: 3 };

/** A size as a drawing writes it: fixed decimals, or (missing) up to the unit's few with trailing zeros dropped. */
export function fmtSize(v: number, unit: string, decimals?: number): string {
  if (!Number.isFinite(v)) return '?';
  const s = decimals !== undefined ? v.toFixed(Math.max(0, Math.min(6, decimals))) : String(+v.toFixed(AUTO_DECIMALS[unit] ?? 2));
  return s.replace(/^-(0(?:\.0+)?)$/, '$1').replace('-', '−');
}

/** Millimetres per part unit (tolerance tables are in mm). */
export const MM: Record<string, number> = { mm: 1, cm: 10, m: 1000, in: 25.4 };

/**
 * Decimals for deviations and limits: as few as write all of them exactly, the same for
 * both (+0.10 / −0.05, ±0.1, +0.021 / 0; ISO 129-1), down to a tenth of a micrometre
 * (js6 ±6.5 µm: 4 in mm, 5 in cm).
 */
export function devDecimals(values: number[], unit: string): number {
  const most = (unit === 'in' ? 5 : 3 + Math.round(Math.log10(MM[unit] ?? 1))) + 1;
  for (let d = 0; d < most; d++) if (values.every((v) => Math.abs(+v.toFixed(d) - v) <= 1e-9 * Math.max(1, Math.abs(v)))) return d;
  return most;
}

/** A deviation: zero as "0", others signed. */
export const fmtDev = (v: number, d: number) => (Math.abs(v) < 0.5 * 10 ** -d ? '0' : `${v > 0 ? '+' : '−'}${Math.abs(v).toFixed(d)}`);

/** The text of a dimension: its main part, deviations or limits stacked after it, and what closes it. */
export interface DimText {
  main: string;
  stack?: [string, string];
  /** After the stack (")"). */
  tail?: string;
  /** Why the tolerance could not be worked out (a class not in the tables). */
  error?: string;
}

/**
 * The text of a size with its tolerance (ISO 129-1, ISO 286-1, ISO 14405-1): "Ø20 H7",
 * "20 ±0.1", "20" with +0.1 / −0.05 stacked, the limits 20.021 / 20.000 stacked, a fit
 * with its deviations in parentheses. `prefix` holds the symbol and count ("4× Ø"); `sign`
 * follows the value and each deviation or limit (an angle's °: "30° ±0.5°").
 */
export function dimText(value: number, unit: string, o: { prefix?: string; suffix?: string; sign?: string; decimals?: number; tol?: Tolerance; override?: string; reference?: boolean }): DimText {
  const sg = o.sign ?? '';
  const v = fmtSize(value, unit, o.decimals) + sg;
  const pre = o.prefix ?? '';
  const suf = o.suffix ?? '';
  const wrap = (t: DimText): DimText => (o.reference ? { ...t, main: `(${t.main}`, tail: `${t.tail ?? ''})` } : t);
  if (o.override?.trim()) return wrap({ main: o.override.replace(/<>/g, v) });
  const tol = o.tol;
  if (!tol) return wrap({ main: `${pre}${v}${suf}` });
  const pm = (t: number) => `±${fmtSize(Math.abs(t), unit, devDecimals([t], unit))}${sg}`;
  if (tol.kind === 'sym') return wrap({ main: `${pre}${v} ${pm(tol.t)}${suf}` });
  // deviations equal either side are written once with ± (ISO 129-1)
  const even = (up: number, lo: number) => up !== 0 && Math.abs(up + lo) <= 1e-12 * Math.abs(up);
  const stacked = (a: number, b: number, limits: boolean): [string, string] => {
    // the upper one above, whichever way round they were entered
    const [up, lo] = a >= b ? [a, b] : [b, a];
    if (limits) {
      const d = Math.max(o.decimals ?? 0, devDecimals([value + up, value + lo], unit));
      return [fmtSize(value + up, unit, d) + sg, fmtSize(value + lo, unit, d) + sg];
    }
    const d = devDecimals([up, lo], unit);
    return [fmtDev(up, d) + sg, fmtDev(lo, d) + sg];
  };
  if (tol.kind === 'dev') {
    if (even(tol.upper, tol.lower)) return wrap({ main: `${pre}${v} ${pm(tol.upper)}${suf}` });
    return wrap({ main: `${pre}${v}`, stack: stacked(tol.upper, tol.lower, false), ...(suf ? { tail: suf } : {}) });
  }
  if (tol.kind === 'limits') return wrap({ main: pre, stack: stacked(tol.upper, tol.lower, true), ...(suf ? { tail: suf } : {}) });
  // a fit: deviations from the tables at the nominal size in millimetres, back in part units
  const code = tol.code.trim();
  const main = `${pre}${v} ${code}${suf}`;
  const fit = parseFit(code);
  if (!fit) return wrap({ main, error: `“${code}” is not an ISO 286 class here: the hole H or the shafts c, d, e, f, g, h, js, k, m, n, p, r, s, grades 5 to 11` });
  const mm = MM[unit] ?? 1;
  let dev;
  try {
    dev = fit.hole && fit.shaft ? null : fitDeviations(code, value * mm);
  } catch (e) {
    return wrap({ main, error: (e as Error).message });
  }
  if (!dev || !tol.show || tol.show === 'code') return wrap({ main });
  const up = dev.upper / 1000 / mm, lo = dev.lower / 1000 / mm;
  if (tol.show === 'dev' && even(up, lo)) return wrap({ main: `${main} (${pm(up)})` });
  return wrap({ main: `${main} (`, stack: stacked(up, lo, tol.show === 'limits'), tail: ')' });
}

// ------------------------------------------------------------ hole callouts

/** What a hole feature is, in part units (a countersink angle in radians). */
export interface HoleData {
  style: HoleFeature['style'];
  d: number;
  /** Missing: through. */
  depth?: number;
  cbD?: number;
  cbDepth?: number;
  csD?: number;
  csAngle?: number;
  /** A tapped hole: its thread ("M8", "M8×1") and threaded depth (missing: as deep as the hole). */
  tap?: { name: string; depth?: number };
}

/** A hole feature with its evaluated parameters as a callout needs it. */
export function holeData(item: HoleFeature, p: Record<string, number> | undefined): HoleData | null {
  if (!p || !(p.d > 0)) return null;
  const h: HoleData = { style: item.style, d: p.d };
  if (!item.through && p.depth > 0) h.depth = p.depth;
  if (item.style === 'counterbore' && p.cbD > 0) Object.assign(h, { cbD: p.cbD, cbDepth: p.cbDepth });
  if (item.style === 'countersink' && p.csD > 0) Object.assign(h, { csD: p.csD, csAngle: p.csAngle });
  if (item.tap) {
    let name = item.tap.size.trim();
    try {
      name = parseThread(item.tap.size).name;
    } catch {
      /* written as given */
    }
    h.tap = { name: name.replace(/x/i, '×'), ...(p.tdepth > 0 ? { depth: p.tdepth } : {}) };
  }
  return h;
}

/**
 * A hole callout (ISO 15786 symbols: ↧ depth, ⌴ counterbore, ⌵ countersink): "4× M8 – 6H
 * ↧ 12", "6× Ø9 ⌴ Ø15 ↧ 4", "Ø8.5 ⌵ Ø16 × 90°". A tapped blind hole drilled deeper than
 * its thread gets the drill on a second line.
 */
export function holeCallout(h: HoleData, count: number, fmt: (v: number) => string, cls = '6H'): string {
  const n = count > 1 ? `${count}× ` : '';
  const deep = (z?: number) => (z !== undefined ? ` ↧ ${fmt(z)}` : '');
  const lines: string[] = [];
  if (h.tap) {
    lines.push(`${n}${h.tap.name}${cls.trim() ? ` – ${cls.trim()}` : ''}${deep(h.tap.depth ?? h.depth)}`);
    if (h.tap.depth !== undefined && h.depth !== undefined && h.depth > h.tap.depth * (1 + 1e-9)) lines.push(`Ø${fmt(h.d)}${deep(h.depth)}`);
  } else lines.push(`${n}Ø${fmt(h.d)}${deep(h.depth)}`);
  if (h.cbD !== undefined) lines[0] += ` ⌴ Ø${fmt(h.cbD)}${deep(h.cbDepth)}`;
  if (h.csD !== undefined) lines[0] += ` ⌵ Ø${fmt(h.csD)} × ${+(((h.csAngle ?? Math.PI / 2) * 180) / Math.PI).toFixed(1)}°`;
  return lines.join('\n');
}

/** The thread feature on a face (named by any of `faceKeys`), if one threads it. */
export function threadOn(comp: CadComponent | undefined, faceKeys: string[]): ThreadFeature | undefined {
  const names = new Set(faceKeys.filter(Boolean).map(baseName));
  return comp?.items.find((i): i is ThreadFeature => i.kind === 'thread' && i.faces.some((f) => names.has(baseName(f.key))));
}

/**
 * The callout of a thread made by the thread feature (ISO 965-1, ISO 6410-1): "M12 – 6g"
 * on a shaft, "2× M8 – 6H ↧ 12" in holes (its length as the depth), "LH" for a left-hand one.
 */
export function threadCallout(item: ThreadFeature, internal: boolean, p: Record<string, number> | undefined, fmt: (v: number) => string, cls?: string): string {
  let name = item.size.trim();
  try {
    name = parseThread(item.size).name;
  } catch {
    /* written as given */
  }
  const n = item.faces.length > 1 ? `${item.faces.length}× ` : '';
  const c = (cls ?? (internal ? '6H' : '6g')).trim();
  const deep = internal && p?.length && p.length > 0 ? ` ↧ ${fmt(p.length)}` : '';
  return `${n}${name.replace(/x/i, '×')}${c ? ` – ${c}` : ''}${deep}${item.hand === 'left' ? ' LH' : ''}`;
}

/** A hole named in a face key: `${copies}${feature}/hole${n}:${role}` (a pattern's copy carries `${pattern}.${k}.`). */
export function holeOfKey(key: string): { feature: string; hole: string } | null {
  for (const part of key.replace(/[#~]\d+/g, '').split(/[|+&]/)) {
    const m = /^(.*?)([^./]+)\/hole(\d+):\w+$/.exec(part);
    if (m) return { feature: m[2], hole: `${m[1]}${m[2]}/hole${m[3]}` };
  }
  return null;
}

/** How many holes of a feature a component's faces show (each pattern or mirror copy counts). */
export function holeCount(feature: string, faceKeys: string[]): number {
  const holes = new Set<string>();
  for (const k of faceKeys) {
    const h = holeOfKey(k);
    if (h?.feature === feature) holes.add(h.hole);
  }
  return holes.size;
}

// ------------------------------------------------------------ parts list

export interface BomRow {
  item: number;
  component: string;
  name: string;
  qty: number;
  material: string;
  /** kg, each. */
  mass?: number;
}

/** A material's name from a density written as the material list writes it ("7850 kg/m^3": Steel). */
export const materialOf = (density: string | undefined) => MATERIALS.find((m) => m.density === density?.trim())?.name ?? '';

/** A component's material for a parts list or title block: its library material, else the one its density names. */
export const componentMaterial = (design: CadDesign, c: CadComponent, partDensity?: string) =>
  materialOfBody(design, c)?.id ?? materialOf(c.density?.trim() ? c.density : partDensity);

/**
 * The parts list of an assembly (ISO 7573): one item per component that has visible
 * occurrences, numbered in the order they first occur, with how many times it occurs, its
 * material (the drawing's, else the one its density names) and its mass each.
 */
export function bomRows(design: CadDesign, o: { masses?: Record<string, number | undefined>; density?: string; rows?: BomSettings['rows'] } = {}): BomRow[] {
  const out: BomRow[] = [];
  for (const occ of design.occurrences) {
    if (occ.hidden) continue;
    const c = design.components.find((q) => q.id === occ.component);
    if (!c) continue;
    const row = out.find((r) => r.component === c.id);
    if (row) {
      row.qty++;
      continue;
    }
    const own = o.rows?.[c.id];
    out.push({
      item: out.length + 1, component: c.id, name: own?.name?.trim() || c.name, qty: 1,
      material: own?.material?.trim() || componentMaterial(design, c, o.density),
      ...(o.masses?.[c.id] !== undefined ? { mass: o.masses[c.id] } : {}),
    });
  }
  return out;
}

/**
 * The mass of what the parts list holds (kg): each item's mass times its quantity, so a
 * hidden occurrence (drawn nowhere, listed nowhere) counts nowhere. Undefined unless every
 * item has a mass.
 */
export function bomMass(rows: BomRow[]): number | undefined {
  return rows.length && rows.every((r) => r.mass !== undefined) ? rows.reduce((s, r) => s + r.qty * r.mass!, 0) : undefined;
}

/** A mass as a parts list writes it (kg, three figures). */
export function fmtMass(kg: number | undefined): string {
  if (kg === undefined || !Number.isFinite(kg)) return '';
  if (kg >= 1000) return String(Math.round(kg));
  return String(+kg.toPrecision(3));
}

// ------------------------------------------------------------ text on the paper

/**
 * Advance widths of Arial / Helvetica (per 1000 em), whose metrics the sheet's text is
 * laid out by; the cap height is 0.716 em, so ISO 3098 capitals of height h are set at
 * h / 0.72. Text inside frames is drawn to the measured width (SVG textLength, DXF fit).
 */
const WIDTHS: Record<string, number> = {
  ' ': 278, '!': 278, '"': 355, '#': 556, $: 556, '%': 889, '&': 667, "'": 191, '(': 333, ')': 333, '*': 389, '+': 584, ',': 278, '-': 333, '.': 278, '/': 278,
  ':': 278, ';': 278, '<': 584, '=': 584, '>': 584, '?': 556, '@': 1015, '[': 278, '\\': 278, ']': 278, '^': 469, _: 556, '`': 333, '{': 334, '|': 260, '}': 334, '~': 584,
  A: 667, B: 667, C: 722, D: 722, E: 667, F: 611, G: 778, H: 722, I: 278, J: 500, K: 667, L: 556, M: 833, N: 722, O: 778, P: 667, Q: 778, R: 722, S: 667, T: 611,
  U: 722, V: 667, W: 944, X: 667, Y: 667, Z: 611,
  a: 556, b: 556, c: 500, d: 556, e: 556, f: 278, g: 556, h: 556, i: 222, j: 222, k: 500, l: 222, m: 833, n: 556, o: 556, p: 556, q: 556, r: 333, s: 500, t: 278,
  u: 556, v: 500, w: 722, x: 500, y: 500, z: 500,
  'Ø': 778, '±': 584, '×': 584, '°': 400, '–': 556, '—': 1000, '−': 584, 'µ': 556, '²': 333, '³': 333, 'ø': 611,
};

const CAP = 0.72;

/** Width (mm) of text whose capitals are h high. */
export function textWidth(text: string, h: number): number {
  let w = 0;
  for (const ch of text) w += WIDTHS[ch] ?? (/\d/.test(ch) ? 556 : 600);
  return (w / 1000) * (h / CAP);
}

/**
 * The compartments of a feature control frame (ISO 1101 8.1): height 2h, the symbol in a
 * square, the tolerance (Ø, value, modifier) and each datum as wide as their text needs
 * with h/2 either side, a datum compartment at least square. Widths from the left (mm).
 */
export function gdtLayout(g: Pick<GdtAnnotation, 'tol' | 'dia' | 'mod' | 'datums'>, h: number, fmt: (v: number) => string): { H: number; widths: number[]; tolText: string; datumTexts: string[]; modW: number } {
  const H = 2 * h, pad = h / 2;
  const tolText = `${g.dia ? 'Ø' : ''}${fmt(g.tol)}`;
  // a modifier is a circled letter a cap height and a half across, after a gap
  const modW = g.mod ? 1.5 * h + 0.3 * h : 0;
  const widths = [H, pad + textWidth(tolText, h) + modW + pad];
  const datumTexts = (g.datums ?? []).filter((d) => d.letter.trim()).slice(0, 3).map((d) => d.letter.trim());
  (g.datums ?? []).filter((d) => d.letter.trim()).slice(0, 3).forEach((d, i) => {
    widths.push(Math.max(H, pad + textWidth(datumTexts[i], h) + (d.mod ? 1.8 * h : 0) + pad));
  });
  return { H, widths, tolText, datumTexts, modW };
}
