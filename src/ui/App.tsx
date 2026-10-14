import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import {
  FilePlus2, FolderOpen, Save, Printer, Undo2, Redo2, Sigma, Type, LineChart, Table2, Image as ImageIcon,
  ListChecks, PencilRuler, Box, Play, Square, ZoomIn, ZoomOut, MoveHorizontal, Sun, Moon, Monitor, PanelRight, BookOpen, Keyboard, Grid3x3,
  AlignVerticalSpaceAround, Loader2, AlertTriangle, CheckCircle2, ChevronDown,
} from 'lucide-react';
import { createRegion, emptyWorksheet, parseWorksheet, GRID, PAGE_MARGIN, PAGE_WIDTH, PX_PER_MM, type Region, type RegionKind, type Worksheet as WS } from '../model/types';
import { EXAMPLES, welcomeWorksheet } from '../model/examples';
import { useWorksheetStore } from './store';
import { useEvaluation } from './useEvaluation';
import { Worksheet, snap, type Cursor } from './Worksheet';
import { SidePanel, type SideTab } from './SidePanel';
import type { EditorHandle } from './editing';
import { openWorksheetFile, foreignFormat, saveWorksheetFile, loadAutosave, writeAutosave, loadPref, savePref, pickFile, readAsDataURL, isTauri, type FileHandle } from '../platform/files';
import { ShortcutsDialog } from './ShortcutsDialog';
import { usePageZoom } from './usePageZoom';
import { ImportReportDialog, type ImportReport } from './ImportReportDialog';
import { CompletionContext, worksheetCompletions } from './autocomplete';
import { SketchContext, INITIAL_SKETCH_UI, type SketchUI } from './sketch/context';
import { CadOpenContext, openCadWindow, openChannel, SESSION, type CadChannel } from './cad/cadWindow';
import { CadWorkspace } from './cad/CadWorkspace';
import type { CadResult } from '../engine/evaluator';

type ThemePref = 'system' | 'light' | 'dark';
const CLIP_MARKER = 'mathstudii/regions';

function initialWorksheet(): WS {
  const saved = loadAutosave();
  if (saved) {
    try {
      return parseWorksheet(saved);
    } catch {
      /* corrupted autosave: start fresh */
    }
  }
  return welcomeWorksheet();
}

function isTypingTarget(el: EventTarget | null): boolean {
  const t = el as HTMLElement | null;
  if (!t) return false;
  return t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable;
}

export function App() {
  const { ws, dispatch, canUndo, canRedo, dirty } = useWorksheetStore(initialWorksheet);
  // CAD parts are edited in a separate window (or full-screen in the page on small screens)
  const [cadOverlay, setCadOverlay] = useState<string | null>(null);
  const cadOverlayRef = useRef(cadOverlay);
  cadOverlayRef.current = cadOverlay;
  const cadWins = useRef(new Map<string, { seen: number; ack: number }>());
  const cadChannel = useRef<CadChannel | null>(null);
  const pushCad = useRef<(id: string) => void>(() => {});
  const evaluation = useEvaluation(ws, ws.settings.autoCalc);
  pushCad.current = (id: string) => {
    const ch = cadChannel.current;
    if (!ch) return;
    const r = ws.regions.find((q) => q.id === id);
    if (!r || r.kind !== 'cad') {
      ch.post({ t: 'gone', s: SESSION, id });
      cadWins.current.delete(id);
      return;
    }
    ch.post({ t: 'state', s: SESSION, id, ack: cadWins.current.get(id)?.ack ?? 0, region: r, result: evaluation.results.get(id) as CadResult | undefined });
  };
  useEffect(() => {
    const ch = openChannel((m) => {
      if (m.s !== SESSION) return;
      const wins = cadWins.current;
      if (m.t === 'hello') {
        wins.set(m.id, { seen: Date.now(), ack: wins.get(m.id)?.ack ?? m.seq });
        pushCad.current(m.id);
      } else if (m.t === 'patch') {
        wins.set(m.id, { seen: Date.now(), ack: m.seq });
        dispatch({ type: 'update', id: m.id, patch: m.patch, coalesce: m.coalesce, ...(m.history === false ? { history: false as const } : {}) });
      } else if (m.t === 'bye') wins.delete(m.id);
    });
    cadChannel.current = ch;
    return () => ch.close();
  }, [dispatch]);
  // every change reaches the open CAD windows
  useEffect(() => {
    const now = Date.now();
    for (const [id, w] of cadWins.current) {
      if (now - w.seen > 10000) cadWins.current.delete(id);
      else pushCad.current(id);
    }
  }, [ws, evaluation.results]);
  const openCad = useCallback((id: string) => {
    const r = ws.regions.find((q) => q.id === id);
    const title = `${(r && r.kind === 'cad' && r.name) || 'Part'} — mathstudii CAD`;
    void openCadWindow(id, title).then((ok) => {
      if (!ok) setCadOverlay(id);
    });
  }, [ws.regions]);
  const overlayRegion = cadOverlay ? ws.regions.find((q) => q.id === cadOverlay) : undefined;
  useEffect(() => {
    if (cadOverlay && overlayRegion?.kind !== 'cad') setCadOverlay(null);
  }, [cadOverlay, overlayRegion]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [cursor, setCursor] = useState<Cursor | null>({ x: PAGE_MARGIN + GRID * 2, y: GRID * 6 });
  const firstRun = useRef(loadPref<number | null>('zoom', null) === null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const { zoom, zoomTo, step: zoomStep } = usePageZoom(scrollerRef, '.sheet-scroller-inner');
  const [theme, setTheme] = useState<ThemePref>(() => loadPref('theme', 'system'));
  const [panelOpen, setPanelOpen] = useState<boolean>(() => loadPref('panel', typeof window !== 'undefined' ? window.innerWidth > 900 : true));
  const [tab, setTab] = useState<SideTab>('math');
  const [showGrid, setShowGrid] = useState<boolean>(() => loadPref('grid', false));
  const [fileHandle, setFileHandle] = useState<FileHandle>(null);
  const [showHelp, setShowHelp] = useState(false);
  const [examplesOpen, setExamplesOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [sketchUI, setSketchUI] = useState<SketchUI>(INITIAL_SKETCH_UI);
  const [importReport, setImportReport] = useState<ImportReport | null>(null);
  const separateRef = useRef<(quiet?: boolean, coalesce?: string) => void>(() => {});
  const [dropping, setDropping] = useState(false);
  const editorRef = useRef<EditorHandle | null>(null);
  const clipboard = useRef<Region[]>([]);

  const registerEditor = useCallback((h: EditorHandle | null) => {
    editorRef.current = h;
  }, []);

  // ------------------------------------------------------------ preferences
  useEffect(() => {
    const el = document.documentElement;
    if (theme === 'system') el.removeAttribute('data-theme');
    else el.setAttribute('data-theme', theme);
    savePref('theme', theme);
  }, [theme]);
  useEffect(() => savePref('panel', panelOpen), [panelOpen]);
  useEffect(() => savePref('grid', showGrid), [showGrid]);
  useEffect(() => {
    const t = window.setTimeout(() => writeAutosave(JSON.stringify(ws)), 600);
    return () => window.clearTimeout(t);
  }, [ws]);
  useEffect(() => {
    document.title = `${dirty ? '• ' : ''}${ws.title} — mathstudii`;
  }, [ws.title, dirty]);
  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 2600);
    return () => window.clearTimeout(t);
  }, [toast]);

  // ------------------------------------------------------------ editing helpers
  /** Height of the region as displayed (not while its editor is open). */
  const regionHeight = (id: string) => {
    const el = document.querySelector<HTMLElement>(`[data-region-id="${id}"]`);
    if (!el) return 24;
    const disp = el.querySelector<HTMLElement>('.math-display');
    const err = el.querySelector<HTMLElement>('.region-error');
    return disp ? disp.offsetHeight + (err?.offsetHeight ?? 0) + 8 : el.offsetHeight;
  };

  const finishEditing = useCallback((id: string, moveBelow: boolean) => {
    const r = ws.regions.find((q) => q.id === id);
    setEditingId((cur) => (cur === id ? null : cur));
    if (!r) return;
    const empty = (r.kind === 'math' && !r.source.trim()) || (r.kind === 'text' && !r.markdown.trim());
    if (empty) {
      dispatch({ type: 'delete', ids: [id] });
      setSelected(new Set());
    }
    if (moveBelow) {
      setSelected(new Set());
      setCursor({ x: r.x, y: snap(r.y + (empty ? 0 : regionHeight(id)) + GRID * 2) });
    }
  }, [ws.regions, dispatch]);

  const addRegion = useCallback((kind: RegionKind, init: Partial<Region> = {}, at?: Cursor) => {
    const pos = at ?? cursor ?? { x: PAGE_MARGIN, y: snap((scrollerRef.current?.scrollTop ?? 0) / zoom + 80) };
    const r = createRegion(kind, pos.x, pos.y, init);
    // keep wide regions on the page
    const w = 'width' in r ? r.width : 0;
    if (w && r.x + w > PAGE_WIDTH - PAGE_MARGIN / 2) r.x = snap(Math.max(PAGE_MARGIN / 2, PAGE_WIDTH - PAGE_MARGIN / 2 - w));
    dispatch({ type: 'add', regions: [r] });
    setSelected(new Set([r.id]));
    if (kind === 'math' || kind === 'text' || kind === 'solve' || kind === 'table' || kind === 'sketch' || kind === 'cad') setEditingId(r.id);
    else {
      setEditingId(null);
      setTab('properties');
      setPanelOpen(true);
    }
    if (kind === 'sketch') {
      setTab('properties');
      setSketchUI({ ...INITIAL_SKETCH_UI, regionId: r.id, tool: 'line' });
    }
    if (kind === 'cad') {
      setTab('properties');
      setSketchUI({ ...INITIAL_SKETCH_UI, regionId: r.id, cadTool: 'line' });
    }
    setCursor(null);
    return r;
  }, [cursor, dispatch, zoom]);

  const insertText = useCallback((text: string) => {
    if (editorRef.current) {
      editorRef.current.insert(text);
      return;
    }
    const clean = text.replace('|', '');
    addRegion('math', { source: clean.trimStart() });
  }, [addRegion]);

  // ------------------------------------------------------------ files
  const confirmDiscard = () => !dirty || window.confirm('Discard unsaved changes?');

  const newDoc = () => {
    if (!confirmDiscard()) return;
    dispatch({ type: 'load', ws: emptyWorksheet() });
    setFileHandle(null);
    setSelected(new Set());
    setEditingId(null);
    setCursor({ x: PAGE_MARGIN + GRID * 2, y: GRID * 6 });
  };

  const loadDoc = (doc: WS, handle: FileHandle = null) => {
    dispatch({ type: 'load', ws: doc });
    setFileHandle(handle);
    setSelected(new Set());
    setEditingId(null);
    scrollerRef.current?.scrollTo({ top: 0 });
  };

  const openDoc = async () => {
    if (!confirmDiscard()) return;
    try {
      const f = await openWorksheetFile();
      if (!f) return;
      if (foreignFormat(f.name)) {
        await importForeignFile(f.bytes, f.name);
        return;
      }
      const doc = parseWorksheet(new TextDecoder().decode(f.bytes));
      if (doc.title === 'Untitled') doc.title = f.name.replace(/\.(mstd|json)$/i, '');
      loadDoc(doc, f.handle);
    } catch (e) {
      window.alert(`Could not open the file: ${(e as Error).message}`);
    }
  };

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDropping(false);
    const f = e.dataTransfer.files[0];
    if (!f) return;
    try {
      if (f.type.startsWith('image/')) {
        addRegion('image', { src: await readAsDataURL(f) });
        return;
      }
      if (!confirmDiscard()) return;
      const bytes = new Uint8Array(await f.arrayBuffer());
      if (foreignFormat(f.name)) await importForeignFile(bytes, f.name);
      else {
        const doc = parseWorksheet(new TextDecoder().decode(bytes));
        if (doc.title === 'Untitled') doc.title = f.name.replace(/\.(mstd|json)$/i, '');
        loadDoc(doc, null);
      }
    } catch (err) {
      window.alert(`Could not open ${f.name}: ${(err as Error).message}`);
    }
  };

  /** Convert a Mathcad or SMath file; it opens as a new, unsaved mathstudii worksheet. */
  const importForeignFile = async (bytes: Uint8Array, name: string) => {
    const res = foreignFormat(name) === 'smath'
      ? (await import('../importers/smath')).importSmath(bytes, name)
      : (await import('../importers/mathcad')).importMathcad(bytes, name);
    loadDoc(res.ws, null);
    setImportReport({ name, format: res.format, warnings: res.warnings, count: res.ws.regions.length });
    // the source program lays out math at different sizes: push overlaps apart once rendered
    window.setTimeout(() => separateRef.current(true), 400);
  };

  const saveDoc = async (saveAs = false) => {
    try {
      const res = await saveWorksheetFile(JSON.stringify(ws, null, 1), ws.title || 'worksheet', fileHandle, saveAs);
      if (!res) return;
      setFileHandle(res.handle);
      dispatch({ type: 'markSaved' });
      setToast(`Saved ${res.name}`);
    } catch (e) {
      window.alert(`Could not save: ${(e as Error).message}`);
    }
  };

  const insertImage = async () => {
    const f = await pickFile('image/*');
    if (!f) return;
    const src = await readAsDataURL(f);
    addRegion('image', { src });
  };

  /** @param coalesce merge the moves into this undo step (e.g. the resize that caused them) */
  const separateRegions = (quiet = false, coalesce = 'separate') => {
    // push overlapping regions down, in reading order
    const boxes = ws.regions
      .map((r) => {
        const el = document.querySelector<HTMLElement>(`[data-region-id="${r.id}"]`);
        return { r, w: el?.offsetWidth ?? 40, h: el?.offsetHeight ?? 24, y: r.y };
      })
      .sort((a, b) => a.y - b.y || a.r.x - b.r.x);
    const placed: typeof boxes = [];
    let moved = 0;
    for (const b of boxes) {
      let y = b.y;
      let changed = true;
      while (changed) {
        changed = false;
        for (const p of placed) {
          if (b.r.x < p.r.x + p.w && b.r.x + b.w > p.r.x && y < p.y + p.h && y + b.h > p.y) {
            y = snap(p.y + p.h + GRID);
            changed = true;
          }
        }
      }
      if (y !== b.y) {
        dispatch({ type: 'move', ids: [b.r.id], dx: 0, dy: y - b.y, coalesce });
        moved++;
      }
      placed.push({ ...b, y });
    }
    if (moved || !quiet) setToast(moved ? `Moved ${moved} region${moved > 1 ? 's' : ''}` : 'No overlapping regions');
  };

  separateRef.current = separateRegions;

  const fitWidth = () => {
    const sc = scrollerRef.current;
    const w = sc?.clientWidth ?? PAGE_WIDTH;
    const pad = window.innerWidth <= 900 ? 24 : 48; // scroller padding on both sides
    zoomTo(Math.min(2, (w - pad) / PAGE_WIDTH));
    sc?.scrollTo({ left: 0 });
  };

  // ------------------------------------------------------------ clipboard
  const copySelection = useCallback(async (cut: boolean) => {
    const regs = ws.regions.filter((r) => selected.has(r.id));
    if (!regs.length) return;
    clipboard.current = regs;
    try {
      await navigator.clipboard?.writeText(JSON.stringify({ [CLIP_MARKER]: regs }));
    } catch {
      /* clipboard permission denied: in-app clipboard still works */
    }
    if (cut) {
      dispatch({ type: 'delete', ids: regs.map((r) => r.id) });
      setSelected(new Set());
    }
  }, [ws.regions, selected, dispatch]);

  const pasteRegions = useCallback((regs: Region[]) => {
    if (!regs.length) return;
    const minX = Math.min(...regs.map((r) => r.x));
    const minY = Math.min(...regs.map((r) => r.y));
    const base = cursor ?? { x: minX + GRID * 2, y: minY + GRID * 2 };
    const copies = regs.map((r) => ({ ...r, id: createRegion('math', 0, 0).id, x: base.x + (r.x - minX), y: base.y + (r.y - minY) })) as Region[];
    dispatch({ type: 'add', regions: copies });
    setSelected(new Set(copies.map((r) => r.id)));
    setCursor(null);
  }, [cursor, dispatch]);

  useEffect(() => {
    const onPaste = async (e: ClipboardEvent) => {
      if (isTypingTarget(e.target)) return;
      const dt = e.clipboardData;
      if (!dt) return;
      const img = [...dt.files].find((f) => f.type.startsWith('image/'));
      if (img) {
        e.preventDefault();
        addRegion('image', { src: await readAsDataURL(img) });
        return;
      }
      const text = dt.getData('text/plain');
      if (!text) return;
      e.preventDefault();
      try {
        const data = JSON.parse(text);
        if (data && Array.isArray(data[CLIP_MARKER])) return pasteRegions(data[CLIP_MARKER]);
      } catch {
        /* plain text */
      }
      if (text.includes('\n') && /[a-z]{4,}\s+[a-z]{3,}/i.test(text) && !/[:=]/.test(text)) addRegion('text', { markdown: text });
      else addRegion('math', { source: text.trim() });
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [addRegion, pasteRegions]);

  // ------------------------------------------------------------ keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // the full-screen CAD workspace handles its own keys
      if (cadOverlayRef.current) return;
      const mod = e.ctrlKey || e.metaKey;
      const typing = isTypingTarget(e.target);
      const k = e.key.toLowerCase();
      if (mod && k === 's') { e.preventDefault(); void saveDoc(e.shiftKey); return; }
      if (mod && k === 'o') { e.preventDefault(); void openDoc(); return; }
      if (mod && k === 'p') { e.preventDefault(); window.print(); return; }
      if (mod && e.altKey && k === 'n') { e.preventDefault(); newDoc(); return; }
      if (e.key === 'F9') { e.preventDefault(); evaluation.calculate(); return; }
      if (e.key === 'Escape' && evaluation.slow) { evaluation.interrupt(); return; }
      if (e.key === 'F1' || (mod && e.key === '/')) { e.preventDefault(); setShowHelp(true); return; }
      if (mod && (k === '=' || k === '+')) { e.preventDefault(); zoomStep(1); return; }
      if (mod && k === '-') { e.preventDefault(); zoomStep(-1); return; }
      if (mod && k === '0') { e.preventDefault(); zoomTo(1); return; }
      if (typing) {
        // undo/redo inside a region editor operates on the worksheet history
        if (mod && k === 'z' && editingId) { e.preventDefault(); dispatch({ type: e.shiftKey ? 'redo' : 'undo' }); }
        else if (mod && k === 'y' && editingId) { e.preventDefault(); dispatch({ type: 'redo' }); }
        return;
      }
      if (mod && k === 'z') { e.preventDefault(); dispatch({ type: e.shiftKey ? 'redo' : 'undo' }); return; }
      if (mod && k === 'y') { e.preventDefault(); dispatch({ type: 'redo' }); return; }
      if (mod && k === 'a') { e.preventDefault(); setSelected(new Set(ws.regions.map((r) => r.id))); setCursor(null); return; }
      if (mod && (k === 'c' || k === 'x')) { if (selected.size) { e.preventDefault(); void copySelection(k === 'x'); } return; }
      if (mod && k === 'd' && selected.size) { e.preventDefault(); pasteRegions(ws.regions.filter((r) => selected.has(r.id))); return; }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selected.size) {
        e.preventDefault();
        dispatch({ type: 'delete', ids: [...selected] });
        setSelected(new Set());
        return;
      }
      if (e.key === 'Escape') { setSelected(new Set()); return; }
      if (e.key === 'Enter' && selected.size === 1) {
        e.preventDefault();
        const r = ws.regions.find((q) => selected.has(q.id));
        if (r && ['math', 'text', 'solve', 'table'].includes(r.kind)) setEditingId(r.id);
        return;
      }
      if (e.key.startsWith('Arrow')) {
        const step = e.shiftKey ? GRID * 4 : GRID;
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
        e.preventDefault();
        if (selected.size) dispatch({ type: 'move', ids: [...selected], dx, dy, coalesce: 'nudge' });
        else setCursor((c) => ({ x: Math.max(0, (c?.x ?? PAGE_MARGIN) + dx), y: Math.max(0, (c?.y ?? GRID * 6) + dy) }));
        return;
      }
      if (!mod && !e.altKey && e.key.length === 1 && cursor) {
        e.preventDefault();
        // render synchronously and focus now, so fast typing never loses the next keys
        let r: Region | undefined;
        flushSync(() => {
          if (e.key === '"') r = addRegion('text', {}, cursor);
          else if (e.key === '@') r = addRegion('plot', {}, cursor);
          else if (e.key === '#') r = addRegion('sketch', {}, cursor);
          else if (e.key === '&') r = addRegion('cad', {}, cursor);
          else r = addRegion('math', { source: e.key }, cursor);
        });
        const ta = r && document.querySelector<HTMLTextAreaElement>(`[data-region-id="${r.id}"] textarea`);
        if (ta) {
          ta.focus({ preventScroll: true });
          ta.setSelectionRange(ta.value.length, ta.value.length);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // files opened from the OS with the installed web app (PWA file handler)
  useEffect(() => {
    const lq = (window as unknown as { launchQueue?: { setConsumer(cb: (p: { files: FileSystemFileHandle[] }) => void): void } }).launchQueue;
    lq?.setConsumer(async ({ files }) => {
      const h = files[0];
      if (!h) return;
      try {
        const f = await h.getFile();
        const doc = parseWorksheet(await f.text());
        loadDoc(doc, h);
      } catch (e) {
        window.alert(`Could not open the file: ${(e as Error).message}`);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // first run on a small screen: fit the page to the width
  useEffect(() => {
    if (firstRun.current && window.innerWidth < PAGE_WIDTH + 80) fitWidth();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);


  const selection = useMemo(() => ws.regions.filter((r) => selected.has(r.id)), [ws.regions, selected]);
  const completions = useMemo(() => worksheetCompletions(ws.regions), [ws.regions]);
  const wsRef = useRef(ws);
  wsRef.current = ws;
  const sketchCtx = useMemo(() => ({
    ui: sketchUI,
    setUi: (patch: Partial<SketchUI>) => setSketchUI((u) => ({ ...u, ...patch })),
    getWorksheet: () => wsRef.current,
    showProperties: () => { setTab('properties'); setPanelOpen(true); },
    separate: (coalesce?: string) => window.setTimeout(() => separateRef.current(true, coalesce), 50),
  }), [sketchUI]);
  const s = ws.settings;
  const cursorMm = cursor ? `${(cursor.x / PX_PER_MM).toFixed(0)}, ${(cursor.y / PX_PER_MM).toFixed(0)} mm` : '';

  return (
    <CompletionContext.Provider value={completions}>
    <SketchContext.Provider value={sketchCtx}>
    <CadOpenContext.Provider value={openCad}>
    <div className={`app${panelOpen ? ' panel-open' : ''}`}>
      <header className="topbar">
        <div className="brand" aria-label="mathstudii">
          <span className="logo" aria-hidden>∑</span>
          <span className="brand-name">mathstudii</span>
        </div>
        <input
          className="doc-title"
          value={ws.title}
          onChange={(e) => dispatch({ type: 'title', title: e.target.value, coalesce: 'title' })}
          aria-label="Worksheet title"
          spellCheck={false}
        />
        {dirty && <span className="dirty-dot" title="Unsaved changes" />}
        <div className="spacer" />
        <div className="tb-group">
          <button className="icon-btn" onClick={newDoc} title="New (Ctrl+Alt+N)" aria-label="New worksheet"><FilePlus2 size={18} /></button>
          <button className="icon-btn" onClick={openDoc} title="Open (Ctrl+O)" aria-label="Open"><FolderOpen size={18} /></button>
          <button className="icon-btn" onClick={() => saveDoc(false)} title="Save (Ctrl+S, Ctrl+Shift+S = Save as)" aria-label="Save"><Save size={18} /></button>
          <button className="icon-btn" onClick={() => window.print()} title="Print / export PDF (Ctrl+P)" aria-label="Print or export PDF"><Printer size={18} /></button>
          <div className="menu-wrap">
            <button className="text-btn" onClick={() => setExamplesOpen((o) => !o)} aria-expanded={examplesOpen} aria-haspopup="menu"><BookOpen size={16} /> <span className="label">Examples</span> <ChevronDown size={14} /></button>
            {examplesOpen && (
              <div className="menu" role="menu" onMouseLeave={() => setExamplesOpen(false)}>
                {EXAMPLES.map((ex) => (
                  <button key={ex.name} role="menuitem" onClick={() => { setExamplesOpen(false); if (confirmDiscard()) loadDoc(ex.make()); }}>{ex.name}</button>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className="tb-group">
          <button className="icon-btn" onClick={() => setTheme(theme === 'system' ? 'dark' : theme === 'dark' ? 'light' : 'system')} title={`Theme: ${theme}`} aria-label={`Theme: ${theme}`}>
            {theme === 'system' ? <Monitor size={18} /> : theme === 'dark' ? <Moon size={18} /> : <Sun size={18} />}
          </button>
          <button className="icon-btn" onClick={() => setShowHelp(true)} title="Keyboard shortcuts (F1)" aria-label="Keyboard shortcuts"><Keyboard size={18} /></button>
          <button className={`icon-btn${panelOpen ? ' on' : ''}`} onClick={() => setPanelOpen(!panelOpen)} title="Toggle side panel" aria-label="Toggle side panel"><PanelRight size={18} /></button>
        </div>
      </header>

      <nav className="toolbar" aria-label="Worksheet tools">
        <div className="tb-group">
          <button className="icon-btn" onClick={() => dispatch({ type: 'undo' })} disabled={!canUndo} title="Undo (Ctrl+Z)" aria-label="Undo"><Undo2 size={17} /></button>
          <button className="icon-btn" onClick={() => dispatch({ type: 'redo' })} disabled={!canRedo} title="Redo (Ctrl+Y)" aria-label="Redo"><Redo2 size={17} /></button>
        </div>
        <div className="tb-group" aria-label="Insert">
          <button className="text-btn" onClick={() => addRegion('math')} title="Math region (or just start typing)"><Sigma size={16} /> Math</button>
          <button className="text-btn" onClick={() => addRegion('text')} title='Text region (type " at the cursor)'><Type size={16} /> Text</button>
          <button className="text-btn" onClick={() => addRegion('plot')} title="Plot (type @ at the cursor)"><LineChart size={16} /> Plot</button>
          <button className="text-btn" onClick={() => addRegion('sketch')} title="Drawing: sketches, cross-sections, mechanisms (type # at the cursor)"><PencilRuler size={16} /> Sketch</button>
          <button className="text-btn" onClick={() => addRegion('cad')} title="Parametric CAD part: constrained sketch, dimensions from the worksheet, extrude/revolve, mass properties (type & at the cursor)"><Box size={16} /> CAD</button>
          <button className="text-btn" onClick={() => addRegion('solve')} title="Solve block"><ListChecks size={16} /> Solve</button>
          <button className="text-btn" onClick={() => addRegion('table')} title="Data table"><Table2 size={16} /> Table</button>
          <button className="text-btn" onClick={insertImage} title="Image (or paste one)"><ImageIcon size={16} /> Image</button>
        </div>
        <div className="tb-group" aria-label="Calculation">
          <label className="check compact" title="Recalculate automatically">
            <input type="checkbox" checked={s.autoCalc} onChange={(e) => dispatch({ type: 'settings', patch: { autoCalc: e.target.checked } })} /> Auto
          </label>
          {evaluation.slow ? (
            <button className="text-btn warn" onClick={evaluation.interrupt} title="Interrupt calculation (Esc)"><Square size={15} /> Stop</button>
          ) : (
            <button className="text-btn" onClick={evaluation.calculate} title="Calculate now (F9)"><Play size={15} /> Calc</button>
          )}
        </div>
        <div className="tb-group" aria-label="Format">
          <label className="select-label" title="Displayed decimal places">
            Decimals
            <select value={s.precision} onChange={(e) => dispatch({ type: 'settings', patch: { precision: Number(e.target.value) } })}>
              {[0, 1, 2, 3, 4, 5, 6, 8, 10, 12, 15].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          <label className="select-label" title="Exponential threshold: numbers ≥ 10^n use scientific notation">
            Exp ≥
            <select value={s.expThreshold} onChange={(e) => dispatch({ type: 'settings', patch: { expThreshold: Number(e.target.value) } })}>
              {[3, 4, 5, 6, 8, 10, 12, 15].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          <label className="select-label" title="Index of the first array element (ORIGIN)">
            ORIGIN
            <select value={s.origin} onChange={(e) => dispatch({ type: 'settings', patch: { origin: Number(e.target.value) as 0 | 1 } })}>
              <option value={0}>0</option>
              <option value={1}>1</option>
            </select>
          </label>
          <label className="select-label" title="Unit system for derived result units">
            Units
            <select value={s.unitSystem} onChange={(e) => dispatch({ type: 'settings', patch: { unitSystem: e.target.value as WS['settings']['unitSystem'] } })}>
              <option value="si">SI</option>
              <option value="us">US</option>
              <option value="cgs">CGS</option>
            </select>
          </label>
          {s.lateBinding !== undefined && (
            <label className="check compact" title="Functions read variables when they are called, including ones defined after the function (SMath behaviour). Off: values are captured where the function is defined (Mathcad behaviour).">
              <input type="checkbox" checked={s.lateBinding} onChange={(e) => dispatch({ type: 'settings', patch: { lateBinding: e.target.checked } })} /> Late binding
            </label>
          )}
          <button className="icon-btn" onClick={() => separateRegions()} title="Separate overlapping regions" aria-label="Separate overlapping regions"><AlignVerticalSpaceAround size={17} /></button>
          <button className={`icon-btn${showGrid ? ' on' : ''}`} onClick={() => setShowGrid(!showGrid)} title="Show grid" aria-label="Show grid"><Grid3x3 size={17} /></button>
        </div>
        <div className="tb-group" aria-label="Zoom">
          <button className="icon-btn" onClick={() => zoomStep(-1)} aria-label="Zoom out" title="Zoom out (Ctrl+−)"><ZoomOut size={17} /></button>
          <button className="zoom-label" onClick={() => zoomTo(1)} title="Reset to 100% (Ctrl+0)">{Math.round(zoom * 100)}%</button>
          <button className="icon-btn" onClick={() => zoomStep(1)} aria-label="Zoom in" title="Zoom in (Ctrl+=)"><ZoomIn size={17} /></button>
          <button className="icon-btn" onClick={fitWidth} aria-label="Fit page width" title="Fit page width"><MoveHorizontal size={17} /></button>
        </div>
      </nav>

      <main
        className="workspace"
        onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDropping(true); } }}
        onDragLeave={(e) => { if (e.currentTarget === e.target) setDropping(false); }}
        onDrop={onDrop}
      >
        {dropping && <div className="drop-hint">Drop a worksheet (.mstd, Mathcad .mcdx / .xmcd, SMath .sm / .smz) or an image</div>}
        <div className="sheet-scroller" ref={scrollerRef}>
          <Worksheet
            ws={ws}
            results={evaluation.results}
            dispatch={dispatch}
            zoom={zoom}
            selected={selected}
            setSelected={(sel) => { setSelected(sel); if (sel.size === 1) { const r = ws.regions.find((q) => sel.has(q.id)); if (r && (r.kind === 'plot' || r.kind === 'image' || r.kind === 'sketch' || r.kind === 'cad')) setTab('properties'); } }}
            editingId={editingId}
            setEditingId={setEditingId}
            cursor={cursor}
            setCursor={setCursor}
            registerEditor={registerEditor}
            finishEditing={finishEditing}
            showGrid={showGrid}
          />
        </div>
        {panelOpen && (
          <SidePanel tab={tab} setTab={setTab} insert={insertText} selection={selection} results={evaluation.results} dispatch={dispatch} onClose={() => setPanelOpen(false)} />
        )}
      </main>

      <footer className="statusbar" role="status">
        {evaluation.busy ? (
          <span className="status-item"><Loader2 size={13} className="spin" /> Calculating…</span>
        ) : evaluation.interrupted ? (
          <span className="status-item warn"><AlertTriangle size={13} /> Calculation interrupted — press F9 to recalculate</span>
        ) : evaluation.errorCount ? (
          <span className="status-item warn"><AlertTriangle size={13} /> {evaluation.errorCount} region{evaluation.errorCount > 1 ? 's' : ''} with errors</span>
        ) : (
          <span className="status-item ok"><CheckCircle2 size={13} /> Calculated in {evaluation.millis.toFixed(0)} ms</span>
        )}
        <span className="spacer" />
        {!s.autoCalc && <span className="status-item">Auto calculation off</span>}
        {cursorMm && <span className="status-item">{cursorMm}</span>}
        <span className="status-item">{ws.regions.length} regions</span>
        <span className="status-item">{isTauri ? 'Desktop' : 'Web'}</span>
      </footer>

      {showHelp && <ShortcutsDialog onClose={() => setShowHelp(false)} />}
      {overlayRegion?.kind === 'cad' && (
        <div className="cadw-overlay" role="dialog" aria-label="CAD workspace">
          <CadWorkspace
            region={overlayRegion} result={evaluation.results.get(overlayRegion.id) as CadResult | undefined} dispatch={dispatch}
            onClose={() => setCadOverlay(null)}
          />
        </div>
      )}
      {importReport && <ImportReportDialog report={importReport} onClose={() => setImportReport(null)} />}
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
    </CadOpenContext.Provider>
    </SketchContext.Provider>
    </CompletionContext.Provider>
  );
}
