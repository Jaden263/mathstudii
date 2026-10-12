import { createContext, useContext } from 'react';
import type { SymbolKind } from '../../model/sketch';
import type { SectionTemplate } from '../../engine/geometry';
import type { Worksheet } from '../../model/types';

export type Tool =
  | 'select' | 'pan' | 'line' | 'poly' | 'rect' | 'circle' | 'arc' | 'arrow' | 'dim'
  | 'text' | 'path' | 'link' | 'symbol' | 'section';

export interface SketchUI {
  /** Sketch region the shape selection belongs to. */
  regionId: string | null;
  selected: string[];
  tool: Tool;
  symbol: SymbolKind;
  template: SectionTemplate;
}

export const INITIAL_SKETCH_UI: SketchUI = { regionId: null, selected: [], tool: 'select', symbol: 'joint', template: 'I' };

export interface SketchContextValue {
  ui: SketchUI;
  setUi: (patch: Partial<SketchUI>) => void;
  /** Latest worksheet (for animation frames). */
  getWorksheet: () => Worksheet;
  /** Open the properties panel (e.g. after placing text). */
  showProperties: () => void;
}

export const SketchContext = createContext<SketchContextValue>({
  ui: INITIAL_SKETCH_UI,
  setUi: () => {},
  getWorksheet: () => ({ format: 'mathstudii', version: 1, title: '', settings: {} as Worksheet['settings'], regions: [] }),
  showProperties: () => {},
});

export const useSketchUI = () => useContext(SketchContext);
