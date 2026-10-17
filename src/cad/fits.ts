// ISO 286-1 limits and fits: the standard tolerance grades IT5 to IT11 and the
// fundamental deviations of the hole H and the shafts c, d, e, f, g, h, js, k, m, n, p, r,
// s for nominal sizes up to 500 mm, from the tables of ISO 286-1:2010 (Table 1: IT
// values; Tables 2 and 3: fundamental deviations of shafts), so the limit deviations
// agree with ISO 286-2 to the micrometre.
//
//   hole H:          EI = 0,              ES = EI + IT
//   shafts c … h:    es from the table,   ei = es − IT
//   shafts k … s:    ei from the table,   es = ei + IT
//   shaft js:        ±IT/2 (js7 … js11: an odd IT in µm taken down to even, ISO 286-1 4.2.3)
//
// A nominal size is "above x up to and including y": 10 mm is in 6–10, 50 mm in 30–50.
// Values are micrometres; sizes millimetres.

/** Upper ends of the main steps of nominal size (Table 1). */
const MAIN = [3, 6, 10, 18, 30, 50, 80, 120, 180, 250, 315, 400, 500];

/** Standard tolerance grades IT5 … IT11 (µm), one value per main step (ISO 286-1 Table 1). */
const IT: Record<number, number[]> = {
  5: [4, 5, 6, 8, 9, 11, 13, 15, 18, 20, 23, 25, 27],
  6: [6, 8, 9, 11, 13, 16, 19, 22, 25, 29, 32, 36, 40],
  7: [10, 12, 15, 18, 21, 25, 30, 35, 40, 46, 52, 57, 63],
  8: [14, 18, 22, 27, 33, 39, 46, 54, 63, 72, 81, 89, 97],
  9: [25, 30, 36, 43, 52, 62, 74, 87, 100, 115, 130, 140, 155],
  10: [40, 48, 58, 70, 84, 100, 120, 140, 160, 185, 210, 230, 250],
  11: [60, 75, 90, 110, 130, 160, 190, 220, 250, 290, 320, 360, 400],
};

/** Upper ends of the intermediate steps (c, r and s change within the main steps above 10 mm). */
const FINE = [3, 6, 10, 14, 18, 24, 30, 40, 50, 65, 80, 100, 120, 140, 160, 180, 200, 225, 250, 280, 315, 355, 400, 450, 500];

/** Fundamental deviations of shafts (µm): es for c … g, ei for k … s, by main step (ISO 286-1 Tables 2 and 3). */
const SHAFT_MAIN: Record<string, number[]> = {
  d: [-20, -30, -40, -50, -65, -80, -100, -120, -145, -170, -190, -210, -230],
  e: [-14, -20, -25, -32, -40, -50, -60, -72, -85, -100, -110, -125, -135],
  f: [-6, -10, -13, -16, -20, -25, -30, -36, -43, -50, -56, -62, -68],
  g: [-2, -4, -5, -6, -7, -9, -10, -12, -14, -15, -17, -18, -20],
  h: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  // k for grades 4 to 7; above IT7 (and up to IT3) ei = 0
  k: [0, 1, 1, 1, 2, 2, 2, 3, 3, 4, 4, 4, 5],
  m: [2, 4, 6, 7, 8, 9, 11, 13, 15, 17, 20, 21, 23],
  n: [4, 8, 10, 12, 15, 17, 20, 23, 27, 31, 34, 37, 40],
  p: [6, 12, 15, 18, 22, 26, 32, 37, 43, 50, 56, 62, 68],
};

/** …and those that change within the main steps, by intermediate step. */
const SHAFT_FINE: Record<string, number[]> = {
  c: [-60, -70, -80, -95, -95, -110, -110, -120, -130, -140, -150, -170, -180, -200, -210, -230, -240, -260, -280, -300, -330, -360, -400, -440, -480],
  r: [10, 15, 19, 23, 23, 28, 28, 34, 34, 41, 43, 51, 54, 63, 65, 68, 77, 80, 84, 94, 98, 108, 114, 126, 132],
  s: [14, 19, 23, 28, 28, 35, 35, 43, 43, 53, 59, 71, 79, 92, 100, 108, 122, 130, 140, 158, 170, 190, 208, 232, 252],
};

export const SHAFT_LETTERS = ['c', 'd', 'e', 'f', 'g', 'h', 'js', 'k', 'm', 'n', 'p', 'r', 's'] as const;
export const GRADES = [5, 6, 7, 8, 9, 10, 11] as const;
export const MAX_SIZE = 500;

const step = (ends: number[], size: number) => ends.findIndex((e) => size <= e);

function checkSize(size: number) {
  if (!(size > 0) || size > MAX_SIZE) throw new Error(`ISO 286 fits here are for nominal sizes above 0 up to 500 mm (this one is ${+size.toFixed(4)} mm)`);
}

/** The standard tolerance ITn of a nominal size (µm). */
export function itGrade(grade: number, size: number): number {
  checkSize(size);
  const row = IT[grade];
  if (!row) throw new Error(`IT${grade} is not one of the grades here (IT5 to IT11)`);
  return row[step(MAIN, size)];
}

/** A tolerance class: "H7", "g6", "js9". */
export interface FitClass {
  letter: string;
  grade: number;
  hole: boolean;
}

/** Read a tolerance class; null when it is not one of the classes here. */
export function parseFitClass(text: string): FitClass | null {
  const m = /^\s*(H|c|d|e|f|g|h|js|k|m|n|p|r|s)\s*(\d{1,2})\s*$/.exec(text);
  if (!m) return null;
  const grade = Number(m[2]);
  if (!(GRADES as readonly number[]).includes(grade)) return null;
  return { letter: m[1], grade, hole: m[1] === 'H' };
}

/** Limit deviations of a class at a nominal size (µm): upper ES/es and lower EI/ei. */
export interface Deviations {
  upper: number;
  lower: number;
}

export function classDeviations(c: FitClass, size: number): Deviations {
  const it = itGrade(c.grade, size);
  if (c.hole) return { upper: it, lower: 0 };
  if (c.letter === 'js') {
    // js7 … js11: an odd IT taken down to the next even value, so ±IT/2 is whole micrometres
    const t = c.grade >= 7 && it % 2 ? it - 1 : it;
    return { upper: t / 2, lower: -t / 2 };
  }
  const fine = SHAFT_FINE[c.letter];
  let fd = fine ? fine[step(FINE, size)] : SHAFT_MAIN[c.letter][step(MAIN, size)];
  if (c.letter === 'k' && c.grade > 7) fd = 0;
  // c … h have their upper deviation from the table, k … s their lower one
  return 'cdefgh'.includes(c.letter) ? { upper: fd, lower: fd - it } : { upper: fd + it, lower: fd };
}

/** Limit deviations of a class written as text ("H7", "g6"), µm. Throws for a class that is not in the tables. */
export function fitDeviations(code: string, size: number): Deviations {
  const c = parseFitClass(code);
  if (!c) throw new Error(`“${code.trim()}” is not a tolerance class here: the hole H or the shafts ${SHAFT_LETTERS.join(', ')}, grades 5 to 11 (H7, g6)`);
  return classDeviations(c, size);
}

/** A fit "H7/g6" read into its hole and shaft classes (either may be given alone). */
export function parseFit(text: string): { hole?: FitClass; shaft?: FitClass } | null {
  const parts = text.split('/').map((s) => s.trim()).filter(Boolean);
  if (!parts.length || parts.length > 2) return null;
  const cs = parts.map(parseFitClass);
  if (cs.some((c) => !c)) return null;
  if (cs.length === 2) return cs[0]!.hole && !cs[1]!.hole ? { hole: cs[0]!, shaft: cs[1]! } : null;
  return cs[0]!.hole ? { hole: cs[0]! } : { shaft: cs[0]! };
}

/**
 * What a hole and a shaft of the same nominal size make (µm): the largest and the
 * smallest clearance (negative: interference) and the kind of fit (ISO 286-1 3.3.4).
 */
export function fitKind(hole: Deviations, shaft: Deviations): { kind: 'clearance' | 'transition' | 'interference'; max: number; min: number } {
  const max = hole.upper - shaft.lower, min = hole.lower - shaft.upper;
  return { kind: min >= 0 ? 'clearance' : max <= 0 ? 'interference' : 'transition', max, min };
}
