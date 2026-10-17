// Worksheet document model. Everything here is plain JSON so it can be saved,
// undone, copied and pasted without custom serialisation.
import type { Shape, SketchAnimation, SketchUnit, SketchView } from './sketch';
import type { CadFeature, CadSketch, CadUnit, CadView, CadView3D } from '../cad/model';
import type { CadDesign } from '../cad/design';
import type { Annotation, BomSettings, Revision, TitleFields } from '../cad/annotations';
import { DEFAULT_SECTION, type BeamAnalysis, type BeamCases, type BeamData, type BeamDiagram, type BeamLayout, type BeamPanel, type BeamForceUnit, type BeamLengthUnit, type BeamSection, type BeamView } from '../beam/model';
import { DEFAULT_CAMERA, newFrame, type Frame3DAnalysis, type Frame3DCamera, type Frame3DData, type Frame3DShow, type Frame3DTab } from '../frame3d/model';
import { newPlate, type PlateData, type PlateRebar, type PlateShow, type PlateTab, type PlateView } from '../plate/model';
import { newSpreadsheet, type SpreadsheetData } from '../sheet/model';

export type RegionKind = 'math' | 'text' | 'plot' | 'solve' | 'table' | 'image' | 'sketch' | 'cad' | 'beam' | 'python' | 'drawing' | 'frame3d' | 'plate' | 'area' | 'spreadsheet';

interface RegionBase {
  id: string;
  kind: RegionKind;
  /** Position on the page in CSS pixels (96 dpi, so 1 mm = 3.7795 px). */
  x: number;
  y: number;
  /** Disabled regions are shown but never evaluated (Mathcad "Disable evaluation"). */
  disabled?: boolean;
  /** Look of this region (on top of the worksheet's format). */
  style?: RegionStyle;
  /** Locked regions cannot be edited, moved or deleted (Mathcad "Lock"). */
  locked?: boolean;
  /** Stays editable while the worksheet is protected (an input of a protected calculation). */
  input?: boolean;
}

/** Text and line formatting; scales multiply the worksheet's. */
export interface RegionStyle {
  /** Font size factor (1 = normal). */
  fontScale?: number;
  bold?: boolean;
  italic?: boolean;
  /** Text colour (CSS colour). */
  color?: string;
  /** Highlight behind the region. */
  background?: string;
  /** Line thickness factor for drawings, plots and beams (1 = normal). */
  lineScale?: number;
}

/** Look of the whole worksheet. */
export interface WorksheetFormat {
  fontScale?: number;
  lineScale?: number;
  /** Font of text regions. */
  textFont?: 'sans' | 'serif';
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
  /** Column names (optional). */
  headers?: string[];
  /** Also define each named column as a vector variable (x, F …). */
  columnVars?: boolean;
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

/** Parametric CAD part: constrained sketch + extrude/revolve, linked to the worksheet. */
export interface CadRegion extends RegionBase {
  kind: 'cad';
  /** Variable that receives the part's properties and named dimensions (optional). */
  name: string;
  width: number;
  height: number;
  unit: CadUnit;
  view: CadView;
  /** Viewport of the CAD window (separate from the page preview's framing). */
  viewW?: CadView;
  view3d: CadView3D;
  /** 3-D camera of the CAD window. */
  view3dW?: CadView3D & { zoom?: number; pan?: { x: number; y: number } };
  /** Sketch, 3-D model, or both side by side. */
  mode: '2d' | '3d' | 'split';
  sketch: CadSketch;
  feature: CadFeature;
  /** Material density expression ("7850 kg/m^3"); empty = no mass. */
  density: string;
  /**
   * Components, timelines and joints. Parts saved before designs existed have only
   * `sketch` and `feature`, which `designOf` turns into a one-sketch design.
   */
  design?: CadDesign;
}

/** Beam or plane frame: members, supports and loads, solved with diagrams. */
export interface BeamRegion extends RegionBase, BeamData {
  kind: 'beam';
  /** Variable that receives reactions, extremes and (for straight beams) M(x), V(x) … */
  name: string;
  width: number;
  height: number;
  lengthUnit: BeamLengthUnit;
  forceUnit: BeamForceUnit;
  view: BeamView;
  /** Grid spacing in the length unit. */
  grid: number;
  snap: boolean;
  /** Section and material of members without their own. */
  section: BeamSection;
  /** Diagram drawn on the structure in the overlay layout. */
  show: BeamDiagram;
  /** Diagrams under the structure (default) or on it. */
  layout?: BeamLayout;
  /** Diagrams stacked under the structure; missing = V, M, δ (and N when there is axial force). */
  panels?: BeamPanel[];
  /** Show the support reactions on the structure in the stacked layout. */
  reactions?: boolean;
  /** Load cases and combinations (absent: all loads act together). */
  loadCases?: BeamCases;
  /** Shear deformation, second order, buckling (absent: first order, Euler–Bernoulli). */
  analysis?: BeamAnalysis;
  /** Influence lines and moving loads (absent: none). */
  traffic?: import('../beam/model').BeamTraffic;
}

/** Python code that reads the worksheet variables above it and exports what it assigns. */
export interface PythonRegion extends RegionBase {
  kind: 'python';
  code: string;
  width: number;
  /** Hide the code and show only the output (print and exported values). */
  collapsed?: boolean;
}

/** A 2-D drawing of a CAD part: standard views, hidden lines, dimensions, title block. */
export interface DrawingRegion extends RegionBase {
  kind: 'drawing';
  /** Id of the CAD region drawn. */
  cad: string;
  width: number;
  height: number;
  sheet: 'A4' | 'A3' | 'A2' | 'A1' | 'A0';
  /** Portrait; missing = landscape. */
  portrait?: boolean;
  /** First angle (ISO, Europe) or third angle (ANSI). */
  projection: 'first' | 'third';
  views: { front: boolean; top: boolean; side: boolean; iso: boolean };
  hidden: boolean;
  /** Paper / model, e.g. 0.5 for 1:2; missing = the largest standard scale that fits. */
  scale?: number;
  dims: boolean;
  /** Tangent edges (where faces meet smoothly) as narrow lines; missing = shown. */
  tangent?: boolean;
  /** Views drawn without centre marks and centre lines (view keys, section and detail ids). */
  noCentres?: string[];
  sections?: DrawingSection[];
  details?: DrawingDetail[];
  title?: string;
  partNo?: string;
  material?: string;
  drawnBy?: string;
  date?: string;
  /** Dimensions, tolerances, notes, GD&T and symbols placed on the views (cad/annotations.ts). */
  annotations?: Annotation[];
  /** Decimals of dimension values; missing = as many as the value needs, up to 2 in mm. */
  decimals?: number;
  /** The rest of the ISO 7200 title block. */
  titleBlock?: TitleFields;
  revisions?: Revision[];
  /** The parts list of an assembly. */
  bom?: BomSettings;
  /** The assembly drawn exploded: each occurrence out by its explode offset (cad/explode.ts). */
  exploded?: boolean;
}

/** A section view: the part cut along a straight line drawn on one of the standard views. */
export interface DrawingSection {
  id: string;
  /** A for A–A. */
  letter: string;
  /** The view the cutting line is drawn on. */
  view: 'front' | 'top' | 'side';
  /** Ends of the cutting line in that view (model units, x right and y up on the paper). */
  a: { x: number; y: number };
  b: { x: number; y: number };
  /** Look the other way (the default is the way that shows the part upright, else to the right of a → b). */
  flip?: boolean;
  /** Centre of the view on the sheet (mm from its lower left corner); missing = placed automatically. */
  at?: { x: number; y: number };
}

/** A detail view: what lies inside a circle on a view, enlarged. */
export interface DrawingDetail {
  id: string;
  letter: string;
  /** The view it enlarges: a standard view's key or a section view's (`sec:${id}`). */
  view: string;
  /** Centre and radius of the circle in that view (model units). */
  c: { x: number; y: number };
  r: number;
  /** Paper / model, e.g. 2 for 2:1. */
  scale: number;
  at?: { x: number; y: number };
}

/** 3-D frame: nodes, members, sections, supports and loads as tables, solved in space. */
export interface Frame3DRegion extends RegionBase, Frame3DData {
  kind: 'frame3d';
  /** Variable that receives reactions, displacements, member extremes and forces along members. */
  name: string;
  width: number;
  height: number;
  lengthUnit: BeamLengthUnit;
  forceUnit: BeamForceUnit;
  camera: Frame3DCamera;
  /** What the 3-D view draws: the model, the deformed shape, a force diagram, the buckling mode. */
  show: Frame3DShow;
  /** Size of the deformed shape and diagrams relative to the automatic one (1). */
  scale?: number;
  /** Node and member names in the view. */
  labels?: boolean;
  /** The members' local axes in the view. */
  axes?: boolean;
  /** Support reactions in the view. */
  reactions?: boolean;
  /** Table shown while editing. */
  tab?: Frame3DTab;
  /** Load cases and combinations (absent: all loads act together). */
  loadCases?: BeamCases;
  analysis?: Frame3DAnalysis;
}

/** Plate or slab: an outline with openings, supports and loads, solved by finite elements. */
export interface PlateRegion extends RegionBase, PlateData {
  kind: 'plate';
  /** Variable that receives deflections, moments, reactions, reinforcement and the fields as functions of (x, y). */
  name: string;
  width: number;
  height: number;
  lengthUnit: BeamLengthUnit;
  forceUnit: BeamForceUnit;
  /** Thickness (bare number mm). */
  thickness: string;
  /** Concrete class (C30/37 …), steel grade (S355 …), or 'custom' with E, ν and ρ. */
  material: string;
  E?: string;
  nu?: string;
  rho?: string;
  /** Element size (bare number in the length unit); empty: automatic. */
  mesh?: string;
  /** Reinforcement of a concrete slab to design (absent: moments only). */
  rebar?: PlateRebar;
  /** What the plan shows. */
  show: PlateShow;
  /** The element mesh over the plan. */
  showMesh?: boolean;
  /** The deflected shape in an oblique view instead of the plan. */
  deformed?: boolean;
  /** Support reactions on the plan. */
  reactions?: boolean;
  /** Names of edges, walls and columns while editing (absent: shown). */
  labels?: boolean;
  /** A section cut (length unit), its values plotted under the plan. */
  cut?: { x1: number; y1: number; x2: number; y2: number };
  view?: PlateView;
  tab?: PlateTab;
  /** Load cases and combinations (absent: all loads act together). */
  loadCases?: BeamCases;
}

/**
 * A collapsible area (Mathcad "Area"): a title bar over a band of the page. The regions whose
 * top lies in the band belong to it; collapsed, they are hidden and what is below moves up.
 */
export interface AreaRegion extends RegionBase {
  kind: 'area';
  title: string;
  /** Height of the band from the top of the title bar to the end line, px (as expanded). */
  height: number;
  collapsed?: boolean;
  /** Regions hidden while collapsed (at the places they have when expanded). */
  hidden?: string[];
  /** Printed as on screen (absent), or always collapsed or expanded. */
  print?: 'collapsed' | 'expanded';
}

/** Spreadsheet component (Mathcad's Excel component): cells and formulas, inputs from the worksheet, outputs back to it. */
export interface SpreadsheetRegion extends RegionBase, SpreadsheetData {
  kind: 'spreadsheet';
}

export type Region = MathRegion | TextRegion | PlotRegion | SolveRegion | TableRegion | ImageRegion | SketchRegion | CadRegion | BeamRegion | PythonRegion | DrawingRegion | Frame3DRegion | PlateRegion | AreaRegion | SpreadsheetRegion;

/** Page header and footer for printed calculation sheets. */
export interface ReportSettings {
  enabled: boolean;
  company?: string;
  project?: string;
  /** Subject of the calculation; the worksheet title when empty. */
  subject?: string;
  docNo?: string;
  revision?: string;
  author?: string;
  checker?: string;
  /** Empty = the date it is printed. */
  date?: string;
  /** Image as a data URL. */
  logo?: string;
}

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
  /**
   * Functions read worksheet variables when they are called (SMath) instead of
   * capturing them when they are defined (Mathcad, the default).
   */
  lateBinding?: boolean;
  /** Font size, line thickness and text font of the whole worksheet. */
  format?: WorksheetFormat;
  /** Header and footer on every page. */
  report?: ReportSettings;
  /** Protected worksheet: only regions marked as inputs can be edited (absent: not protected). */
  protect?: WorksheetProtection;
}

/** Protection of a worksheet, with an optional password kept as a salted SHA-256 hash. */
export interface WorksheetProtection {
  /** Hex SHA-256 of salt + password; absent when no password is needed to unprotect. */
  hash?: string;
  /** Random hex salt. */
  salt?: string;
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
    case 'cad':
      return {
        ...base, kind, name: '', width: 480, height: 320, unit: 'mm', view: { cx: 100, cy: 60, zoom: 2 },
        view3d: { yaw: -35, pitch: 25 }, mode: '3d', sketch: { points: [], entities: [], constraints: [] },
        feature: { type: 'none' }, density: '7850 kg/m^3', ...(init as Partial<CadRegion>),
      };
    case 'beam':
      return {
        ...base, kind, name: '', width: 560, height: 300, lengthUnit: 'm', forceUnit: 'kN', view: { cx: 3, cy: 0.5, zoom: 70 },
        grid: 0.5, snap: true, section: { ...DEFAULT_SECTION }, show: 'model', nodes: [], members: [], supports: [], loads: [],
        ...(init as Partial<BeamRegion>),
      };
    case 'python':
      return { ...base, kind, code: '', width: 480, ...(init as Partial<PythonRegion>) };
    case 'drawing':
      return {
        ...base, kind, cad: '', width: 680, height: 481, sheet: 'A4', projection: 'first',
        views: { front: true, top: true, side: true, iso: true }, hidden: true, dims: true, ...(init as Partial<DrawingRegion>),
      };
    case 'frame3d':
      return {
        ...base, kind, name: '', width: 600, height: 420, lengthUnit: 'm', forceUnit: 'kN', camera: { ...DEFAULT_CAMERA }, show: 'model',
        ...newFrame(), ...(init as Partial<Frame3DRegion>),
      };
    case 'plate':
      return {
        ...base, kind, name: '', width: 640, height: 460, lengthUnit: 'm', forceUnit: 'kN', thickness: '200', material: 'C30/37', show: 'model',
        ...newPlate(), ...(init as Partial<PlateRegion>),
      };
    case 'area':
      return { ...base, kind, title: 'Area', height: 96, ...(init as Partial<AreaRegion>) };
    case 'spreadsheet':
      return { ...base, kind, ...newSpreadsheet(), ...(init as Partial<SpreadsheetRegion>) };
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
