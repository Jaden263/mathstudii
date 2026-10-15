import { createContext, useContext } from 'react';
import type { SymbolKind } from '../../model/sketch';
import type { SectionTemplate } from '../../engine/geometry';
import type { Worksheet } from '../../model/types';

export type Tool =
  | 'select' | 'pan' | 'line' | 'poly' | 'rect' | 'circle' | 'arc' | 'arrow' | 'dim'
  | 'text' | 'path' | 'link' | 'symbol' | 'section';

export type CadTool =
  | 'select' | 'line' | 'rect' | 'crect' | 'circle' | 'arc' | 'arc3' | 'polygon' | 'slot' | 'point'
  | 'dim' | 'fillet' | 'trim' | 'mirror' | 'measure' | 'pan';

export type BeamTool = 'select' | 'member' | 'pin' | 'roller' | 'fixed' | 'hinge' | 'force' | 'line' | 'moment';

export interface SketchUI {
  /** Sketch region the shape selection belongs to. */
  regionId: string | null;
  selected: string[];
  tool: Tool;
  symbol: SymbolKind;
  template: SectionTemplate;
  /** Tool of the CAD editor (CAD regions share the selection fields above). */
  cadTool: CadTool;
  /** Draw new CAD geometry as construction lines. */
  cadConstruction: boolean;
  /** Tool options of the CAD window. */
  cadSides: number;
  cadFillet: number;
  cadGridSnap: boolean;
  cadDimKind: 'smart' | 'horizontal' | 'vertical';
  /** Show relation glyphs in the CAD window. */
  cadRelations: boolean;
  /** Tool of the beam editor. */
  beamTool: BeamTool;
}

export const INITIAL_SKETCH_UI: SketchUI = { regionId: null, selected: [], tool: 'select', symbol: 'joint', template: 'I', cadTool: 'select', cadConstruction: false, cadSides: 6, cadFillet: 5, cadGridSnap: false, cadDimKind: 'smart', cadRelations: true, beamTool: 'member' };

export interface SketchContextValue {
  ui: SketchUI;
  setUi: (patch: Partial<SketchUI>) => void;
  /** Latest worksheet (for animation frames). */
  getWorksheet: () => Worksheet;
  /** Open the properties panel (e.g. after placing text). */
  showProperties: () => void;
  /** Push overlapping regions apart (after a sketch grows). */
  separate: (coalesce?: string) => void;
}

export const SketchContext = createContext<SketchContextValue>({
  ui: INITIAL_SKETCH_UI,
  setUi: () => {},
  getWorksheet: () => ({ format: 'mathstudii', version: 1, title: '', settings: {} as Worksheet['settings'], regions: [] }),
  showProperties: () => {},
  separate: () => {},
});

export const useSketchUI = () => useContext(SketchContext);
