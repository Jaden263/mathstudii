// Python in the worksheet (Pyodide: CPython compiled to WebAssembly). Code regions see
// the worksheet variables defined above them and export what they assign. Values cross
// as tagged JSON, so units survive both ways (worksheet 5 kN ↔ Python Quantity ↔ 5 kN).
import type { PyodideAPI } from 'pyodide';
import type { Unit } from 'mathjs';
import { math, isMatrix, isUnit, isComplex } from '../engine/math';
import { normalize } from '../engine/library';
import PRELUDE from './prelude.py?raw';

export type PythonLoader = () => Promise<PyodideAPI>;

/** A value as it crosses the bridge (see _enc/_dec in prelude.py). */
type Wire = number | { t: string; [k: string]: unknown };

export interface PythonOutput {
  name: string;
  value?: unknown;
  /** Why the variable could not be exported (its Python type). */
  skip?: string;
}

export interface PythonRun {
  stdout: string;
  error?: string;
  /** 1-based line of the error in the region's code. */
  line?: number;
  outputs: PythonOutput[];
}

let py: PyodideAPI | null = null;
let starting: Promise<void> | null = null;
let runFn: ((code: string, inputs: string) => string) | null = null;
let callFn: ((id: number, args: string) => string) | null = null;
let resetFn: (() => void) | null = null;
/** Worksheet functions handed to Python in this evaluation. */
let jsFns = new Map<number, { f: (...a: unknown[]) => unknown; name: string }>();
const jsIds = new Map<unknown, number>();

export function pythonReady(): boolean {
  return py !== null;
}

/** Start Python (once). Later calls wait for the same start. */
export function initPython(load: PythonLoader): Promise<void> {
  starting ??= (async () => {
    const p = await load();
    p.runPython(PRELUDE, { filename: '<mathstudii>' });
    p.globals.set('_js_call', (id: number, args: string) => callJs(id, args));
    runFn = p.globals.get('_run');
    callFn = p.globals.get('_call_py');
    resetFn = p.globals.get('_reset');
    py = p;
  })().catch((e) => {
    starting = null;
    throw e;
  });
  return starting;
}

/** Load the packages (numpy, scipy …) the code imports. Pyodide fetches them on first use. */
export async function preparePackages(codes: string[]): Promise<void> {
  if (!py) return;
  for (const code of codes) {
    try {
      await py.loadPackagesFromImports(code, { messageCallback: () => {}, errorCallback: () => {} });
    } catch {
      /* the import fails when the code runs, with a hint (see withHint) */
    }
  }
}

/** Forget functions handed across in the previous evaluation. */
export function resetPython(): void {
  jsFns = new Map();
  jsIds.clear();
  resetFn?.();
}

const PY_KEYWORDS = new Set(('False None True and as assert async await break class continue def del elif else except finally for from '
  + 'global if import in is lambda nonlocal not or pass raise return try while with yield match case type').split(' '));
const PY_NAME = /^[\p{L}_][\p{L}\p{N}_]*$/u;

/** Worksheet variable names Python can see (no primes, keywords or private names). */
export function pythonName(name: string): boolean {
  return PY_NAME.test(name) && !name.startsWith('_') && !PY_KEYWORDS.has(name);
}

/** Run a code region with these worksheet variables. Python must be ready. */
export function runPython(code: string, vars: Iterable<[string, unknown]>): PythonRun {
  if (!runFn) throw new Error('Python is not loaded');
  const inputs: Record<string, Wire> = {};
  for (const [name, v] of vars) {
    if (!pythonName(name)) continue;
    try {
      inputs[name] = enc(v, name);
    } catch {
      /* not representable in Python: leave it out */
    }
  }
  const res = JSON.parse(runFn(code, JSON.stringify(inputs))) as {
    stdout: string;
    error: { msg: string; line: number | null } | null;
    outputs: { name: string; v?: Wire; skip?: string }[];
  };
  const out: PythonRun = { stdout: res.stdout, outputs: [] };
  if (res.error) {
    out.error = withHint(res.error.msg);
    if (res.error.line) out.line = res.error.line;
  }
  for (const o of res.outputs) {
    if (o.skip !== undefined) out.outputs.push({ name: o.name, skip: o.skip });
    else {
      try {
        out.outputs.push({ name: o.name, value: dec(o.v!) });
      } catch (e) {
        out.outputs.push({ name: o.name, skip: (e as Error).message });
      }
    }
  }
  return out;
}

function withHint(msg: string): string {
  const m = /^ModuleNotFoundError: No module named '([\w.]+)'/.exec(msg);
  if (!m || !py) return msg;
  const mod = m[1].split('.')[0];
  const known = Object.values(py.lockfile?.packages ?? {}).some((p) => p.imports?.includes(mod));
  if (known) return `${msg} — Pyodide has it, but it could not be downloaded (packages like numpy load from the internet the first time they are used)`;
  return `${msg} — not available in the browser's Python`;
}

// ---------------------------------------------------------------- worksheet → Python

const num = (x: number): Wire => (Number.isFinite(x) ? x : { t: 'f', v: Number.isNaN(x) ? 'nan' : x > 0 ? 'inf' : '-inf' });

/** mathjs dimension order: mass, length, time, current, temperature, luminous intensity, amount, angle, bit. */
const PY_DIM_FROM_MATHJS = [0, 1, 2, 3, 4, 6, 5];

function enc(v: unknown, name = 'f', depth = 0): Wire {
  if (depth > 40) throw new Error('too deep');
  if (typeof v === 'number') return num(v);
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string') return { t: 's', v };
  if (isComplex(v)) return { t: 'c', re: num(v.re), im: num(v.im) };
  if (isUnit(v)) {
    const u = v as Unit & { dimensions: number[]; value: unknown };
    if (u.value === null || u.value === undefined) throw new Error('unit without a value');
    if (typeof u.value !== 'number') throw new Error('complex quantity');
    const d = PY_DIM_FROM_MATHJS.map((i) => u.dimensions[i] ?? 0);
    // angles are plain numbers in radians on the Python side
    if (d.every((x) => x === 0)) return num(u.value);
    return { t: 'q', si: num(u.value), d };
  }
  if (isMatrix(v)) return enc(v.toArray(), name, depth);
  if (Array.isArray(v)) return { t: 'a', v: v.map((x) => enc(x, name, depth + 1)) };
  if (typeof v === 'function') {
    const pyid = (v as { __pyid?: number }).__pyid;
    if (pyid !== undefined) return { t: 'pf', id: pyid };
    let id = jsIds.get(v);
    if (id === undefined) {
      id = jsFns.size + 1;
      jsFns.set(id, { f: v as (...a: unknown[]) => unknown, name });
      jsIds.set(v, id);
    }
    return { t: 'jf', id, n: name };
  }
  if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
    const out: Record<string, Wire> = {};
    for (const [k, x] of Object.entries(v)) {
      try {
        out[k] = enc(x, k, depth + 1);
      } catch {
        /* skip this field */
      }
    }
    return { t: 'o', v: out };
  }
  throw new Error('not representable');
}

function callJs(id: number, args: string): string {
  const fn = jsFns.get(id);
  if (!fn) return JSON.stringify({ error: 'worksheet function no longer available' });
  try {
    const a = (JSON.parse(args) as Wire[]).map(dec);
    return JSON.stringify({ v: enc(normalize(fn.f(...a)), fn.name) });
  } catch (e) {
    return JSON.stringify({ error: (e as Error).message ?? String(e) });
  }
}

// ---------------------------------------------------------------- Python → worksheet

const BASE = ['kg', 'm', 's', 'A', 'K', 'mol', 'cd'];

/**
 * Display units per dimension (Python order kg, m, s, A, K, mol, cd). One entry: a named
 * unit mathjs prefixes itself (45 kN). Several: pick the largest that keeps the number ≥ 1.
 */
const DISPLAY: Record<string, string[]> = {
  '1,1,-2,0,0,0,0': ['N'],
  '1,-1,-2,0,0,0,0': ['Pa'],
  '1,2,-2,0,0,0,0': ['N m', 'kN m', 'MN m'],
  '1,0,-2,0,0,0,0': ['N/m', 'kN/m', 'MN/m'],
  '1,-2,-2,0,0,0,0': ['N/m^3', 'kN/m^3'],
  '1,2,-3,0,0,0,0': ['W'],
  '0,0,-1,0,0,0,0': ['Hz'],
  '0,2,0,0,0,0,0': ['mm^2', 'm^2'],
  '0,3,0,0,0,0,0': ['mm^3', 'cm^3', 'm^3'],
  '0,4,0,0,0,0,0': ['mm^4', 'cm^4', 'm^4'],
  '1,-3,0,0,0,0,0': ['kg/m^3'],
  '1,-1,0,0,0,0,0': ['kg/m'],
  '0,1,-1,0,0,0,0': ['m/s'],
  '0,1,-2,0,0,0,0': ['m/s^2'],
  '0,3,-1,0,0,0,0': ['m^3/s'],
  '1,2,-3,-1,0,0,0': ['V'],
  '1,2,-3,-2,0,0,0': ['ohm'],
  '0,0,1,1,0,0,0': ['C'],
};
const factorCache = new Map<string, number>();

function factor(unit: string): number {
  let f = factorCache.get(unit);
  if (f === undefined) {
    f = math.unit(1, unit).value as number;
    factorCache.set(unit, f);
  }
  return f;
}

function quantity(si: number, d: number[]): Unit {
  const key = d.join(',');
  const options = DISPLAY[key] ?? [d.map((p, i) => (p === 0 ? '' : p === 1 ? BASE[i] : `${BASE[i]}^${p}`)).filter(Boolean).join(' ')];
  let unit = options[0];
  for (const o of options) if (Math.abs(si / factor(o)) >= 1) unit = o;
  return math.unit(si / factor(unit), unit);
}

function dec(w: Wire): unknown {
  if (typeof w === 'number') return w;
  switch (w.t) {
    case 'f': return w.v === 'nan' ? NaN : w.v === 'inf' ? Infinity : -Infinity;
    case 'c': return math.complex(dec(w.re as Wire) as number, dec(w.im as Wire) as number);
    case 'q': {
      const si = dec(w.si as Wire) as number;
      const d = w.d as number[];
      return d.every((x) => x === 0) ? si : quantity(si, d);
    }
    case 's': return w.v as string;
    case 'a': {
      const items = (w.v as Wire[]).map(dec);
      if (items.length === 0) return math.matrix([]);
      return normalize(items);
    }
    case 'o': {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(w.v as Record<string, Wire>)) out[k] = dec(x);
      return out;
    }
    case 'jf': {
      const fn = jsFns.get(w.id as number);
      if (!fn) throw new Error('worksheet function no longer available');
      return fn.f;
    }
    case 'pf': return pyFunction(w.id as number, (w.p as string[] | undefined) ?? []);
    default: throw new Error(`unknown value from Python (${w.t})`);
  }
}

function pyFunction(id: number, params: string[]) {
  const f = (...args: unknown[]) => {
    if (!callFn) throw new Error('Python is not loaded');
    const res = JSON.parse(callFn(id, JSON.stringify(args.map((a) => enc(a))))) as { v?: Wire; error?: string };
    if (res.error !== undefined) throw new Error(res.error);
    return dec(res.v!);
  };
  Object.defineProperty(f, '__pyid', { value: id });
  Object.defineProperty(f, 'pyParams', { value: params });
  return f;
}

/** Parameter names of a function exported from Python (for display). */
export function pyParams(v: unknown): string[] | null {
  return typeof v === 'function' && '__pyid' in v ? ((v as unknown as { pyParams: string[] }).pyParams ?? []) : null;
}
