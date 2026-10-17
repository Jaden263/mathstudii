// What a drawing on the page shares with its side panel: the annotation selected on the
// sheet, and what the annotations came to as the drawing drew them (values, references
// lost, the parts list, the automatic dimensions). Not part of the document: it is what the
// sheet shows now, published by the drawing and read by the panel.
import { useSyncExternalStore } from 'react';
import type { Annotation, BomRow } from '../../cad/annotations';
import type { PlacedAnnotation } from '../../cad/drawingAnnotate';

export interface DrawingLive {
  unit: string;
  placed: PlacedAnnotation[];
  bom: BomRow[];
  /** The automatic dimensions as drawn (to make them editable). */
  auto: Annotation[];
  /** The placed views: key and name. */
  views: { key: string; name: string }[];
  /** The model's named topology is there (annotations can be placed and followed). */
  topology: boolean;
  /** The drawing shows an assembly. */
  assembly: boolean;
  /** Balloons for the parts of a view that have none yet. */
  balloons?: (view: string) => Annotation[];
}

const selected = new Map<string, string | null>();
const focus = new Map<string, string>();
const live = new Map<string, DrawingLive>();
const listeners = new Set<() => void>();
let version = 0;

function changed() {
  version++;
  for (const f of listeners) f();
}

const subscribe = (f: () => void) => {
  listeners.add(f);
  return () => listeners.delete(f);
};

/** Select an annotation of a drawing (null: none); `edit` asks the panel to put the cursor in its text. */
export function selectAnnotation(region: string, id: string | null, edit = false) {
  if (selected.get(region) === id && !edit) return;
  selected.set(region, id);
  if (edit && id) focus.set(region, id);
  changed();
}

/** The annotation whose text the panel should focus once (and forget). */
export function takeFocus(region: string, id: string): boolean {
  if (focus.get(region) !== id) return false;
  focus.delete(region);
  return true;
}

export function publishDrawing(region: string, l: DrawingLive) {
  live.set(region, l);
  changed();
}

export function useDrawingState(region: string): { selected: string | null; live?: DrawingLive } {
  useSyncExternalStore(subscribe, () => version);
  return { selected: selected.get(region) ?? null, live: live.get(region) };
}
