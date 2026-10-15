import { useReducer } from 'react';
import type { Region, Worksheet, WorksheetSettings } from '../model/types';

export type Action =
  | { type: 'load'; ws: Worksheet }
  | { type: 'add'; regions: Region[] }
  | { type: 'update'; id: string; patch: Partial<Region>; coalesce?: string; /** false: not an undo step (e.g. a sketch's zoom) */ history?: false }
  | { type: 'move'; ids: string[]; dx: number; dy: number; coalesce?: string }
  | { type: 'delete'; ids: string[] }
  /** Draw these regions above (front) or below (back) the others. */
  | { type: 'reorder'; ids: string[]; to: 'front' | 'back' }
  | { type: 'settings'; patch: Partial<WorksheetSettings> }
  | { type: 'title'; title: string; coalesce?: string }
  | { type: 'undo' }
  | { type: 'redo' }
  /** The document as of `version` (default: now) is stored. */
  | { type: 'markSaved'; version?: number };

interface State {
  ws: Worksheet;
  past: Worksheet[];
  future: Worksheet[];
  lastCoalesce: string | null;
  lastTime: number;
  /** Version counter of the document; compared with savedVersion for the dirty flag. */
  version: number;
  savedVersion: number;
}

const HISTORY = 200;

function apply(ws: Worksheet, a: Action): Worksheet {
  switch (a.type) {
    case 'add':
      return { ...ws, regions: [...ws.regions, ...a.regions] };
    case 'update':
      return { ...ws, regions: ws.regions.map((r) => (r.id === a.id ? ({ ...r, ...a.patch } as Region) : r)) };
    case 'move': {
      const ids = new Set(a.ids);
      return {
        ...ws,
        regions: ws.regions.map((r) => (ids.has(r.id) ? { ...r, x: Math.max(0, r.x + a.dx), y: Math.max(0, r.y + a.dy) } : r)),
      };
    }
    case 'delete': {
      const ids = new Set(a.ids);
      return { ...ws, regions: ws.regions.filter((r) => !ids.has(r.id)) };
    }
    case 'reorder': {
      const ids = new Set(a.ids);
      const moved = ws.regions.filter((r) => ids.has(r.id));
      const rest = ws.regions.filter((r) => !ids.has(r.id));
      return { ...ws, regions: a.to === 'front' ? [...rest, ...moved] : [...moved, ...rest] };
    }
    case 'settings':
      return { ...ws, settings: { ...ws.settings, ...a.patch } };
    case 'title':
      return { ...ws, title: a.title };
    default:
      return ws;
  }
}

function reducer(s: State, a: Action): State {
  switch (a.type) {
    case 'load':
      return { ws: a.ws, past: [], future: [], lastCoalesce: null, lastTime: 0, version: s.version + 1, savedVersion: s.version + 1 };
    case 'markSaved':
      return { ...s, savedVersion: Math.max(s.savedVersion, Math.min(a.version ?? s.version, s.version)) };
    case 'undo': {
      if (!s.past.length) return s;
      const prev = s.past[s.past.length - 1];
      return { ...s, ws: prev, past: s.past.slice(0, -1), future: [s.ws, ...s.future], lastCoalesce: null, version: s.version + 1 };
    }
    case 'redo': {
      if (!s.future.length) return s;
      const [next, ...rest] = s.future;
      return { ...s, ws: next, past: [...s.past, s.ws], future: rest, lastCoalesce: null, version: s.version + 1 };
    }
    default: {
      const ws = apply(s.ws, a);
      if (ws === s.ws) return s;
      if ('history' in a && a.history === false) return { ...s, ws, version: s.version + 1 };
      const key = 'coalesce' in a && a.coalesce ? a.coalesce : null;
      const now = Date.now();
      // typing into the same field within 1.5 s merges into one undo step
      const merge = key !== null && key === s.lastCoalesce && now - s.lastTime < 1500;
      const past = merge ? s.past : [...s.past, s.ws].slice(-HISTORY);
      return { ws, past, future: [], lastCoalesce: key, lastTime: now, version: s.version + 1, savedVersion: s.savedVersion };
    }
  }
}

export function useWorksheetStore(initial: () => Worksheet) {
  const [state, dispatch] = useReducer(reducer, undefined, () => ({
    ws: initial(), past: [], future: [], lastCoalesce: null, lastTime: 0, version: 0, savedVersion: 0,
  }));
  return {
    ws: state.ws,
    dispatch,
    canUndo: state.past.length > 0,
    canRedo: state.future.length > 0,
    dirty: state.version !== state.savedVersion,
    version: state.version,
  };
}
