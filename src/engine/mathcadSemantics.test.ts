// Mathcad semantics that imported worksheets rely on, each checked against the value Mathcad
// saved with a real worksheet or against PTC's documented behaviour.
import { describe, it, expect, beforeAll } from 'vitest';
import { evaluateWorksheet, type MathResult, type SolveResult } from './evaluator';
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
});

describe('odesolve', () => {
  it('takes Prime’s form odesolve(y(t), b) with the unknown written with its variable', () => {
    const block = createRegion('solve', 40, 0, { guesses: '', constraints: "h''(t) = -9.81\nh(0) = 0\nh'(0) = 10", solver: 'h := odesolve(h(t), 3)' });
    // h(1) = 10 − 9.81/2
    expect(shown([block, 'h(1) ='])).toBe('5.095');
  });
});
