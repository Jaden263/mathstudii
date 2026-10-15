import { useCallback, useRef, useState, type Dispatch } from 'react';
import type { Region, Worksheet as WS, WorksheetFormat } from '../model/types';
import { GRID, PAGE_HEIGHT, PAGE_MARGIN, PAGE_WIDTH } from '../model/types';
import type { RegionResult } from '../engine/evaluator';
import type { Action } from './store';
import type { EditorHandle } from './editing';
import { MathView, TextView, SolveView, TableView, ImageView, PlotRegionView, SketchRegionView, CadRegionView, BeamRegionView, type RegionViewProps } from './regions';

export interface Cursor {
  x: number;
  y: number;
}

interface Props {
  ws: WS;
  results: Map<string, RegionResult>;
  dispatch: Dispatch<Action>;
  zoom: number;
  selected: Set<string>;
  setSelected: (s: Set<string>) => void;
  editingId: string | null;
  setEditingId: (id: string | null) => void;
  cursor: Cursor | null;
  setCursor: (c: Cursor | null) => void;
  registerEditor: (h: EditorHandle | null) => void;
  /** Leave edit mode for a region (removes it when empty). */
  finishEditing: (id: string, moveBelow: boolean) => void;
  showGrid: boolean;
}

export const snap = (v: number) => Math.round(v / GRID) * GRID;

/** CSS for a region's format: size and thickness as variables the views multiply with. */
function regionLook(r: Region, f: WorksheetFormat | undefined): React.CSSProperties {
  const st = r.style;
  const fs = (f?.fontScale ?? 1) * (st?.fontScale ?? 1), lw = (f?.lineScale ?? 1) * (st?.lineScale ?? 1);
  const out: Record<string, string | number> = {};
  if (fs !== 1) out['--fs'] = fs;
  if (lw !== 1) out['--lw'] = lw;
  if (st?.bold) out.fontWeight = 700;
  if (st?.italic) out.fontStyle = 'italic';
  if (st?.color) out.color = st.color;
  if (st?.background) out.backgroundColor = st.background;
  return out as React.CSSProperties;
}

const EDITABLE = new Set(['math', 'text', 'solve', 'table', 'sketch', 'cad', 'beam']);

function hasError(res: RegionResult | undefined): boolean {
  if (!res) return false;
  if ('error' in res && res.error) return true;
  if (res.kind === 'solve') return !!(res.solver.error || res.guesses.some((g) => g.error) || res.constraints.some((c) => c.error));
  return false;
}

export function Worksheet(p: Props) {
  const sheetRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ dx: number; dy: number } | null>(null);
  const [band, setBand] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);

  const maxY = p.ws.regions.reduce((m, r) => Math.max(m, r.y + 400), 0);
  const pages = Math.max(1, Math.ceil((maxY + PAGE_HEIGHT / 2) / PAGE_HEIGHT));
  const height = pages * PAGE_HEIGHT;

  const toSheet = useCallback((clientX: number, clientY: number) => {
    const rect = sheetRef.current!.getBoundingClientRect();
    return { x: (clientX - rect.left) / p.zoom, y: (clientY - rect.top) / p.zoom };
  }, [p.zoom]);

  const onSheetPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || e.target !== e.currentTarget) return;
    const start = toSheet(e.clientX, e.clientY);
    if (p.editingId) p.finishEditing(p.editingId, false);
    let moved = false;
    const move = (ev: PointerEvent) => {
      const cur = toSheet(ev.clientX, ev.clientY);
      if (!moved && Math.hypot(cur.x - start.x, cur.y - start.y) < 4) return;
      moved = true;
      setBand({ x0: start.x, y0: start.y, x1: cur.x, y1: cur.y });
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (moved) {
        const cur = toSheet(ev.clientX, ev.clientY);
        const [x0, x1] = [Math.min(start.x, cur.x), Math.max(start.x, cur.x)];
        const [y0, y1] = [Math.min(start.y, cur.y), Math.max(start.y, cur.y)];
        const ids = new Set<string>();
        sheetRef.current!.querySelectorAll<HTMLElement>('[data-region-id]').forEach((el) => {
          const r = p.ws.regions.find((q) => q.id === el.dataset.regionId);
          if (!r) return;
          const w = el.offsetWidth, h = el.offsetHeight;
          if (r.x < x1 && r.x + w > x0 && r.y < y1 && r.y + h > y0) ids.add(r.id);
        });
        p.setSelected(ids);
        p.setCursor(null);
        setBand(null);
      } else {
        p.setSelected(new Set());
        p.setCursor({ x: snap(start.x), y: snap(start.y) });
        sheetRef.current?.focus({ preventScroll: true });
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const onRegionPointerDown = (e: React.PointerEvent, r: Region, viaGrip = false) => {
    if (e.button !== 0) return;
    if (p.editingId === r.id && !viaGrip) return;
    e.stopPropagation();
    // touch: the region itself scrolls the page; moving is done with the grip
    const touchTap = e.pointerType === 'touch' && !viaGrip;
    const start = { x: e.clientX, y: e.clientY };
    const additive = e.shiftKey || e.metaKey || e.ctrlKey;
    let ids = p.selected.has(r.id) ? [...p.selected] : [r.id];
    let moved = false;
    let cancelled = false;
    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - start.x) / p.zoom;
      const dy = (ev.clientY - start.y) / p.zoom;
      if (!moved && Math.hypot(dx, dy) < 4) return;
      if (touchTap) {
        cancelled = true;
        return;
      }
      if (!moved) {
        moved = true;
        if (p.editingId) p.finishEditing(p.editingId, false);
        if (!p.selected.has(r.id)) {
          ids = additive ? [...p.selected, r.id] : [r.id];
          p.setSelected(new Set(ids));
        }
      }
      setDrag({ dx: snap(dx), dy: snap(dy) });
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      setDrag(null);
      if (cancelled || ev.type === 'pointercancel') return;
      if (moved) {
        const dx = snap((ev.clientX - start.x) / p.zoom);
        const dy = snap((ev.clientY - start.y) / p.zoom);
        if (dx || dy) p.dispatch({ type: 'move', ids, dx, dy });
        return;
      }
      p.setCursor(null);
      if (additive) {
        const next = new Set(p.selected);
        if (next.has(r.id)) next.delete(r.id);
        else next.add(r.id);
        p.setSelected(next);
        return;
      }
      if (viaGrip) return;
      if (p.editingId && p.editingId !== r.id) p.finishEditing(p.editingId, false);
      p.setSelected(new Set([r.id]));
      if (EDITABLE.has(r.kind) && !r.disabled) p.setEditingId(r.id);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  const renderRegion = (r: Region) => {
    const editing = p.editingId === r.id;
    const props: RegionViewProps<Region> = {
      region: r,
      result: p.results.get(r.id),
      editing,
      selected: p.selected.has(r.id),
      dispatch: p.dispatch,
      onDone: (below) => p.finishEditing(r.id, !!below),
      registerEditor: p.registerEditor,
      zoom: p.zoom,
    };
    switch (r.kind) {
      case 'math': return <MathView {...(props as RegionViewProps<typeof r>)} />;
      case 'text': return <TextView {...(props as RegionViewProps<typeof r>)} />;
      case 'solve': return <SolveView {...(props as RegionViewProps<typeof r>)} />;
      case 'table': return <TableView {...(props as RegionViewProps<typeof r>)} />;
      case 'image': return <ImageView {...(props as RegionViewProps<typeof r>)} />;
      case 'plot': return <PlotRegionView {...(props as RegionViewProps<typeof r>)} />;
      case 'sketch': return <SketchRegionView {...(props as RegionViewProps<typeof r>)} />;
      case 'cad': return <CadRegionView {...(props as RegionViewProps<typeof r>)} />;
      case 'beam': return <BeamRegionView {...(props as RegionViewProps<typeof r>)} />;
    }
  };

  return (
    <div className="sheet-scroller-inner" style={{ width: PAGE_WIDTH * p.zoom, height: height * p.zoom }}>
      <div
        ref={sheetRef}
        className={`sheet${p.showGrid ? ' show-grid' : ''}${p.ws.settings.format?.textFont === 'serif' ? ' serif-text' : ''}`}
        style={{ width: PAGE_WIDTH, height, transform: `scale(${p.zoom})` }}
        onPointerDown={onSheetPointerDown}
        tabIndex={-1}
        data-sheet
      >
        <div className="margin-guide" style={{ left: PAGE_MARGIN, right: PAGE_MARGIN }} />
        {Array.from({ length: pages - 1 }, (_, i) => (
          <div key={i} className="page-break" style={{ top: (i + 1) * PAGE_HEIGHT }}>
            <span>Page {i + 2}</span>
          </div>
        ))}
        {p.ws.regions.map((r) => {
          const sel = p.selected.has(r.id);
          const offset = drag && sel ? drag : null;
          const res = p.results.get(r.id);
          return (
            <div
              key={r.kind === 'plot' ? `${r.id}|${p.ws.settings.format?.fontScale ?? 1}|${p.ws.settings.format?.lineScale ?? 1}` : r.id}
              data-region-id={r.id}
              className={`region kind-${r.kind}${sel ? ' selected' : ''}${p.editingId === r.id ? ' is-editing' : ''}${r.disabled ? ' disabled' : ''}${hasError(res) ? ' error' : ''}`}
              style={{ left: r.x, top: r.y, transform: offset ? `translate(${offset.dx}px, ${offset.dy}px)` : undefined, ...regionLook(r, p.ws.settings.format) }}
              onPointerDown={(e) => onRegionPointerDown(e, r)}
            >
              {renderRegion(r)}
              {(sel || p.editingId === r.id) && (
                <div className="grip" title="Drag to move" aria-hidden onPointerDown={(e) => onRegionPointerDown(e, r, true)} />
              )}
            </div>
          );
        })}
        {p.cursor && !p.editingId && (
          <div className="crosshair" style={{ left: p.cursor.x, top: p.cursor.y }} aria-hidden>
            <span />
          </div>
        )}
        {band && (
          <div className="band" style={{ left: Math.min(band.x0, band.x1), top: Math.min(band.y0, band.y1), width: Math.abs(band.x1 - band.x0), height: Math.abs(band.y1 - band.y0) }} />
        )}
      </div>
    </div>
  );
}
