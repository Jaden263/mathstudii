// Sketch (drawing) regions: vector shapes in real-world coordinates (y up),
// in the sketch's length unit. Any numeric field can be bound to a worksheet
// expression, which makes drawings parametric (sections, mechanisms).
import type { Pt, SectionTemplate } from '../engine/geometry';
import { TEMPLATES } from '../engine/geometry';

export type { Pt };

export type Dash = 'solid' | 'dash' | 'dot' | 'center';

export interface ShapeStyle {
  stroke?: string;
  /** Line width in screen px. */
  width?: number;
  dash?: Dash;
  /** Fill colour for closed shapes; null = none. */
  fill?: string | null;
  /** Draw a 45° hatch inside solid areas (cross-section convention). */
  hatch?: boolean;
}

/** Closed shapes: does it count as material, a hole, or neither for section properties? */
export type AreaRole = 'solid' | 'hole' | 'none';

export type SymbolKind =
  | 'fixed' | 'pin' | 'roller' | 'joint' | 'slider' | 'ground'
  | 'force' | 'moment' | 'spring' | 'damper' | 'load';

export const SYMBOLS: { kind: SymbolKind; label: string }[] = [
  { kind: 'joint', label: 'Pin joint' },
  { kind: 'pin', label: 'Pinned support' },
  { kind: 'roller', label: 'Roller support' },
  { kind: 'fixed', label: 'Fixed support' },
  { kind: 'slider', label: 'Slider' },
  { kind: 'ground', label: 'Ground' },
  { kind: 'force', label: 'Force' },
  { kind: 'load', label: 'Distributed load' },
  { kind: 'moment', label: 'Moment' },
  { kind: 'spring', label: 'Spring' },
  { kind: 'damper', label: 'Damper' },
];

interface ShapeBase {
  id: string;
  style?: ShapeStyle;
  role?: AreaRole;
  /** Field path ("a.x", "r", "params.h", "pts.2.y", "rot") → worksheet expression. */
  bind?: Record<string, string>;
}

export type Shape =
  | (ShapeBase & { type: 'line'; a: Pt; b: Pt })
  | (ShapeBase & { type: 'arrow'; a: Pt; b: Pt; double?: boolean })
  | (ShapeBase & { type: 'dim'; a: Pt; b: Pt; offset: number; text?: string })
  | (ShapeBase & { type: 'link'; a: Pt; b: Pt })
  | (ShapeBase & { type: 'poly'; pts: Pt[]; closed: boolean })
  | (ShapeBase & { type: 'path'; pts: Pt[] })
  | (ShapeBase & { type: 'rect'; a: Pt; b: Pt })
  | (ShapeBase & { type: 'circle'; c: Pt; r: number })
  | (ShapeBase & { type: 'arc'; c: Pt; r: number; a0: number; a1: number })
  | (ShapeBase & { type: 'text'; p: Pt; text: string; size: number })
  | (ShapeBase & { type: 'symbol'; p: Pt; symbol: SymbolKind; rot: number; size: number })
  | (ShapeBase & { type: 'section'; p: Pt; template: SectionTemplate; params: Record<string, string>; rot: number });

export type ShapeType = Shape['type'];

export interface SketchView {
  /** World point at the centre of the region. */
  cx: number;
  cy: number;
  /** Screen pixels per sketch unit. */
  zoom: number;
}

export interface SketchAnimation {
  /** Worksheet variable swept while playing (must be defined above the sketch). */
  variable: string;
  from: string;
  to: string;
  /** Duration of one sweep in seconds. */
  seconds: number;
}

export const SKETCH_UNITS = ['mm', 'cm', 'm', 'in', 'ft'] as const;
export type SketchUnit = (typeof SKETCH_UNITS)[number];

export function newShapeId(): string {
  return 's' + Math.random().toString(36).slice(2, 9);
}

export function defaultSectionParams(t: SectionTemplate): Record<string, string> {
  return Object.fromEntries(TEMPLATES[t].params.map((p) => [p.key, String(p.default)]));
}

/** Closed shapes that can carry area. */
export function isClosed(s: Shape): boolean {
  return s.type === 'rect' || s.type === 'circle' || s.type === 'section' || (s.type === 'poly' && s.closed);
}

/** Default role: sections and closed polygons are material unless set otherwise. */
export function areaRole(s: Shape): AreaRole {
  if (!isClosed(s)) return 'none';
  return s.role ?? (s.type === 'section' ? 'solid' : 'none');
}

/** Read a numeric field by path ("a.x", "pts.3.y", "params.h"). */
export function getField(s: Shape, path: string): unknown {
  let v: unknown = s;
  for (const k of path.split('.')) {
    if (v === null || typeof v !== 'object') return undefined;
    v = (v as Record<string, unknown>)[k];
  }
  return v;
}

/** Immutable set of a field by path. */
export function setField<T extends Shape>(s: T, path: string, value: unknown): T {
  const keys = path.split('.');
  const rec = (obj: unknown, i: number): unknown => {
    const k = keys[i];
    const base: Record<string, unknown> | unknown[] = Array.isArray(obj) ? [...obj] : { ...(obj as Record<string, unknown>) };
    (base as Record<string, unknown>)[k] = i === keys.length - 1 ? value : rec((obj as Record<string, unknown>)?.[k], i + 1);
    return base;
  };
  return rec(s, 0) as T;
}

/** Apply engine-resolved bound values (and section parameters) over the stored shape. */
export function applyResolved<T extends Shape>(s: T, resolved: Record<string, number> | undefined): T {
  if (!resolved) return s;
  let out = s;
  for (const [k, v] of Object.entries(resolved)) out = setField(out, k, v);
  return out;
}

/** All point fields of a shape with their paths (for handles and snapping). */
export function shapePoints(s: Shape): { path: string; p: Pt }[] {
  switch (s.type) {
    case 'line': case 'arrow': case 'dim': case 'link': case 'rect':
      return [{ path: 'a', p: s.a }, { path: 'b', p: s.b }];
    case 'poly': case 'path':
      return s.pts.map((p, i) => ({ path: `pts.${i}`, p }));
    case 'circle': case 'arc':
      return [{ path: 'c', p: s.c }];
    case 'text': case 'symbol': case 'section':
      return [{ path: 'p', p: s.p }];
  }
}

/** Move every point of a shape. */
export function translateShape<T extends Shape>(s: T, dx: number, dy: number): T {
  let out = s;
  for (const { path, p } of shapePoints(s)) out = setField(out, path, { x: p.x + dx, y: p.y + dy });
  return out;
}

/** Is this field (or a parent point) bound to an expression? */
export function isBound(s: Shape, path: string): boolean {
  if (!s.bind) return false;
  return Object.keys(s.bind).some((k) => k === path || k.startsWith(path + '.'));
}
