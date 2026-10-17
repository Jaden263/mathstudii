// What a worksheet becomes in another program, region by region, before any file format:
// math as statements (tree.ts), text as Markdown, solve blocks, plots where the format has
// them, and for the regions only mathstudii has (beams, plates, frames, CAD, sketches,
// drawings, Python, spreadsheets) a picture when the page could make one, a labelled note,
// and their scalar results as definitions, so that the math below them still calculates.
import { expandedLayout } from '../model/areas';
import { readingOrder, type PlotRegion, type Region, type SolveRegion, type TableRegion, type Worksheet } from '../model/types';
import { math, isUnit, isMatrix, isComplex } from '../engine/math';
import { unitParts } from '../engine/format';
import type { RegionResult } from '../engine/evaluator';
import { compileExpr, freeSymbols, parseExpr } from '../engine/compile';
import { ChainScope } from '../engine/scope';
import { splitComparison, parseStatement, splitTop, isIdentifier } from '../engine/syntax';
import { odesolveNames } from '../engine/odesolve';
import { pdesolveNames } from '../engine/pdesolve';
import { symbolicUnitNames } from '../engine/symbolic';
import { TreeReader, definedNames, plainNumber, NotRepresentable, type Op, type Statement, type X } from './tree';

export type Format = 'mcdx' | 'xmcd' | 'sm';

export const FORMAT_NAME: Record<Format, string> = { mcdx: 'Mathcad Prime', xmcd: 'Mathcad 15', sm: 'SMath Studio' };

export interface Picture {
  png: Uint8Array;
  width: number;
  height: number;
}

export interface ExportContext {
  /** PNG pictures of regions only mathstudii can draw (plots, beams …), by region id. */
  pictures?: Map<string, Picture>;
  /** The evaluated worksheet: its variables and what each region shows. */
  variables?: Map<string, unknown>;
  shown?: Map<string, unknown>;
  /** What each region calculated (the names a Python region assigned). */
  results?: Map<string, RegionResult>;
  metric?: boolean;
}

interface At { x: number; y: number }

export type Item =
  | (At & { k: 'math'; st: Statement; source: string; disabled?: boolean; result?: unknown; regionId?: string })
  | (At & { k: 'text'; width: number; md: string })
  | (At & { k: 'picture'; width: number; height: number; png: Uint8Array })
  | (At & { k: 'solve'; guesses: Statement[]; constraints: X[]; solver: Statement; result?: unknown; regionId: string })
  | (At & { k: 'plot'; width: number; height: number; traces: { x: X; y: X }[]; colors?: string[]; xUnit?: X; yUnit?: X; xmin?: X; xmax?: X; ymin?: X; ymax?: X });

export interface Plan {
  items: Item[];
  warnings: string[];
  title: string;
  origin: 0 | 1;
}

const KIND_NAME: Record<string, string> = {
  beam: 'beam', frame3d: '3-D frame', plate: 'plate', cad: 'CAD part', sketch: 'sketch', drawing: 'drawing',
  python: 'Python', spreadsheet: 'spreadsheet', plot: 'plot', image: 'picture', area: 'area', table: 'table',
};

/** The size an item takes on the page (px), roughly as the other program draws it. */
export function itemSize(it: Item): { w: number; h: number } {
  switch (it.k) {
    case 'math': {
      const lines = it.st.k === 'program' ? it.source.split('\n').length : 1;
      const rows = it.st.k === 'define' && it.st.value.k === 'matrix' ? it.st.value.rows.length : 1;
      const longest = Math.max(...it.source.split('\n').map((l) => l.length));
      return { w: Math.max(40, Math.min(640, 8.5 * longest + 16)), h: Math.max(26, 22 * lines, 21 * rows + 8) };
    }
    case 'text': {
      const perLine = Math.max(10, it.width / 7.5);
      const lines = it.md.split('\n').filter((l) => l.trim()).reduce((s, l) => s + Math.ceil(l.length / perLine), 0);
      return { w: it.width, h: Math.max(20, 19 * lines + 4) };
    }
    case 'picture':
    case 'plot':
      return { w: it.width, h: it.height };
    case 'solve':
      return { w: 320, h: 38.4 * (it.guesses.length + it.constraints.length + 1) + 20 };
  }
}

/**
 * Regions that grew (a note, a picture and values in place of a beam, a solve block) push what
 * is below them down, so that nothing overlaps and the order of calculation stays. What one
 * region became stays together; when that is several regions (or Mathcad 15's solve block, one
 * region per line), it holds the whole width of the page, so that a region beside it is not
 * calculated between them.
 */
function layout(items: Item[], group: number[], wideSolve: boolean): Item[] {
  const groups = new Map<number, Item[]>();
  items.forEach((it, i) => groups.set(group[i], [...(groups.get(group[i]) ?? []), it]));
  const list = [...groups.values()].map((its) => ({ its, y: Math.min(...its.map((i) => i.y)), x: Math.min(...its.map((i) => i.x)) }))
    .sort((a, b) => a.y - b.y || a.x - b.x);
  const placed: { x0: number; x1: number; y1: number; wide: boolean }[] = [];
  const out: Item[] = [];
  let shift = 0;
  for (const { its, y } of list) {
    const boxes = its.map((it) => ({ ...itemSize(it), dy: it.y - y }));
    const x0 = Math.min(...its.map((it) => it.x)), x1 = Math.max(...its.map((it, i) => it.x + boxes[i].w));
    let top = y + shift;
    const need = Math.max(0, ...placed.filter((p) => p.wide || (p.x0 < x1 && x0 < p.x1)).map((p) => p.y1));
    if (need > top) {
      shift += need - top;
      top = need;
    }
    its.forEach((it, i) => {
      it.y = top + boxes[i].dy;
      out.push(it);
    });
    const wide = its.length > 1 || (wideSolve && its.some((it) => it.k === 'solve'));
    placed.push({ x0, x1, y1: Math.max(...its.map((it, i) => it.y + boxes[i].h)) + 6, wide });
  }
  return out;
}

/** A note in place of an item the writer found it cannot hold, and its warning. */
export function notExported(it: Item, e: Error, program: string, plan: Plan): Extract<Item, { k: 'text' }> {
  const what = it.k === 'math' ? `\`${it.source.trim().split('\n')[0]}\`` : it.k === 'solve' ? 'a solve block' : `a ${it.k}`;
  plan.warnings.push(`${it.k === 'solve' ? 'solve block' : it.k} at ${Math.round(it.y)} px: uses ${e.message}, which ${program} cannot hold`);
  return { k: 'text', x: it.x, y: it.y, width: 320, md: `⚠ Not exported: ${what} (uses ${e.message}, which ${program} cannot hold)` };
}

/** A value that is a table of named values (a section's properties, a material). */
const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !isUnit(v) && !isMatrix(v) && !isComplex(v) && !Array.isArray(v);

export function makePlan(ws: Worksheet, format: Format, ctx: ExportContext = {}): Plan {
  const regions = readingOrder(expandedLayout(ws));
  const sources: string[] = [];
  for (const r of regions) {
    if (r.kind === 'math') sources.push(r.source);
    if (r.kind === 'solve') sources.push(...r.guesses.split('\n'), r.solver);
  }
  const names = definedNames(sources);
  // region results (b.M_max), tables, spreadsheet and Python outputs are worksheet values too
  for (const r of regions) {
    if ('name' in r && typeof r.name === 'string' && r.name.trim()) names.add(r.name.trim());
    if (r.kind === 'table' && r.columnVars) (r.headers ?? []).forEach((h) => h.trim() && names.add(h.trim()));
    if (r.kind === 'spreadsheet') r.outputs.forEach((o) => o.name.trim() && names.add(o.name.trim()));
  }
  if (regions.some((r) => r.kind === 'python')) for (const k of ctx.variables?.keys() ?? []) names.add(k);
  // the variable of an odesolve or Pdesolve block (t, x) and of a plot are names, not units (tonne)
  for (const r of regions) {
    if (r.kind === 'solve') [...odesolveNames(r.solver), ...pdesolveNames(r.solver)].forEach((n) => names.add(n));
    if (r.kind === 'plot') [r.xExpr, ...r.traces.map((t) => t.xExpr ?? '')].forEach((e) => isIdentifier(e) && names.add(e.trim()));
  }
  const reader = new TreeReader(names);
  // the fields of region results the worksheet reads: b.M_max, f.combos.ULS2.F1.Rx
  const usedPaths = new Map<string, string[][]>();
  for (const r of regions) {
    const text = r.kind === 'math' ? r.source : r.kind === 'solve' ? `${r.guesses}\n${r.constraints}\n${r.solver}` : r.kind === 'plot' ? [r.xExpr, r.z, ...r.traces.flatMap((t) => [t.y, t.xExpr ?? ''])].join('\n') : r.kind === 'text' ? r.markdown : '';
    for (const m of text.matchAll(/(?<![\p{L}\p{N}_.])([\p{L}_][\p{L}\p{N}_]*)((?:\.[\p{L}_][\p{L}\p{N}_]*)+)/gu)) {
      const list = usedPaths.get(m[1]) ?? [];
      list.push(m[2].slice(1).split('.'));
      usedPaths.set(m[1], list);
    }
  }
  /** In symbolic math a letter is a variable unless it is written as a unit (2 m), as the evaluator reads it. */
  const readerFor = (source: string): TreeReader => {
    const st = parseStatement(source);
    if (st.type !== 'symbolic') return reader;
    const units = symbolicUnitNames(st.expr, st.keywords, { scope: new ChainScope(null, ctx.variables ?? new Map()), functions: new Map() });
    const free = new Set<string>();
    for (const src of [st.expr, ...splitTop(st.keywords, ',')]) {
      try {
        freeSymbols(parseExpr(src.replace(/(^|[^=<>!])=(?!=)/g, '$1==')), free);
      } catch {
        /* reported when the statement is read */
      }
    }
    return new TreeReader([...names, ...[...free].filter((n) => !units.has(n))]);
  };
  const out: Plan = { items: [], warnings: [], title: ws.title || 'worksheet', origin: (ws.settings.origin ?? 0) as 0 | 1 };
  const metric = ctx.metric ?? (ws.settings.unitSystem ?? 'si') === 'si';
  const note = (at: At, md: string, width = 320) => out.items.push({ k: 'text', x: at.x, y: at.y, width, md });
  const failed = (r: Region, what: string, e: unknown) => {
    const msg = e instanceof NotRepresentable ? `uses ${e.message}, which ${FORMAT_NAME[format]} cannot hold` : (e as Error).message;
    out.warnings.push(`${what} at ${Math.round(r.y)} px: ${msg}`);
    note(r, `⚠ Not exported (${what}): ${msg}`);
  };

  /** A worksheet value as an expression of the target: numbers with units, matrices, text. */
  const valueX = (v: unknown, depth = 0): X | null => {
    if (typeof v === 'number') return Number.isFinite(v) ? signed(String(v)) : null;
    if (typeof v === 'boolean') return { k: 'num', v: v ? '1' : '0' };
    if (typeof v === 'string') return { k: 'str', v };
    if (isComplex(v)) {
      const im: X = { k: 'imag', v: plainNumber(String(Math.abs(v.im))) };
      return { k: 'op', op: v.im < 0 ? 'minus' : 'plus', args: [signed(String(v.re)), im] };
    }
    if (isUnit(v)) {
      const p = unitParts(v, undefined, metric);
      const n = typeof p.value === 'number' ? p.value : NaN;
      if (!Number.isFinite(n)) return null;
      if (!p.units) return signed(String(n));
      let unit: X;
      try {
        unit = reader.unit(p.units);
      } catch {
        return null;
      }
      const q: X = { k: 'scale', value: { k: 'num', v: plainNumber(String(Math.abs(n))) }, unit };
      return n < 0 ? { k: 'op', op: 'neg', args: [q] } : q;
    }
    if ((isMatrix(v) || Array.isArray(v)) && depth === 0) {
      const a = (isMatrix(v) ? v.toArray() : v) as unknown[];
      const rows = (a.length && Array.isArray(a[0]) ? a : a.map((x) => [x])) as unknown[][];
      if (rows.length * (rows[0]?.length ?? 0) > 400 || !rows.length) return null;
      const xs = rows.map((row) => row.map((c) => valueX(c, 1)));
      if (xs.some((row) => row.some((c) => !c))) return null;
      return { k: 'matrix', rows: xs as X[][] };
    }
    return null;
  };
  const valueText = (v: unknown): string => {
    if (isUnit(v)) {
      const p = unitParts(v, undefined, metric);
      return `${typeof p.value === 'number' ? +p.value.toPrecision(4) : String(p.value)}${p.units ? ' ' + p.units.replace(/ /g, '') : ''}`;
    }
    if (typeof v === 'number') return String(+v.toPrecision(4));
    try {
      return math.format(v as never, { precision: 4 });
    } catch {
      return String(v);
    }
  };

  /**
   * The results of a region named `name` (b.M_max, f.combos.ULS2.F1.Rx …) as definitions named
   * with _ (b_M_max): every one the worksheet reads, then its other top-level values, up to 24.
   */
  const resultsOf = (name: string): { name: string; value: unknown }[] => {
    const v = ctx.variables?.get(name);
    if (v === undefined) return [];
    const list = new Map<string, unknown>();
    for (const path of usedPaths.get(name) ?? []) {
      let x: unknown = v;
      for (const k of path) x = isRecord(x) ? x[k] : undefined;
      if (x !== undefined && valueX(x)) list.set([name, ...path].join('_'), x);
    }
    const used = list.size;
    const walk = (prefix: string, val: unknown, depth: number) => {
      if (list.size >= used + 24) return;
      if (isRecord(val)) {
        if (depth >= 1) return;
        for (const [k, x] of Object.entries(val)) if (/^[\p{L}_][\p{L}\p{N}_]*$/u.test(k)) walk(`${prefix}_${k}`, x, depth + 1);
        return;
      }
      if (typeof val !== 'function' && val !== undefined && val !== null && valueX(val) && !list.has(prefix)) list.set(prefix, val);
    };
    walk(name, v, 0);
    return [...list].map(([n, value]) => ({ name: n, value }));
  };

  const definitionItems = (at: At, defs: { name: string; value: unknown }[]) => {
    let y = at.y;
    for (const d of defs) {
      const value = valueX(d.value);
      if (!value) continue;
      out.items.push({ k: 'math', x: at.x, y, st: { k: 'define', global: false, target: { k: 'var', name: d.name }, value, show: false }, source: `${d.name} := ${valueText(d.value)}` });
      y += 28;
    }
    return y;
  };

  /** A region only mathstudii has: a labelled note with its values, its picture, its values as definitions. */
  const standIn = (r: Region, label: string, extra = '', defs: { name: string; value: unknown }[] = []) => {
    const pic = ctx.pictures?.get(r.id);
    const kind = KIND_NAME[r.kind] ?? r.kind;
    const listed = defs.slice(0, 12).map((d) => `${d.name} = ${valueText(d.value)}`);
    // a plot the other program has but this export cannot write as one, or a region it has not
    const why = r.kind === 'plot' ? `it is not written as a ${FORMAT_NAME[format]} plot` : `${FORMAT_NAME[format]} has no ${kind} region`;
    const md = [`**[mathstudii ${kind}${label ? ` “${label}”` : ''}]** ${pic ? 'shown as a picture' : 'not exported'}: ${why}.${extra ? ' ' + extra : ''}`,
      ...(listed.length ? [`Values: ${listed.join('; ')}${defs.length > listed.length ? ' …' : ''}`] : [])].join('\n\n');
    note(r, md, Math.max(260, Math.min(640, pic?.width ?? 0)));
    let y = r.y + itemSize(out.items[out.items.length - 1]).h + 6;
    if (pic) {
      const w = Math.min(pic.width, 640), h = Math.round((pic.height * w) / pic.width);
      out.items.push({ k: 'picture', x: r.x, y, width: w, height: h, png: pic.png });
      y += h + 8;
    }
    if (defs.length) definitionItems({ x: r.x, y }, defs);
    out.warnings.push(`The ${kind}${label ? ` ${label}` : ''} at ${Math.round(r.y)} px became ${[pic ? 'a picture' : 'a note', defs.length ? `${defs.length} value definition${defs.length > 1 ? 's' : ''}` : ''].filter(Boolean).join(' and ')}`);
  };
  const nameOf = (r: Region) => ('name' in r && typeof r.name === 'string' ? r.name.trim() : '');

  const group: number[] = [];
  regions.forEach((r, g) => {
    const first = out.items.length;
    try {
      switch (r.kind) {
        case 'math': {
          if (!r.source.trim()) break;
          const pst = parseStatement(r.source);
          const target = pst.type === 'define' && pst.lhs.kind === 'var' ? pst.lhs.name : null;
          const value = target ? ctx.variables?.get(target) : undefined;
          if (target && isRecord(value)) {
            // s := section("IPE 300"): a table of values, which the other program has no counterpart for
            const defs = resultsOf(target);
            note(r, `\`${r.source.trim()}\` is a mathstudii table of values; ${defs.length ? `its ${defs.length} values follow as ${target}_…` : 'it has no values to export'}.`, 360);
            definitionItems({ x: r.x, y: r.y + itemSize(out.items[out.items.length - 1]).h + 6 }, defs);
            out.warnings.push(`${target} at ${Math.round(r.y)} px is a table of values: written as ${defs.length} value definition${defs.length === 1 ? '' : 's'} (${target}_…)`);
            break;
          }
          let st: Statement | null;
          try {
            st = readerFor(r.source).statement(r.source);
          } catch (e) {
            // a definition the other program cannot write (b.M(x), section(…).I_y) as the value it has
            const v = target ? valueX(value) : null;
            if (!(e instanceof NotRepresentable) || !v || pst.type !== 'define') throw e;
            out.warnings.push(`${target} at ${Math.round(r.y)} px uses ${e.message}: written as its value`);
            out.items.push({ k: 'math', x: r.x, y: r.y, st: { k: 'define', global: pst.global, target: { k: 'var', name: target! }, value: v, show: pst.show, unit: pst.unit ? reader.unit(pst.unit) : undefined }, source: `${target} := ${valueText(value)}`, result: ctx.shown?.get(r.id), regionId: r.id });
            break;
          }
          if (!st) break;
          if (format === 'sm' && r.disabled) {
            note(r, `\`${r.source.trim()}\` *(disabled)*`);
            break;
          }
          out.items.push({ k: 'math', x: r.x, y: r.y, st, source: r.source, disabled: r.disabled, result: ctx.shown?.get(r.id), regionId: r.id });
          break;
        }
        case 'text': {
          // live values {{x|unit}} are written as they are now
          const md = r.markdown.replace(/\{\{([^}]+)\}\}/g, (all, raw: string) => {
            const [expr, unit] = raw.split('|').map((s) => s.trim());
            try {
              const scope = new ChainScope(null, ctx.variables ?? new Map());
              let v = compileExpr(expr).evaluate(scope);
              if (unit && isUnit(v)) v = math.unit(v.toNumeric(unit) as number, unit);
              return valueText(v);
            } catch {
              return all;
            }
          });
          out.items.push({ k: 'text', x: r.x, y: r.y, width: r.width, md });
          break;
        }
        case 'image': {
          const png = dataUrlPng(r.src) ?? ctx.pictures?.get(r.id)?.png;
          if (!png) {
            note(r, '⚠ A picture in a format other than PNG was not exported');
            out.warnings.push(`A picture at ${Math.round(r.y)} px is not a PNG and was left out`);
            break;
          }
          const size = pngSize(png);
          const width = r.width, height = size ? Math.round((size.h * r.width) / size.w) : Math.round(r.width * 0.75);
          out.items.push({ k: 'picture', x: r.x, y: r.y, width, height, png });
          break;
        }
        case 'solve':
          solve(r);
          break;
        case 'table':
          table(r);
          break;
        case 'plot':
          plot(r);
          break;
        case 'area':
          note(r, `## ${r.title || 'Area'}`, 300);
          break;
        case 'python': {
          // what the code assigned, as the values it has now
          const res = ctx.results?.get(r.id);
          const assigned = (res?.kind === 'python' ? res.outputs.map((o) => o.name) : undefined)
            ?? r.code.split('\n').flatMap((line) => /^([A-Za-z_]\w*)\s*=(?!=)/.exec(line)?.[1] ?? []);
          const defs = [...new Set(assigned)].filter((n) => ctx.variables?.has(n)).map((n) => ({ name: n, value: ctx.variables!.get(n) }));
          standIn(r, '', 'Its code is not run there; what it assigns follows as values.', defs.filter((d) => valueX(d.value)));
          break;
        }
        case 'spreadsheet':
          standIn(r, r.link?.file ?? '', '', r.outputs.filter((o) => o.name.trim() && ctx.variables?.has(o.name.trim())).map((o) => ({ name: o.name.trim(), value: ctx.variables!.get(o.name.trim()) })).filter((d) => valueX(d.value)));
          break;
        default:
          standIn(r, nameOf(r), '', nameOf(r) ? resultsOf(nameOf(r)) : []);
      }
    } catch (e) {
      failed(r, r.kind === 'math' ? 'math' : KIND_NAME[r.kind] ?? r.kind, e);
    }
    for (let i = first; i < out.items.length; i++) group[i] = g;
  });
  out.items = layout(out.items, group, format === 'xmcd');
  return out;

  function solve(r: SolveRegion) {
    const lines = (s: string) => s.split('\n').map((l) => l.trim()).filter(Boolean);
    const guesses = lines(r.guesses).map((g) => reader.statement(g)).filter((s): s is Statement => !!s);
    const constraints = lines(r.constraints).map((c) => {
      const parts = splitComparison(c);
      if (!parts) throw new Error(`the constraint “${c}” is not an equation or inequality`);
      const [l, op, rr] = parts;
      const OPS: Record<string, Op> = { '=': 'equal', '==': 'equal', '<': 'lessThan', '>': 'greaterThan', '<=': 'lessOrEqual', '>=': 'greaterOrEqual', '≤': 'lessOrEqual', '≥': 'greaterOrEqual', '!=': 'notEqual', '≠': 'notEqual' };
      return { k: 'op', op: OPS[op] ?? 'equal', args: [reader.expr(l), reader.expr(rr)] } as X;
    });
    const solver = reader.statement(r.solver);
    if (!solver) throw new Error('the solve block has no solver');
    if (format !== 'sm') {
      out.items.push({ k: 'solve', x: r.x, y: r.y, guesses, constraints, solver, regionId: r.id, result: ctx.shown?.get(r.id) });
      return;
    }
    // SMath has no solve blocks: the block as a note, what it found as values
    const st = parseStatement(r.solver);
    const targets = st.type === 'define' ? (st.lhs.kind === 'destructure' ? st.lhs.names : st.lhs.kind === 'var' ? [st.lhs.name] : []) : [];
    const defs = targets.map((t) => ({ name: t, value: ctx.variables?.get(t) })).filter((d) => valueX(d.value));
    const fnValued = st.type === 'define' && (st.lhs.kind === 'func' || targets.some((t) => typeof ctx.variables?.get(t) === 'function'));
    const found = defs.length ? 'what it found follows as values' : fnValued ? `its solution${targets.length ? ` ${targets.join(', ')}` : ''} is a function, which is not exported` : 'it found no value to export';
    note(r, `**[mathstudii solve block]** SMath Studio has no Given/Find block; ${found}.\n\nGiven ${lines(r.constraints).map((c) => `\`${c}\``).join(', ')}: \`${r.solver.trim()}\``, 360);
    definitionItems({ x: r.x, y: r.y + itemSize(out.items[out.items.length - 1]).h + 6 }, defs);
    out.warnings.push(`The solve block at ${Math.round(r.y)} px became ${defs.length ? `${defs.length} value definition${defs.length > 1 ? 's' : ''}` : 'a note'} (SMath has no solve blocks)`);
  }

  function table(r: TableRegion) {
    if (!r.name.trim()) throw new Error('a table without a name');
    const width = Math.max(1, r.units.length, r.headers?.length ?? 0, ...r.cells.map((c) => c.length));
    const rows = r.cells.filter((row) => row.some((c) => c.trim() !== ''));
    const unitX = r.units.map((u) => (u?.trim() ? reader.unit(u.trim()) : null));
    const cell = (t: string, j: number): X => {
      const s = t.trim();
      if (!s) return unitX[j] ? { k: 'scale', value: { k: 'num', v: '0' }, unit: unitX[j]! } : { k: 'num', v: '0' };
      let x: X;
      try {
        x = reader.expr(s);
      } catch {
        return { k: 'str', v: s };
      }
      if (x.k === 'id' && !names.has(x.name) && /[A-Za-z]/.test(s) && !/[*/^()+=]/.test(s)) return { k: 'str', v: s };
      const u = unitX[j];
      if (!u) return x;
      return x.k === 'num' ? { k: 'scale', value: x, unit: u } : { k: 'op', op: 'mult', args: [{ k: 'parens', a: x }, u] };
    };
    const name = r.name.trim();
    const columns = Array.from({ length: width }, (_, j) => j);
    // Mathcad 15 matrices hold one dimension: a table in several units becomes its columns
    const dims = new Set(columns.map((j) => {
      const u = r.units[j]?.trim();
      try {
        return u ? math.unit(1, u).toSI().formatUnits() : '';
      } catch {
        return u;
      }
    }));
    if (format === 'xmcd' && dims.size > 1) {
      note(r, `Table ${name}: a Mathcad 15 matrix holds one unit, so its columns follow as vectors.`, 300);
      let y = r.y + 30;
      for (const j of columns) {
        const col = (r.headers?.[j] ?? '').trim() || `${name}_${j + (ws.settings.origin ?? 0)}`;
        const value: X = { k: 'matrix', rows: rows.map((row) => [cell(row[j] ?? '', j)]) };
        out.items.push({ k: 'math', x: r.x, y, st: { k: 'define', global: false, target: { k: 'var', name: col }, value, show: false }, source: `${col} := (column ${j})` });
        y += 21 * rows.length + 16;
      }
      out.warnings.push(`Table ${name} at ${Math.round(r.y)} px: its columns are in different units, which a Mathcad 15 matrix cannot hold; written as one vector per column`);
      return;
    }
    const value: X = { k: 'matrix', rows: rows.map((row) => columns.map((j) => cell(row[j] ?? '', j))) };
    out.items.push({ k: 'math', x: r.x, y: r.y, st: { k: 'define', global: false, target: { k: 'var', name }, value, show: true }, source: `${name} := (table)`, result: ctx.variables?.get(name) });
    if (r.columnVars) {
      let y = r.y + 21 * rows.length + 30;
      (r.headers ?? []).forEach((h, j) => {
        if (!h.trim()) return;
        const col: X = { k: 'col', m: { k: 'id', name, role: 'var' }, j: { k: 'num', v: String(j + (ws.settings.origin ?? 0)) } };
        out.items.push({ k: 'math', x: r.x, y, st: { k: 'define', global: false, target: { k: 'var', name: h.trim() }, value: col, show: false }, source: `${h} := col(${name}, ${j})` });
        y += 28;
      });
    }
  }

  function plot(r: PlotRegion) {
    if (format === 'mcdx' && r.plotType === 'xy') {
      const ts = r.traces.filter((t) => t.y.trim());
      let traces: { x: X; y: X }[] = [];
      try {
        traces = ts.map((t) => ({ x: reader.expr((t.xExpr || r.xExpr).trim()), y: reader.expr(t.y.trim()) }));
      } catch (e) {
        // b.M(x) and the like: Prime cannot plot it, the picture shows it
        if (!(e instanceof NotRepresentable)) throw e;
      }
      if (traces.length) {
        const lim = (s: string) => (s.trim() ? reader.expr(s.trim()) : undefined);
        const argb = (c?: string) => (c && /^#[0-9a-f]{6}$/i.test(c) ? `#FF${c.slice(1).toUpperCase()}` : undefined);
        const colors = ts.map((t) => argb(t.color));
        out.items.push({
          k: 'plot', x: r.x, y: r.y, width: r.width, height: r.height, traces,
          colors: colors.some(Boolean) ? colors.map((c, i) => c ?? ['#FF00008B', '#FFB22222', '#FF228B22'][i % 3]) : undefined,
          xUnit: r.xUnit.trim() ? reader.unit(r.xUnit.trim()) : undefined, yUnit: r.yUnit.trim() ? reader.unit(r.yUnit.trim()) : undefined,
          xmin: lim(r.xmin), xmax: lim(r.xmax), ymin: lim(r.ymin), ymax: lim(r.ymax),
        });
        if (r.logX || r.logY) out.warnings.push(`Plot at ${Math.round(r.y)} px: logarithmic axes are written as linear ones`);
        return;
      }
    }
    standIn(r, r.title || '', r.plotType === 'xy' || r.plotType === 'polar' ? `It plots ${r.traces.map((t) => t.y).filter(Boolean).join(', ')} against ${r.xExpr}.` : `It shows ${r.z}.`);
  }
}

function signed(s: string): X {
  return s.startsWith('-') ? { k: 'op', op: 'neg', args: [{ k: 'num', v: plainNumber(s.slice(1)) }] } : { k: 'num', v: plainNumber(s) };
}

/** The bytes of a PNG data URL (other image types are not PNG and give null). */
export function dataUrlPng(src: string): Uint8Array | null {
  const m = /^data:image\/png;base64,(.*)$/s.exec(src);
  if (!m) return null;
  try {
    return Uint8Array.from(atob(m[1].replace(/\s+/g, '')), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/** Width and height from a PNG's IHDR. */
export function pngSize(png: Uint8Array): { w: number; h: number } | null {
  if (png.length < 24 || png[0] !== 0x89 || png[1] !== 0x50) return null;
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { w: dv.getUint32(16), h: dv.getUint32(20) };
}
