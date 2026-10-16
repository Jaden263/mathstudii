// A drawing sheet of a CAD part on the page: the standard views with visible and hidden
// lines, overall dimensions, a border and an ISO 7200-style title block. It follows the
// part: change a dimension in the worksheet and the drawing redraws.
import { useEffect, useMemo, useRef, useState, type Dispatch } from 'react';
import { Download, Printer, FileCode2 } from 'lucide-react';
import type { CadRegion, DrawingRegion } from '../../model/types';
import type { CadResult } from '../../cad/evaluate';
import type { Action } from '../store';
import { designOf } from '../../cad/design';
import { designNumbers } from '../../cad/keys';
import { scaleText, standardScale, type ViewLines } from '../../cad/drawing';
import type { ViewSpecRequest } from '../../cad/kernel/protocol';
import { isSuperseded, kernelRequest } from './kernelClient';

interface Props {
  region: DrawingRegion;
  cad?: CadRegion;
  cadResult?: CadResult;
  selected: boolean;
  dispatch: Dispatch<Action>;
}

const SHEETS = { A4: [297, 210], A3: [420, 297] } as const;

interface Placed {
  key: string;
  lines: ViewLines;
  /** Paper position of the view's model origin and scale. */
  ox: number;
  oy: number;
}

/** Everything drawn on the sheet, in paper millimetres (y down), for SVG and DXF alike. */
interface Sheet {
  W: number;
  H: number;
  placed: Placed[];
  scale: number;
  dims: { x1: number; y1: number; x2: number; y2: number; ox: number; oy: number; text: string; vertical: boolean }[];
  frame: { x: number; y: number; w: number; h: number };
  title: { x: number; y: number; w: number; h: number };
}

function layout(r: DrawingRegion, views: Record<string, ViewLines>, unit: string): Sheet | null {
  const [W, H] = SHEETS[r.sheet];
  const frame = { x: 20, y: 10, w: W - 30, h: H - 20 };
  const title = { x: frame.x + frame.w - 180, y: frame.y + frame.h - 32, w: 180, h: 32 };
  // grid of views: first angle puts the left-side view to the right of the front and the
  // top view below it; third angle the right-side view to the right and the top above
  const first = r.projection === 'first';
  const grid: (string | null)[][] = first ? [['front', 'side'], ['top', 'iso']] : [['top', 'iso'], ['front', 'side']];
  const has = (k: string | null) => !!k && !!views[k];
  const size = (k: string | null) => (has(k) ? { w: views[k!].box.x1 - views[k!].box.x0, h: views[k!].box.y1 - views[k!].box.y0 } : { w: 0, h: 0 });
  const colW = [0, 1].map((c) => Math.max(size(grid[0][c]).w, size(grid[1][c]).w));
  const rowH = [0, 1].map((rw) => Math.max(size(grid[rw][0]).h, size(grid[rw][1]).h));
  const usedCols = colW.filter((x) => x > 0).length, usedRows = rowH.filter((x) => x > 0).length;
  if (!usedCols || !usedRows) return null;
  // room for dimensions around each view and the title block under the lower row
  const gap = 24;
  const availW = frame.w - gap * (usedCols + 1);
  const availH = frame.h - title.h - gap * (usedRows + 1);
  const scale = r.scale ?? standardScale(Math.max((colW[0] + colW[1]) / availW, (rowH[0] + rowH[1]) / availH), 1);
  const placed: Placed[] = [];
  const dims: Sheet['dims'] = [];
  const cellW = colW.map((x) => x * scale), cellH = rowH.map((x) => x * scale);
  const spareW = Math.max(0, frame.w - cellW[0] - cellW[1]), spareH = Math.max(0, frame.h - title.h - cellH[0] - cellH[1]);
  const gx = spareW / (usedCols + 1), gy = spareH / (usedRows + 1);
  const fmt = (v: number) => `${+v.toFixed(v >= 100 ? 1 : 2)}`;
  for (let rw = 0; rw < 2; rw++) {
    for (let c = 0; c < 2; c++) {
      const k = grid[rw][c];
      if (!has(k)) continue;
      const v = views[k!];
      const cx = frame.x + gx + (c ? cellW[0] + gx : 0) + cellW[c] / 2;
      const cy = frame.y + gy + (rw ? cellH[0] + gy : 0) + cellH[rw] / 2;
      const mx = (v.box.x0 + v.box.x1) / 2, my = (v.box.y0 + v.box.y1) / 2;
      // paper: x = ox + X·scale, y = oy − Y·scale
      const ox = cx - mx * scale, oy = cy + my * scale;
      placed.push({ key: k!, lines: v, ox, oy });
      if (r.dims && k !== 'iso') {
        const x0 = ox + v.box.x0 * scale, x1 = ox + v.box.x1 * scale, yb = oy - v.box.y0 * scale, yt = oy - v.box.y1 * scale;
        dims.push({ x1: x0, y1: yb, x2: x1, y2: yb, ox: 0, oy: 8, text: fmt(v.box.x1 - v.box.x0), vertical: false });
        dims.push({ x1: x1, y1: yb, x2: x1, y2: yt, ox: 8, oy: 0, text: fmt(v.box.y1 - v.box.y0), vertical: true });
      }
    }
  }
  void unit;
  return { W, H, placed, scale, dims, frame, title };
}

function SheetSvg({ r, sheet, cad, svgRef }: { r: DrawingRegion; sheet: Sheet; cad?: CadRegion; svgRef?: React.Ref<SVGSVGElement> }) {
  const { W, H, frame, title, scale } = sheet;
  const name = r.title?.trim() || cad?.design?.components[0]?.name || cad?.name || 'Part';
  const cells: [string, string, number, number, number][] = [
    // label, value, x, y (relative to the title block), width
    ['Title', name, 0, 0, 110],
    ['Part no.', r.partNo ?? '', 110, 0, 70],
    ['Material', r.material ?? '', 0, 11, 70],
    ['Scale', scaleText(scale), 70, 11, 25],
    ['Units', cad?.unit ?? 'mm', 95, 11, 15],
    ['Drawn', r.drawnBy ?? '', 0, 22, 70],
    ['Date', r.date?.trim() || new Date().toISOString().slice(0, 10), 70, 22, 40],
  ];
  return (
    <svg ref={svgRef} xmlns="http://www.w3.org/2000/svg" viewBox={`0 0 ${W} ${H}`} className="dw-svg" fontFamily="Inter, Arial, sans-serif">
      <rect x={0} y={0} width={W} height={H} fill="#fff" />
      <rect x={frame.x} y={frame.y} width={frame.w} height={frame.h} fill="none" stroke="#000" strokeWidth={0.7} />
      {sheet.placed.map((p) => (
        <g key={p.key}>
          {r.hidden && (
            <path
              d={segPath(p.lines.hidden, p.ox, p.oy, scale)} fill="none" stroke="#000" strokeWidth={0.25}
              strokeDasharray="3 1.5" strokeLinecap="butt"
            />
          )}
          <path d={segPath(p.lines.visible, p.ox, p.oy, scale)} fill="none" stroke="#000" strokeWidth={0.5} strokeLinecap="round" />
          {p.key === 'iso' && (
            <text x={p.ox + ((p.lines.box.x0 + p.lines.box.x1) / 2) * scale} y={p.oy - p.lines.box.y0 * scale + 6} fontSize={3} textAnchor="middle" fill="#555">Isometric</text>
          )}
        </g>
      ))}
      {sheet.dims.map((d, i) => <Dim key={i} d={d} />)}
      <g className="dw-title">
        <rect x={title.x} y={title.y} width={title.w} height={title.h} fill="#fff" stroke="#000" strokeWidth={0.5} />
        {cells.map(([label, value, x, y, w]) => (
          <g key={label}>
            <rect x={title.x + x} y={title.y + y} width={w} height={11} fill="none" stroke="#000" strokeWidth={0.25} />
            <text x={title.x + x + 1.5} y={title.y + y + 3.2} fontSize={2.2} fill="#555">{label}</text>
            <text x={title.x + x + 1.5} y={title.y + y + 8.6} fontSize={label === 'Title' ? 4 : 3.2} fontWeight={label === 'Title' ? 600 : 400} fill="#000">{value}</text>
          </g>
        ))}
        <ProjectionSymbol x={title.x + 110} y={title.y + 11} w={70} h={21} first={r.projection === 'first'} />
      </g>
    </svg>
  );
}

function segPath(s: number[], ox: number, oy: number, k: number): string {
  let d = '';
  for (let i = 0; i < s.length; i += 4) {
    d += `M${(ox + s[i] * k).toFixed(3)} ${(oy - s[i + 1] * k).toFixed(3)}L${(ox + s[i + 2] * k).toFixed(3)} ${(oy - s[i + 3] * k).toFixed(3)}`;
  }
  return d;
}

function Dim({ d }: { d: Sheet['dims'][number] }) {
  const ax = d.x1 + d.ox, ay = d.y1 + d.oy, bx = d.x2 + d.ox, by = d.y2 + d.oy;
  const arrow = (x: number, y: number, dx: number, dy: number) => {
    const l = Math.hypot(dx, dy) || 1, ux = dx / l, uy = dy / l, s = 2.5, w = 0.8;
    return `M${x} ${y}L${x - ux * s - uy * w} ${y - uy * s + ux * w}L${x - ux * s + uy * w} ${y - uy * s - ux * w}Z`;
  };
  const mx = (ax + bx) / 2, my = (ay + by) / 2;
  return (
    <g stroke="#000" strokeWidth={0.18} fill="#000">
      <line x1={d.x1 + Math.sign(d.ox) * 1} y1={d.y1 + Math.sign(d.oy) * 1} x2={ax + Math.sign(d.ox) * 1.5} y2={ay + Math.sign(d.oy) * 1.5} />
      <line x1={d.x2 + Math.sign(d.ox) * 1} y1={d.y2 + Math.sign(d.oy) * 1} x2={bx + Math.sign(d.ox) * 1.5} y2={by + Math.sign(d.oy) * 1.5} />
      <line x1={ax} y1={ay} x2={bx} y2={by} />
      <path d={arrow(ax, ay, ax - bx, ay - by) + arrow(bx, by, bx - ax, by - ay)} stroke="none" />
      <text
        x={d.vertical ? mx + 1.2 : mx} y={d.vertical ? my : my - 1} fontSize={3.5} stroke="none" textAnchor="middle"
        transform={d.vertical ? `rotate(-90 ${mx + 1.2} ${my})` : undefined} dy={d.vertical ? -0.8 : 0}
      >{d.text}</text>
    </g>
  );
}

/** ISO 128 projection symbol: a truncated cone seen from the side and from the end. */
function ProjectionSymbol({ x, y, w, h, first }: { x: number; y: number; w: number; h: number; first: boolean }) {
  const cy = y + h / 2 + 1.5;
  const side = (sx: number) => <path d={`M${sx} ${cy - 3}L${sx + 9} ${cy - 5}L${sx + 9} ${cy + 5}L${sx} ${cy + 3}Z`} fill="none" stroke="#000" strokeWidth={0.3} />;
  const end = (ex: number) => (
    <g fill="none" stroke="#000" strokeWidth={0.3}>
      <circle cx={ex} cy={cy} r={5} />
      <circle cx={ex} cy={cy} r={3} />
    </g>
  );
  const a = x + w / 2 - 14, b = x + w / 2 + 8;
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} fill="none" stroke="#000" strokeWidth={0.25} />
      <text x={x + 1.5} y={y + 3.2} fontSize={2.2} fill="#555">{first ? 'First angle projection' : 'Third angle projection'}</text>
      {first ? <>{side(a)}{end(b)}</> : <>{end(a + 4)}{side(b - 4)}</>}
    </g>
  );
}

/**
 * The views of the part, drawn by the kernel worker (hidden lines take a while on a big
 * part): the last ones stay on the sheet while new ones are on their way.
 */
function useViews(region: DrawingRegion, cad: CadRegion | undefined, cadResult: CadResult | undefined): { views: Record<string, ViewLines> | null; busy: boolean; failed?: string } {
  const [state, setState] = useState<{ views: Record<string, ViewLines> | null; busy: boolean; failed?: string }>({ views: null, busy: true });
  const dr = cadResult?.design;
  const v = region.views;
  const specs = useMemo(() => {
    const out: ViewSpecRequest[] = [];
    if (v.front) out.push({ key: 'front', view: 'front', hidden: region.hidden });
    if (v.top) out.push({ key: 'top', view: 'top', hidden: region.hidden });
    if (v.side) out.push({ key: 'side', view: region.projection === 'first' ? 'left' : 'right', hidden: region.hidden });
    if (v.iso) out.push({ key: 'iso', view: 'iso', hidden: false });
    return out;
  }, [v.front, v.top, v.side, v.iso, region.hidden, region.projection]);
  const key = dr?.display;
  useEffect(() => {
    if (!cad || !dr || cadResult?.needsBrep) return;
    let live = true;
    setState((s) => ({ ...s, busy: true }));
    kernelRequest({ op: 'views', design: designOf(cad), numbers: designNumbers(dr), specs }, `views:${region.id}`).then(
      (views) => live && setState({ views, busy: false }),
      (e) => live && !isSuperseded(e) && setState((s) => ({ ...s, busy: false, failed: (e as Error).message })),
    );
    return () => {
      live = false;
    };
  }, [key, specs, region.id, !!cadResult?.needsBrep]); // eslint-disable-line react-hooks/exhaustive-deps
  return state;
}

export function DrawingView({ region, cad, cadResult, selected, dispatch }: Props) {
  const { views: all, busy, failed } = useViews(region, cad, cadResult);
  const svgRef = useRef<SVGSVGElement>(null);
  // views that drew nothing (no bodies) leave the sheet empty
  const views = useMemo(() => (all && Object.values(all).some((x) => x.visible.length) ? all : null), [all]);
  const sheet = useMemo(() => (views ? layout(region, views, cad?.unit ?? 'mm') : null), [region, views, cad?.unit]);

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
    copy.setAttribute('width', `${sheet.W}mm`);
    copy.setAttribute('height', `${sheet.H}mm`);
    return `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(copy)}`;
  };
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
    doc.write(`<!doctype html><html><head><title>${fileName}</title><style>@page{size:${region.sheet} landscape;margin:0}html,body{margin:0}svg{display:block;width:${sheet.W}mm;height:${sheet.H}mm}</style></head><body>${svgText().replace(/^<\?xml[^>]*>/, '')}</body></html>`);
    doc.close();
    setTimeout(() => {
      frame.contentWindow?.focus();
      frame.contentWindow?.print();
      setTimeout(() => frame.remove(), 1000);
    }, 100);
  };

  const status = !cad ? 'The part this drawing belongs to was deleted.' : failed && !views ? `The drawing failed: ${failed}` : !all ? (cadResult?.needsBrep ? 'Loading the 3-D kernel…' : 'Drawing the part…') : !views ? 'The part has no bodies yet.' : null;
  return (
    <div className="drawing-region" style={{ width: region.width }}>
      <div className="dw-sheet" style={{ height: region.height }}>
        {sheet && !status ? <SheetSvg r={region} sheet={sheet} cad={cad} svgRef={svgRef} /> : <div className="dw-empty">{status ?? 'Nothing to draw'}</div>}
        {busy && sheet && <span className="cad-busy">Redrawing…</span>}
      </div>
      {selected && sheet && (
        <div className="dw-tools" onPointerDown={(e) => e.stopPropagation()}>
          <button className="btn" onClick={printSheet} title={`Print or save as PDF on ${region.sheet} landscape, true scale`}><Printer size={13} /> Print {region.sheet}</button>
          <button className="btn" onClick={() => download(svgText(), 'image/svg+xml', 'svg')} title="Vector drawing (opens in Inkscape, Illustrator, browsers)"><Download size={13} /> SVG</button>
          <button className="btn" onClick={() => download(sheetDxf(sheet, region), 'application/dxf', 'dxf')} title="DXF in paper millimetres (layers VISIBLE, HIDDEN, DIM, FRAME)"><FileCode2 size={13} /> DXF</button>
          <span className="dw-scale">Scale {scaleText(sheet.scale)}</span>
        </div>
      )}
      {void dispatch}
    </div>
  );
}

// ------------------------------------------------------------ DXF

function sheetDxf(sheet: Sheet, r: DrawingRegion): string {
  const out: string[] = [];
  const p = (...xs: (string | number)[]) => out.push(...xs.map(String));
  // DXF y goes up: flip the paper
  const Y = (y: number) => +(sheet.H - y).toFixed(4);
  const X = (x: number) => +x.toFixed(4);
  const line = (layer: string, x1: number, y1: number, x2: number, y2: number) => p(0, 'LINE', 8, layer, 10, X(x1), 20, Y(y1), 11, X(x2), 21, Y(y2));
  const text = (layer: string, x: number, y: number, h: number, s: string, rot = 0) => p(0, 'TEXT', 8, layer, 10, X(x), 20, Y(y), 40, h, 1, s, 50, rot);
  p(0, 'SECTION', 2, 'HEADER', 9, '$INSUNITS', 70, 4, 0, 'ENDSEC');
  p(0, 'SECTION', 2, 'TABLES', 0, 'TABLE', 2, 'LTYPE', 70, 2);
  p(0, 'LTYPE', 2, 'CONTINUOUS', 70, 0, 3, 'Solid line', 72, 65, 73, 0, 40, 0);
  p(0, 'LTYPE', 2, 'DASHED', 70, 0, 3, '__ __ __', 72, 65, 73, 2, 40, 4.5, 49, 3, 49, -1.5);
  p(0, 'ENDTAB', 0, 'TABLE', 2, 'LAYER', 70, 4);
  for (const [name, color, lt] of [['VISIBLE', 7, 'CONTINUOUS'], ['HIDDEN', 8, 'DASHED'], ['DIM', 3, 'CONTINUOUS'], ['FRAME', 7, 'CONTINUOUS']] as const) {
    p(0, 'LAYER', 2, name, 70, 0, 62, color, 6, lt);
  }
  p(0, 'ENDTAB', 0, 'ENDSEC', 0, 'SECTION', 2, 'ENTITIES');
  const k = sheet.scale;
  for (const pl of sheet.placed) {
    const put = (segs: number[], layer: string) => {
      for (let i = 0; i < segs.length; i += 4) line(layer, pl.ox + segs[i] * k, pl.oy - segs[i + 1] * k, pl.ox + segs[i + 2] * k, pl.oy - segs[i + 3] * k);
    };
    put(pl.lines.visible, 'VISIBLE');
    if (r.hidden) put(pl.lines.hidden, 'HIDDEN');
  }
  for (const d of sheet.dims) {
    line('DIM', d.x1 + d.ox, d.y1 + d.oy, d.x2 + d.ox, d.y2 + d.oy);
    line('DIM', d.x1, d.y1, d.x1 + d.ox * 1.2, d.y1 + d.oy * 1.2);
    line('DIM', d.x2, d.y2, d.x2 + d.ox * 1.2, d.y2 + d.oy * 1.2);
    const mx = (d.x1 + d.x2) / 2 + d.ox, my = (d.y1 + d.y2) / 2 + d.oy;
    text('DIM', d.vertical ? mx - 0.8 : mx - d.text.length * 0.9, d.vertical ? my + d.text.length * 0.9 : my - 1, 3.5, d.text, d.vertical ? 90 : 0);
  }
  const f = sheet.frame, t = sheet.title;
  for (const [x1, y1, x2, y2] of [[f.x, f.y, f.x + f.w, f.y], [f.x + f.w, f.y, f.x + f.w, f.y + f.h], [f.x + f.w, f.y + f.h, f.x, f.y + f.h], [f.x, f.y + f.h, f.x, f.y], [t.x, t.y, t.x + t.w, t.y], [t.x, t.y, t.x, t.y + t.h]]) line('FRAME', x1, y1, x2, y2);
  text('FRAME', t.x + 2, t.y + 8, 4, r.title?.trim() || 'Part');
  text('FRAME', t.x + 72, t.y + 19, 3, `Scale ${scaleText(k)}`);
  p(0, 'ENDSEC', 0, 'EOF');
  return out.join('\n') + '\n';
}
