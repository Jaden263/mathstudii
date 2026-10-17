// Random numbers as Mathcad draws them, so that a worksheet gives the same numbers Mathcad
// does (and the same ones on every recalculation). Mathcad Prime's generator is the Microsoft
// C runtime's rand() (a linear congruential generator), started at 1 for every calculation;
// Seed(n) restarts it. The methods per distribution (Kinderman–Monahan for the normal,
// Knuth's product for Poisson, exponential sums, a normal square and Jöhnk's ratio for gamma
// shapes …) were identified, and checked to the last bit, against values Mathcad Prime saved
// in worksheets (mcad2py's notes, MIT licence, docs/mcdx-schema-notes.md "seed.mcdx").
import { math } from './math';
import { num, int, vec } from './library';

let state = 1;

/** A new calculation starts from Mathcad's default seed. */
export function resetRandom(seed = 1) {
  state = seed >>> 0;
}

/** rand(): 15 bits of a 32-bit LCG. */
function rand(): number {
  state = (Math.imul(state, 214013) + 2531011) >>> 0;
  return (state >>> 16) & 0x7fff;
}

/** A uniform deviate in [0, 1) from two rand() calls (30 bits). */
function uniform(): number {
  return (rand() * 32768 + rand()) / 2 ** 30;
}

const KM = Math.sqrt(8 / Math.E);
/** A standard normal deviate: Kinderman–Monahan ratio of uniforms. */
function normal(): number {
  for (;;) {
    const u = uniform();
    const v = KM * (uniform() - 0.5);
    if (u === 0) continue;
    const x = v / u;
    if (x * x <= -4 * Math.log(u)) return x;
  }
}

const exponential = () => -Math.log(uniform());

/** A gamma deviate of shape a: whole part as exponentials, a half as z²/2, other fractions by Jöhnk's ratio. */
function gamma(a: number): number {
  if (!(a > 0)) throw new Error('The shape parameter must be positive');
  let g = 0;
  const whole = Math.floor(a);
  for (let k = 0; k < whole; k++) g += exponential();
  const f = a - whole;
  if (Math.abs(f - 0.5) < 1e-15) {
    const z = normal();
    g += (z * z) / 2;
  } else if (f > 0) {
    for (;;) {
      const x = Math.exp(Math.log(uniform()) / f);
      const y = uniform() ** (1 / (1 - f));
      if (x + y <= 1) {
        g += (x / (x + y)) * exponential();
        break;
      }
    }
  }
  return g;
}

const chisq = (d: number) => 2 * gamma(d / 2);

function poisson(lambda: number): number {
  const L = Math.exp(-lambda);
  let k = 0, p = 1;
  do {
    k++;
    p *= uniform();
  } while (p > L);
  return k - 1;
}

function binomial(n: number, q: number): number {
  const u = uniform();
  if (q >= 1) return n;
  let k = 0, p = (1 - q) ** n, F = p;
  while (u > F && k < n) {
    k++;
    p *= ((n - k + 1) / k) * (q / (1 - q));
    F += p;
  }
  return k;
}

/** m draws of f, as a vector. */
const draws = (m: unknown, f: () => number) => {
  const n = int(m, 'number of values');
  if (n < 1) throw new Error('The number of values must be at least 1');
  return vec(Array.from({ length: n }, f));
};

const RANDOM_LIBRARY: Record<string, unknown> = {
  /** Seed(n): restart the generator; returns its previous state. */
  Seed: (n: unknown) => {
    const prev = state;
    resetRandom(int(n, 'seed'));
    return prev;
  },
  rnd: (x: unknown) => num(x) * uniform(),
  runif: (m: unknown, a: unknown, b: unknown) => draws(m, () => num(a) + (num(b) - num(a)) * uniform()),
  rnorm: (m: unknown, mu: unknown, s: unknown) => draws(m, () => num(mu) + num(s) * normal()),
  rlnorm: (m: unknown, mu: unknown, s: unknown) => draws(m, () => Math.exp(num(mu) + num(s) * normal())),
  rexp: (m: unknown, r: unknown) => draws(m, () => exponential() / num(r)),
  rweibull: (m: unknown, s: unknown) => draws(m, () => exponential() ** (1 / num(s))),
  rlogis: (m: unknown, l: unknown, s: unknown) => draws(m, () => {
    const u = uniform();
    return num(l) + num(s) * Math.log(u / (1 - u));
  }),
  rcauchy: (m: unknown, l: unknown, s: unknown) => draws(m, () => num(l) + num(s) * Math.tan(Math.PI * (uniform() - 0.5))),
  rgeom: (m: unknown, q: unknown) => draws(m, () => Math.floor(Math.log(uniform()) / Math.log(1 - num(q)))),
  rbinom: (m: unknown, n: unknown, q: unknown) => draws(m, () => binomial(int(n, 'n'), num(q))),
  rpois: (m: unknown, l: unknown) => draws(m, () => poisson(num(l))),
  rnbinom: (m: unknown, n: unknown, q: unknown) => draws(m, () => poisson((gamma(num(n)) * (1 - num(q))) / num(q))),
  rgamma: (m: unknown, s: unknown) => draws(m, () => gamma(num(s))),
  rchisq: (m: unknown, d: unknown) => draws(m, () => chisq(num(d))),
  rbeta: (m: unknown, a: unknown, b: unknown) => draws(m, () => {
    const x = gamma(num(a)), y = gamma(num(b));
    return x / (x + y);
  }),
  rF: (m: unknown, d1: unknown, d2: unknown) => draws(m, () => (chisq(num(d1)) / num(d1)) / (chisq(num(d2)) / num(d2))),
  // |z|/√(χ²/d) with a random sign: what one saved Mathcad draw (value and uniforms used) fits
  rt: (m: unknown, d: unknown) => draws(m, () => {
    const t = Math.abs(normal()) / Math.sqrt(chisq(num(d)) / num(d));
    return uniform() < 0.5 ? -t : t;
  }),
};

math.import(RANDOM_LIBRARY, { override: true });
