// Worksheet document model. Everything here is plain JSON so it can be saved,
// undone, copied and pasted without custom serialisation.
import type { Shape, SketchAnimation, SketchUnit, SketchView } from './sketch';

export type RegionKind = 'math' | 'text' | 'plot' | 'solve' | 'table' | 'image' | 'sketch';

interface RegionBase {
  id: string;
  kind: RegionKind;
  /** Position on the page in CSS pixels (96 dpi, so 1 mm = 3.7795 px). */
  x: number;
  y: number;
  /** Disabled regions are shown but never evaluated (Mathcad "Disable evaluation"). */
  disabled?: boolean;
}

export interface MathRegion extends RegionBase {
  kind: 'math';
  source: string;
}

export interface TextRegion extends RegionBase {
  kind: 'text';
  markdown: string;
  width: number;
}

export type PlotType = 'xy' | 'polar' | 'surface' | 'contour';
export type TraceStyle = 'line' | 'points' | 'both' | 'bar' | 'step';

export interface PlotTrace {
  /** Optional per-trace x expression; falls back to the plot's x expression. */
  xExpr?: string;
  y: string;
  style: TraceStyle;
  color?: string;
}

export interface PlotRegion extends RegionBase {
  kind: 'plot';
  plotType: PlotType;
  /** x-axis expression (xy), angle expression (polar). */
  xExpr: string;
  traces: PlotTrace[];
  /** Surface/contour: z = f(x, y) expression or a matrix name. */
  z: string;
  xmin: string;
  xmax: string;
  ymin: string;
  ymax: string;
  xUnit: string;
  yUnit: string;
  logX: boolean;
  logY: boolean;
  title: string;
  width: number;
  height: number;
}

export interface SolveRegion extends RegionBase {
  kind: 'solve';
  guesses: string;
  constraints: string;
  solver: string;
}

export interface TableRegion extends RegionBase {
  kind: 'table';
  name: string;
  /** One unit expression per column ("" = dimensionless). */
  units: string[];
  cells: string[][];
}

export interface ImageRegion extends RegionBase {
  kind: 'image';
  src: string;
  width: number;
}

export interface SketchRegion extends RegionBase {
  kind: 'sketch';
  /** Region size on the page, px. */
  width: number;
  height: number;
  /** Variable that receives the section properties of the closed shapes (optional). */
  name: string;
  unit: SketchUnit;
  view: SketchView;
  /** Grid spacing in sketch units (0 = no grid). */
  grid: number;
  snap: boolean;
  /** Show centroid and principal axes when the sketch has area. */
  showProps: boolean;
  shapes: Shape[];
  animation?: SketchAnimation;
}

export type Region = MathRegion | TextRegion | PlotRegion | SolveRegion | TableRegion | ImageRegion | SketchRegion;

export interface WorksheetSettings {
  /** Displayed decimal places. */
  precision: number;
  /** Numbers with |exponent| >= threshold are displayed in scientific notation. */
  expThreshold: number;
  /** First array index (Mathcad ORIGIN). */
  origin: 0 | 1;
  autoCalc: boolean;
  /** Solver convergence tolerance (Mathcad TOL/CTOL). */
  tol: number;
  /** Unit system used when simplifying derived units in results. */
  unitSystem: 'si' | 'us' | 'cgs';
}

export interface Worksheet {
  format: 'mathstudii';
  version: 1;
  title: string;
  settings: WorksheetSettings;
  regions: Region[];
}

export const DEFAULT_SETTINGS: WorksheetSettings = {
  precision: 4,
  expThreshold: 6,
  origin: 0,
  autoCalc: true,
  tol: 1e-9,
  unitSystem: 'si',
};

export const PX_PER_MM = 96 / 25.4;
export const PAGE_WIDTH = Math.round(210 * PX_PER_MM); // A4
export const PAGE_HEIGHT = Math.round(297 * PX_PER_MM);
export const PAGE_MARGIN = Math.round(15 * PX_PER_MM);
export const GRID = 8;

let counter = 0;
export function newId(): string {
  counter = (counter + 1) % 1e6;
  return Date.now().toString(36) + counter.toString(36) + Math.random().toString(36).slice(2, 6);
}

export function emptyWorksheet(): Worksheet {
  return { format: 'mathstudii', version: 1, title: 'Untitled', settings: { ...DEFAULT_SETTINGS }, regions: [] };
}

export function createRegion(kind: RegionKind, x: number, y: number, init: Partial<Region> = {}): Region {
  const base = { id: newId(), x, y };
  switch (kind) {
    case 'math':
      return { ...base, kind, source: '', ...(init as Partial<MathRegion>) };
    case 'text':
      return { ...base, kind, markdown: '', width: 360, ...(init as Partial<TextRegion>) };
    case 'plot':
      return {
        ...base, kind, plotType: 'xy', xExpr: 'x', traces: [{ y: 'sin(x)', style: 'line' }], z: '',
        xmin: '', xmax: '', ymin: '', ymax: '', xUnit: '', yUnit: '', logX: false, logY: false,
        title: '', width: 420, height: 280, ...(init as Partial<PlotRegion>),
      };
    case 'solve':
      return { ...base, kind, guesses: 'x := 1', constraints: 'x^2 = 2', solver: 'x_s := find(x) =', ...(init as Partial<SolveRegion>) };
    case 'table':
      return { ...base, kind, name: 'T', units: ['', ''], cells: [['0', '0'], ['1', '1'], ['2', '4']], ...(init as Partial<TableRegion>) };
    case 'image':
      return { ...base, kind, src: '', width: 240, ...(init as Partial<ImageRegion>) };
    case 'sketch':
      return {
        ...base, kind, width: 420, height: 300, name: '', unit: 'mm', view: { cx: 0, cy: 0, zoom: 1 },
        grid: 10, snap: true, showProps: true, shapes: [], ...(init as Partial<SketchRegion>),
      };
  }
}

/** Mathcad evaluates top-to-bottom, then left-to-right. */
export function readingOrder(regions: Region[]): Region[] {
  return [...regions].sort((a, b) => (Math.abs(a.y - b.y) < 4 ? a.x - b.x : a.y - b.y));
}

export function parseWorksheet(text: string): Worksheet {
  const data = JSON.parse(text);
  if (!data || data.format !== 'mathstudii' || !Array.isArray(data.regions)) {
    throw new Error('Not a mathstudii worksheet');
  }
  return { ...emptyWorksheet(), ...data, settings: { ...DEFAULT_SETTINGS, ...data.settings } };
}
