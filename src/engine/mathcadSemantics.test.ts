// Mathcad semantics that imported worksheets rely on, each checked against the value Mathcad
// saved with a real worksheet or against PTC's documented behaviour.
import { describe, it, expect, beforeAll } from 'vitest';
import { evaluateWorksheet, evaluateWithScope, type MathResult, type SolveResult } from './evaluator';
import { emptyWorksheet, createRegion, type Region, type Worksheet } from '../model/types';
import { loadCas } from './symbolic';

function sheet(lines: (string | Region)[], settings: Partial<Worksheet['settings']> = {}): Worksheet {
  const ws = emptyWorksheet();
  ws.settings = { ...ws.settings, ...settings };
  ws.regions = lines.map((l, i) => {
    const r = typeof l === 'string' ? createRegion('math', 40, 40 + i * 40, { source: l }) : l;
    r.y = 40 + i * 40;
    return r;
  });
  return ws;
}

/** The results of every region. */
function run(lines: (string | Region)[], settings?: Partial<Worksheet['settings']>) {
  const ws = sheet(lines, settings);
  const out = evaluateWorksheet(ws);
  return ws.regions.map((r) => out.results.get(r.id)!);
}

/** The shown value of the last region (the TeX after its last "="). */
function shown(lines: (string | Region)[], settings?: Partial<Worksheet['settings']>): string {
  const res = run(lines, settings);
  const last = res[res.length - 1];
  const tex = last.kind === 'solve' ? (last as SolveResult).solver.tex : (last as MathResult).tex;
  const err = last.kind === 'solve' ? (last as SolveResult).solver.error : (last as MathResult).error;
  if (err) throw new Error(err);
  return tex.slice(tex.lastIndexOf(' = ') + 3);
}

beforeAll(async () => {
  await loadCas();
});

describe('names', () => {
  it('may be written in any alphabet (Cyrillic worksheets)', () => {
    expect(shown(['m_сух := 3', 'm_топ := 1', 'm_0 := m_сух + m_топ =', 'F_аэрод(V) := 2 V', 'F_аэрод(m_0) ='])).toBe('8');
    expect(shown(['Höhe := 2 m', 'Höhe^2 ='])).toMatch(/^4\\ \\mathrm\{m\}\^\{2\}$/);
  });
  it('keep Σ, π and Γ that are letters of a name (γ_Σ_dB), while Σ(…), 2 π and Γ(…) stay operators', () => {
    expect(shown(['γ_Σ_dB := 30', 'γ_Σ := 10^(γ_Σ_dB/10)', 'x_π := 2', 'γ_Σ + x_π ='])).toBe('1002');
    expect(shown(['Σ(k, k, 1, 4) + Γ(5) ='])).toBe('34');
    expect(shown(['2π ='])).toBe('6.2832');
  });
});

describe('odesolve', () => {
  it('takes Prime’s form odesolve(y(t), b) with the unknown written with its variable', () => {
    const block = createRegion('solve', 40, 0, { guesses: '', constraints: "h''(t) = -9.81\nh(0) = 0\nh'(0) = 10", solver: 'h := odesolve(h(t), 3)' });
    // h(1) = 10 − 9.81/2
    expect(shown([block, 'h(1) ='])).toBe('5.095');
  });
});

describe('arithmetic', () => {
  it('adds a plain 0 to a quantity of any unit (a matrix product over [w, 0; 0, l])', () => {
    // RC_col.mcdx: Contour := ½·([−1, −1; …]·[w_c, 0; 0, l_c]) saved as ±0.65 m corners
    expect(shown(['w := 1.3 m', 'l := 1.3 m', 'C := 1/2*([-1, -1; -1, 1]*[w, 0; 0, l])', 'C[1, 1] = m'])).toMatch(/^0\.65\\ \\mathrm\{m\}$/);
    expect(shown(['a := 2 m', 'a - 0 + (0 - a) ='])).toBe('0\\ \\mathrm{m}');
    expect(() => shown(['a := 2 m', 'a + 1 ='])).toThrow(/Units do not match/);
  });
  it('raises a vector to a power element by element, a square matrix as a matrix', () => {
    // GBerezin Column.mcdx: A_s := π·d_s²/4 of a vector of bar diameters, saved as a vector of areas
    expect(shown(['d_s := [32; 18] mm', 'A_s := π*d_s^2/4 = cm^2'])).toMatch(/8\.0425 \\\\ 2\.5447/);
    expect(shown(['[1, 2; 3, 4]^2 ='])).toMatch(/7 & 10 \\\\ 15 & 22/);
  });
});

describe('ORIGIN', () => {
  it('is a variable worksheets read, and ORIGIN := 1 moves the first index from there on', () => {
    expect(shown(['ORIGIN ='])).toBe('0');
    expect(shown(['ORIGIN ='], { origin: 1 })).toBe('1');
    expect(shown(['v := [5; 6; 7]', 'ORIGIN := 1', 'v[ORIGIN] + v[3] ='])).toBe('12');
  });
});

describe('comparisons and programs', () => {
  it('a comparison followed by = has the value 1 or 0', () => {
    const ws = sheet(['a := 2', 'a < 3 =', 'a > 3 =']);
    const { shown: values } = evaluateWithScope(ws);
    expect(ws.regions.slice(1).map((r) => values.get(r.id))).toEqual([1, 0]);
  });
  it('a program whose last if is false has the value computed before it', () => {
    // kut666 practice worksheets (Mathcad 15): the value of the last line that ran
    expect(shown(['f(x) :=\n  y ← 1\n  if x > 0\n    y ← 2', 'f(-1) + 10 f(1) ='])).toBe('21');
  });
});
