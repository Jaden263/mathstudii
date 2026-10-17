// A drawing sheet of a CAD part on the page: the standard views, section and detail views
// with visible, hidden, tangent and centre lines in ISO 128 line types, hatched cut faces,
// dimensions, tolerances, GD&T and symbols, a border, an ISO 7200 title block and the parts
// list. It follows the part: change a dimension in the worksheet and the drawing redraws,
// its dimensions with it. Selected, it has tools to draw a cutting line (a section view) or
// a circle (a detail view) on a view, and to annotate: picks snap to the model's corners,
// edges, circle centres and quadrants with the entity under the pointer highlighted; an
// annotation is selected and dragged on the sheet and edited in the side panel.
import { useEffect, useMemo, useRef, useState, type Dispatch } from 'react';
import { CircleDot, Crosshair, Download, FileCode2, Printer, Ruler, Scissors, StickyNote, TriangleAlert, ZoomIn } from 'lucide-react';
import type { CadRegion, DrawingRegion } from '../../model/types';
import { newId } from '../../model/types';
import type { CadResult } from '../../cad/evaluate';
import type { Action } from '../store';
import { designOf, type CadDesign } from '../../cad/design';
import { designNumbers } from '../../cad/keys';
import { scaleText } from '../../cad/drawing';
import type { DrawView } from '../../cad/drawing2d';
import {
  detailScale, drawingRequests, layerStyle, layoutSheet, nextLetter, primPath, sheetSize, snapPoints, toPaper, toView, unitMm, viewAt,
  type Layer, type PlacedView, type Sheet, type SheetInfo,
} from '../../cad/drawingSheet';
import { sheetDxf } from '../../cad/drawingDxf';
import { bomRows, materialOf, MM, type Annotation, type DrawPick, type XY } from '../../cad/annotations';
import { annotateSheet, annotationAt, annotationParts, autoBalloons, viewPicks, type PlacedAnnotation, type ViewPicks } from '../../cad/drawingAnnotate';
import { autoDimensions } from '../../cad/autoDims';
import { continueDimension, movedAnnotation, newDimension, nextDatumLetter } from '../../cad/annotationTools';
import { anchorOn, cylOutlines, freePick, pickAt, pickOf, type DrawnPart, type PickHit, type ViewEntity } from '../../cad/drawingRefs';
import { isSuperseded, kernelRequest, useBuildResult } from './kernelClient';
import { publishDrawing, selectAnnotation, useDrawingState } from './drawingState';

interface Props {
  region: DrawingRegion;
  cad?: CadRegion;
  cadResult?: CadResult;
  selected: boolean;
  dispatch: Dispatch<Action>;
}

/** Layers drawn bottom up: hatching under the lines, wide lines over the narrow ones. */
const ORDER: Layer[] = ['HATCH', 'THIN', 'TANGENT', 'HIDDEN', 'CENTER', 'DIM', 'TEXT', 'VISIBLE', 'BORDER'];

/** The colour of an annotation that lost its geometry, in the files too (no stylesheet there). */
const WARN = '#d9480f';

interface SvgProps {
  sheet: Sheet;
  svgRef?: React.Ref<SVGSVGElement>;
  children?: React.ReactNode;
  /** Owners drawn only on the screen (a preview), not in the files. */
  draft?: string;
  onPointerDown?: (e: React.PointerEvent<SVGSVGElement>) => void;
  onPointerMove?: (e: React.PointerEvent<SVGSVGElement>) => void;
  onPointerLeave?: () => void;
}

function SheetSvg({ sheet, svgRef, children, draft, onPointerDown, onPointerMove, onPointerLeave }: SvgProps) {
  const { W, H } = sheet;
  const paths = useMemo(() => {
    const by = new Map<string, string[]>();
    for (const ink of sheet.inks) {
      if (draft && ink.owner === draft) continue;
      const k = `${ink.layer}${ink.warn ? '!' : ''}`;
      const l = by.get(k) ?? [];
      l.push(primPath(ink.p, H));
      by.set(k, l);
    }
    return ORDER.flatMap((l) => ['', '!'].filter((w) => by.has(l + w)).map((w) => ({ key: l + w, layer: l, warn: !!w, d: by.get(l + w)!.join(''), ...layerStyle(l, sheet.group) })));
  }, [sheet, H, draft]);
  const fills = useMemo(() => {
    const out = { plain: '', warn: '' };
    for (const f of sheet.fills) {
      if (draft && f.owner === draft) continue;
      let d = '';
      for (let i = 0; i + 1 < f.pts.length; i += 2) d += `${i ? 'L' : 'M'}${f.pts[i].toFixed(3)} ${(H - f.pts[i + 1]).toFixed(3)}`;
      out[f.warn ? 'warn' : 'plain'] += `${d}Z`;
    }
    return out;
  }, [sheet, H, draft]);
  const at = (v: number) => +v.toFixed(3);
  return (
    <svg
      ref={svgRef} xmlns="http://www.w3.org/2000/svg" viewBox={`0 0 ${W} ${H}`} className="dw-svg" fontFamily="Inter, Arial, sans-serif"
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerLeave={onPointerLeave}
    >
      <rect x={0} y={0} width={W} height={H} fill="#fff" />
      {paths.map((p) => (
        <path
          key={p.key} data-layer={p.layer} d={p.d} fill="none" stroke={p.warn ? WARN : '#000'} strokeWidth={p.width}
          strokeDasharray={p.dash.length ? p.dash.map((v) => +v.toFixed(4)).join(' ') : undefined}
          strokeLinecap={p.dash.length ? 'butt' : 'round'} strokeLinejoin="round"
        />
      ))}
      {fills.plain && <path d={fills.plain} fill="#000" stroke="none" />}
      {fills.warn && <path d={fills.warn} fill={WARN} stroke="none" />}
      {sheet.labels.map((l, i) => (draft && l.owner === draft ? null : (
        // ISO 3098 heights are of the capitals: about 0.72 of the font size; annotations set to their laid-out width
        <text
          key={i} x={at(l.x)} y={at(H - l.y)} fontSize={at(l.h / 0.72)} fill={l.warn ? WARN : l.faint ? '#555' : '#000'} fontWeight={l.bold ? 600 : 400}
          textAnchor={l.anchor} transform={l.rot ? `rotate(${-l.rot} ${at(l.x)} ${at(H - l.y)})` : undefined}
          {...(l.w ? { textLength: at(l.w), lengthAdjust: 'spacingAndGlyphs' } : {})}
        >{l.text}</text>
      )))}
      {children}
    </svg>
  );
}

/** One annotation's line work again, on top: the selected one, the one under the pointer, a preview. */
function Overlay({ sheet, owner, className }: { sheet: Sheet; owner: string; className: string }) {
  const H = sheet.H;
  const d = sheet.inks.filter((i) => i.owner === owner).map((i) => primPath(i.p, H)).join('');
  let f = '';
  for (const q of sheet.fills) {
    if (q.owner !== owner) continue;
    for (let i = 0; i + 1 < q.pts.length; i += 2) f += `${i ? 'L' : 'M'}${q.pts[i].toFixed(3)} ${(H - q.pts[i + 1]).toFixed(3)}`;
    f += 'Z';
  }
  const at = (v: number) => +v.toFixed(3);
  return (
    <g className={className}>
      {d && <path d={d} />}
      {f && <path d={f} className="fill" />}
      {sheet.labels.filter((l) => l.owner === owner).map((l, i) => (
        <text
          key={i} x={at(l.x)} y={at(H - l.y)} fontSize={at(l.h / 0.72)} textAnchor={l.anchor}
          transform={l.rot ? `rotate(${-l.rot} ${at(l.x)} ${at(H - l.y)})` : undefined} {...(l.w ? { textLength: at(l.w), lengthAdjust: 'spacingAndGlyphs' } : {})}
        >{l.text}</text>
      ))}
    </g>
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

type ViewTool = 'section' | 'detail';
type AnnotTool = 'dim' | 'note' | 'hole' | 'gdt' | 'datum' | 'surface' | 'centre' | 'balloon';
type Tool = ViewTool | AnnotTool;
const isAnnot = (t: Tool | null): t is AnnotTool => !!t && t !== 'section' && t !== 'detail';

/** Small glyphs for the tools lucide has no icon for: a feature control frame, a datum, a surface symbol, a balloon. */
const glyph = (d: string, extra?: React.ReactNode) => (
  <svg width={13} height={13} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d={d} />
    {extra}
  </svg>
);
const GdtIcon = () => glyph('M1 4h14v8H1zM6 4v8M3 8h1.6M10.5 8h2', null);
const DatumIcon = () => glyph('M4 2h8v7H4zM8 9v3', <path d="M5.5 15h5L8 12z" fill="currentColor" />);
const SurfaceIcon = () => glyph('M1 9l3 5 6-12h5');
const BalloonIcon = () => glyph('M2 15l4-4', <><circle cx={10} cy={6} r={5} /><path d="M9.5 4l1-1v6" /></>);

const ANNOT_TOOLS: { tool: AnnotTool; label: string; icon: React.ReactNode; title: string }[] = [
  { tool: 'dim', label: 'Dimension', icon: <Ruler size={13} />, title: 'Dimension: pick a circle, a line, or two points, edges or lines; click again to place the text (D)' },
  { tool: 'note', label: 'Note', icon: <StickyNote size={13} />, title: 'Note: pick an edge for its leader (or click where the note goes); type the text in the side panel' },
  { tool: 'hole', label: 'Hole', icon: <CircleDot size={13} />, title: 'Hole callout from the hole feature: pick a hole, then place the text' },
  { tool: 'gdt', label: 'GD&T', icon: <GdtIcon />, title: 'Feature control frame (ISO 1101): pick an edge or a dimension, then place the frame' },
  { tool: 'datum', label: 'Datum', icon: <DatumIcon />, title: 'Datum feature symbol (ISO 5459): pick an edge or a dimension, then place the letter' },
  { tool: 'surface', label: 'Surface', icon: <SurfaceIcon />, title: 'Surface texture (ISO 1302 / ISO 21920-1): pick a surface edge, then place the symbol on it or on a leader' },
  { tool: 'centre', label: 'Centre', icon: <Crosshair size={13} />, title: 'Centre mark: click a circle or arc to add one, or an automatic one to take it away (click again to bring it back)' },
  { tool: 'balloon', label: 'Balloon', icon: <BalloonIcon />, title: 'Balloon with the parts list item: pick a part, then place the balloon' },
];

const HINTS: Record<AnnotTool, [string, string]> = {
  dim: ['Pick a circle, a line, or a point or edge (Esc cancels)', 'Pick a second point or edge, or click to place the text'],
  note: ['Pick an edge for the leader, or click where the note goes', 'Click where the note goes'],
  hole: ['Pick a hole (its circle or its outline)', 'Click where the callout goes'],
  gdt: ['Pick an edge or a dimension, or click where the frame goes', 'Click where the frame goes'],
  datum: ['Pick the datum edge or a dimension', 'Click where the letter goes'],
  surface: ['Pick the surface (its edge)', 'Click on the edge, or away from it for a leader'],
  centre: ['Click a circle or arc', ''],
  balloon: ['Pick a part', 'Click where the balloon goes'],
};

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

/** Which entities a tool takes. */
function accepts(tool: AnnotTool, e: ViewEntity): boolean {
  const s = e.shape.k;
  switch (tool) {
    case 'hole':
      return !!e.hole && (s === 'circle' || s === 'cyl');
    case 'centre':
      return s === 'circle';
    case 'datum':
    case 'surface':
      return s !== 'point';
    default:
      return true;
  }
}

/** What an annotation tool is part way through: the view and what was picked (or the dimension it goes on). */
interface ADraft {
  view: string;
  picks: DrawPick[];
  dim?: string;
}

/** A dimension chain or baseline being continued: its first and last dimensions. */
interface Chain {
  first: Annotation & { kind: 'dim' };
  prev: Annotation & { kind: 'dim' };
}

const EMPTY: CadDesign = { version: 2, components: [], occurrences: [], joints: [] };

export function DrawingView({ region, cad, cadResult, selected, dispatch }: Props) {
  const { views: all, busy, failed } = useDrawing(region, cad, cadResult);
  const design = useMemo(() => (cad ? designOf(cad) : EMPTY), [cad]);
  const shownBuild = useBuildResult(region.id, design, cadResult);
  const parts = useMemo<DrawnPart[] | null>(() => annotationParts(shownBuild.build, cad ? design : undefined), [shownBuild.build, design, cad]);
  const { selected: picked } = useDrawingState(region.id);
  const svgRef = useRef<SVGSVGElement>(null);
  const [tool, setTool] = useState<Tool | null>(null);
  const [draft, setDraft] = useState<{ view: PlacedView; a: [number, number]; b: [number, number] } | null>(null);
  const [drag, setDrag] = useState<{ key: string; at: { x: number; y: number } } | null>(null);
  const [adraft, setADraft] = useState<ADraft | null>(null);
  const [hover, setHover] = useState<{ view: string; hit: PickHit | null; free?: XY; ann?: string; at: XY } | null>(null);
  const [mode, setMode] = useState<'single' | 'chain' | 'baseline'>('single');
  const [chain, setChain] = useState<Chain | null>(null);
  const [adrag, setADrag] = useState<{ id: string; d: XY } | null>(null);
  // views that drew nothing (no bodies) leave the sheet empty
  const views = useMemo(() => (all && Object.values(all).some((x) => x.visible.length) ? all : null), [all]);
  const annotations = useMemo(() => region.annotations ?? [], [region.annotations]);
  const unit = cad?.unit ?? 'mm';

  // the parts list: each component once with how often it occurs, its material and mass
  const bom = useMemo(() => {
    const masses = Object.fromEntries(Object.entries(cadResult?.design?.components ?? {}).map(([k, v]) => [k, v?.m]));
    return bomRows(design, { masses, density: cad?.density, rows: region.bom?.rows });
  }, [design, cadResult?.design?.components, cad?.density, region.bom?.rows]);
  const assembly = design.occurrences.filter((o) => !o.hidden).length > 1;

  // a view or an annotation being dragged sits where the pointer has it until it is dropped
  const placedRef = useRef<PlacedAnnotation[]>([]);
  const shown = useMemo<DrawingRegion>(() => {
    let r = region;
    if (drag) {
      const id = drag.key.slice(4);
      r = drag.key.startsWith('sec:')
        ? { ...r, sections: r.sections?.map((s) => (s.id === id ? { ...s, at: drag.at } : s)) }
        : { ...r, details: r.details?.map((d) => (d.id === id ? { ...d, at: drag.at } : d)) };
    }
    if (adrag) {
      const p = placedRef.current.find((q) => q.id === adrag.id);
      r = { ...r, annotations: annotations.map((a) => (a.id === adrag.id ? movedAnnotation(a, adrag.d, p?.pos, p?.now) : a)) };
    }
    return r;
  }, [region, drag, adrag, annotations]);

  const info = useMemo<SheetInfo>(() => {
    const name = cad?.design?.components[0]?.name || cad?.name || 'Part';
    const comps = design.components.filter((c) => design.occurrences.some((o) => o.component === c.id && !o.hidden));
    const material = comps.length === 1 ? materialOf(comps[0].density?.trim() ? comps[0].density : cad?.density) : '';
    return { unit, name, date: new Date().toISOString().slice(0, 10), mass: cadResult?.mass?.m, material, bom, assembly, overall: !parts };
  }, [cad?.design, cad?.name, cad?.density, design, unit, cadResult?.mass?.m, bom, assembly, parts]);

  // the annotation being made, drawn as it would be (a preview, not in the files)
  const preview = useMemo<Annotation | null>(() => {
    if (!isAnnot(tool) || !hover || !views) return null;
    return draftAnnotation(tool, adraft, hover, region, 'draft', unit);
  }, [tool, adraft, hover, views, region, unit]);

  const result = useMemo(() => {
    if (!views) return null;
    const sheet = layoutSheet(shown, views, info);
    if (!sheet) return null;
    const auto = shown.dims && parts ? autoDimensions(shown, sheet, parts) : [];
    const placed = annotateSheet(sheet, shown, { unit, parts, design, params: cadResult?.design?.params, bom }, [...auto, ...(preview ? [preview] : [])]);
    return { sheet, placed, auto };
  }, [shown, views, info, parts, unit, design, cadResult?.design?.params, bom, preview]);
  const sheet = result?.sheet ?? null;
  if (result) placedRef.current = result.placed;
  const meshes = views ? Object.values(views).map((v) => v.mesh).filter(Boolean) : [];
  const mesh = meshes.includes('all') ? 'all' : meshes.length ? 'some' : null;
  const lost = result?.placed.filter((p) => p.lost && p.id !== 'draft' && !p.auto) ?? [];

  // the side panel reads what the annotations came to
  useEffect(() => {
    if (!result) return;
    publishDrawing(region.id, {
      unit, placed: result.placed.filter((p) => p.id !== 'draft'), bom, auto: result.auto, topology: !!parts, assembly,
      ...(parts ? { balloons: (view: string) => autoBalloons(region, result.sheet, parts, bom, view, newId) } : {}),
      views: result.sheet.views.map((v) => ({ key: v.key, name: v.key.startsWith('sec:') ? `${v.view.name}` : v.key.startsWith('det:') ? `detail ${region.details?.find((d) => `det:${d.id}` === v.key)?.letter ?? ''}` : v.key })),
    });
  }, [result, region, unit, bom, parts, assembly]);

  useEffect(() => {
    if (selected) return;
    setTool(null);
    setDraft(null);
    setADraft(null);
    setChain(null);
    setHover(null);
  }, [selected]);

  const set = (patch: Partial<DrawingRegion>) => dispatch({ type: 'update', id: region.id, patch });
  const addAnnotation = (a: Annotation, edit = false) => {
    set({ annotations: [...annotations, a] });
    selectAnnotation(region.id, a.id, edit);
  };
  const cancel = () => {
    setDraft(null);
    setADraft(null);
    setChain(null);
  };
  const chooseTool = (t: Tool | null) => {
    setTool(t);
    cancel();
    setHover(null);
  };

  // Escape steps back, Delete takes the selected annotation away (before the worksheet deletes the region)
  useEffect(() => {
    if (!selected) return;
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (e.key === 'Escape' && (tool || picked)) {
        e.stopPropagation();
        if (draft || adraft || chain) cancel();
        else if (tool) chooseTool(null);
        else selectAnnotation(region.id, null);
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && picked && annotations.some((a) => a.id === picked)) {
        e.stopPropagation();
        e.preventDefault();
        set({ annotations: annotations.filter((a) => a.id !== picked && !(a.kind === 'gdt' && a.dim === picked) && !(a.kind === 'datum' && a.dim === picked)) });
        selectAnnotation(region.id, null);
      }
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }); // eslint-disable-line react-hooks/exhaustive-deps

  /** What the pointer is over for an annotation tool: a model entity (or a point of the line work), or a dimension. */
  const hoverAt = (x: number, y: number, t: AnnotTool) => {
    if (!sheet) return null;
    const pv = adraft ? sheet.views.find((v) => v.key === adraft.view) : viewAt(sheet, x, y, 6);
    if (!pv) return null;
    const at = toView(pv, x, y) as XY;
    const ann = (t === 'gdt' || t === 'datum') && !adraft ? annotationAt(sheet, x, y, 1.2) : null;
    const dim = ann && annotations.find((a) => a.id === ann && a.kind === 'dim') ? ann : undefined;
    const vp: ViewPicks | null = viewPicks(region, pv, parts);
    let hit: PickHit | null = null, free: XY | undefined;
    if (vp && !dim) {
      hit = pickAt(vp.ents, at[0], at[1], 2 / pv.k, 1.2 / pv.k, { accept: (e) => accepts(t, e) });
      // a point of the line work that is no model entity (a dimension only): flagged should it move
      if (!hit && t === 'dim') {
        let bd = 1.6 / pv.k;
        for (const s of vp.snaps) {
          const d = Math.hypot(s[0] - at[0], s[1] - at[1]);
          if (d < bd) [free, bd] = [s, d];
        }
      }
    }
    return { pv, at, hit, free, dim };
  };

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!selected || !sheet || e.button !== 0) return;
    const [x, y] = sheetPoint(e.currentTarget, sheet.H, e);
    const pv = viewAt(sheet, x, y);
    if (tool === 'section' || tool === 'detail') {
      e.stopPropagation();
      e.preventDefault();
      if (!draft) {
        // sections cut the standard views; details enlarge any view but another detail
        if (!pv || (tool === 'section' ? !['front', 'top', 'side'].includes(pv.key) : pv.kind === 'detail')) return;
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
        set({ details: [...(region.details ?? []), { id: newId(), letter, view: view.key, c: { x: A[0], y: A[1] }, r, scale: detailScale(view.k / unitMm(unit)) }] });
      }
      setDraft(null);
      setTool(null);
      return;
    }
    if (isAnnot(tool)) {
      e.stopPropagation();
      e.preventDefault();
      if (!parts) return;
      const h = hoverAt(x, y, tool);
      if (!h) return;
      const pick = h.hit ? pickOf(h.hit, parts) : h.free ? freePick(...h.free) : null;
      clickTool(tool, h.pv, h.at, pick, h.dim);
      return;
    }
    // an annotation: select it, and drag it unless the automatic dimensioning placed it
    const ann = annotationAt(sheet, x, y);
    if (ann && ann !== 'draft') {
      e.stopPropagation();
      e.preventDefault();
      selectAnnotation(region.id, ann);
      const a = annotations.find((q) => q.id === ann);
      const p = result?.placed.find((q) => q.id === ann);
      const pvA = p && sheet.views.find((v) => v.key === p.view);
      if (!a || !pvA || a.kind === 'centre') return;
      const svg = e.currentTarget, H = sheet.H, start = [x, y];
      let d: XY = [0, 0];
      const move = (ev: PointerEvent) => {
        const [mx, my] = sheetPoint(svg, H, ev);
        d = [(mx - start[0]) / pvA.k, (my - start[1]) / pvA.k];
        setADrag({ id: ann, d });
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        setADrag(null);
        if (Math.hypot(d[0], d[1]) * pvA.k < 0.3) return;
        set({ annotations: annotations.map((q) => (q.id === ann ? movedAnnotation(q, d, p.pos, p.now) : q)) });
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      return;
    }
    if (picked) selectAnnotation(region.id, null);
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

  /** A click of an annotation tool: a pick, or the place that finishes the annotation. */
  const clickTool = (t: AnnotTool, pv: PlacedView, at: XY, pick: DrawPick | null, dim?: string) => {
    if (t === 'dim') {
      if (chain) {
        // the next of a chain or baseline: each pick makes one
        if (!pick) return;
        const n = continueDimension(newId(), mode === 'baseline' ? 'baseline' : 'chain', chain.first, chain.prev, pick, 8 / pv.k);
        if (n) {
          addAnnotation(n);
          setChain({ first: chain.first, prev: n });
        }
        return;
      }
      if (!adraft) {
        if (pick) setADraft({ view: pv.key, picks: [pick] });
        return;
      }
      const first = adraft.picks[0];
      if (pick && adraft.picks.length < 2 && !samePick(first, pick)) {
        setADraft({ ...adraft, picks: [...adraft.picks, pick] });
        return;
      }
      const d = newDimension(newId(), adraft.view, adraft.picks, at);
      setADraft(null);
      if (!d) return;
      addAnnotation(d);
      if (mode !== 'single' && d.type === 'linear' && d.b) setChain({ first: d, prev: d });
      return;
    }
    if (t === 'centre') {
      if (!pick || pick.shape.k !== 'circle') return;
      const s = pick.shape;
      const near = (q: XY) => Math.hypot(q[0] - s.cx, q[1] - s.cy) < 1e-6 * Math.max(1, s.r);
      const hidden = annotations.find((a) => a.kind === 'centre' && a.hide && a.view === pv.key && a.a.shape.k === 'circle' && near([a.a.shape.cx, a.a.shape.cy]));
      if (hidden) {
        set({ annotations: annotations.filter((a) => a !== hidden) });
        return;
      }
      const auto = region.noCentres?.includes(pv.key) ? undefined : pv.view.axes.find((m) => m.kind === 'mark' && near([m.x, m.y]));
      addAnnotation({ id: newId(), kind: 'centre', view: pv.key, a: pick, ...(auto ? { hide: true } : {}) });
      return;
    }
    if (!adraft) {
      // the first click picks what the annotation points at (or, for some, places it at once)
      if (t === 'gdt' && dim) {
        addAnnotation(draftAnnotation('gdt', { view: pv.key, picks: [], dim }, { view: pv.key, hit: null, at }, region, newId(), unit)!);
        return;
      }
      if (t === 'datum' && dim) {
        setADraft({ view: pv.key, picks: [], dim });
        return;
      }
      if (pick && pick.snap !== 'free') {
        setADraft({ view: pv.key, picks: [pick] });
        return;
      }
      if (t === 'note' || t === 'gdt') addAnnotation(draftAnnotation(t, { view: pv.key, picks: [] }, { view: pv.key, hit: null, at }, region, newId(), unit)!, t === 'note');
      return;
    }
    const a = draftAnnotation(t, adraft, { view: adraft.view, hit: null, at }, region, newId(), unit, pv.k);
    setADraft(null);
    if (a) addAnnotation(a, a.kind === 'note');
  };

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!sheet) return;
    const [x, y] = sheetPoint(e.currentTarget, sheet.H, e);
    if (isAnnot(tool)) {
      const h = hoverAt(x, y, tool);
      setHover(h ? { view: h.pv.key, hit: h.hit, free: h.free, ann: h.dim, at: h.at } : null);
      return;
    }
    if (!tool || !draft) return;
    let b = snapIn(draft.view, x, y);
    if (tool === 'section') {
      // within 5° of the paper's axes: straight across or up, a snapped end too (the plane
      // follows the line's direction, and an end caught on a corner would tilt it)
      const dx = b[0] - draft.a[0], dy = b[1] - draft.a[1], t = Math.tan(Math.PI / 36);
      if (Math.abs(dy) < t * Math.abs(dx)) b = [b[0], draft.a[1]];
      else if (Math.abs(dx) < t * Math.abs(dy)) b = [draft.a[0], b[1]];
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

  const status = !cad ? 'The part this drawing belongs to was deleted.' : failed && !views ? `The drawing failed: ${failed}` : !all ? (cadResult?.needsBrep ? 'Loading the 3-D kernel…' : 'Drawing the part…') : !views ? (Object.values(region.views).some(Boolean) ? 'The part has no bodies yet.' : 'Switch on a view in the side panel.') : null;
  const orient = region.portrait ? 'portrait' : 'landscape';
  const hint = tool === 'section' ? (draft ? 'Click the other end of the cutting line (Esc cancels)' : 'Click on the front, top or side view where the cutting line starts')
    : tool === 'detail' ? (draft ? 'Click to set the size of the circle (Esc cancels)' : 'Click the centre of the detail on a view')
    : isAnnot(tool) ? (!parts ? 'Waiting for the model’s edges…' : chain ? `Pick the next point of the ${mode} (Esc ends)` : HINTS[tool][adraft ? 1 : 0]) : null;
  const hoverPv = hover && sheet?.views.find((v) => v.key === hover.view);
  return (
    <div className="drawing-region" style={{ width: region.width }}>
      <div className={`dw-sheet${tool ? ' dw-picking' : ''}`} style={{ height: region.height }}>
        {sheet && !status ? (
          <SheetSvg sheet={sheet} svgRef={svgRef} draft="draft" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerLeave={() => setHover(null)}>
            <g data-ui="">
              {selected && sheet.views.map((v) => (
                <rect
                  key={v.key} data-view={v.key} className={v.kind !== 'base' && !tool ? 'dw-movable' : 'dw-view'}
                  x={v.box.x0 - 2} y={sheet.H - v.box.y1 - 2} width={v.box.x1 - v.box.x0 + 4} height={v.box.y1 - v.box.y0 + 4}
                >
                  {v.kind !== 'base' && <title>Drag to move the view</title>}
                </rect>
              ))}
              {selected && picked && <Overlay sheet={sheet} owner={picked} className="dw-hl" />}
              {preview && <Overlay sheet={sheet} owner="draft" className="dw-hl dw-preview" />}
              {hover?.ann && <Overlay sheet={sheet} owner={hover.ann} className="dw-hl" />}
              {adraft && sheet.views.filter((v) => v.key === adraft.view).flatMap((v) => adraft.picks.map((p, i) => <PickMark key={i} pv={v} H={sheet.H} shape={p.shape} snap={p.snap} done />))}
              {hoverPv && hover?.hit && <PickMark pv={hoverPv} H={sheet.H} shape={hover.hit.e.shape} snap={hover.hit.snap} at={[hover.hit.x, hover.hit.y]} />}
              {hoverPv && hover?.free && <PickMark pv={hoverPv} H={sheet.H} shape={{ k: 'point', x: hover.free[0], y: hover.free[1] }} snap="free" />}
              {draft && tool === 'section' && <line className="dw-draft" x1={draft.a[0]} y1={sheet.H - draft.a[1]} x2={draft.b[0]} y2={sheet.H - draft.b[1]} />}
              {draft && tool === 'detail' && <circle className="dw-draft" cx={draft.a[0]} cy={sheet.H - draft.a[1]} r={Math.hypot(draft.b[0] - draft.a[0], draft.b[1] - draft.a[1])} />}
            </g>
          </SheetSvg>
        ) : <div className="dw-empty">{status ?? 'Nothing to draw'}</div>}
        {busy && sheet && <span className="cad-busy">Redrawing…</span>}
        {hint && <span className="dw-hint">{hint}</span>}
      </div>
      {selected && sheet && (
        <>
          <div className="dw-tools" onPointerDown={(e) => e.stopPropagation()}>
            <button className={`btn${tool === 'section' ? ' on' : ''}`} onClick={() => chooseTool(tool === 'section' ? null : 'section')} title="Section view: draw a cutting line across the front, top or side view"><Scissors size={13} /> Section</button>
            <button className={`btn${tool === 'detail' ? ' on' : ''}`} onClick={() => chooseTool(tool === 'detail' ? null : 'detail')} title="Detail view: draw a circle on a view to enlarge"><ZoomIn size={13} /> Detail</button>
            <button className="btn" onClick={printSheet} title={`Print or save as PDF on ${region.sheet} ${orient}, true scale`}><Printer size={13} /> Print {region.sheet}</button>
            <button className="btn" onClick={() => download(svgText(), 'image/svg+xml', 'svg')} title="Vector drawing in millimetres (opens in Inkscape, Illustrator, browsers)"><Download size={13} /> SVG</button>
            <button className="btn" onClick={() => download(sheetDxf(sheet), 'application/dxf', 'dxf')} title="DXF R2000 in paper millimetres: true circles, arcs and ellipses on layers VISIBLE, HIDDEN, CENTER, TANGENT, THIN, HATCH, DIM, TEXT, BORDER with ISO lineweights"><FileCode2 size={13} /> DXF</button>
            <span className="dw-scale" title={`${region.sheet} ${orient}, ${W} × ${H} mm`}>
              {mesh && <span title={mesh === 'all' ? 'OpenCascade is not loaded: the lines come from the display mesh' : 'Coils and modeled threads are drawn from their mesh'}>{mesh === 'all' ? 'mesh lines' : 'partly mesh'} · </span>}
              {region.sheet}{region.portrait ? ' portrait' : ''} · {scaleText(sheet.scale)}
            </span>
          </div>
          <div className="dw-tools dw-annot" onPointerDown={(e) => e.stopPropagation()}>
            {ANNOT_TOOLS.map((t) => (
              <button key={t.tool} className={`btn${tool === t.tool ? ' on' : ''}`} onClick={() => chooseTool(tool === t.tool ? null : t.tool)} title={t.title} disabled={!parts}>{t.icon} {t.label}</button>
            ))}
            {tool === 'dim' && (
              <span className="dw-seg" role="group" aria-label="Dimension mode">
                {(['single', 'chain', 'baseline'] as const).map((m) => (
                  <button key={m} className={`btn${mode === m ? ' on' : ''}`} onClick={() => { setMode(m); setChain(null); }} title={m === 'single' ? 'One dimension at a time' : m === 'chain' ? 'Chain: each next point is dimensioned from the last' : 'Baseline: every next point from the first, each a row further out'}>
                    {m === 'single' ? 'Single' : m === 'chain' ? 'Chain' : 'Baseline'}
                  </button>
                ))}
              </span>
            )}
            {lost.length > 0 && (
              <span className="dw-lost" title={lost.map((p) => `${p.text ?? p.kind}: ${p.lost}`).join('\n')}>
                <TriangleAlert size={13} /> {lost.length} lost
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** Whether two picks are the same entity and snap. */
const samePick = (p: DrawPick, q: DrawPick) => p.snap === q.snap && p.occ === q.occ && p.ref?.key === q.ref?.key && p.ref?.body === q.ref?.body && JSON.stringify(p.shape) === JSON.stringify(q.shape);

/** The entity under the pointer highlighted, with a marker of the snap: a square at a corner, a circle at a centre, a triangle at a middle, a diamond at a quadrant. */
function PickMark({ pv, H, shape, snap, at, done }: { pv: PlacedView; H: number; shape: DrawPick['shape']; snap: string; at?: XY; done?: boolean }) {
  const P = (x: number, y: number) => {
    const [px, py] = toPaper(pv, x, y);
    return [px, H - py] as const;
  };
  const cls = done ? 'dw-pick dw-picked' : 'dw-pick';
  let curve: React.ReactNode = null;
  if (shape.k === 'line') {
    const [x1, y1] = P(shape.x1, shape.y1), [x2, y2] = P(shape.x2, shape.y2);
    curve = <line x1={x1} y1={y1} x2={x2} y2={y2} />;
  } else if (shape.k === 'circle') {
    const [cx, cy] = P(shape.cx, shape.cy);
    const r = shape.r * pv.k;
    curve = shape.a1 - shape.a0 >= 2 * Math.PI - 1e-9 ? <circle cx={cx} cy={cy} r={r} /> : <path d={primPath({ k: 'arc', cx: cx, cy: H - cy, r, a0: shape.a0, a1: shape.a1 }, H)} />;
  } else if (shape.k === 'cyl') {
    curve = cylOutlines(shape).map(([ax, ay, bx, by], i) => {
      const [x1, y1] = P(ax, ay), [x2, y2] = P(bx, by);
      return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} />;
    });
  }
  // the marker where the snap is (a curve's: where the pointer is on it)
  const point = shape.k === 'point' ? [shape.x, shape.y] as XY : at && ['line', 'circle', 'cyl'].includes(snap) ? anchorOn(shape, at).at : at;
  let marker: React.ReactNode = null;
  if (point) {
    const [x, y] = P(...point), s = 1.3;
    if (snap === 'centre') marker = <><circle cx={x} cy={y} r={s} /><path d={`M${x - s * 1.6} ${y}H${x + s * 1.6}M${x} ${y - s * 1.6}V${y + s * 1.6}`} /></>;
    else if (snap === 'mid') marker = <path d={`M${x} ${y - s * 1.2}L${x + s * 1.1} ${y + s * 0.8}L${x - s * 1.1} ${y + s * 0.8}Z`} />;
    else if (/^q\d$/.test(snap)) marker = <path d={`M${x} ${y - s * 1.3}L${x + s * 1.3} ${y}L${x} ${y + s * 1.3}L${x - s * 1.3} ${y}Z`} />;
    else if (snap === 'vertex' || snap.startsWith('cut') || snap === 'free') marker = <rect x={x - s} y={y - s} width={2 * s} height={2 * s} className={snap === 'free' ? 'free' : undefined} />;
  }
  return <g className={cls}>{curve}{marker}</g>;
}

/**
 * The annotation a tool makes from what was picked and the place clicked (or, with id
 * 'draft', the preview of it under the pointer): a dimension, note, hole callout, frame,
 * datum, surface symbol or balloon, with sensible first values to edit in the side panel.
 */
function draftAnnotation(tool: AnnotTool, d: ADraft | null, hover: { view: string; hit: PickHit | null; free?: XY; at: XY }, r: DrawingRegion, id: string, unit: string, k?: number): Annotation | null {
  const view = d?.view ?? hover.view, at = hover.at;
  const p = d?.picks[0];
  const tol = 0.05 / (MM[unit] ?? 1);
  switch (tool) {
    case 'dim':
      return d && d.picks.length ? newDimension(id, view, d.picks, at) : null;
    case 'note':
      return d ? { id, kind: 'note', view, text: 'Note', at, ...(p ? { leader: p } : {}) } : null;
    case 'hole':
      return p ? { id, kind: 'hole', view, a: p, at } : null;
    case 'gdt': {
      if (!d) return null;
      const round = p && (p.shape.k === 'circle' || p.shape.k === 'cyl');
      const onDim = d.dim ? r.annotations?.find((a) => a.id === d.dim) : undefined;
      const sized = onDim?.kind === 'dim' && (onDim.type === 'diameter' || onDim.type === 'radius');
      return {
        id, kind: 'gdt', view, char: round || sized ? 'position' : 'flatness', tol, ...(round || sized ? { dia: true } : {}), at,
        ...(d.dim ? { dim: d.dim } : p ? { leader: p } : {}),
      };
    }
    case 'datum': {
      if (!d || (!p && !d.dim)) return null;
      const onDim = d.dim ? r.annotations?.find((a) => a.id === d.dim) : undefined;
      const leader = p ?? (onDim?.kind === 'dim' ? onDim.a : null);
      return leader ? { id, kind: 'datum', view, letter: nextDatumLetter(r.annotations), at, leader, ...(d.dim ? { dim: d.dim } : {}) } : null;
    }
    case 'surface': {
      if (!p) return null;
      // clicked on (or within 2 mm of) the surface: the symbol stands on it
      const foot = anchorOn(p.shape, at).at;
      const on = k !== undefined ? Math.hypot(foot[0] - at[0], foot[1] - at[1]) * k < 2 : false;
      return { id, kind: 'surface', view, param: 'Ra', value: 3.2, process: 'removal', at: on ? foot : at, leader: p };
    }
    case 'balloon':
      return p && p.occ ? { id, kind: 'balloon', view, occ: p.occ, a: p, at } : null;
    case 'centre':
      return null;
  }
}

/** The page the print path writes: the sheet at its true size on a page of the sheet's size. */
export function printPage(title: string, region: DrawingRegion, svg: string): string {
  const [W, H] = sheetSize(region);
  return `<!doctype html><html><head><title>${title}</title><style>@page{size:${W}mm ${H}mm;margin:0}html,body{margin:0}svg{display:block;width:${W}mm;height:${H}mm}</style></head><body>${svg.replace(/^<\?xml[^>]*>/, '')}</body></html>`;
}
