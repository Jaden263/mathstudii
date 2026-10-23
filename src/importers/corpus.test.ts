// Corpus harness: imports every Mathcad Prime (.mcdx), Mathcad 11–15 (.xmcd) and SMath (.sm, .smz)
// file in a folder, recalculates it, compares the results with the ones the program saved in the
// file and writes a report. The files themselves stay outside the repository (most public
// worksheets do not allow copying them here). Skipped unless CORPUS_DIR is set:
//
//   CORPUS_DIR=/path/to/files CORPUS_OUT=/path/to/report-tag npx vitest run src/importers/corpus.test.ts
//
// CORPUS_OUT is a path prefix: <prefix>.json (every file, every saved result, every warning) and
// <prefix>.txt (totals per format, one line per file, the most common causes). CORPUS_FILTER is a
// regular expression on the file name to run a few files only; CORPUS_JOBS the number of processes.
//
// What it records, per file:
//   - what the file holds, read here independently of the importers: region kinds, results the
//     program saved (values, its own errors, plot traces), formatting and features
//   - what the import made of it: region kinds, warnings, constructs it could not convert
//   - every saved result: agree / differ (ours and theirs, with units) / not evaluated (our error),
//     saved results the importer did not keep, and why when a warning says so
//   - layout: regions not at their place, calculation order changed against the program's,
//     overlaps (with region sizes estimated from their content, as no layout engine runs here)
import { describe, it, expect, beforeAll } from 'vitest';
import { readdirSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, statSync, existsSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { availableParallelism, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { unzipSync, gunzipSync, decompressSync, strFromU8 } from 'fflate';
import { DOMParser, type Element as XElement, type Node as XNode } from '@xmldom/xmldom';
import { pageBreakShift } from './pages';
import { importMathcad } from './mathcad';
import { importSmath } from './smath';
import { compareSaved } from './saved';
import { sanitize, type ImportResult } from './common';
import { compileExpr } from '../engine/compile';
import { ChainScope } from '../engine/scope';
import { evaluateWithScope, type PlotResult, type RegionResult } from '../engine/evaluator';
import { loadCas } from '../engine/symbolic';
import { evaluationOrder } from '../model/areas';
import type { Region } from '../model/types';
import { separateKeepingOrder, type Box } from '../ui/separateOrdered';

const DIR = process.env.CORPUS_DIR ?? '';
const OUT = process.env.CORPUS_OUT ?? '';
const FILTER = process.env.CORPUS_FILTER ? new RegExp(process.env.CORPUS_FILTER, 'i') : null;

type El = XElement;
type Fmt = 'mcdx' | 'xmcd' | 'sm';

const local = (n: XNode): string => (n as El).localName || n.nodeName.replace(/^.*:/, '');
const elements = (n: XNode): El[] => {
  const out: El[] = [];
  for (let c = n.firstChild; c; c = c.nextSibling) if (c.nodeType === 1) out.push(c as El);
  return out;
};
const child = (n: XNode, name: string) => elements(n).find((c) => local(c) === name);
const descendants = (n: XNode, name: string): El[] => {
  const out: El[] = [];
  const walk = (e: XNode) => {
    for (const c of elements(e)) {
      if (local(c) === name) out.push(c);
      walk(c);
    }
  };
  walk(n);
  return out;
};
const num = (e: El, a: string) => Number(e.getAttribute(a) ?? NaN);
const parse = (xml: string) => new DOMParser({ onError: () => {} }).parseFromString(xml.replace(/^\uFEFF/, ''), 'text/xml');
const bump = (m: Record<string, number>, k: string, n = 1) => {
  if (n) m[k] = (m[k] ?? 0) + n;
};

// ------------------------------------------------------------ what the file holds

interface SavedTrace {
  xs: number[];
  ys: number[];
}

/** A region as the source program placed it (px, 96 dpi), with what it saved. */
interface SrcRegion {
  kind: string;
  /** math: the top element (define, eval …) or the input control; plot: its type. */
  sub?: string;
  x: number;
  /** Top as the program has it. */
  y: number;
  /** Other tops the import may use for it: Mathcad 15 math by its baseline, area offsets. */
  alt: number[];
  /** Calculation order key (the program's rule). */
  order: number;
  w: number;
  h: number;
  inArea: boolean;
  saved?: 'value' | 'error' | 'symbolic' | 'implicit';
  savedText?: string;
  /** An implicit (not shown) result that is one number, e.g. 1 for a check that holds. */
  savedScalar?: number;
  traces?: SavedTrace[];
  /** Names a math region (or a solve block) defines on the worksheet, as the import spells them. */
  defines?: string[];
}

interface Inventory {
  regions: SrcRegion[];
  /** Formatting and features the file uses (counts), for the fidelity gaps. */
  features: Record<string, number>;
  settings: Record<string, string>;
}

const text = (e: El | undefined) => (e?.textContent ?? '').replace(/\s+/g, ' ').trim();

/** An <ml:id> as Mathcad shows it: Prime's subscript spans and Mathcad 15's subscript attribute become _. */
function rawName(el: El): string {
  let s = '';
  const walk = (n: XNode) => {
    for (let c = n.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3) s += c.nodeValue ?? '';
      else if (c.nodeType === 1) {
        if (/subscript$/i.test(local(c))) s += '_';
        walk(c);
      }
    }
  };
  walk(el);
  s = s.trim();
  const sub = el.getAttribute('subscript');
  return sub ? `${s}_${sub}` : s;
}

const PROVENANCE = /^(originRef|parentRef|comment|originComment|contentHash|hash)$/;
/** The worksheet names the definitions in a Mathcad math element (or a solve block) define. */
function mathDefines(m: El): string[] {
  const out: string[] = [];
  const target = (t: El | undefined) => {
    if (!t) return;
    const k = local(t);
    if (k === 'id') out.push(sanitize(rawName(t)));
    else if (k === 'function') target(child(t, 'id'));
    else if (k === 'matrix') elements(t).forEach(target);
    else if (k === 'apply' && local(elements(t)[0] ?? t) === 'indexer') target(elements(t)[1]);
  };
  const visit = (e: El) => {
    for (const c of elements(e)) {
      const k = local(c);
      if (k === 'provenance') visit(c);
      else if (k === 'define' || k === 'globalDefine') target(elements(c).find((x) => !PROVENANCE.test(local(x))));
      else if (k === 'regions' || k === 'region' || k === 'math') visit(c);
    }
  };
  visit(m);
  return out;
}

function primeInventory(bytes: Uint8Array): Inventory {
  const files = unzipSync(bytes);
  const get = (p: string) => {
    const k = Object.keys(files).find((f) => f.toLowerCase() === p);
    return k ? files[k] : undefined;
  };
  const doc = parse(strFromU8(get('mathcad/worksheet.xml') ?? new Uint8Array()));
  const results = new Map<string, El>();
  const rx = get('mathcad/result.xml');
  if (rx) for (const rd of descendants(parse(strFromU8(rx)), 'resultData')) results.set(rd.getAttribute('result-id') ?? '', rd);
  const rels: Record<string, string> = {};
  const relsXml = get('mathcad/_rels/worksheet.xml.rels');
  if (relsXml) for (const r of descendants(parse(strFromU8(relsXml)), 'Relationship')) rels[r.getAttribute('Id') ?? ''] = (r.getAttribute('Target') ?? '').replace(/^\//, '');
  const features: Record<string, number> = {};
  const settings: Record<string, string> = {};
  const regions: SrcRegion[] = [];

  const xamlFeatures = (idref: string | null) => {
    const target = idref ? rels[idref] : undefined;
    const path = target ? (target.startsWith('mathcad/') ? target : `mathcad/${target}`).toLowerCase() : '';
    const pkg = path ? get(path) : undefined;
    if (!pkg) return;
    let xaml = '';
    try {
      const inner = unzipSync(pkg);
      const k = Object.keys(inner).find((f) => /document\.xaml$/i.test(f));
      xaml = k ? strFromU8(inner[k]) : '';
    } catch {
      return;
    }
    const d = parse(xaml);
    const all = descendants(d, 'Run').concat(descendants(d, 'Span'), descendants(d, 'Paragraph'));
    for (const e of all) {
      if (e.getAttribute('FontWeight') === 'Bold' || local(e) === 'Bold') bump(features, 'text.bold');
      if (e.getAttribute('FontStyle') === 'Italic') bump(features, 'text.italic');
      if (/Underline/.test(e.getAttribute('TextDecorations') ?? '')) bump(features, 'text.underline');
      if (/Strikethrough/.test(e.getAttribute('TextDecorations') ?? '')) bump(features, 'text.strikethrough');
      const fg = e.getAttribute('Foreground');
      if (fg && !/^#FF000000$/i.test(fg)) bump(features, 'text.color');
      const bg = e.getAttribute('Background');
      if (bg && !/^#00/i.test(bg) && !/^#FFFFFFFF$/i.test(bg)) bump(features, 'text.highlight');
      if (e.getAttribute('FontSize')) bump(features, 'text.fontSize');
      if (e.getAttribute('FontFamily')) bump(features, 'text.fontFamily');
      if (/^(Center|Right|Justify)$/.test(e.getAttribute('TextAlignment') ?? '')) bump(features, 'text.align');
      if (e.getAttribute('BaselineAlignment') === 'Subscript' || e.getAttribute('Typography.Variants') === 'Subscript') bump(features, 'text.sub');
      if (e.getAttribute('BaselineAlignment') === 'Superscript' || e.getAttribute('Typography.Variants') === 'Superscript') bump(features, 'text.sup');
    }
    bump(features, 'text.bold', descendants(d, 'Bold').length);
    bump(features, 'text.italic', descendants(d, 'Italic').length);
    bump(features, 'text.underline', descendants(d, 'Underline').length);
    bump(features, 'text.list', descendants(d, 'List').length);
    bump(features, 'text.table', descendants(d, 'Table').length);
    bump(features, 'text.link', descendants(d, 'Hyperlink').length);
    bump(features, 'text.inlineObject', descendants(d, 'InlineUIContainer').length + descendants(d, 'BlockUIContainer').length);
  };

  // a collapsed area calculates its regions where it is, before what follows it (which the file
  // places with the area collapsed): their order is the area's, then their own within it
  const walk = (container: El, dx: number, dy: number, inArea: boolean, hidden: { order: number; scale: number } | null = null) => {
    for (const r of elements(container).filter((c) => local(c) === 'region')) {
      const body = elements(r)[0];
      if (!body) continue;
      const kind = local(body);
      const x = dx + (num(r, 'left') || 0), y = dy + (num(r, 'top') || 0);
      const reg: SrcRegion = {
        kind, x, y, alt: [], order: hidden ? hidden.order + (num(r, 'top') || 0) * hidden.scale : y, inArea,
        w: num(r, 'actualWidth') || num(r, 'width') || 0, h: num(r, 'actualHeight') || num(r, 'height') || 0,
      };
      regions.push(reg);
      if (kind === 'Area') {
        bump(features, 'area');
        if (body.getAttribute('is-collapsed') === 'true' || body.getAttribute('IsCollapsed') === 'True') bump(features, 'area.collapsed');
        if (/true/i.test(body.getAttribute('is-locked') ?? body.getAttribute('IsLocked') ?? '')) bump(features, 'area.locked');
        const inner = child(body, 'regions');
        const collapsed = /^true$/i.test(body.getAttribute('IsCollapsed') ?? '');
        if (inner) walk(inner, x, y, true, collapsed ? { order: reg.order, scale: (hidden?.scale ?? 1) * 1e-6 } : hidden && { order: reg.order, scale: hidden.scale });
        continue;
      }
      if (kind === 'math') {
        const top = elements(body)[0];
        reg.sub = top ? local(top) : '';
        const ctl = top && (/Control$/.test(local(top)) ? top : elements(top).find((c) => /Control$/.test(local(c))));
        if (ctl) {
          reg.sub = local(ctl);
          bump(features, `control.${local(ctl)}`);
        }
        bump(features, 'math.resultFormat', elements(body).filter((c) => local(c) === 'resultFormat').length);
        bump(features, 'math.formattingOverride', elements(body).filter((c) => local(c) === 'formattingOverride').length);
        if (body.getAttribute('disable-calc') === 'true' || body.getAttribute('is-disabled') === 'true') bump(features, 'math.disabled');
      }
      if (kind === 'math' || kind === 'solveblock') reg.defines = mathDefines(body);
      if (kind === 'text') xamlFeatures(body.getAttribute('item-idref'));
      if (kind === 'picture') bump(features, 'picture');
      if (kind === 'pageBreak') bump(features, 'pageBreak');
      if (kind === 'solveblock') bump(features, 'solveblock');
      if (kind === 'spec-table') bump(features, 'table');
      if (/component/i.test(kind)) bump(features, `component.${kind}`);
      if (kind === 'plot') {
        const type = elements(body)[0];
        reg.sub = type ? local(type) : '';
        bump(features, `plot.${reg.sub}`);
        const traces = descendants(body, 'trace');
        bump(features, 'plot.traces', traces.length);
        for (const t of traces) {
          const st = child(t, 'traceStyle');
          if (st && (st.getAttribute('symbol') ?? 'none') !== 'none') bump(features, 'plot.symbols');
          if (st && !/^lines$/.test(text(st))) bump(features, `plot.style.${text(st)}`);
          if (st && (st.getAttribute('line-style') ?? 'Solid') !== 'Solid') bump(features, 'plot.lineStyle');
        }
        bump(features, 'plot.traceColors', traces.length ? 1 : 0);
        for (const d of descendants(body, 'xyDomain')) {
          if (d.getAttribute('scale-type') === 'log') bump(features, 'plot.log');
          if (d.getAttribute('auto-scale') === 'false') bump(features, 'plot.fixedLimits');
        }
        if (descendants(body, 'axisLabel').some((a) => text(a))) bump(features, 'plot.axisLabel');
        if (descendants(body, 'markers').some((a) => elements(a).length)) bump(features, 'plot.markers');
        if (text(descendants(body, 'title')[0])) bump(features, 'plot.title');
        if (descendants(body, 'yAxis').filter((a) => a.getAttribute('rank') === '2').length) bump(features, 'plot.y2');
        // Prime keeps the points it drew, one result per trace
        reg.traces = [];
        for (const t of traces) {
          const rd = results.get(t.getAttribute('resultRef') ?? '');
          const tr = rd ? descendants(rd, 'Trace2dResult')[0] : undefined;
          if (!tr) continue;
          const vec = (name: string) => {
            const dv = descendants(child(child(tr, 'Data') ?? tr, name) ?? tr, 'DataVectors')[0];
            try {
              return (JSON.parse(text(dv) || '[]') as unknown[]).flat(3).map(Number);
            } catch {
              return [];
            }
          };
          reg.traces.push({ xs: vec('RangePoints'), ys: vec('ResultPoints') });
        }
      }
      // results: a math region (also inside a solve block) whose result data has a value; shown
      // when the math evaluates (=), else Prime keeps it without showing it (a check such as a < b)
      const rank = { implicit: 1, error: 2, symbolic: 3, value: 4 };
      for (const m of kind === 'math' ? [body] : descendants(body, 'math')) {
        const rd = results.get(m.getAttribute('resultRef') ?? '\0');
        if (!rd) continue;
        const res = child(rd, 'result');
        let got: SrcRegion['saved'], t = '';
        if (res && elements(res).length) {
          got = descendants(m, 'symEval').length ? 'symbolic' : descendants(m, 'eval').length ? 'value' : 'implicit';
          t = text(res).slice(0, 120);
          const only = elements(res)[0];
          if (got === 'implicit' && local(only) === 'real') reg.savedScalar = Number(text(only));
        } else if (descendants(rd, 'engineError').length) {
          got = 'error';
          t = text(descendants(rd, 'resource-string')[0]).slice(0, 160);
        }
        if (got && (!reg.saved || rank[got] > rank[reg.saved])) {
          reg.saved = got;
          reg.savedText = t;
        }
      }
    }
  };
  const regionsEl = elements(doc.documentElement!).find((c) => local(c) === 'regions');
  if (regionsEl) walk(regionsEl, 0, 0, false);

  for (const part of ['header', 'footer']) {
    const x = get(`mathcad/${part}.xml`);
    if (!x) continue;
    const d = parse(strFromU8(x));
    if (descendants(d, 'region').length || text(d.documentElement ?? undefined)) bump(features, part);
  }
  const pres = get('mathcad/settings/presentation.xml');
  if (pres) {
    const d = parse(strFromU8(pres));
    const gen = descendants(d, 'general')[0] ?? descendants(d, 'resultFormat')[0];
    if (gen) for (const a of ['precision', 'show-trailing-zeros', 'exponential-threshold', 'complex-threshold', 'zero-threshold']) if (gen.getAttribute(a)) settings[a] = gen.getAttribute(a)!;
    const page = descendants(d, 'pageModel')[0] ?? descendants(d, 'page')[0];
    if (page) for (const a of ['page-width', 'page-height', 'orientation']) if (page.getAttribute(a)) settings[a] = page.getAttribute(a)!;
  }
  const calc = get('mathcad/settings/calculation.xml');
  if (calc) {
    const biv = descendants(parse(strFromU8(calc)), 'builtInVariables')[0];
    if (biv) for (const a of ['array-origin', 'convergence-tolerance', 'constraint-tolerance']) if (biv.getAttribute(a)) settings[a] = biv.getAttribute(a)!;
  }
  return { regions, features, settings };
}

function xmcdInventory(bytes: Uint8Array): Inventory {
  const doc = parse(strFromU8(bytes));
  const PX = 96 / 72;
  const features: Record<string, number> = {};
  const settings: Record<string, string> = {};
  const regions: SrcRegion[] = [];
  // An open area keeps its regions on the page, a collapsed one relative to itself (ay is the
  // page height of that frame). A collapsed area calculates its regions where it is, before what
  // follows it: their order is the area's, then their own within it.
  const walk = (container: El, ax: number, ay: number, inArea: boolean, hidden: { order: number; scale: number } | null = null) => {
    for (const r of elements(container).filter((c) => local(c) === 'region')) {
      const parts = elements(r).filter((c) => local(c) !== 'rendering');
      if (parts.some((c) => local(c) === 'link')) bump(features, 'region.hyperlink');
      const body = parts.find((c) => local(c) !== 'link');
      if (!body) continue;
      const kind = local(body);
      const x = num(r, 'left') * PX || 0, y = num(r, 'top') * PX || 0;
      const alignY = r.getAttribute('align-y') !== null ? num(r, 'align-y') * PX : null;
      // math placed by its baseline; in a collapsed area, on the page where the area is
      const alt = [alignY !== null ? alignY - 12 : y];
      if (ay) alt.push(ay + y, ay + (alignY ?? y) - 12);
      const order = hidden ? hidden.order + (alignY ?? y) * hidden.scale : alignY ?? y;
      const reg: SrcRegion = { kind, x, y, alt, order, inArea, w: num(r, 'width') * PX || 0, h: num(r, 'height') * PX || 0 };
      if (r.getAttribute('show-border') === 'true') bump(features, 'region.border');
      if (r.getAttribute('show-highlight') === 'true' || !/^(inherit|#fff|#ffffff|)$/i.test(r.getAttribute('background-color') ?? '')) bump(features, 'region.highlight');
      regions.push(reg);
      if (kind === 'area') {
        bump(features, 'area');
        if (body.getAttribute('is-collapsed') === 'true') bump(features, 'area.collapsed');
        if (body.getAttribute('is-locked') === 'true') bump(features, 'area.locked');
        const collapsed = body.getAttribute('is-collapsed') === 'true';
        if (collapsed) walk(body, ax + x, ay + y, true, { order, scale: (hidden?.scale ?? 1) * 1e-6 });
        else walk(body, ax, ay, true, hidden);
        continue;
      }
      if (kind === 'math') {
        let top: El | undefined = elements(body)[0];
        while (top && local(top) === 'provenance') top = elements(top).filter((c) => !/^(originRef|parentRef|comment|originComment|contentHash|hash)$/.test(local(c))).pop();
        reg.sub = top ? local(top) : '';
        reg.defines = mathDefines(body);
        bump(features, 'math.provenance', descendants(body, 'provenance').length ? 1 : 0);
        bump(features, 'math.resultFormat', descendants(body, 'resultFormat').length ? 1 : 0);
        if (body.getAttribute('disable-calc') === 'true') bump(features, 'math.disabled');
        const ev = descendants(body, 'eval')[0];
        const res = ev ? elements(ev).find((c) => local(c) === 'result') : undefined;
        const sym = descendants(body, 'symResult')[0];
        if (res) {
          reg.saved = 'value';
          reg.savedText = text(res).slice(0, 120);
        } else if (body.getAttribute('error')) {
          reg.saved = 'error';
          reg.savedText = body.getAttribute('error')!.slice(0, 160);
        } else if (sym) {
          reg.saved = 'symbolic';
          reg.savedText = text(sym).slice(0, 120);
        }
      }
      if (kind === 'text') {
        bump(features, 'text.bold', descendants(body, 'b').length);
        bump(features, 'text.italic', descendants(body, 'i').length);
        bump(features, 'text.underline', descendants(body, 'u').length);
        bump(features, 'text.sub', descendants(body, 'sub').length);
        bump(features, 'text.sup', descendants(body, 'sup').length);
        const f = descendants(body, 'f');
        bump(features, 'text.fontSize', f.filter((e) => e.getAttribute('size')).length);
        bump(features, 'text.fontFamily', f.filter((e) => e.getAttribute('family')).length);
        bump(features, 'text.color', f.filter((e) => e.getAttribute('color')).length + descendants(body, 'c').length);
        bump(features, 'text.highlight', f.filter((e) => e.getAttribute('background-color')).length);
        bump(features, 'text.align', descendants(body, 'p').filter((p) => /^(center|right|justify)$/.test(p.getAttribute('text-align') ?? '')).length);
        bump(features, 'text.list', descendants(body, 'p').filter((p) => /^(disc|decimal|circle|square)/.test(p.getAttribute('list-style-type') ?? '')).length);
        bump(features, 'text.style', descendants(body, 'p').filter((p) => !/^(Normal|)$/.test(p.getAttribute('style') ?? '')).length);
        bump(features, 'text.link', descendants(body, 'a').length);
        bump(features, 'text.math', descendants(body, 'math').length);
      }
      if (kind === 'plot') {
        reg.sub = elements(body).length ? local(elements(body)[0]) : 'binary';
        bump(features, `plot.${reg.sub}`);
      }
      if (kind === 'picture') bump(features, 'picture');
      if (kind === 'pageBreak') bump(features, 'pageBreak');
      if (kind === 'reference') bump(features, 'reference');
      if (kind === 'ole') bump(features, 'ole');
      if (kind === 'component') {
        reg.sub = body.getAttribute('type') ?? elements(body).map(local).join('+');
        bump(features, `component.${reg.sub}`);
      }
    }
  };
  const regionsEl = elements(doc.documentElement!).find((c) => local(c) === 'regions');
  if (regionsEl) walk(regionsEl, 0, 0, false);
  const gen = descendants(doc, 'general')[0];
  if (gen) for (const a of ['precision', 'show-trailing-zeros', 'exponential-threshold', 'complex-threshold', 'zero-threshold']) if (gen.getAttribute(a)) settings[a] = gen.getAttribute(a)!;
  const page = descendants(doc, 'pageModel')[0];
  if (page) for (const a of ['page-width', 'page-height', 'orientation']) if (page.getAttribute(a)) settings[a] = page.getAttribute(a)!;
  const biv = descendants(doc, 'builtInVariables')[0];
  if (biv) for (const a of ['array-origin', 'convergence-tolerance', 'constraint-tolerance', 'random-seed']) if (biv.getAttribute(a)) settings[a] = biv.getAttribute(a)!;
  const us = descendants(doc, 'currentUnitSystem')[0];
  if (us) settings['unit-system'] = us.getAttribute('name') ?? '';
  for (const part of ['header', 'footer']) {
    const e = page ? child(page, part) : undefined;
    if (e && (descendants(e, 'region').length || text(e))) bump(features, part);
  }
  return { regions, features, settings };
}

function smXml(bytes: Uint8Array): string {
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    const files = unzipSync(bytes);
    const k = Object.keys(files).find((f) => /\.(sm|xml)$/i.test(f)) ?? Object.keys(files)[0];
    return smXml(files[k]);
  }
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) return strFromU8(gunzipSync(bytes));
  const head = strFromU8(bytes.subarray(0, 64)).replace(/^\uFEFF/, '').trimStart();
  return head.startsWith('<') ? strFromU8(bytes) : strFromU8(decompressSync(bytes));
}

function smInventory(bytes: Uint8Array): Inventory {
  const doc = parse(smXml(bytes));
  const features: Record<string, number> = {};
  const settings: Record<string, string> = {};
  const regions: SrcRegion[] = [];
  const walk = (container: El, inArea: boolean) => {
    for (const r of elements(container).filter((c) => local(c) === 'region')) {
      const nested = elements(r).filter((c) => local(c) === 'region');
      const body = elements(r).find((c) => local(c) !== 'region');
      const kind = body ? local(body) : nested.length ? 'area' : '';
      if (!kind) continue;
      const x = num(r, 'left') || 0, y = num(r, 'top') || 0;
      const reg: SrcRegion = { kind, x, y, alt: [], order: y, inArea, w: num(r, 'width') || 0, h: num(r, 'height') || 0 };
      regions.push(reg);
      if (r.getAttribute('border') === 'true') bump(features, 'region.border');
      if (!/^(#ffffff|)$/i.test(r.getAttribute('bgColor') ?? '')) bump(features, 'region.highlight');
      if (!/^(#000000|)$/i.test(r.getAttribute('color') ?? '')) bump(features, 'region.color');
      if (kind === 'area') {
        bump(features, 'area');
        if (body?.getAttribute('collapsed') === 'true' || body?.getAttribute('isCollapsed') === 'true') bump(features, 'area.collapsed');
      }
      if (nested.length) walk(r, true);
      if (!body) continue;
      if (kind === 'math') {
        const res = child(body, 'result');
        if (res) {
          const action = res.getAttribute('action') ?? '';
          reg.saved = action === 'symbolic' ? 'symbolic' : 'value';
          reg.savedText = elements(res).map((e) => e.textContent ?? '').join(' ').slice(0, 120);
          reg.sub = action;
        }
        if (child(body, 'contract')) bump(features, 'math.displayUnit');
        if (body.getAttribute('ignoreUnits') === 'true') bump(features, 'math.ignoreUnits');
        if (child(body, 'description')) bump(features, 'math.description');
        if (body.getAttribute('evaluate') === 'false' || r.getAttribute('evaluate') === 'false') bump(features, 'math.disabled');
      }
      if (kind === 'text') {
        bump(features, 'text.bold', descendants(body, 'b').length + descendants(body, 'p').filter((p) => /bold/i.test(p.getAttribute('style') ?? '')).length);
        bump(features, 'text.italic', descendants(body, 'i').length);
        bump(features, 'text.fontSize', r.getAttribute('fontSize') && r.getAttribute('fontSize') !== '10' ? 1 : 0);
      }
      if (kind === 'picture' || kind === 'image') bump(features, 'picture');
      if (kind === 'plot' || kind === 'xyplot') {
        reg.sub = body.getAttribute('type') ?? kind;
        bump(features, `plot.${kind}.${reg.sub}`);
      }
      if (!/^(math|text|picture|plot|area)$/.test(kind)) bump(features, `plugin.${kind}`);
    }
  };
  const root = doc.documentElement!;
  const regionsEl = local(root) === 'regions' ? root : child(root, 'regions') ?? descendants(doc, 'regions')[0];
  if (regionsEl) walk(regionsEl, false);
  const calc = descendants(doc, 'calculation')[0];
  if (calc) for (const k of ['precision', 'exponentialThreshold', 'fractions']) if (child(calc, k)) settings[k] = text(child(calc, k));
  return { regions, features, settings };
}

// ------------------------------------------------------------ what the import made of it

/** Region sizes estimated from their content (px): there is no layout engine in a test. */
function estimate(r: Region): { w: number; h: number } {
  switch (r.kind) {
    case 'math': {
      const lines = r.source.split('\n');
      const longest = Math.max(...lines.map((l) => l.length));
      const shown = / =( |$)/.test(lines[0]) ? 70 : 0;
      const tall = /\/|\^|sqrt|integral|sum\(|\[/.test(r.source) ? 12 : 0;
      return { w: Math.min(700, Math.max(30, longest * 7 + shown)), h: lines.length * 20 + tall + 6 };
    }
    case 'text': {
      const perLine = Math.max(8, r.width / 7);
      const lines = r.markdown.split(/\n+/).reduce((n, p) => n + Math.max(1, Math.ceil(p.replace(/[*#`]/g, '').length / perLine)), 0);
      return { w: r.width, h: lines * 18 + 6 };
    }
    case 'image': return { w: r.width, h: Math.round(r.width * imageAspect(r.src)) };
    case 'plot': return { w: r.width, h: r.height };
    case 'solve': {
      const lines = [r.guesses, r.constraints, r.solver].join('\n').split('\n').filter((l) => l.trim()).length;
      return { w: 300, h: lines * 22 + 40 };
    }
    case 'area': return { w: 0, h: 0 };
    default: return { w: 200, h: 100 };
  }
}

/** Height / width of a data-URL image, from its header (PNG, JPEG, GIF, BMP); 0.75 when unknown. */
function imageAspect(src: string): number {
  try {
    const b64 = src.slice(src.indexOf(',') + 1, src.indexOf(',') + 1 + 64 * 1024);
    const b = Uint8Array.from(atob(b64.slice(0, b64.length - (b64.length % 4))), (c) => c.charCodeAt(0));
    const be16 = (i: number) => (b[i] << 8) | b[i + 1], be32 = (i: number) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
    const le16 = (i: number) => b[i] | (b[i + 1] << 8), le32 = (i: number) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24));
    if (b[0] === 0x89 && b[1] === 0x50) return be32(20) / be32(16);
    if (b[0] === 0x47 && b[1] === 0x49) return le16(8) / le16(6);
    if (b[0] === 0x42 && b[1] === 0x4d) return Math.abs(le32(22)) / le32(18);
    if (b[0] === 0xff && b[1] === 0xd8) {
      for (let i = 2; i < b.length - 9;) {
        if (b[i] !== 0xff) break;
        const m = b[i + 1], len = be16(i + 2);
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return be16(i + 5) / be16(i + 7);
        i += 2 + len;
      }
    }
  } catch {
    /* unknown */
  }
  return 0.75;
}

const category = (kind: string): string => {
  if (/^(math|solve|solveblock)$/.test(kind)) return 'math';
  if (/^(text)$/.test(kind)) return 'text';
  if (/^(image|picture)$/.test(kind)) return 'image';
  if (/plot/.test(kind)) return 'plot';
  return kind;
};

/** A warning with its place and names taken out, so that warnings of one kind count together. */
function warningKey(w: string): string {
  return w
    .replace(/ at -?\d+ px/g, '')
    .replace(/^\d+ (regions?|plots?)/, 'N $1')
    .replace(/for [^ ]+ \(a list of \d+ choices\)/, 'for X (a list of N choices)')
    .replace(/“[^”]*”/g, (m) => (/(element|operator|region|control)/.test(w) ? m : '“…”'))
    .replace(/(reference to ).*?( at|:)/, '$1…$2')
    .replace(/(A reference to )[^ ]+/, '$1…')
    .replace(/(multiple of |shown in |became its input ).*$/, '$1…')
    .slice(0, 200);
}

/** An evaluation error with the names in it replaced, so that errors of one kind count together. */
function errorKey(e: string): string {
  return e
    .replace(/"[^"]*"/g, '"…"')
    .replace(/(Undefined (symbol|function|variable)) .*/i, (_m, a: string) => `${a} …`)
    .replace(/\b\d+(\.\d+)?\b/g, 'N')
    .slice(0, 160);
}

const resultError = (r: RegionResult | undefined): string | undefined => {
  if (!r) return 'not calculated';
  if ('error' in r && r.error) return r.error;
  if (r.kind === 'solve') return r.solver.error ?? r.guesses.find((g) => g.error)?.error ?? r.constraints.find((c) => c.error)?.error;
  return undefined;
};

const regionSource = (r: Region | undefined): string => {
  if (!r) return '';
  if (r.kind === 'math') return r.source;
  if (r.kind === 'solve') return `${r.guesses} | ${r.constraints} | ${r.solver}`.replace(/\n/g, '; ');
  if (r.kind === 'plot') return `plot ${r.xExpr} : ${r.traces.map((t) => t.y).join(', ')}`;
  return r.kind;
};

const short = (s: string, n = 160) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** Names a math source defines and reads (for telling a harmful order change). */
function names(src: string): { def: string | null; uses: Set<string> } {
  const m = /^([\p{L}_][\p{L}\p{N}_ʹ]*)\s*(\([^)]*\))?\s*(:=|≡)/u.exec(src);
  const rhs = m ? src.slice(m[0].length) : src;
  const uses = new Set(rhs.replace(/"[^"]*"/g, '').match(/[\p{L}_][\p{L}\p{N}_ʹ]*/gu) ?? []);
  return { def: m ? m[1] : null, uses };
}

/** Names an imported region defines: x := …, f(x) := …, [a; b] := …, v[i] := …, a solve block's results. */
function definedHere(r: Region): string[] {
  const src = r.kind === 'math' ? r.source : r.kind === 'solve' ? r.solver : '';
  const m = /^\s*(\[[^\]]*\]|[\p{L}_][\p{L}\p{N}_ʹ]*)\s*(\([^)]*\)|\[[^\]]*\])?\s*(:=|≡)/u.exec(src);
  if (!m) return [];
  return m[1].startsWith('[') ? m[1].slice(1, -1).split(/[;,]/).map((x) => x.trim()).filter(Boolean) : [m[1]];
}

interface FileReport {
  file: string;
  format: Fmt;
  bytes: number;
  importError?: string;
  evalError?: string;
  /** The import or the calculation did not finish within the time limit (CORPUS_FILE_TIMEOUT). */
  timedOut?: boolean;
  ms: { import: number; eval: number };
  source: {
    regions: number;
    kinds: Record<string, number>;
    features: Record<string, number>;
    settings: Record<string, string>;
    saved: { values: number; errors: number; symbolic: number; implicit: number; plotTraces: number };
  };
  imported: { regions: number; kinds: Record<string, number>; notImported: number };
  warnings: string[];
  unconverted: string[];
  saved: {
    /** Values the program shows in the file. */
    inFile: number;
    /** Kept by the importer to compare. */
    captured: number;
    /** Kept, but our parser cannot read the saved value. */
    unparseable: string[];
    checked: number;
    agree: number;
    /** upstream: the failed definition this result reads through, when there is one. */
    differ: { source: string; ours: string; theirs: string; upstream?: string }[];
    missing: { source: string; theirs: string; error: string; root: string; rootAt?: string }[];
    /** Values in the file the importer did not keep (by place); reason = a warning at that place. */
    lost: { kind: string; y: number; theirs: string; reason: string; unsure?: boolean }[];
    /** Results the program itself saved as an error, and what we give there. */
    theirErrors: { error: string; ours: string }[];
    /** Prime's results of regions that do not show them: checks (a < b) compared with ours. */
    implicit: { inFile: number; compared: number; agree: number; differ: { source: string; ours: string; theirs: string }[] };
  };
  plots: { savedTraces: number; compared: number; agree: number; differ: { plot: string; trace: number; why: string }[] };
  evalErrors: { id?: string; source: string; error: string; root: string; rootAt?: string }[];
  layout: {
    matched: number;
    /** Source regions with no imported region at their place, by kind. */
    unmatched: Record<string, number>;
    /** Imported regions at a place where the file had none of that kind. */
    extra: Record<string, number>;
    /** Matched regions whose top differs from the program's by more than 2 px. */
    misplaced: { kind: string; y: number; ours: number }[];
    /** Pairs of math regions that calculate in another order than in the program. */
    inversions: number;
    /** …of which the later one here defines a name the earlier one reads. */
    harmful: { first: string; second: string }[];
    overlapsInFile: number;
    overlapsEstimated: number;
    pushedDown: number;
    pushHeight: number;
    offPage: number;
  };
}

function inventory(bytes: Uint8Array, fmt: Fmt): Inventory {
  return fmt === 'mcdx' ? primeInventory(bytes) : fmt === 'xmcd' ? xmcdInventory(bytes) : smInventory(bytes);
}

function overlapping(boxes: { x: number; y: number; w: number; h: number }[]): number {
  let n = 0;
  const s = boxes.filter((b) => b.w > 0 && b.h > 0).sort((a, b) => a.y - b.y);
  for (let i = 0; i < s.length; i++) {
    for (let j = i + 1; j < s.length && s[j].y < s[i].y + s[i].h; j++) {
      const a = s[i], b = s[j];
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) n++;
    }
  }
  return n;
}

/** What the file holds, before importing it. */
function fileReport(file: string): { rep: FileReport; src: SrcRegion[]; bytes: Uint8Array } {
  const bytes = new Uint8Array(readFileSync(join(DIR, file)));
  const format: Fmt = /\.mcdx$/i.test(file) ? 'mcdx' : /\.xmcd$/i.test(file) ? 'xmcd' : 'sm';
  const rep: FileReport = {
    file, format, bytes: bytes.length, ms: { import: 0, eval: 0 },
    source: { regions: 0, kinds: {}, features: {}, settings: {}, saved: { values: 0, errors: 0, symbolic: 0, implicit: 0, plotTraces: 0 } },
    imported: { regions: 0, kinds: {}, notImported: 0 },
    warnings: [], unconverted: [],
    saved: { inFile: 0, captured: 0, unparseable: [], checked: 0, agree: 0, differ: [], missing: [], lost: [], theirErrors: [], implicit: { inFile: 0, compared: 0, agree: 0, differ: [] } },
    plots: { savedTraces: 0, compared: 0, agree: 0, differ: [] },
    evalErrors: [],
    layout: { matched: 0, unmatched: {}, extra: {}, misplaced: [], inversions: 0, harmful: [], overlapsInFile: 0, overlapsEstimated: 0, pushedDown: 0, pushHeight: 0, offPage: 0 },
  };
  let inv: Inventory = { regions: [], features: {}, settings: {} };
  try {
    inv = inventory(bytes, format);
  } catch (e) {
    rep.importError = `the harness could not read the file: ${(e as Error).message}`;
  }
  const src = inv.regions;
  rep.source.regions = src.length;
  for (const r of src) bump(rep.source.kinds, r.sub && r.kind !== 'math' ? `${r.kind}:${r.sub}` : r.kind);
  rep.source.features = inv.features;
  rep.source.settings = inv.settings;
  for (const r of src) {
    if (r.saved === 'value') rep.source.saved.values++;
    else if (r.saved === 'error') rep.source.saved.errors++;
    else if (r.saved === 'symbolic') rep.source.saved.symbolic++;
    else if (r.saved === 'implicit') rep.source.saved.implicit++;
    rep.source.saved.plotTraces += r.traces?.length ?? 0;
  }
  rep.saved.inFile = rep.source.saved.values;
  rep.plots.savedTraces = rep.source.saved.plotTraces;
  rep.layout.overlapsInFile = overlapping(src.filter((r) => !/^(area|Area|pageBreak)$/.test(r.kind)));
  return { rep, src, bytes };
}

/** A worksheet another one includes, found in the corpus folder: the file of that name (saved as path__name) from the closest folder. */
function sibling(file: string, name: string): Uint8Array | undefined {
  const want = name.replace(/ /g, '__').toLowerCase();
  const common = (a: string, b: string) => {
    let k = 0;
    while (k < a.length && a[k] === b[k]) k++;
    return k;
  };
  const hit = readdirSync(DIR)
    .filter((f) => f !== file && (f.toLowerCase() === want || f.toLowerCase().endsWith(`__${want}`)))
    .sort((a, b) => common(b, file) - common(a, file))[0];
  return hit ? new Uint8Array(readFileSync(join(DIR, hit))) : undefined;
}

function analyse(file: string): FileReport {
  const { rep, src, bytes } = fileReport(file);
  const format = rep.format;
  let res: ImportResult;
  const t0 = performance.now();
  try {
    res = format === 'sm' ? importSmath(bytes, file) : importMathcad(bytes, file);
    // the worksheets it includes, picked from the corpus folder as a user would
    if (format === 'sm' && res.references?.length) {
      const references: Record<string, Uint8Array> = {};
      for (const name of res.references) {
        const b = sibling(file, name);
        if (b) references[name] = b;
      }
      if (Object.keys(references).length) res = importSmath(bytes, file, { references });
    }
  } catch (e) {
    rep.importError = (e as Error).message;
    rep.ms.import = performance.now() - t0;
    return rep;
  }
  rep.ms.import = performance.now() - t0;
  const ws = res.ws;
  rep.warnings = res.warnings;
  rep.unconverted = res.warnings.filter((w) => /cannot import|could not be converted|Skipped|not imported|picture of it|picture from|are not drawn|dropped/i.test(w));
  rep.imported.regions = ws.regions.length;
  for (const r of ws.regions) bump(rep.imported.kinds, r.kind);
  rep.imported.notImported = ws.regions.filter((r) => r.kind === 'text' && r.markdown.startsWith('⚠️')).length;

  const t1 = performance.now();
  let ev: ReturnType<typeof evaluateWithScope>;
  try {
    ev = evaluateWithScope(ws);
  } catch (e) {
    rep.evalError = (e as Error).message;
    rep.ms.eval = performance.now() - t1;
    return rep;
  }
  rep.ms.eval = performance.now() - t1;
  const byId = new Map(ws.regions.map((r) => [r.id, r]));

  // saved results
  const saved = res.saved ?? [];
  rep.saved.captured = saved.length;
  for (const s of saved) {
    try {
      compileExpr(s.expr).evaluate(new ChainScope(null));
    } catch (e) {
      rep.saved.unparseable.push(`${short(regionSource(byId.get(s.regionId)), 80)} ⇐ ${short(s.expr, 80)}: ${(e as Error).message}`);
    }
  }
  const cmp = compareSaved(saved, ws.regions, ev.shown);
  rep.saved.checked = cmp.checked;
  rep.saved.agree = cmp.agree;
  rep.saved.differ = cmp.differ.map((d) => ({ source: short(d.source), ours: short(d.ours), theirs: short(d.theirs) }));
  const missingIds = cmp.missing.map((m) => m.regionId);
  rep.saved.missing = cmp.missing.map((m) => ({ source: short(m.source), theirs: short(m.theirs), error: resultError(ev.results.get(m.regionId)) ?? 'no value', root: '' }));

  for (const r of ws.regions) {
    const err = resultError(ev.results.get(r.id));
    if (err && !r.disabled && (r.kind === 'math' || r.kind === 'solve' || r.kind === 'plot')) rep.evalErrors.push({ id: r.id, source: short(regionSource(r)), error: short(err, 200), root: '' });
  }

  // match imported regions to the file's by place: same kind of region, top within 2 px; Mathcad
  // files only: a page break moves what is below it as the import does (pageBreakShift)
  const shiftY = format === 'sm' ? () => 0 : pageBreakShift(src.filter((s) => s.kind === 'pageBreak').map((s) => s.y));
  const ys = (s: SrcRegion) => [s.y, ...s.alt].map((y) => y + shiftY(y));
  /** As the file has them (warnings name these places). */
  const fileYs = (s: SrcRegion) => [s.y, ...s.alt];
  const pool = ws.regions.filter((r) => r.kind !== 'area' && !(r.kind === 'text' && r.markdown.startsWith('⚠️')));
  const used = new Set<string>();
  const matchOf = new Map<SrcRegion, Region>();
  const matchable = src.filter((s) => !/^(area|Area|pageBreak)$/.test(s.kind));
  // side by side regions pair by their rank from the left (the import scales x to the page)
  // ranks from the left among the regions of a kind on the same line, worked out once (files have thousands)
  const rowRanks = <T extends { x: number }>(list: T[], y: (t: T) => number, cat: (t: T) => string) => {
    const out = new Map<T, number>();
    const sorted = [...list].sort((p, q) => y(p) - y(q));
    for (let i = 0; i < sorted.length; i++) {
      let n = 0;
      for (let j = i - 1; j >= 0 && y(sorted[i]) - y(sorted[j]) <= 2; j--) if (cat(sorted[j]) === cat(sorted[i]) && sorted[j].x < sorted[i].x) n++;
      for (let j = i + 1; j < sorted.length && y(sorted[j]) - y(sorted[i]) <= 2; j++) if (cat(sorted[j]) === cat(sorted[i]) && sorted[j].x < sorted[i].x) n++;
      out.set(sorted[i], n);
    }
    return out;
  };
  const srcRank = rowRanks(matchable, (o) => o.y, (o) => category(o.kind));
  const poolRank = rowRanks(pool, (o) => o.y, (o) => category(o.kind));
  for (const s of [...matchable].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const cat = category(s.kind);
    const sRank = srcRank.get(s)!;
    let best: Region | undefined, bestD = Infinity;
    for (const r of pool) {
      if (used.has(r.id) || category(r.kind) !== cat) continue;
      const d = Math.min(...ys(s).map((y) => Math.abs(Math.max(8, Math.round(y)) - r.y)));
      if (d > 2) continue;
      // regions of collapsed areas overlap on the page: one defining another name (or one that
      // defines nothing where the file's defines something, or the other way round) is not this one
      let other = 0;
      if (r.kind === 'math' && s.defines) {
        const def = names(r.source).def;
        if (!!def !== s.defines.length > 0 || (def && !s.defines.includes(def))) other = 5;
      }
      const score = d + other + Math.abs(poolRank.get(r)! - sRank) * 10 + Math.abs(r.x - s.x) / 1e4;
      if (score < bestD) {
        best = r;
        bestD = score;
      }
    }
    if (best) {
      used.add(best.id);
      matchOf.set(s, best);
    }
  }
  // the ⚠️ placeholders stand at the place of what they replace
  const placeholders = ws.regions.filter((r) => r.kind === 'text' && r.markdown.startsWith('⚠️'));
  rep.layout.matched = matchOf.size;
  for (const s of matchable) {
    if (matchOf.has(s)) continue;
    const holder = placeholders.some((p) => ys(s).some((y) => Math.abs(Math.max(8, Math.round(y)) - p.y) <= 2));
    bump(rep.layout.unmatched, `${s.kind}${holder ? ' (not imported)' : ''}`);
  }
  for (const r of pool) if (!used.has(r.id)) bump(rep.layout.extra, r.kind);
  for (const [s, r] of matchOf) {
    if (ys(s).every((y) => Math.abs(Math.max(8, Math.round(y)) - r.y) > 2)) rep.layout.misplaced.push({ kind: s.kind, y: Math.round(s.y), ours: r.y });
  }

  // saved values the importer did not keep: a shown value with no saved entry at its region
  const savedIds = new Set(saved.map((s) => s.regionId));
  const warnAt = (s: SrcRegion) => res.warnings.find((w) => {
    const m = / at (-?\d+) px/.exec(w);
    return m && fileYs(s).some((y) => Math.abs(Number(m[1]) - y) <= 2);
  });
  // matching by place is not exact (regions side by side, moved ones): as many as the import is
  // short of are reported, those with a warning at their place first
  const lost: FileReport['saved']['lost'] = [];
  for (const s of src) {
    if (s.saved !== 'value') continue;
    const r = matchOf.get(s);
    if (r && savedIds.has(r.id)) continue;
    const w = warnAt(s);
    const reason = w ?? (r ? `imported as ${short(regionSource(r), 100)} (no saved value kept)` : 'no imported region at its place');
    lost.push({ kind: s.kind, y: Math.round(s.y), theirs: s.savedText ?? '', reason: short(reason, 220), ...(w ? {} : { unsure: true }) });
  }
  rep.saved.lost = [...lost.filter((l) => !l.unsure), ...lost.filter((l) => l.unsure)].slice(0, Math.max(0, rep.saved.inFile - saved.length));
  // results the program saved as its own error
  for (const s of src) {
    if (s.saved !== 'error') continue;
    const r = matchOf.get(s);
    const ours = r ? resultError(ev.results.get(r.id)) ?? 'a value' : 'not imported';
    rep.saved.theirErrors.push({ error: s.savedText ?? '', ours: short(ours, 160) });
  }

  // results Prime keeps for regions that do not show them: checks (1 holds, 0 fails)
  for (const s of src) {
    if (s.saved !== 'implicit') continue;
    rep.saved.implicit.inFile++;
    const r = matchOf.get(s);
    const res = r ? ev.results.get(r.id) : undefined;
    if (s.savedScalar === undefined || !res || res.kind !== 'math' || !res.check) continue;
    rep.saved.implicit.compared++;
    const ours = res.check.ok ? 1 : 0;
    if (ours === s.savedScalar) rep.saved.implicit.agree++;
    else rep.saved.implicit.differ.push({ source: short(regionSource(r)), ours: String(ours), theirs: String(s.savedScalar) });
  }

  // plot traces Prime saved
  for (const s of src) {
    if (!s.traces?.length) continue;
    const r = matchOf.get(s);
    const pr = r ? (ev.results.get(r.id) as PlotResult | undefined) : undefined;
    s.traces.forEach((t, k) => {
      rep.plots.compared++;
      const name = r ? regionSource(r) : `plot at ${Math.round(s.y)} px`;
      const ser = pr?.series?.[k];
      let why = '';
      if (!r) why = 'plot not imported';
      else if (pr?.error) why = `our error: ${pr.error}`;
      else if (!ser) why = `we draw ${pr?.series?.length ?? 0} traces, Mathcad ${s.traces!.length}`;
      else if (ser.xs.length !== t.xs.length) why = `${ser.xs.length} points here, ${t.xs.length} in Mathcad`;
      else {
        const close = (a: number[], b: number[]) => {
          const scale = Math.max(1e-300, ...b.filter(Number.isFinite).map(Math.abs));
          return a.every((v, i) => (Number.isNaN(v) && !Number.isFinite(b[i])) || Math.abs(v - b[i]) <= 1e-6 * scale);
        };
        if (!close(ser.xs, t.xs)) why = `x differs (ours ${ser.xs.slice(0, 3).map((v) => +v.toPrecision(6))}…, theirs ${t.xs.slice(0, 3).map((v) => +v.toPrecision(6))}…)`;
        else if (!close(ser.ys, t.ys)) why = `y differs (ours ${ser.ys.slice(0, 3).map((v) => +v.toPrecision(6))}…, theirs ${t.ys.slice(0, 3).map((v) => +v.toPrecision(6))}…)`;
      }
      if (why) rep.plots.differ.push({ plot: short(name, 100), trace: k, why: short(why, 200) });
      else rep.plots.agree++;
    });
  }

  // root causes: an undefined name leads to the region that should define it, and on to what failed there
  const order = new Map(evaluationOrder(ws).map((r, i) => [r.id, i]));
  const definers = new Map<string, Region[]>();
  for (const r of ws.regions) for (const n of definedHere(r)) definers.set(n, [...(definers.get(n) ?? []), r]);
  const srcDefiner = new Map<string, SrcRegion>();
  for (const s of src) for (const n of s.defines ?? []) if (!srcDefiner.has(n)) srcDefiner.set(n, s);
  const external = src.some((s) => /^(reference|ole|component)$/.test(s.kind) || /component/i.test(s.kind));
  const sources = ws.regions.map(regionSource).join('\n');
  // the region the chain ends at, with its error as it stands
  let rootAt = '';
  const rootCause = (id: string, seen: Set<string>): string => {
    const err = resultError(ev.results.get(id));
    rootAt = `${short(regionSource(byId.get(id)), 120)} ⇒ ${short(err ?? 'no value', 120)}`;
    if (!err) return 'no value, no error';
    const m = /"([^"]+)" is not defined/.exec(err) ?? /Undefined (?:symbol|function) ([^\s:]+)/.exec(err);
    if (!m) return `error: ${errorKey(err)}`;
    const n = m[1];
    const defs = (definers.get(n) ?? []).filter((d) => d.id !== id);
    if (defs.length) {
      const bad = defs.find((d) => resultError(ev.results.get(d.id)) && !seen.has(d.id));
      if (bad) {
        seen.add(bad.id);
        return rootCause(bad.id, seen);
      }
      return defs.every((d) => (order.get(d.id) ?? 0) > (order.get(id) ?? 0)) ? `defined further down here (calculation order): ${n}` : `defined, but not where it is read (scope): ${n}`;
    }
    const s = srcDefiner.get(n);
    if (s) {
      const w = warnAt(s);
      return w ? `not imported: ${warningKey(w)}` : `defined in the file, not by the import: ${n} (${s.kind}${s.sub ? ` ${s.sub}` : ''})`;
    }
    if (new RegExp(`(^|[^\\p{L}\\p{N}_])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\(`, 'u').test(sources)) return `function not available: ${n}`;
    return external ? `not defined in the file (it has a reference, component or object): ${n}` : `never defined in the file: ${n}`;
  };
  rep.saved.missing.forEach((m, i) => {
    m.root = short(rootCause(missingIds[i], new Set([missingIds[i]])), 200);
    m.rootAt = rootAt;
  });
  for (const e of rep.evalErrors) {
    e.root = short(rootCause(e.id!, new Set([e.id!])), 200);
    e.rootAt = rootAt;
    delete e.id;
  }
  // a result that differs may read a name whose (re)definition failed upstream: an older value is used
  const upstream = (id: string): string | undefined => {
    const seen = new Set([id]);
    const queue = [id];
    for (let steps = 0; queue.length && steps < 5000; steps++) {
      const r = byId.get(queue.shift()!);
      if (!r) continue;
      for (const n of names(regionSource(r)).uses) {
        for (const d of definers.get(n) ?? []) {
          if (seen.has(d.id)) continue;
          seen.add(d.id);
          if (resultError(ev.results.get(d.id))) {
            const root = rootCause(d.id, new Set([d.id]));
            return `${short(root, 160)} ⇐ ${rootAt}`;
          }
          queue.push(d.id);
        }
      }
    }
    return undefined;
  };
  cmp.differ.forEach((d, i) => {
    const u = upstream(d.regionId);
    if (u) rep.saved.differ[i].upstream = short(u, 300);
  });

  // calculation order: the program's rule on the matched math regions, against ours
  const calc = [...matchOf.entries()].filter(([s, r]) => category(s.kind) === 'math' && (r.kind === 'math' || r.kind === 'solve'));
  calc.sort((a, b) => a[0].order - b[0].order || a[0].x - b[0].x);
  const ours = new Map(evaluationOrder(ws).map((r, i) => [r.id, i]));
  const info = calc.map(([, r]) => ({ r, at: ours.get(r.id) ?? 0, ...names(r.kind === 'math' ? r.source : r.kind === 'solve' ? r.solver : '') }));
  for (let i = 0; i < info.length; i++) {
    for (let j = i + 1; j < info.length; j++) {
      if (info[i].at < info[j].at) continue;
      rep.layout.inversions++;
      // the program calculates i first; here j comes first
      const a = info[i], b = info[j];
      if (a.def && b.uses.has(a.def) && rep.layout.harmful.length < 20) rep.layout.harmful.push({ first: short(regionSource(a.r), 80), second: short(regionSource(b.r), 80) });
    }
  }

  // overlaps at the sizes things come out here (estimated), and how far separating pushes them
  const boxes: Box[] = ws.regions.filter((r) => r.kind !== 'area').map((r) => ({ id: r.id, x: r.x, y: r.y, ...estimate(r) }));
  rep.layout.overlapsEstimated = overlapping(boxes);
  const moves = separateKeepingOrder(boxes, 4, (y) => y);
  // a region pushed takes what follows along: count the regions that are pushed further themselves
  let carried = 0;
  for (const b of [...boxes].sort((p, q) => (Math.abs(p.y - q.y) < 4 ? p.x - q.x : p.y - q.y))) {
    const dy = moves.get(b.id) ?? 0;
    if (dy > carried) rep.layout.pushedDown++;
    carried = Math.max(carried, dy);
  }
  rep.layout.pushHeight = Math.round(Math.max(0, ...moves.values()));
  rep.layout.offPage = boxes.filter((b) => b.x + b.w > 794).length;
  return rep;
}

// ------------------------------------------------------------ report

interface Totals {
  files: number;
  imported: number;
  importErrors: number;
  inFile: number;
  captured: number;
  checked: number;
  agree: number;
  differ: number;
  missing: number;
  unparseable: number;
  lost: number;
  theirErrors: number;
  implicit: number;
  implicitCompared: number;
  implicitAgree: number;
  savedTraces: number;
  tracesAgree: number;
  sourceRegions: number;
  importedRegions: number;
  notImported: number;
  unconverted: number;
  warnings: number;
  evalErrors: number;
  inversions: number;
  harmful: number;
  misplaced: number;
  pushedDown: number;
  seconds: number;
  /** Files whose calculation did not finish in time, and the saved values they show. */
  timedOut: number;
  timedOutValues: number;
}

function totals(list: FileReport[]): Totals {
  const t: Totals = {
    files: 0, imported: 0, importErrors: 0, inFile: 0, captured: 0, checked: 0, agree: 0, differ: 0, missing: 0, unparseable: 0, lost: 0, theirErrors: 0,
    implicit: 0, implicitCompared: 0, implicitAgree: 0, savedTraces: 0, tracesAgree: 0, sourceRegions: 0, importedRegions: 0, notImported: 0, unconverted: 0, warnings: 0, evalErrors: 0, inversions: 0, harmful: 0,
    misplaced: 0, pushedDown: 0, seconds: 0, timedOut: 0, timedOutValues: 0,
  };
  for (const f of list) {
    t.files++;
    if (f.importError) t.importErrors++;
    else t.imported++;
    if (f.timedOut) {
      t.timedOut++;
      t.timedOutValues += f.saved.inFile;
    }
    t.inFile += f.saved.inFile;
    t.captured += f.saved.captured;
    t.checked += f.saved.checked;
    t.agree += f.saved.agree;
    t.differ += f.saved.differ.length;
    t.missing += f.saved.missing.length;
    t.unparseable += f.saved.unparseable.length;
    t.lost += f.saved.lost.length;
    t.theirErrors += f.saved.theirErrors.length;
    t.implicit += f.saved.implicit.inFile;
    t.implicitCompared += f.saved.implicit.compared;
    t.implicitAgree += f.saved.implicit.agree;
    t.savedTraces += f.plots.savedTraces;
    t.tracesAgree += f.plots.agree;
    t.sourceRegions += f.source.regions;
    t.importedRegions += f.imported.regions;
    t.notImported += f.imported.notImported;
    t.unconverted += f.unconverted.length;
    t.warnings += f.warnings.length;
    t.evalErrors += f.evalErrors.length;
    t.inversions += f.layout.inversions;
    t.harmful += f.layout.harmful.length;
    t.misplaced += f.layout.misplaced.length;
    t.pushedDown += f.layout.pushedDown;
    t.seconds += (f.ms.import + f.ms.eval) / 1000;
  }
  t.seconds = Math.round(t.seconds);
  return t;
}

function top(counts: Map<string, number>, n: number): string[] {
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${String(v).padStart(5)}  ${k}`);
}

function summary(list: FileReport[]): string {
  const out: string[] = [];
  out.push(`Corpus ${DIR}: ${list.length} files, ${new Date().toISOString()}`, '');
  out.push('Saved results: inFile = values the program shows in the file; captured = kept by the importer;');
  out.push('agree / differ / notEval (our error or no value) of the captured ones; lost = shown in the file, not kept;');
  out.push('unparseable = kept but not readable here; theirErr = the program saved its own error there.');
  out.push('pushed down = regions that overlap what is above them at the sizes estimated here (not counting those only carried along).', '');
  for (const fmt of ['mcdx', 'xmcd', 'sm'] as Fmt[]) {
    const t = totals(list.filter((f) => f.format === fmt));
    if (!t.files) continue;
    out.push(`== ${fmt}: ${t.files} files, ${t.imported} imported, ${t.importErrors} failed to import, ${t.seconds} s`);
    out.push(`   saved results: inFile ${t.inFile}, captured ${t.captured}, agree ${t.agree}, differ ${t.differ}, notEval ${t.missing}, unparseable ${t.unparseable}, lost ${t.lost}; theirErr ${t.theirErrors}`);
    if (t.timedOut) out.push(`   ${t.timedOut} files did not finish within ${LIMIT / 1000} s; they show ${t.timedOutValues} saved values (counted in inFile only)`);
    out.push(`   agree / inFile = ${t.inFile ? ((100 * t.agree) / t.inFile).toFixed(1) : '-'} %; agree / captured = ${t.captured ? ((100 * t.agree) / t.captured).toFixed(1) : '-'} %`);
    out.push(`   plot traces saved ${t.savedTraces}, agree ${t.tracesAgree}; results kept but not shown (Prime) ${t.implicit}, checks compared ${t.implicitCompared}, agree ${t.implicitAgree}`);
    out.push(`   regions: in file ${t.sourceRegions}, imported ${t.importedRegions}, not imported (⚠️) ${t.notImported}; warnings ${t.warnings} (unconverted ${t.unconverted}); regions with an evaluation error ${t.evalErrors}`);
    out.push(`   layout: misplaced ${t.misplaced}, order inversions ${t.inversions} (harmful ${t.harmful}), pushed down (estimated sizes) ${t.pushedDown}`);
    const kinds = new Map<string, number>(), feats = new Map<string, number>();
    for (const f of list.filter((x) => x.format === fmt)) {
      for (const [k, v] of Object.entries(f.source.kinds)) kinds.set(k, (kinds.get(k) ?? 0) + v);
      for (const [k, v] of Object.entries(f.source.features)) feats.set(k, (feats.get(k) ?? 0) + v);
    }
    out.push(`   region kinds in the files: ${[...kinds.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ')}`);
    out.push(`   features in the files: ${[...feats.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ')}`, '');
  }
  out.push('== per file: fmt | regions file→ours (⚠️) | saved inFile/captured: agree differ notEval lost | traces agree/saved | warnings | inversions(harmful) misplaced | ms');
  for (const f of list) {
    if (f.importError || f.timedOut) {
      out.push(`${f.file} | ${f.format} | ${f.timedOut ? `DID NOT FINISH: ${f.evalError}` : `IMPORT FAILED: ${f.importError}`} | saved inFile ${f.saved.inFile}`);
      continue;
    }
    const s = f.saved;
    out.push([
      f.file, f.format, `${f.source.regions}→${f.imported.regions} (${f.imported.notImported})`,
      `${s.inFile}/${s.captured}: ${s.agree} ${s.differ.length} ${s.missing.length} ${s.lost.length}`,
      `${f.plots.agree}/${f.plots.savedTraces}`, `${f.warnings.length}`,
      `${f.layout.inversions}(${f.layout.harmful.length}) ${f.layout.misplaced.length}`, `${Math.round(f.ms.import + f.ms.eval)}${f.evalError ? ` EVAL FAILED: ${f.evalError}` : ''}`,
    ].join(' | '));
  }
  for (const fmt of ['mcdx', 'xmcd', 'sm'] as Fmt[]) {
    const files = list.filter((f) => f.format === fmt);
    if (!files.length) continue;
    const warn = new Map<string, number>(), errs = new Map<string, number>(), miss = new Map<string, number>(), lost = new Map<string, number>(), unm = new Map<string, number>();
    for (const f of files) {
      for (const w of f.warnings) warn.set(warningKey(w), (warn.get(warningKey(w)) ?? 0) + 1);
      for (const e of f.evalErrors) errs.set(errorKey(e.error), (errs.get(errorKey(e.error)) ?? 0) + 1);
      for (const m of f.saved.missing) miss.set(errorKey(m.error), (miss.get(errorKey(m.error)) ?? 0) + 1);
      for (const l of f.saved.lost) lost.set(warningKey(l.reason), (lost.get(warningKey(l.reason)) ?? 0) + 1);
      for (const [k, v] of Object.entries(f.layout.unmatched)) unm.set(k, (unm.get(k) ?? 0) + v);
    }
    out.push('', `== ${fmt}: most common warnings`, ...top(warn, 40));
    const roots = new Map<string, number>(), errRoots = new Map<string, number>();
    for (const f of files) {
      for (const m of f.saved.missing) roots.set(m.root, (roots.get(m.root) ?? 0) + 1);
      for (const e of f.evalErrors) errRoots.set(e.root, (errRoots.get(e.root) ?? 0) + 1);
    }
    out.push('', `== ${fmt}: why saved results were not evaluated`, ...top(miss, 30));
    out.push('', `== ${fmt}: root causes of the saved results not evaluated (traced through undefined names)`, ...top(roots, 60));
    out.push('', `== ${fmt}: root causes of all evaluation errors`, ...top(errRoots, 60));
    out.push('', `== ${fmt}: why saved results were lost`, ...top(lost, 30));
    out.push('', `== ${fmt}: evaluation errors (all regions)`, ...top(errs, 30));
    out.push('', `== ${fmt}: file regions not found at their place`, ...top(unm, 20));
    out.push('', `== ${fmt}: results that differ`);
    for (const f of files) for (const d of f.saved.differ) out.push(`  ${f.file}: ${d.source}  ours ${d.ours}  theirs ${d.theirs}`);
  }
  return out.join('\n') + '\n';
}

// ------------------------------------------------------------ run

// The files run in CORPUS_JOBS child processes (default: up to 4 cores), each a vitest run of this
// file on a list of them (CORPUS_LIST). A file whose import and calculation take longer than
// CORPUS_FILE_TIMEOUT seconds (default 45; some calculations cannot be interrupted) is reported as
// not finished, and its process restarts on the files after it.
const JOBS = Math.max(1, Number(process.env.CORPUS_JOBS ?? Math.min(4, availableParallelism())));
const LIMIT = Math.max(5, Number(process.env.CORPUS_FILE_TIMEOUT ?? 45)) * 1000;
const LIST = process.env.CORPUS_LIST ?? '';

const all = DIR ? readdirSync(DIR).filter((f) => /\.(mcdx|xmcd|smz?)$/i.test(f) && (!FILTER || FILTER.test(f))).sort() : [];

/** Lists of about equal work: largest first, each to the least loaded (Prime packages are compressed). */
function shares(list: string[], n: number): string[][] {
  const out = Array.from({ length: n }, () => [] as string[]);
  const load = new Array<number>(n).fill(0);
  const cost = (f: string) => statSync(join(DIR, f)).size * (/\.mcdx$/i.test(f) ? 5 : /\.xmcd$/i.test(f) ? 0.3 : 1);
  for (const [f, c] of list.map((f) => [f, cost(f)] as const).sort((a, b) => b[1] - a[1])) {
    const k = load.indexOf(Math.min(...load));
    out[k].push(f);
    load[k] += c;
  }
  return out.filter((l) => l.length);
}

function writeReport(reports: FileReport[]) {
  if (!OUT || !reports.length) return;
  mkdirSync(dirname(OUT), { recursive: true });
  const byFormat = Object.fromEntries((['mcdx', 'xmcd', 'sm'] as Fmt[]).map((f) => [f, totals(reports.filter((r) => r.format === f))]));
  writeFileSync(`${OUT}.json`, JSON.stringify({ dir: DIR, date: new Date().toISOString(), timeLimit: LIMIT / 1000, totals: byFormat, files: reports }, null, 1));
  writeFileSync(`${OUT}.txt`, summary(reports));
}

/** Run a list of files in a child process; restart after a file that runs out of time. */
async function runList(list: string[], tag: string, results: Map<string, FileReport>): Promise<void> {
  const cli = join(dirname(createRequire(import.meta.url).resolve('vitest/package.json')), 'vitest.mjs');
  let rest = list;
  while (rest.length) {
    writeFileSync(`${tag}.list`, rest.join('\n'));
    for (const ext of ['jsonl', 'progress']) rmSync(`${tag}.${ext}`, { force: true });
    let stuck = '';
    let err = '';
    await new Promise<void>((done) => {
      const p = spawn(process.execPath, [cli, 'run', fileURLToPath(import.meta.url), '--testTimeout=0'], {
        env: { ...process.env, CORPUS_LIST: `${tag}.list`, CORPUS_OUT: tag },
        stdio: ['ignore', 'ignore', 'pipe'],
        // a process group of its own: vitest runs the tests in worker processes, which must go too
        detached: true,
      });
      p.stderr.on('data', (d: Buffer) => {
        err = (err + d.toString()).slice(-2000);
      });
      // the file a child is on, and since when
      const watch = setInterval(() => {
        if (!existsSync(`${tag}.progress`)) return;
        const last = readFileSync(`${tag}.progress`, 'utf8').trim().split('\n').pop() ?? '';
        const [at, file] = last.split('\t');
        if (file && Date.now() - Date.parse(at) > LIMIT && !stuck) {
          stuck = file;
          try {
            process.kill(-p.pid!, 'SIGKILL');
          } catch {
            p.kill('SIGKILL');
          }
        }
      }, 1000);
      p.on('close', () => {
        clearInterval(watch);
        done();
      });
    });
    if (existsSync(`${tag}.jsonl`)) {
      for (const line of readFileSync(`${tag}.jsonl`, 'utf8').split('\n')) {
        if (!line) continue;
        const r = JSON.parse(line) as FileReport;
        results.set(r.file, r);
      }
    }
    const next = rest.find((f) => !results.has(f));
    if (next) {
      // out of time, or the process died on it: report it as not finished and go on with the rest
      const { rep } = fileReport(next);
      rep.timedOut = true;
      rep.evalError = stuck === next ? `import and calculation took longer than ${LIMIT / 1000} s` : `the process ended on this file: ${err.trim().split('\n').pop() ?? ''}`;
      results.set(next, rep);
    }
    rest = rest.filter((f) => !results.has(f));
  }
  for (const ext of ['list', 'jsonl', 'progress']) rmSync(`${tag}.${ext}`, { force: true });
}

const isChild = !!LIST;
const files = isChild ? readFileSync(LIST, 'utf8').split('\n').filter(Boolean) : all;

describe.skipIf(!DIR)('corpus of real worksheets (CORPUS_DIR)', () => {
  beforeAll(() => loadCas());
  if (isChild) {
    // a child: one file at a time, each report written as soon as it is done
    it.each(files)('%s', (file) => {
      appendFileSync(`${OUT}.progress`, `${new Date().toISOString()}\t${file}\n`);
      appendFileSync(`${OUT}.jsonl`, JSON.stringify(analyse(file)) + '\n');
    });
  } else {
    it(`${all.length} files in ${Math.min(JOBS, all.length)} processes`, async () => {
      const base = OUT || join(tmpdir(), `corpus-${process.pid}`);
      mkdirSync(dirname(base), { recursive: true });
      const results = new Map<string, FileReport>();
      await Promise.all(shares(all, JOBS).map((list, k) => runList(list, `${base}.w${k}`, results)));
      const reports = all.map((f) => results.get(f)!).filter(Boolean);
      writeReport(reports);
      expect(reports.length).toBe(all.length);
    }, 0);
  }
});
