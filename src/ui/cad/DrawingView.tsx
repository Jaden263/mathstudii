// A drawing sheet of a CAD part on the page: the standard views, section and detail views
// with visible, hidden, tangent and centre lines in ISO 128 line types, hatched cut faces,
// overall dimensions, a border and an ISO 7200-style title block. It follows the part:
// change a dimension in the worksheet and the drawing redraws. Selected, it has tools to
// draw a cutting line (a section view) or a circle (a detail view) on a view, and section
// and detail views can be dragged to where they should sit.
import { useEffect, useMemo, useRef, useState, type Dispatch } from 'react';
import { Download, Printer, FileCode2, Scissors, ZoomIn } from 'lucide-react';
import type { CadRegion, DrawingRegion } from '../../model/types';
import { newId } from '../../model/types';
import type { CadResult } from '../../cad/evaluate';
import type { Action } from '../store';
import { designOf } from '../../cad/design';
import { designNumbers } from '../../cad/keys';
import { scaleText } from '../../cad/drawing';
import type { DrawView } from '../../cad/drawing2d';
import {
  detailScale, drawingRequests, layerStyle, layoutSheet, nextLetter, primPath, sheetSize, snapPoints, toPaper, toView, viewAt,
  type Layer, type PlacedView, type Sheet,
} from '../../cad/drawingSheet';
import { sheetDxf } from '../../cad/drawingDxf';
import { isSuperseded, kernelRequest } from './kernelClient';

interface Props {
  region: DrawingRegion;
  cad?: CadRegion;
  cadResult?: CadResult;
  selected: boolean;
  dispatch: Dispatch<Action>;
}

/** Layers drawn bottom up: hatching under the lines, wide lines over the narrow ones. */
const ORDER: Layer[] = ['HATCH', 'THIN', 'TANGENT', 'HIDDEN', 'CENTER', 'DIM', 'VISIBLE', 'BORDER'];

interface SvgProps {
  sheet: Sheet;
  svgRef?: React.Ref<SVGSVGElement>;
  children?: React.ReactNode;
  onPointerDown?: (e: React.PointerEvent<SVGSVGElement>) => void;
  onPointerMove?: (e: React.PointerEvent<SVGSVGElement>) => void;
}

function SheetSvg({ sheet, svgRef, children, onPointerDown, onPointerMove }: SvgProps) {
  const { W, H } = sheet;
  const paths = useMemo(() => {
    const by = new Map<Layer, string[]>();
    for (const ink of sheet.inks) {
      const l = by.get(ink.layer) ?? [];
      l.push(primPath(ink.p, H));
      by.set(ink.layer, l);
    }
    return ORDER.filter((l) => by.has(l)).map((l) => ({ layer: l, d: by.get(l)!.join(''), ...layerStyle(l, sheet.group) }));
  }, [sheet, H]);
  const fills = useMemo(() => sheet.fills.map((f) => {
    let d = '';
    for (let i = 0; i + 1 < f.pts.length; i += 2) d += `${i ? 'L' : 'M'}${f.pts[i].toFixed(3)} ${(H - f.pts[i + 1]).toFixed(3)}`;
    return `${d}Z`;
  }).join(''), [sheet, H]);
  const at = (v: number) => +v.toFixed(3);
  return (
    <svg
      ref={svgRef} xmlns="http://www.w3.org/2000/svg" viewBox={`0 0 ${W} ${H}`} className="dw-svg" fontFamily="Inter, Arial, sans-serif"
      onPointerDown={onPointerDown} onPointerMove={onPointerMove}
    >
      <rect x={0} y={0} width={W} height={H} fill="#fff" />
      {paths.map((p) => (
        <path
          key={p.layer} data-layer={p.layer} d={p.d} fill="none" stroke="#000" strokeWidth={p.width}
          strokeDasharray={p.dash.length ? p.dash.map((v) => +v.toFixed(4)).join(' ') : undefined}
          strokeLinecap={p.dash.length ? 'butt' : 'round'} strokeLinejoin="round"
        />
      ))}
      {fills && <path d={fills} fill="#000" stroke="none" />}
      {sheet.labels.map((l, i) => (
        // ISO 3098 heights are of the capitals: about 0.72 of the font size
        <text
          key={i} x={at(l.x)} y={at(H - l.y)} fontSize={at(l.h / 0.72)} fill={l.faint ? '#555' : '#000'} fontWeight={l.bold ? 600 : 400}
          textAnchor={l.anchor} transform={l.rot ? `rotate(${-l.rot} ${at(l.x)} ${at(H - l.y)})` : undefined}
        >{l.text}</text>
      ))}
      {children}
    </svg>
  );
}

/**
 * The drawing's views from the kernel worker (hidden lines take a while on a big part):
 * the last ones stay on the sheet while new ones are on their way.
 */
function useDrawing(region: DrawingRegion, cad: CadRegion | undefined, cadResult: CadResult | undefined): { views: Record<string, DrawView> | null; busy: boolean; failed?: string } {
  const [state, setState] = useState<{ views: Record<string, DrawView> | null; busy: boolean; failed?: string }>({ views: null, busy: true });
  const dr = cadResult?.design;
  const requests = useMemo(() => drawingRequests(region), [region]);
  const reqKey = JSON.stringify(requests);
  const key = dr?.display;
  useEffect(() => {
    if (!cad || !dr || cadResult?.needsBrep) return;
    let live = true;
    setState((s) => ({ ...s, busy: true }));
    kernelRequest({ op: 'drawing', design: designOf(cad), numbers: designNumbers(dr), views: requests }, `drawing:${region.id}`).then(
      (views) => live && setState({ views, busy: false }),
      (e) => live && !isSuperseded(e) && setState((s) => ({ ...s, busy: false, failed: (e as Error).message })),
    );
    return () => {
      live = false;
    };
  }, [key, reqKey, region.id, !!cadResult?.needsBrep]); // eslint-disable-line react-hooks/exhaustive-deps
  return state;
}

type Tool = 'section' | 'detail';

/** A point of the sheet (mm, y up) under the pointer. */
function sheetPoint(svg: SVGSVGElement, H: number, e: { clientX: number; clientY: number }): [number, number] {
  const m = svg.getScreenCTM();
  if (!m) return [0, 0];
  const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
  return [p.x, H - p.y];
}

/** The nearest centre, end or middle of a line within 2.5 mm of the paper, else the point itself. */
function snapIn(pv: PlacedView, x: number, y: number): [number, number] {
  let best: [number, number] = [x, y], bd = 2.5;
  for (const [sx, sy] of snapPoints(pv.view)) {
    const q = toPaper(pv, sx, sy), d = Math.hypot(q[0] - x, q[1] - y);
    if (d < bd) [best, bd] = [q, d];
  }
  return best;
}

export function DrawingView({ region, cad, cadResult, selected, dispatch }: Props) {
  const { views: all, busy, failed } = useDrawing(region, cad, cadResult);
  const svgRef = useRef<SVGSVGElement>(null);
  const [tool, setTool] = useState<Tool | null>(null);
  const [draft, setDraft] = useState<{ view: PlacedView; a: [number, number]; b: [number, number] } | null>(null);
  const [drag, setDrag] = useState<{ key: string; at: { x: number; y: number } } | null>(null);
  // views that drew nothing (no bodies) leave the sheet empty
  const views = useMemo(() => (all && Object.values(all).some((x) => x.visible.length) ? all : null), [all]);
  // a view being dragged sits where the pointer has it until it is dropped
  const shown = useMemo<DrawingRegion>(() => {
    if (!drag) return region;
    const id = drag.key.slice(4);
    return drag.key.startsWith('sec:')
      ? { ...region, sections: region.sections?.map((s) => (s.id === id ? { ...s, at: drag.at } : s)) }
      : { ...region, details: region.details?.map((d) => (d.id === id ? { ...d, at: drag.at } : d)) };
  }, [region, drag]);
  const sheet = useMemo(() => {
    if (!views) return null;
    const name = cad?.design?.components[0]?.name || cad?.name || 'Part';
    return layoutSheet(shown, views, { unit: cad?.unit ?? 'mm', name, date: new Date().toISOString().slice(0, 10) });
  }, [shown, views, cad?.unit, cad?.design, cad?.name]);
  const meshes = views ? Object.values(views).map((v) => v.mesh).filter(Boolean) : [];
  const mesh = meshes.includes('all') ? 'all' : meshes.length ? 'some' : null;

  useEffect(() => {
    if (selected) return;
    setTool(null);
    setDraft(null);
  }, [selected]);
  useEffect(() => {
    if (!tool) return;
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setTool(null);
      setDraft(null);
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [tool]);

  const set = (patch: Partial<DrawingRegion>) => dispatch({ type: 'update', id: region.id, patch });

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!selected || !sheet || e.button !== 0) return;
    const [x, y] = sheetPoint(e.currentTarget, sheet.H, e);
    const pv = viewAt(sheet, x, y);
    if (tool) {
      e.stopPropagation();
      e.preventDefault();
      if (!draft) {
        if (!pv || (tool === 'section' && !['front', 'top', 'side'].includes(pv.key))) return;
        const a = snapIn(pv, x, y);
        setDraft({ view: pv, a, b: a });
        return;
      }
      const { view, a, b } = draft;
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 1) return;
      const A = toView(view, ...a), B = toView(view, ...b);
      const letter = nextLetter(region);
      if (tool === 'section') {
        set({ sections: [...(region.sections ?? []), { id: newId(), letter, view: view.key as 'front' | 'top' | 'side', a: { x: A[0], y: A[1] }, b: { x: B[0], y: B[1] } }] });
      } else {
        const r = Math.hypot(B[0] - A[0], B[1] - A[1]);
        set({ details: [...(region.details ?? []), { id: newId(), letter, view: view.key, c: { x: A[0], y: A[1] }, r, scale: detailScale(view.k) }] });
      }
      setDraft(null);
      setTool(null);
      return;
    }
    // section and detail views move by dragging
    if (!pv || pv.kind === 'base') return;
    e.stopPropagation();
    e.preventDefault();
    const svg = e.currentTarget, H = sheet.H;
    const c0 = { x: (pv.box.x0 + pv.box.x1) / 2, y: (pv.box.y0 + pv.box.y1) / 2 };
    const start = [x, y];
    let at = c0;
    const move = (ev: PointerEvent) => {
      const [mx, my] = sheetPoint(svg, H, ev);
      at = { x: Math.round(c0.x + mx - start[0]), y: Math.round(c0.y + my - start[1]) };
      setDrag({ key: pv.key, at });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setDrag(null);
      if (at === c0) return;
      const id = pv.key.slice(4);
      if (pv.kind === 'section') set({ sections: region.sections?.map((s) => (s.id === id ? { ...s, at } : s)) });
      else set({ details: region.details?.map((d) => (d.id === id ? { ...d, at } : d)) });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!tool || !draft || !sheet) return;
    const [x, y] = sheetPoint(e.currentTarget, sheet.H, e);
    let b = snapIn(draft.view, x, y);
    if (tool === 'section' && b[0] === x && b[1] === y) {
      // within 5° of the paper's axes: straight across or up
      const dx = x - draft.a[0], dy = y - draft.a[1], t = Math.tan(Math.PI / 36);
      if (Math.abs(dy) < t * Math.abs(dx)) b = [x, draft.a[1]];
      else if (Math.abs(dx) < t * Math.abs(dy)) b = [draft.a[0], y];
    }
    setDraft({ ...draft, b });
  };

  const fileName = (region.title?.trim() || cad?.name || 'drawing').replace(/[^\w-]+/g, '_');
  const download = (data: string, type: string, ext: string) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([data], { type }));
    a.download = `${fileName}.${ext}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  const svgText = () => {
    const el = svgRef.current;
    if (!el || !sheet) return '';
    const copy = el.cloneNode(true) as SVGSVGElement;
    copy.querySelectorAll('[data-ui]').forEach((n) => n.remove());
    copy.setAttribute('width', `${sheet.W}mm`);
    copy.setAttribute('height', `${sheet.H}mm`);
    return `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(copy)}`;
  };
  const [W, H] = sheetSize(region);
  const printSheet = () => {
    if (!sheet) return;
    const frame = document.createElement('iframe');
    frame.style.position = 'fixed';
    frame.style.width = '0';
    frame.style.height = '0';
    frame.style.border = '0';
    document.body.appendChild(frame);
    const doc = frame.contentDocument!;
    doc.open();
    doc.write(printPage(fileName, region, svgText()));
    doc.close();
    setTimeout(() => {
      frame.contentWindow?.focus();
      frame.contentWindow?.print();
      setTimeout(() => frame.remove(), 1000);
    }, 100);
  };

  const status = !cad ? 'The part this drawing belongs to was deleted.' : failed && !views ? `The drawing failed: ${failed}` : !all ? (cadResult?.needsBrep ? 'Loading the 3-D kernel…' : 'Drawing the part…') : !views ? 'The part has no bodies yet.' : null;
  const orient = region.portrait ? 'portrait' : 'landscape';
  const hint = tool === 'section' ? (draft ? 'Click the other end of the cutting line (Esc cancels)' : 'Click on the front, top or side view where the cutting line starts')
    : tool === 'detail' ? (draft ? 'Click to set the size of the circle (Esc cancels)' : 'Click the centre of the detail on a view') : null;
  return (
    <div className="drawing-region" style={{ width: region.width }}>
      <div className={`dw-sheet${tool ? ' dw-picking' : ''}`} style={{ height: region.height }}>
        {sheet && !status ? (
          <SheetSvg sheet={sheet} svgRef={svgRef} onPointerDown={onPointerDown} onPointerMove={onPointerMove}>
            <g data-ui="">
              {selected && sheet.views.map((v) => (
                <rect
                  key={v.key} data-view={v.key} className={v.kind !== 'base' && !tool ? 'dw-movable' : 'dw-view'}
                  x={v.box.x0 - 2} y={sheet.H - v.box.y1 - 2} width={v.box.x1 - v.box.x0 + 4} height={v.box.y1 - v.box.y0 + 4}
                >
                  {v.kind !== 'base' && <title>Drag to move the view</title>}
                </rect>
              ))}
              {draft && tool === 'section' && <line className="dw-draft" x1={draft.a[0]} y1={sheet.H - draft.a[1]} x2={draft.b[0]} y2={sheet.H - draft.b[1]} />}
              {draft && tool === 'detail' && <circle className="dw-draft" cx={draft.a[0]} cy={sheet.H - draft.a[1]} r={Math.hypot(draft.b[0] - draft.a[0], draft.b[1] - draft.a[1])} />}
            </g>
          </SheetSvg>
        ) : <div className="dw-empty">{status ?? 'Nothing to draw'}</div>}
        {busy && sheet && <span className="cad-busy">Redrawing…</span>}
        {hint && <span className="dw-hint">{hint}</span>}
      </div>
      {selected && sheet && (
        <div className="dw-tools" onPointerDown={(e) => e.stopPropagation()}>
          <button className={`btn${tool === 'section' ? ' on' : ''}`} onClick={() => { setTool(tool === 'section' ? null : 'section'); setDraft(null); }} title="Section view: draw a cutting line across the front, top or side view"><Scissors size={13} /> Section</button>
          <button className={`btn${tool === 'detail' ? ' on' : ''}`} onClick={() => { setTool(tool === 'detail' ? null : 'detail'); setDraft(null); }} title="Detail view: draw a circle on a view to enlarge"><ZoomIn size={13} /> Detail</button>
          <button className="btn" onClick={printSheet} title={`Print or save as PDF on ${region.sheet} ${orient}, true scale`}><Printer size={13} /> Print {region.sheet}</button>
          <button className="btn" onClick={() => download(svgText(), 'image/svg+xml', 'svg')} title="Vector drawing in millimetres (opens in Inkscape, Illustrator, browsers)"><Download size={13} /> SVG</button>
          <button className="btn" onClick={() => download(sheetDxf(sheet), 'application/dxf', 'dxf')} title="DXF R2000 in paper millimetres: true circles, arcs and ellipses on layers VISIBLE, HIDDEN, CENTER, TANGENT, THIN, HATCH, DIM, TEXT, BORDER with ISO lineweights"><FileCode2 size={13} /> DXF</button>
          <span className="dw-scale">
            {mesh && <span title={mesh === 'all' ? 'OpenCascade is not loaded: the lines come from the display mesh' : 'Coils and modeled threads are drawn from their mesh'}>{mesh === 'all' ? 'mesh lines' : 'partly from the mesh'} · </span>}
            {region.sheet} {orient} {W} × {H} · Scale {scaleText(sheet.scale)}
          </span>
        </div>
      )}
    </div>
  );
}

/** The page the print path writes: the sheet at its true size on a page of the sheet's size. */
export function printPage(title: string, region: DrawingRegion, svg: string): string {
  const [W, H] = sheetSize(region);
  return `<!doctype html><html><head><title>${title}</title><style>@page{size:${W}mm ${H}mm;margin:0}html,body{margin:0}svg{display:block;width:${W}mm;height:${H}mm}</style></head><body>${svg.replace(/^<\?xml[^>]*>/, '')}</body></html>`;
}
