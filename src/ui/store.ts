import { useReducer } from 'react';
import type { AreaRegion, Region, Worksheet, WorksheetProtection, WorksheetSettings } from '../model/types';
import { collapseArea, expandArea, fitArea, groupIntoArea, insertArea, isArea, makeRoom, nestBands, ungroupArea, withContents } from '../model/areas';
import { canAddAt, canEdit, canMove, isProtected, isViewPatch, lockedIds, movableIds, respectLocks } from '../model/protect';

export type Action =
  | { type: 'load'; ws: Worksheet }
  /** `room`: first move what is at that height and below down (pasting an area). */
  | { type: 'add'; regions: Region[]; room?: { at: number; height: number } }
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
  | { type: 'markSaved'; version?: number }
  | { type: 'collapse'; id: string }
  | { type: 'expand'; id: string }
  /** Put regions into a new area; `heights` are their rendered heights (px). */
  | { type: 'group'; ids: string[]; heights: Record<string, number>; area: AreaRegion }
  /** An empty area at area.y, pushing what is below down. */
  | { type: 'insertArea'; area: AreaRegion }
  | { type: 'ungroup'; id: string }
  /** An area's contents grew: its band grows to `height` (not an undo step). */
  | { type: 'areaFit'; id: string; height: number }
  /** Lock or unlock regions (not an undo step: undo never unlocks). */
  | { type: 'lock'; ids: string[]; locked: boolean }
  /** Mark regions as inputs that stay editable when the worksheet is protected. */
  | { type: 'input'; ids: string[]; input: boolean }
  /** Protect the worksheet (or lift the protection with null) — the caller checks the password. */
  | { type: 'protect'; protect: WorksheetProtection | null };

export interface State {
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

/** Changes kept out of the undo history. */
const NO_HISTORY = new Set<Action['type']>(['areaFit', 'lock', 'input', 'protect']);

/** Settings a protected worksheet still lets anyone change. */
const OPEN_SETTINGS = new Set(['autoCalc']);

function apply(ws: Worksheet, a: Action): Worksheet {
  switch (a.type) {
    case 'add': {
      const regions = a.regions.filter((r) => canAddAt(ws, r.y));
      if (!regions.length) return ws;
      const base = a.room ? makeRoom(ws, a.room.at, a.room.height) : ws;
      return nestBands({ ...base, regions: [...base.regions, ...regions] });
    }
    case 'update': {
      const r = ws.regions.find((q) => q.id === a.id);
      if (!r || (!canEdit(ws, r) && !isViewPatch(a.patch))) return ws;
      return { ...ws, regions: ws.regions.map((q) => (q === r ? ({ ...q, ...a.patch } as Region) : q)) };
    }
    case 'move': {
      const ids = movableIds(ws, a.ids);
      if (!ids.size) return ws;
      // an area moves with its contents by the step its bar takes
      const step = new Map<string, { dx: number; dy: number }>();
      for (const id of a.ids) {
        const r = ws.regions.find((q) => q.id === id);
        if (!r || !ids.has(id) || !isArea(r)) continue;
        const d = { dx: Math.max(-r.x, a.dx), dy: Math.max(-r.y, a.dy) };
        for (const m of withContents(ws.regions, [id])) if (!step.has(m)) step.set(m, d);
      }
      // an area dragged into another's band is taken in by it
      const moved = nestBands({
        ...ws,
        regions: ws.regions.map((r) => {
          if (!ids.has(r.id)) return r;
          const d = step.get(r.id);
          return d ? { ...r, x: r.x + d.dx, y: r.y + d.dy } : { ...r, x: Math.max(0, r.x + a.dx), y: Math.max(0, r.y + a.dy) };
        }),
      });
      // nothing is dropped into a locked area (it could not be taken out again)
      const locked = lockedIds(moved);
      return [...ids].some((id) => locked.has(id)) ? ws : moved;
    }
    case 'delete': {
      // an area goes with everything in it
      const ids = movableIds(ws, a.ids);
      return ids.size ? { ...ws, regions: ws.regions.filter((r) => !ids.has(r.id)) } : ws;
    }
    case 'collapse':
      return collapseArea(ws, a.id);
    case 'expand':
      return expandArea(ws, a.id);
    case 'group':
      return isProtected(ws) ? ws : groupIntoArea(ws, a.ids, (id) => a.heights[id] ?? 24, a.area);
    case 'insertArea':
      return canAddAt(ws, a.area.y) ? nestBands(insertArea(ws, a.area)) : ws;
    case 'ungroup': {
      const r = ws.regions.find((q) => q.id === a.id);
      return r && canMove(ws, r) ? ungroupArea(ws, a.id) : ws;
    }
    case 'areaFit':
      return fitArea(ws, a.id, a.height);
    case 'lock':
    case 'input': {
      if (isProtected(ws)) return ws;
      const ids = new Set(a.ids);
      const key = a.type === 'lock' ? 'locked' : 'input';
      const on = a.type === 'lock' ? a.locked : a.input;
      return {
        ...ws,
        regions: ws.regions.map((r) => {
          if (!ids.has(r.id) || !!r[key] === on) return r;
          const q = { ...r };
          if (on) q[key] = true;
          else delete q[key];
          return q;
        }),
      };
    }
    case 'protect': {
      const settings = { ...ws.settings };
      if (a.protect) settings.protect = a.protect;
      else delete settings.protect;
      return { ...ws, settings };
    }
    case 'reorder': {
      const ids = new Set(a.ids);
      const moved = ws.regions.filter((r) => ids.has(r.id));
      const rest = ws.regions.filter((r) => !ids.has(r.id));
      return { ...ws, regions: a.to === 'front' ? [...rest, ...moved] : [...moved, ...rest] };
    }
    case 'settings': {
      const patch = isProtected(ws) ? Object.fromEntries(Object.entries(a.patch).filter(([k]) => OPEN_SETTINGS.has(k))) : a.patch;
      if ('protect' in patch) return ws;
      return Object.keys(patch).length ? { ...ws, settings: { ...ws.settings, ...patch } } : ws;
    }
    case 'title':
      return isProtected(ws) ? ws : { ...ws, title: a.title };
    default:
      return ws;
  }
}

/** What moving these regions would give: the same worksheet when locks refuse the move. */
export const moveResult = (ws: Worksheet, ids: string[], dx: number, dy: number): Worksheet => apply(ws, { type: 'move', ids, dx, dy });

export function reducer(s: State, a: Action): State {
  switch (a.type) {
    case 'load':
      return { ws: a.ws, past: [], future: [], lastCoalesce: null, lastTime: 0, version: s.version + 1, savedVersion: s.version + 1 };
    case 'markSaved':
      return { ...s, savedVersion: Math.max(s.savedVersion, Math.min(a.version ?? s.version, s.version)) };
    // undo and redo never touch what is locked or protected now
    case 'undo': {
      if (!s.past.length) return s;
      const prev = respectLocks(s.past[s.past.length - 1], s.ws);
      return { ...s, ws: prev, past: s.past.slice(0, -1), future: [s.ws, ...s.future], lastCoalesce: null, version: s.version + 1 };
    }
    case 'redo': {
      if (!s.future.length) return s;
      const [next, ...rest] = s.future;
      return { ...s, ws: respectLocks(next, s.ws), past: [...s.past, s.ws], future: rest, lastCoalesce: null, version: s.version + 1 };
    }
    default: {
      const ws = apply(s.ws, a);
      if (ws === s.ws) return s;
      if (('history' in a && a.history === false) || NO_HISTORY.has(a.type)) return { ...s, ws, version: s.version + 1 };
      const key = 'coalesce' in a && a.coalesce ? a.coalesce : null;
      const now = Date.now();
      // typing into the same field within 1.5 s merges into one undo step
      const merge = key !== null && key === s.lastCoalesce && now - s.lastTime < 1500;
      const past = merge ? s.past : [...s.past, s.ws].slice(-HISTORY);
      return { ws, past, future: [], lastCoalesce: key, lastTime: now, version: s.version + 1, savedVersion: s.savedVersion };
    }
  }
}

export function initialState(ws: Worksheet): State {
  return { ws, past: [], future: [], lastCoalesce: null, lastTime: 0, version: 0, savedVersion: 0 };
}

export function useWorksheetStore(initial: () => Worksheet) {
  const [state, dispatch] = useReducer(reducer, undefined, () => initialState(initial()));
  return {
    ws: state.ws,
    dispatch,
    canUndo: state.past.length > 0,
    canRedo: state.future.length > 0,
    dirty: state.version !== state.savedVersion,
    version: state.version,
  };
}
