import { describe, it, expect } from 'vitest';
import katex from 'katex';
import { evaluateWorksheet, type MathResult } from './evaluator';
import { emptyWorksheet, createRegion } from '../model/types';
import { FUNCTIONS } from '../ui/catalog';
import { math } from './math';

function run(lines: string[]): MathResult[] {
  const ws = emptyWorksheet();
  ws.regions = lines.map((source, i) => createRegion('math', 40, 40 + i * 40, { source }));
  const out = evaluateWorksheet(ws);
  return ws.regions.map((r) => {
    const res = out.results.get(r.id) as MathResult;
    expect(() => katex.renderToString(res.tex, { throwOnError: true }), res.tex).not.toThrow();
    return res;
  });
}

/** Number shown by the last line. */
function value(...lines: string[]): number {
  const res = run(lines);
  const r = res[res.length - 1];
  if (r.error) throw new Error(r.error);
  const shown = r.tex.slice(r.tex.lastIndexOf(' = ') + 3).replace(/\\,/g, '');
  const m = /^(-?[\d.]+)(?: \\cdot 10\^\{(-?\d+)\})?/.exec(shown);
  if (!m) throw new Error(`no number in ${shown}`);
  return Number(m[1]) * 10 ** Number(m[2] ?? 0);
}

const tiny = (expr: string, tol = 1e-12, ...pre: string[]) => expect(Math.abs(value(...pre, `${expr} =`)), expr).toBeLessThan(tol);

describe('special functions in the worksheet', () => {
  it('Mathcad names and textbook display', () => {
    const r = run(['Jn(2, 1.5) =', 'Yn(0.5, 2) =', 'Leg(3, 2, 0.5) =', 'Lag(2, 1.5, 0.3) =', 'Jac(3, 0.5, 0.5, 0.2) =', 'ellipPi(0.3, 1, 0.5) =', 'ibeta(0.3, 2, 3) =', 'LambertW(-0.1, -1) =', 'gamma(2, 1) =']);
    expect(r[0].tex).toMatch(/^ ?J_\{2\}/);
    expect(r[2].tex).toMatch(/P_\{3\}\^\{2\}/);
    expect(r[3].tex).toMatch(/L_\{2\}\^\{\(1\.5\)\}/);
    expect(r[4].tex).toMatch(/P_\{3\}\^\{\(0\.5,0\.5\)\}/);
    expect(r[7].tex).toMatch(/W_\{-1\}/);
    expect(r[8].tex).toMatch(/\\Gamma\\mathopen\{\}\\left\(2,\\,1\\right\)/);
    for (const x of r) expect(x.error).toBeUndefined();
  });
  it('gamma(a, x) is the upper incomplete gamma function', () => {
    tiny('gamma(2, 1) - 2/e', 1e-15); // Γ(2, x) = (1 + x) e^−x
    tiny('gamma(0.5, 2) - sqrt(π) * erfc(sqrt(2))', 1e-15);
    tiny('gamma(5) - 24', 1e-12); // one argument: still Γ
    tiny('gammaP(2.5, 1.7) + gammaQ(2.5, 1.7) - 1', 1e-15);
    tiny('gammainc(2.5, 1.7) / gamma(2.5) - gammaP(2.5, 1.7)', 1e-15);
  });
  it('replaces the inaccurate real zeta and lgamma', () => {
    tiny('zeta(-7.5) / 0.003269039572600220 - 1', 1e-13); // mathjs gave 0.0223
    tiny('lgamma(0.5) - ln(sqrt(π))', 1e-15); // mathjs: 3e-12 off
  });
  it('angles in degrees for elliptic amplitudes', () => {
    tiny('ellipF(90 deg, 0.5) - ellipK(0.5)', 1e-15);
    tiny('ellipE(30 deg, 0) - π/6', 1e-15);
  });
  it('distributions', () => {
    tiny('dweibull(1, 2) - 2/e', 1e-15);
    tiny('pweibull(2, 1) - (1 - exp(-2))', 1e-15);
    tiny('qweibull(pweibull(1.3, 2.5, 3), 2.5, 3) - 1.3', 1e-14);
    tiny('dlnorm(1, 0, 1) - 1/sqrt(2 π)', 1e-15);
    tiny('plnorm(e^1.2, 1.2, 0.4) - 0.5', 1e-15);
    tiny('qlnorm(0.5, 1, 0.5) - e', 1e-15);
    tiny('dgamma(2, 1) - exp(-2)', 1e-15);
    tiny('dgamma(6, 2.5, 3) - dgamma(2, 2.5) / 3', 1e-15); // scale θ
    tiny('qgamma(pgamma(3.3, 2.2), 2.2) - 3.3', 1e-12);
    tiny('dbeta(0.3, 1, 1) - 1', 1e-15);
    tiny('pbeta(0.3, 2, 3) - 0.3483', 1e-15); // 6x² − 8x³ + 3x⁴
    tiny('qbeta(pbeta(0.42, 2.5, 4), 2.5, 4) - 0.42', 1e-12);
    tiny('dF(1.5, 2, 2) - 1/2.5^2', 1e-15); // dF(x, 2, 2) = 1/(1 + x)²
    tiny('integral(dF(u, 3, 7), u, 0, 6/7*2) - pF(6/7*2, 3, 7)', 1e-10);
    tiny('pF(2, 3, 7) - 0.7973063575133491', 1e-14); // I_{6/13}(3/2, 7/2): 3x/(3x + 7) = 6/13 at x = 2
  });
  it('worksheet variables with the same names still multiply', () => {
    const r = run(['Si := 3 m', 'Si (2) =', 'beta := 0.5', 'beta (4) =']);
    expect(r[1].tex).toMatch(/= 6\\ \\mathrm\{m\}$/);
    expect(r[3].tex).toMatch(/= 2$/);
  });
  it('clear errors outside the real domain', () => {
    const r = run(['Ci(-1) =', 'LambertW(-1) =', 'Jn(0.5, -1) =', 'ellipK(2) =', 'Leg(2.5, 0.3) =', 'erfinv(1.5) =']);
    expect(r.map((x) => x.error)).toEqual([
      'Ci(x) is complex for x < 0',
      'LambertW(x) is complex for x < −1/e',
      'Jn(ν, x) is complex for x < 0 and non-integer ν',
      'ellipK: the modulus k must satisfy |k| ≤ 1',
      'Leg: n must be an integer',
      'erfinv(y) needs −1 < y < 1',
    ]);
  });
  it('every catalogued special, ODE and distribution function exists', () => {
    const names = FUNCTIONS.filter((f) => ['Special functions', 'Differential equations', 'Statistics', 'Transforms & ODEs'].includes(f.cat)).map((f) => f.name);
    const renamed: Record<string, string> = { stdev: 'mcStdevP', Stdev: 'mcStdevS', var: 'mcVarP', Var: 'mcVarS', corr: 'mcCorr', fft: 'mcFft', ifft: 'mcIfft' };
    const missing = names.filter((n) => typeof (math as unknown as Record<string, unknown>)[renamed[n] ?? n] !== 'function');
    expect(missing).toEqual([]);
  });
});
