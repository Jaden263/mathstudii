// A workbook that calculates: cells hold what was typed ("=B2*2", "12.5", "text"), formulas
// are parsed once, a dependency graph of formula cells orders the calculation (Tarjan's
// strongly connected components: precedents first, and every cell of a cycle found), and
// formulas that give arrays spill into the cells below and to the right, as in Excel 365.
import { evalNode, toArr, type Ctx } from './evaluate';
import { parseFormula, functionsIn, FormulaError, type Node } from './formula';
import './functions';
import { formatValue } from './numfmt';
import { areaName, cellName, inArea, key, keyCol, keyRow, MAX_COLS, MAX_ROWS, parseCell, parseRange, quoteSheet, type Area } from './refs';
import { Arr, ERR, parseInput, Ref, XlError, type Scalar, type Value } from './values';

export interface CellStyle {
  /** Number format code ("0.00", "0%", "yyyy-mm-dd"). */
  fmt?: string;
  b?: boolean;
}

export interface SheetModel {
  name: string;
  /** Cell contents as typed, keyed "A1": "=B2*2", "12.5", "TRUE", "text", "'0123" (text). */
  cells: Record<string, string>;
  styles?: Record<string, CellStyle>;
  /** Column widths in px, by column index. */
  widths?: Record<string, number>;
  /** Merged areas ("A1:B2"). */
  merges?: string[];
}

export interface DefinedName {
  name: string;
  /** What the name stands for, as in a formula without "=": "Sheet1!$B$2:$B$9", "0.05". */
  ref: string;
  /** Index of the sheet a local name belongs to. */
  sheet?: number;
}

export interface WorkbookModel {
  sheets: SheetModel[];
  names?: DefinedName[];
  /** Dates counted from 1904 (old Mac Excel) instead of 1900. */
  date1904?: boolean;
}

interface Entry {
  src: string;
  node?: Node;
  value?: Scalar;
}

const VISITING = 1, DONE = 2;

/** Formats of cells whose formula is one of these functions and that have none of their own. */
const IMPLIED_FORMATS: Record<string, string> = {
  DATE: 'yyyy-mm-dd', TODAY: 'yyyy-mm-dd', EDATE: 'yyyy-mm-dd', EOMONTH: 'yyyy-mm-dd', DATEVALUE: 'yyyy-mm-dd', WORKDAY: 'yyyy-mm-dd',
  NOW: 'yyyy-mm-dd hh:mm', TIME: 'hh:mm:ss', TIMEVALUE: 'hh:mm:ss',
};

class SheetState {
  readonly entries = new Map<number, Entry>();
  readonly overrides = new Map<number, Scalar>();
  values = new Map<number, Scalar>();
  state = new Map<number, number>();
  spillOwner = new Map<number, number>();
  spills = new Map<number, Area>();
  /** Spill areas of the previous pass, so readers can ask for their anchor first. */
  prevOwner = new Map<number, number>();
  used: Area | null = null;
  constructor(readonly name: string, readonly styles: Record<string, CellStyle> = {}) {}
}

export interface Cycle {
  /** "Sheet1!A1 → Sheet1!B1 → Sheet1!A1" (sheet names left out on a one-sheet book). */
  text: string;
  cells: { sheet: number; r: number; c: number }[];
}

export class Workbook {
  readonly sheets: SheetState[];
  readonly date1904: boolean;
  now: number;
  private readonly names = new Map<string, { ref: string; node: Node | null; sheet?: number }>();
  cycles: Cycle[] = [];
  readonly unknownFunctions = new Set<string>();
  /** Formulas that could not be read: cell → message. */
  readonly parseErrors = new Map<string, string>();
  private nameDepth = 0;

  constructor(model: WorkbookModel, opts: { now?: number } = {}) {
    this.date1904 = !!model.date1904;
    this.now = opts.now ?? Date.now();
    this.sheets = model.sheets.map((s) => new SheetState(s.name, s.styles ?? {}));
    model.sheets.forEach((s, i) => {
      for (const [ref, src] of Object.entries(s.cells)) {
        const p = parseCell(ref);
        if (p) this.setCell(i, p.r, p.c, src);
      }
    });
    for (const n of model.names ?? []) {
      let node: Node | null = null;
      try {
        node = parseFormula(n.ref.replace(/^=/, ''));
      } catch {
        node = null;
      }
      this.names.set(`${n.sheet ?? ''}|${n.name.toUpperCase()}`, { ref: n.ref, node, sheet: n.sheet });
    }
  }

  /** Change what a cell holds (as typed); recalc() afterwards. */
  setCell(sheet: number, r: number, c: number, src: string): void {
    const sh = this.sheets[sheet];
    const k = key(r, c);
    const where = this.label(sheet, r, c);
    this.parseErrors.delete(where);
    if (!src) {
      sh.entries.delete(k);
      return;
    }
    const p = parseInput(src);
    if ('value' in p) {
      sh.entries.set(k, { src, value: p.value });
      return;
    }
    try {
      sh.entries.set(k, { src, node: parseFormula(p.formula) });
    } catch (e) {
      // Excel would not accept it; here the cell shows #NAME? and the reason is kept
      this.parseErrors.set(where, e instanceof FormulaError ? e.message : String(e));
      sh.entries.set(k, { src, value: e instanceof FormulaError && e.shows === '#REF!' ? ERR.ref : ERR.name });
    }
  }

  /** A value written over a cell for the next calculations (a worksheet input). */
  setInput(sheet: number, r: number, c: number, v: Scalar): void {
    this.sheets[sheet].overrides.set(key(r, c), v);
  }

  sheetIndex(name: string): number {
    const u = name.toUpperCase();
    return this.sheets.findIndex((s) => s.name.toUpperCase() === u);
  }

  label(sheet: number, r: number, c: number): string {
    return this.sheets.length > 1 ? `${quoteSheet(this.sheets[sheet].name)}!${cellName(r, c)}` : cellName(r, c);
  }

  /** A cell, range or defined name in the notation of a binding ("B2", "Sheet2!A1:C3", "loads"). */
  resolve(text: string, sheet = 0): { sheet: number; area: Area } | null {
    const p = parseRange(text);
    if (p) {
      const s = p.sheet === undefined ? sheet : this.sheetIndex(p.sheet);
      return s < 0 ? null : { sheet: s, area: { r1: p.r1, c1: p.c1, r2: p.r2, c2: p.c2 } };
    }
    const v = this.nameValue(text.trim(), sheet);
    return v instanceof Ref ? { sheet: v.sheet, area: { r1: v.r1, c1: v.c1, r2: v.r2, c2: v.c2 } } : null;
  }

  value(sheet: number, r: number, c: number): Scalar {
    const sh = this.sheets[sheet];
    const k = key(r, c);
    if (sh.overrides.has(k)) return sh.overrides.get(k)!;
    const e = sh.entries.get(k);
    if (e) return e.node ? (sh.values.get(k) ?? null) : (e.value ?? null);
    return sh.spillOwner.has(k) ? (sh.values.get(k) ?? null) : null;
  }

  /** What the cell shows, in its number format (General numbers in `width` characters). */
  display(sheet: number, r: number, c: number, width?: number): string {
    const sh = this.sheets[sheet];
    // a formula giving a date shows it as one, as Excel formats such a cell when it is entered
    const node = sh.entries.get(key(r, c))?.node;
    const fmt = sh.styles[cellName(r, c)]?.fmt ?? (node?.t === 'fn' ? IMPLIED_FORMATS[node.name] : undefined);
    return formatValue(this.value(sheet, r, c), fmt, this.date1904, width);
  }

  input(sheet: number, r: number, c: number): string {
    return this.sheets[sheet].entries.get(key(r, c))?.src ?? '';
  }

  isFormula(sheet: number, r: number, c: number): boolean {
    return !!this.sheets[sheet].entries.get(key(r, c))?.node;
  }

  /** A worksheet input is written over this cell. */
  isInput(sheet: number, r: number, c: number): boolean {
    return this.sheets[sheet].overrides.has(key(r, c));
  }

  /** The area a formula's array result fills (null when it gave one value). */
  spillArea(sheet: number, r: number, c: number): Area | null {
    return this.sheets[sheet].spills.get(key(r, c)) ?? null;
  }

  /** The formula cell whose array result fills this cell, if any. */
  spillAnchor(sheet: number, r: number, c: number): { r: number; c: number } | null {
    const a = this.sheets[sheet].spillOwner.get(key(r, c));
    return a === undefined ? null : { r: keyRow(a), c: keyCol(a) };
  }

  /** Cells that have a value (typed, calculated or spilled), in row order. */
  *cells(sheet: number): Generator<{ r: number; c: number; v: Scalar }> {
    const sh = this.sheets[sheet];
    const keys = new Set<number>([...sh.entries.keys(), ...sh.spillOwner.keys(), ...sh.overrides.keys()]);
    for (const k of [...keys].sort((a, b) => a - b)) yield { r: keyRow(k), c: keyCol(k), v: this.value(sheet, keyRow(k), keyCol(k)) };
  }

  usedArea(sheet: number): Area | null {
    return this.sheets[sheet].used;
  }

  // ------------------------------------------------------------ calculation

  recalc(): void {
    this.unknownFunctions.clear();
    this.pass();
    // a formula reading cells another formula spills into needs that formula first: once
    // the spill areas are known, calculate again with them
    if (this.sheets.some((s) => s.spillOwner.size)) {
      for (const s of this.sheets) s.prevOwner = s.spillOwner;
      this.pass();
      for (const s of this.sheets) s.prevOwner = new Map();
    }
  }

  private pass(): void {
    for (const sh of this.sheets) {
      sh.values = new Map();
      sh.state = new Map();
      sh.spillOwner = new Map();
      sh.spills = new Map();
      sh.used = null;
      for (const k of [...sh.entries.keys(), ...sh.overrides.keys()]) grow(sh, keyRow(k), keyCol(k));
      for (const [k, a] of sh.prevOwner) if (a !== k) grow(sh, keyRow(k), keyCol(k));
    }
    const { order, cycles } = this.graph();
    this.cycles = cycles;
    for (const cy of cycles) {
      for (const p of cy.cells) {
        const sh = this.sheets[p.sheet], k = key(p.r, p.c);
        sh.values.set(k, ERR.circ);
        sh.state.set(k, DONE);
      }
    }
    for (const [s, k] of order) if (this.sheets[s].state.get(k) !== DONE) this.compute(s, k);
  }

  private get = (s: number, r: number, c: number): Scalar => {
    const sh = this.sheets[s];
    if (!sh) return ERR.ref;
    const k = key(r, c);
    if (sh.overrides.has(k)) return sh.overrides.get(k)!;
    const e = sh.entries.get(k);
    if (e) {
      if (!e.node) return e.value ?? null;
      const st = sh.state.get(k);
      if (st === DONE) return sh.values.get(k) ?? null;
      if (st === VISITING) return ERR.circ;
      return this.compute(s, k);
    }
    if (!sh.spillOwner.has(k)) {
      const a = sh.prevOwner.get(k);
      if (a !== undefined && sh.state.get(a) !== DONE && sh.entries.get(a)?.node) this.compute(s, a);
    }
    return sh.spillOwner.has(k) ? (sh.values.get(k) ?? null) : null;
  };

  private ctx(s: number, r: number, c: number): Ctx {
    return {
      sheet: s, row: r, col: c, date1904: this.date1904, now: this.now,
      get: this.get,
      used: (i) => this.sheets[i]?.used ?? null,
      sheetIndex: (n) => this.sheetIndex(n),
      sheetCount: () => this.sheets.length,
      name: (n, sheet) => this.nameValue(n, sheet === undefined ? s : this.sheetIndex(sheet), r, c),
      unknown: (n) => this.unknownFunctions.add(n),
    };
  }

  private nameValue(name: string, sheet: number, r = 0, c = 0): Value | undefined {
    const u = name.toUpperCase();
    const n = this.names.get(`${sheet}|${u}`) ?? this.names.get(`|${u}`);
    if (!n) return undefined;
    if (!n.node || this.nameDepth > 16) return ERR.ref;
    this.nameDepth++;
    try {
      return evalNode(n.node, this.ctx(n.sheet ?? sheet, r, c));
    } finally {
      this.nameDepth--;
    }
  }

  private compute(s: number, k: number): Scalar {
    const sh = this.sheets[s];
    const e = sh.entries.get(k)!;
    const r = keyRow(k), c = keyCol(k);
    sh.state.set(k, VISITING);
    const ctx = this.ctx(s, r, c);
    let v: Value;
    try {
      v = evalNode(e.node!, ctx);
    } catch (err) {
      if (err instanceof RangeError) v = ERR.calc; // too deep: a chain of dependents beyond the stack
      else throw err;
    }
    let out: Scalar;
    if (v instanceof Ref && v.single) out = this.get(v.sheet, v.r1, v.c1) ?? 0;
    else if (v instanceof Ref || v instanceof Arr) {
      let arr: Arr;
      try {
        arr = toArr(v, ctx);
      } catch (err) {
        if (!(err instanceof XlError)) throw err;
        arr = new Arr([[err]]);
      }
      out = arr.h === 1 && arr.w === 1 ? (arr.rows[0][0] ?? 0) : this.spill(s, r, c, arr);
    } else out = v ?? 0;
    sh.values.set(k, out);
    sh.state.set(k, DONE);
    return out;
  }

  /** Put an array into the cells from (r, c); the anchor's value, or #SPILL! when a cell is taken. */
  private spill(s: number, r: number, c: number, arr: Arr): Scalar {
    const sh = this.sheets[s];
    if (r + arr.h > MAX_ROWS || c + arr.w > MAX_COLS) return ERR.spill;
    const anchor = key(r, c);
    for (let i = 0; i < arr.h; i++) for (let j = 0; j < arr.w; j++) {
      if (!i && !j) continue;
      const k = key(r + i, c + j);
      const owner = sh.spillOwner.get(k);
      if (sh.entries.has(k) || sh.overrides.has(k) || (owner !== undefined && owner !== anchor)) return ERR.spill;
    }
    sh.spills.set(anchor, { r1: r, c1: c, r2: r + arr.h - 1, c2: c + arr.w - 1 });
    for (let i = 0; i < arr.h; i++) for (let j = 0; j < arr.w; j++) {
      const k = key(r + i, c + j);
      sh.spillOwner.set(k, anchor);
      if (i || j) sh.values.set(k, arr.rows[i][j] ?? 0);
      grow(sh, r + i, c + j);
    }
    return arr.rows[0][0] ?? 0;
  }

  // ------------------------------------------------------------ dependency graph

  /** Areas a formula reads, as written (names followed). */
  private precedents(node: Node, sheet: number, out: { sheet: number; area: Area }[], depth = 0): void {
    switch (node.t) {
      case 'ref': {
        const s1 = node.ref.sheet === undefined ? sheet : this.sheetIndex(node.ref.sheet);
        const s2 = node.ref.sheet2 === undefined ? s1 : this.sheetIndex(node.ref.sheet2);
        if (s1 < 0 || s2 < 0) return;
        for (let s = Math.min(s1, s2); s <= Math.max(s1, s2); s++) out.push({ sheet: s, area: node.ref.area });
        return;
      }
      case 'name': {
        const s = node.sheet === undefined ? sheet : this.sheetIndex(node.sheet);
        const n = this.names.get(`${s}|${node.name.toUpperCase()}`) ?? this.names.get(`|${node.name.toUpperCase()}`);
        if (n?.node && depth < 16) this.precedents(n.node, n.sheet ?? s, out, depth + 1);
        return;
      }
      case 'fn': node.args.forEach((a) => this.precedents(a, sheet, out, depth)); return;
      case 'bin': this.precedents(node.a, sheet, out, depth); this.precedents(node.b, sheet, out, depth); return;
      case 'un': case 'pct': this.precedents(node.a, sheet, out, depth); return;
      default: return;
    }
  }

  private graph(): { order: [number, number][]; cycles: Cycle[] } {
    const nodes: [number, number][] = [];
    const index = this.sheets.map(() => new Map<number, number>());
    this.sheets.forEach((sh, s) => {
      for (const [k, e] of sh.entries) if (e.node && !sh.overrides.has(k)) { index[s].set(k, nodes.length); nodes.push([s, k]); }
    });
    const formulaKeys = index.map((m) => [...m.keys()]);
    const adj: number[][] = nodes.map(([s, k]) => {
      const refs: { sheet: number; area: Area }[] = [];
      this.precedents(this.sheets[s].entries.get(k)!.node!, s, refs);
      const out = new Set<number>();
      for (const { sheet, area } of refs) {
        const m = index[sheet];
        if (!m.size) continue;
        const cellsInArea = (area.r2 - area.r1 + 1) * (area.c2 - area.c1 + 1);
        if (cellsInArea <= m.size) {
          for (let r = area.r1; r <= area.r2; r++) for (let c = area.c1; c <= area.c2; c++) {
            const j = m.get(key(r, c));
            if (j !== undefined) out.add(j);
          }
        } else {
          for (const fk of formulaKeys[sheet]) if (inArea(area, keyRow(fk), keyCol(fk))) out.add(m.get(fk)!);
        }
      }
      return [...out];
    });
    // Tarjan, without recursion: components come out precedents first
    const n = nodes.length;
    const idx = new Int32Array(n).fill(-1), low = new Int32Array(n), onStack = new Uint8Array(n);
    const stack: number[] = [], order: [number, number][] = [], cycles: Cycle[] = [];
    let counter = 0;
    for (let v0 = 0; v0 < n; v0++) {
      if (idx[v0] >= 0) continue;
      const calls: [number, number][] = [[v0, 0]];
      idx[v0] = low[v0] = counter++;
      stack.push(v0);
      onStack[v0] = 1;
      while (calls.length) {
        const top = calls[calls.length - 1];
        const u = top[0];
        if (top[1] < adj[u].length) {
          const w = adj[u][top[1]++];
          if (idx[w] < 0) {
            idx[w] = low[w] = counter++;
            stack.push(w);
            onStack[w] = 1;
            calls.push([w, 0]);
          } else if (onStack[w]) low[u] = Math.min(low[u], idx[w]);
          continue;
        }
        calls.pop();
        if (calls.length) low[calls[calls.length - 1][0]] = Math.min(low[calls[calls.length - 1][0]], low[u]);
        if (low[u] !== idx[u]) continue;
        const comp: number[] = [];
        let w: number;
        do {
          w = stack.pop()!;
          onStack[w] = 0;
          comp.push(w);
        } while (w !== u);
        if (comp.length > 1 || adj[u].includes(u)) cycles.push(this.cycleOf(comp, adj, nodes));
        else order.push(nodes[u]);
      }
    }
    return { order, cycles };
  }

  /** One loop through a strongly connected component, for the message. */
  private cycleOf(comp: number[], adj: number[][], nodes: [number, number][]): Cycle {
    const inComp = new Set(comp);
    // start at the first cell in reading order, then breadth-first back to it
    const start = comp.reduce((a, b) => (nodes[b][0] < nodes[a][0] || (nodes[b][0] === nodes[a][0] && nodes[b][1] < nodes[a][1]) ? b : a));
    const prev = new Map<number, number>();
    const queue = [start];
    let last = -1;
    while (queue.length && last < 0) {
      const u = queue.shift()!;
      for (const w of adj[u]) {
        if (!inComp.has(w)) continue;
        if (w === start) { last = u; break; }
        if (!prev.has(w)) { prev.set(w, u); queue.push(w); }
      }
    }
    // start reads …, which reads start
    const loop = [start];
    for (let u = last; u !== start && u >= 0; u = prev.get(u)!) loop.splice(1, 0, u);
    loop.push(start);
    const cells = comp.map((i) => ({ sheet: nodes[i][0], r: keyRow(nodes[i][1]), c: keyCol(nodes[i][1]) }));
    return { text: loop.map((i) => this.label(nodes[i][0], keyRow(nodes[i][1]), keyCol(nodes[i][1]))).join(' → '), cells };
  }

  /** Every function the formulas call that this engine does not have. */
  functionsUsed(): Set<string> {
    const out = new Set<string>();
    for (const sh of this.sheets) for (const e of sh.entries.values()) if (e.node) functionsIn(e.node, out);
    return out;
  }

  /** The values of an area (rows of scalars). */
  areaValues(sheet: number, a: Area): Scalar[][] {
    const rows: Scalar[][] = [];
    for (let r = a.r1; r <= a.r2; r++) {
      const row: Scalar[] = [];
      for (let c = a.c1; c <= a.c2; c++) row.push(this.value(sheet, r, c));
      rows.push(row);
    }
    return rows;
  }

  areaLabel(sheet: number, a: Area): string {
    return this.sheets.length > 1 ? `${quoteSheet(this.sheets[sheet].name)}!${areaName(a)}` : areaName(a);
  }
}

function grow(sh: SheetState, r: number, c: number) {
  const u = sh.used;
  if (!u) sh.used = { r1: r, c1: c, r2: r, c2: c };
  else {
    if (r < u.r1) u.r1 = r;
    if (r > u.r2) u.r2 = r;
    if (c < u.c1) u.c1 = c;
    if (c > u.c2) u.c2 = c;
  }
}

/** Calculate a workbook model as it is. */
export function calculate(model: WorkbookModel, opts?: { now?: number }): Workbook {
  const wb = new Workbook(model, opts);
  wb.recalc();
  return wb;
}
