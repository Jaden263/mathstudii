// Textbook notation for the special functions: Jn(m, x) → J_m(x), Leg(n, x) → P_n(x),
// ellipK(k) → K(k) … (arguments arrive already in TeX).

const call = (args: string) => `\\mathopen{}\\left(${args}\\right)\\mathclose{}`;

const SUBSCRIPTED: Record<string, string> = {
  Jn: 'J', Yn: 'Y', In: 'I', Kn: 'K', js: 'j', ys: 'y', En: 'E',
  Her: 'H', Tcheb: 'T', Ucheb: 'U',
};

const FIXED: Record<string, string> = {
  J0: 'J_{0}', J1: 'J_{1}', Y0: 'Y_{0}', Y1: 'Y_{1}', I0: 'I_{0}', I1: 'I_{1}', K0: 'K_{0}', K1: 'K_{1}',
  Ai: '\\operatorname{Ai}', Bi: '\\operatorname{Bi}', Ei: '\\operatorname{Ei}', E1: 'E_{1}', Si: '\\operatorname{Si}', Ci: '\\operatorname{Ci}',
  FresnelS: 'S', FresnelC: 'C', ellipK: 'K', ellipF: 'F', digamma: '\\psi', zeta: '\\zeta', beta: '\\mathrm{B}',
  gamma: '\\Gamma', gammainc: '\\gamma', gammaP: 'P', gammaQ: 'Q', lgamma: '\\ln\\Gamma',
  erfinv: '\\operatorname{erf}^{-1}', erfcinv: '\\operatorname{erfc}^{-1}', erfc: '\\operatorname{erfc}', sinc: '\\operatorname{sinc}',
};

/** TeX for a special-function call, or undefined to use the default. */
export function specialFunctionTex(name: string, a: string[]): string | undefined {
  const args = (xs: string[]) => call(xs.join(',\\,'));
  if (FIXED[name]) return `${FIXED[name]}${args(a)}`;
  if (SUBSCRIPTED[name] && a.length === 2) return `${SUBSCRIPTED[name]}_{${a[0]}}${args(a.slice(1))}`;
  switch (name) {
    case 'Leg': return a.length === 3 ? `P_{${a[0]}}^{${a[1]}}${args(a.slice(2))}` : a.length === 2 ? `P_{${a[0]}}${args(a.slice(1))}` : undefined;
    case 'Lag': return a.length === 3 ? `L_{${a[0]}}^{(${a[1]})}${args(a.slice(2))}` : a.length === 2 ? `L_{${a[0]}}${args(a.slice(1))}` : undefined;
    case 'Jac': case 'Jacobi': return a.length === 4 ? `P_{${a[0]}}^{(${a[1]},${a[2]})}${args(a.slice(3))}` : undefined;
    case 'ellipE': return `E${args(a)}`;
    case 'ellipPi': return a.length === 3 ? `\\Pi${call(`${a[0]};\\,${a[1]},\\,${a[2]}`)}` : `\\Pi${args(a)}`;
    case 'ibeta': case 'Ibeta': return a.length === 3 ? `I_{${a[0]}}${args(a.slice(1))}` : undefined;
    case 'betainc': return a.length === 3 ? `\\mathrm{B}${call(`${a[0]};\\,${a[1]},\\,${a[2]}`)}` : undefined;
    case 'LambertW': return a.length === 2 ? `W_{${a[1]}}${args(a.slice(0, 1))}` : `W${args(a)}`;
    case 'Psi': return a.length === 2 ? `\\psi^{(${a[0]})}${args(a.slice(1))}` : `\\psi${args(a)}`;
    case 'polygamma': return a.length === 2 ? `\\psi^{(${a[0]})}${args(a.slice(1))}` : undefined;
  }
  return undefined;
}
