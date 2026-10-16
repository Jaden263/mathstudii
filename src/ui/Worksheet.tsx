import { useCallback, useLayoutEffect, useRef, useState, type Dispatch } from 'react';
import { Lock } from 'lucide-react';
import type { Region, ReportSettings, Worksheet as WS, WorksheetFormat } from '../model/types';
import { GRID, PAGE_HEIGHT, PAGE_MARGIN, PAGE_WIDTH } from '../model/types';
import { AREA_BAR, hiddenIds, isArea, withContents } from '../model/areas';
import { canEdit, isProtected, lockedIds, movableIds } from '../model/protect';
import { AreaBar, areaWidth, useAreaFit, usePrintLayout } from './AreaBar';
import type { RegionResult } from '../engine/evaluator';
import { moveResult, type Action } from './store';
import type { EditorHandle } from './editing';
import { MathView, TextView, SolveView, TableView, ImageView, PlotRegionView, SketchRegionView, CadRegionView, BeamRegionView, Frame3DRegionView, PlateRegionView, PythonRegionView, DrawingRegionView, SpreadsheetRegionView, type RegionViewProps } from './regions';

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
  /** Right-click on a region (region) or on empty paper (null), with the sheet position. */
  onContextMenu: (e: React.MouseEvent, region: Region | null, at: Cursor) => void;
  /** Regions matching the find bar, and the current match. */
  hits?: Set<string>;
  currentHit?: string | null;
  /** Tell the user why something did not happen (a locked region did not move). */
  notify?: (msg: string) => void;
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

const EDITABLE = new Set(['math', 'text', 'solve', 'table', 'sketch', 'cad', 'beam', 'python', 'frame3d', 'plate', 'spreadsheet']);

function hasError(res: RegionResult | undefined): boolean {
  if (!res) return false;
  if ('error' in res && res.error) return true;
  if (res.kind === 'solve') return !!(res.solver.error || res.guesses.some((g) => g.error) || res.constraints.some((c) => c.error));
  return false;
}

function checkClass(res: RegionResult | undefined): string {
  if (res?.kind !== 'math' || !res.check) return '';
  return res.check.ok ? ' check-ok' : ' check-fail';
}

/** Header and footer of one printed page. */
function PageFrame({ index, count, report, title }: { index: number; count: number; report: ReportSettings; title: string }) {
  const top = index * PAGE_HEIGHT;
  const date = report.date?.trim() || new Date().toISOString().slice(0, 10);
  const people = [report.author && `Made: ${report.author}`, report.checker && `Checked: ${report.checker}`, `Date: ${date}`].filter(Boolean).join('   ·   ');
  const doc = [report.docNo && `Doc. ${report.docNo}`, report.revision && `Rev. ${report.revision}`].filter(Boolean).join('   ');
  return (
    <>
      <div className="page-header" style={{ top: top + Math.round(5 * 3.7795), left: PAGE_MARGIN, right: PAGE_MARGIN }} aria-hidden>
        <div className="ph-left">
          {report.logo && <img src={report.logo} alt="" />}
          <span>{report.company}</span>
        </div>
        <div className="ph-mid">
          <b>{report.project}</b>
          <span>{report.subject?.trim() || title}</span>
        </div>
        <div className="ph-right">{doc}</div>
      </div>
      <div className="page-footer" style={{ top: top + PAGE_HEIGHT - Math.round(11 * 3.7795), left: PAGE_MARGIN, right: PAGE_MARGIN }} aria-hidden>
        <span>{people}</span>
        <span>Page {index + 1} of {count}</span>
      </div>
    </>
  );
}

export function Worksheet(p: Props) {
  const sheetRef = useRef<HTMLDivElement>(null);
  // printing shows each area collapsed or expanded as it asks; on screen as it is
  const view = usePrintLayout(p.ws);
  useAreaFit(sheetRef, p.ws, p.editingId, p.dispatch);
  const hidden = hiddenIds(view.regions);
  const shown = view.regions.filter((r) => !hidden.has(r.id));
  const locked = lockedIds(p.ws);
  const protectedWs = isProtected(p.ws);
  // pages that hold something (printing leaves out the empty paper after the last region)
  const [contentBottom, setContentBottom] = useState(0);
  useLayoutEffect(() => {
    let bottom = 0;
    sheetRef.current?.querySelectorAll<HTMLElement>('[data-region-id]').forEach((el) => {
      bottom = Math.max(bottom, el.offsetTop + el.offsetHeight);
    });
    if (Math.abs(bottom - contentBottom) > 1) setContentBottom(bottom);
  });
  const [drag, setDrag] = useState<{ dx: number; dy: number; ids: Set<string> } | null>(null);
  const [band, setBand] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);

  const maxY = shown.reduce((m, r) => Math.max(m, r.y + 400), 0);
  const pages = Math.max(1, Math.ceil((maxY + PAGE_HEIGHT / 2) / PAGE_HEIGHT));
  const height = pages * PAGE_HEIGHT;
  const contentPages = Math.max(1, Math.ceil((contentBottom + 1) / PAGE_HEIGHT));
  const report = p.ws.settings.report;

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
    // locked regions, and areas with something locked inside, stay where they are
    let free = new Set<string>();
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
        free = movableIds(p.ws, ids);
        if (free.size < withContents(p.ws.regions, ids).size) p.notify?.(protectedWs ? 'The worksheet is protected: regions do not move' : 'Locked regions do not move');
      }
      setDrag({ dx: snap(dx), dy: snap(dy), ids: free });
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
        const go = ids.filter((id) => free.has(id));
        if (!(dx || dy) || !go.length) return;
        if (moveResult(p.ws, go, dx, dy) === p.ws) p.notify?.('A locked area takes nothing in: unlock it first');
        else p.dispatch({ type: 'move', ids: go, dx, dy });
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
      if (!EDITABLE.has(r.kind) || r.disabled) return;
      if (canEdit(p.ws, r, locked)) p.setEditingId(r.id);
      else p.notify?.(protectedWs && !locked.has(r.id) ? 'The worksheet is protected: only inputs can be edited' : 'This region is locked (right-click → Unlock to edit it)');
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
      case 'frame3d': return <Frame3DRegionView {...(props as RegionViewProps<typeof r>)} />;
      case 'plate': return <PlateRegionView {...(props as RegionViewProps<typeof r>)} />;
      case 'python': return <PythonRegionView {...(props as RegionViewProps<typeof r>)} />;
      case 'spreadsheet': return <SpreadsheetRegionView {...(props as RegionViewProps<typeof r>)} />;
      case 'drawing': {
        const cad = p.ws.regions.find((q) => q.id === r.cad);
        return <DrawingRegionView {...(props as RegionViewProps<typeof r>)} cad={cad?.kind === 'cad' ? cad : undefined} cadResult={cad ? p.results.get(cad.id) : undefined} />;
      }
      case 'area':
        return (
          <AreaBar
            region={r} count={withContents(view.regions, [r.id]).size - 1} locked={locked.has(r.id)} canRename={canEdit(p.ws, r, locked)} renaming={editing}
            dispatch={p.dispatch} onRename={() => { p.setSelected(new Set([r.id])); p.setEditingId(r.id); }} onDone={() => p.finishEditing(r.id, false)}
          />
        );
    }
  };

  /** A collapsed area holding a match of the find bar shows it on its bar. */
  const hitInside = (r: Region) => {
    if (!p.hits?.size || !isArea(r) || !r.collapsed) return null;
    const inside = withContents(view.regions, [r.id]);
    if (p.currentHit && inside.has(p.currentHit)) return ' find-current';
    return [...p.hits].some((h) => inside.has(h)) ? ' find-hit' : null;
  };

  return (
    <div className="sheet-scroller-inner" style={{ width: PAGE_WIDTH * p.zoom, height: height * p.zoom }}>
      <div
        ref={sheetRef}
        className={`sheet${p.showGrid ? ' show-grid' : ''}${p.ws.settings.format?.textFont === 'serif' ? ' serif-text' : ''}`}
        style={{ width: PAGE_WIDTH, height, transform: `scale(${p.zoom})`, ['--print-h' as string]: `${contentPages * PAGE_HEIGHT}px` }}
        onPointerDown={onSheetPointerDown}
        onContextMenu={(e) => {
          if (e.target !== e.currentTarget) return;
          e.preventDefault();
          const at = toSheet(e.clientX, e.clientY);
          p.onContextMenu(e, null, { x: snap(at.x), y: snap(at.y) });
        }}
        tabIndex={-1}
        data-sheet
      >
        <div className="margin-guide" style={{ left: PAGE_MARGIN, right: PAGE_MARGIN }} />
        {report?.enabled && Array.from({ length: contentPages }, (_, i) => (
          <PageFrame key={i} index={i} count={contentPages} report={report} title={p.ws.title} />
        ))}
        {Array.from({ length: pages - 1 }, (_, i) => (
          <div key={i} className="page-break" style={{ top: (i + 1) * PAGE_HEIGHT }}>
            <span>Page {i + 2}</span>
          </div>
        ))}
        {shown.map((r) => {
          // the band of an open area: a rule down its left side to the end line
          if (!isArea(r) || r.collapsed) return null;
          const offset = drag?.ids.has(r.id) ? drag : null;
          return (
            <div
              key={`band-${r.id}`} className="area-band" aria-hidden
              style={{ left: r.x, top: r.y + AREA_BAR, width: areaWidth(r), height: Math.max(0, r.height - AREA_BAR), transform: offset ? `translate(${offset.dx}px, ${offset.dy}px)` : undefined }}
            />
          );
        })}
        {shown.map((r) => {
          const sel = p.selected.has(r.id);
          const offset = drag?.ids.has(r.id) ? drag : null;
          const res = p.results.get(r.id);
          const input = protectedWs && r.input && !locked.has(r.id);
          return (
            <div
              key={r.kind === 'plot' ? `${r.id}|${p.ws.settings.format?.fontScale ?? 1}|${p.ws.settings.format?.lineScale ?? 1}` : r.id}
              data-region-id={r.id}
              className={`region kind-${r.kind}${sel ? ' selected' : ''}${p.editingId === r.id ? ' is-editing' : ''}${r.disabled ? ' disabled' : ''}${hasError(res) ? ' error' : ''}${checkClass(res)}${p.hits?.has(r.id) ? (p.currentHit === r.id ? ' find-current' : ' find-hit') : hitInside(r) ?? ''}${input ? ' protect-input' : ''}`}
              style={{ left: r.x, top: r.y, transform: offset ? `translate(${offset.dx}px, ${offset.dy}px)` : undefined, ...regionLook(r, p.ws.settings.format) }}
              onPointerDown={(e) => onRegionPointerDown(e, r)}
              onContextMenu={(e) => {
                // editors that use the right button themselves, and text being typed, keep their own menu
                if (e.defaultPrevented) return;
                const t = e.target as HTMLElement;
                if (p.editingId === r.id && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT')) return;
                e.preventDefault();
                e.stopPropagation();
                p.onContextMenu(e, r, toSheet(e.clientX, e.clientY));
              }}
            >
              {renderRegion(r)}
              {r.locked && !isArea(r) && <span className="lock-badge" title="Locked" aria-label="Locked"><Lock size={11} /></span>}
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
