import { beforeAll, describe, expect, it } from 'vitest';
import { loadPyodide } from 'pyodide';
import { initPython, runPython, resetPython, pyParams } from './runtime';
import { math } from '../engine/math';
import { evaluateWorksheet, type MathResult } from '../engine/evaluator';
import { createRegion, emptyWorksheet, type Region } from '../model/types';

beforeAll(async () => {
  await initPython(() => loadPyodide());
}, 60000);

const unit = (s: string) => math.unit(s);
const si = (v: unknown) => (v as { value: number }).value;

describe('python bridge', () => {
  it('runs code and captures print output', () => {
    const r = runPython('x = 6 * 7\nprint("hello", x)', []);
    expect(r.error).toBeUndefined();
    expect(r.stdout).toBe('hello 42\n');
    expect(r.outputs).toEqual([{ name: 'x', value: 42 }]);
  });

  it('passes units both ways', () => {
    const r = runPython('M = q * L**2 / 8\nM_kNm = M.to("kN*m")\ns = f"{M:.1f kN*m}"', [['q', unit('10 kN/m')], ['L', unit('6 m')]]);
    expect(r.error).toBeUndefined();
    const out = Object.fromEntries(r.outputs.map((o) => [o.name, o.value]));
    expect(si(out.M)).toBeCloseTo(45000);
    expect(math.equal(math.unit((out.M as math.Unit).toString()), unit('45 kN m'))).toBe(true);
    expect(out.M_kNm).toBeCloseTo(45);
    expect(out.s).toBe('45.0 kN*m');
  });

  it('catches unit errors and reports the line', () => {
    const r = runPython('a = 1\nb = L + 2', [['L', unit('6 m')]]);
    expect(r.error).toMatch(/TypeError: unsupported units for \+: m and a plain number/);
    expect(r.line).toBe(2);
    expect(r.outputs).toEqual([]);
    const s = runPython('def f(:\n  pass', []);
    expect(s.error).toMatch(/SyntaxError/);
    expect(s.line).toBe(1);
  });

  it('does not export unchanged inputs, modules or private names', () => {
    const r = runPython('import math\n_tmp = 3\nx = x\nz = x * 2', [['x', 3]]);
    expect(r.outputs.map((o) => o.name)).toEqual(['z']);
    const loop = runPython('total = 0\nfor i in range(4):\n    sq = i * i\n    total += sq\nwith open("/tmp/x", "w") as fh:\n    pass\nclass C:\n    k = 1', []);
    expect(loop.outputs.map((o) => o.name)).toEqual(['total']);
  });

  it('shows results in engineering units', () => {
    const r = runPython('M = Q(45, "kN*m")\nI = Q(8356, "cm^4")\nF = Q(2500, "N")', []);
    const out = Object.fromEntries(r.outputs.map((o) => [o.name, (o.value as math.Unit).toString()]));
    expect(out.M).toBe('45 kN m');
    expect(out.I).toBe('8356 cm^4');
    expect(out.F).toBe('2.5 kN');
  });

  it('converts lists, vectors and matrices', () => {
    const r = runPython('w = [2*x for x in v]\nA = [[1, 2], [3, 4]]\nn = len(v)\nlens = [Q(1, "mm"), Q(2, "mm")]', [['v', math.matrix([1, 2, 3])]]);
    const out = Object.fromEntries(r.outputs.map((o) => [o.name, o.value]));
    expect((out.w as math.Matrix).toArray()).toEqual([2, 4, 6]);
    expect((out.A as math.Matrix).size()).toEqual([2, 2]);
    expect(out.n).toBe(3);
    expect(si((out.lens as math.Matrix).get([1]))).toBeCloseTo(0.002);
  });

  it('exports Python functions callable from the worksheet, and calls worksheet functions', () => {
    resetPython();
    const sq = (x: unknown) => math.multiply(x as number, x as number);
    const r = runPython('def area(b, h):\n    return b * h\ng = sq(Q(3, "m"))', [['sq', sq]]);
    expect(r.error).toBeUndefined();
    const area = r.outputs.find((o) => o.name === 'area')!.value as (...a: unknown[]) => unknown;
    expect(pyParams(area)).toEqual(['b', 'h']);
    expect(si(area(unit('2 m'), unit('300 mm')))).toBeCloseTo(0.6);
    expect(si(r.outputs.find((o) => o.name === 'g')!.value)).toBeCloseTo(9);
  });

  it('reads worksheet objects with attribute access', () => {
    const r = runPython('m = b.M_max.to("kN*m")', [['b', { M_max: unit('12 kN m'), name: 'x' }]]);
    expect(r.outputs[0].value).toBeCloseTo(12);
  });
});

describe('python regions in a worksheet', () => {
  const sheet = (regions: Region[]) => ({ ...emptyWorksheet(), regions });

  it('uses variables above and feeds results to regions below', () => {
    const ws = sheet([
      createRegion('math', 0, 0, { source: 'q := 8 kN/m' }),
      createRegion('math', 0, 40, { source: 'L := 5 m' }),
      createRegion('python', 0, 80, { code: 'M = q * L**2 / 8\ndef double(x):\n    return 2 * x\nprint(M)' }),
      createRegion('math', 0, 300, { source: 'M = kN m' }),
      createRegion('math', 0, 340, { source: 'double(M) = kN m' }),
    ]);
    const out = evaluateWorksheet(ws);
    const py = out.results.get(ws.regions[2].id)!;
    expect(py.kind).toBe('python');
    if (py.kind !== 'python') return;
    expect(py.error).toBeUndefined();
    expect(py.stdout).toContain('25000 N·m');
    expect(py.outputs.map((o) => o.name)).toEqual(['M', 'double']);
    expect((out.results.get(ws.regions[3].id) as MathResult).tex).toContain('25');
    expect((out.results.get(ws.regions[4].id) as MathResult).tex).toContain('50');
    expect(out.errorCount).toBe(0);
  });

  it('only sees variables defined above it', () => {
    const ws = sheet([
      createRegion('python', 0, 0, { code: 'y = x + 1' }),
      createRegion('math', 0, 200, { source: 'x := 1' }),
    ]);
    const out = evaluateWorksheet(ws);
    const py = out.results.get(ws.regions[0].id)!;
    expect(py.kind === 'python' && py.error).toMatch(/NameError: name 'x' is not defined/);
  });
});
