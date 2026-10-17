// ISO 286 limit deviations against the tables of ISO 286-2:2010 (the values a designer
// reads there), and the kinds of fit of ISO 286-1 3.3.4.
import { describe, expect, it } from 'vitest';
import { classDeviations, fitDeviations, fitKind, itGrade, parseFit, parseFitClass } from './fits';

describe('ISO 286 fits', () => {
  it('the values a drawing needs most', () => {
    expect(fitDeviations('H7', 20)).toEqual({ upper: 21, lower: 0 });
    expect(fitDeviations('g6', 20)).toEqual({ upper: -7, lower: -20 });
    expect(fitDeviations('H8', 50)).toEqual({ upper: 39, lower: 0 });
    expect(fitDeviations('f7', 50)).toEqual({ upper: -25, lower: -50 });
    expect(fitDeviations('k6', 10)).toEqual({ upper: 10, lower: 1 });
  });

  it('IT grades at the ends of the steps (ISO 286-1 Table 1: "above … up to and including")', () => {
    expect(itGrade(7, 3)).toBe(10);
    expect(itGrade(7, 3.0001)).toBe(12);
    expect(itGrade(5, 500)).toBe(27);
    expect(itGrade(11, 18)).toBe(110);
    expect(itGrade(11, 18.5)).toBe(130);
    expect(() => itGrade(7, 501)).toThrow(/500 mm/);
    expect(() => itGrade(12, 20)).toThrow(/IT5 to IT11/);
  });

  it('more classes from ISO 286-2, including the steps where c, r and s change', () => {
    expect(fitDeviations('h6', 25)).toEqual({ upper: 0, lower: -13 });
    expect(fitDeviations('p6', 40)).toEqual({ upper: 42, lower: 26 });
    expect(fitDeviations('s7', 60)).toEqual({ upper: 83, lower: 53 });
    expect(fitDeviations('s6', 70)).toEqual({ upper: 78, lower: 59 });
    expect(fitDeviations('r6', 100)).toEqual({ upper: 73, lower: 51 });
    expect(fitDeviations('r6', 110)).toEqual({ upper: 76, lower: 54 });
    expect(fitDeviations('c11', 12)).toEqual({ upper: -95, lower: -205 });
    expect(fitDeviations('d9', 30)).toEqual({ upper: -65, lower: -117 });
    expect(fitDeviations('e8', 450)).toEqual({ upper: -135, lower: -232 });
    expect(fitDeviations('m6', 30)).toEqual({ upper: 21, lower: 8 });
    expect(fitDeviations('n6', 30)).toEqual({ upper: 28, lower: 15 });
    expect(fitDeviations('H11', 400)).toEqual({ upper: 360, lower: 0 });
  });

  it('k above IT7 starts at zero; js takes an odd IT down to even from IT7 on', () => {
    expect(fitDeviations('k7', 25)).toEqual({ upper: 23, lower: 2 });
    expect(fitDeviations('k8', 25)).toEqual({ upper: 33, lower: 0 });
    expect(fitDeviations('js6', 25)).toEqual({ upper: 6.5, lower: -6.5 });
    expect(fitDeviations('js7', 25)).toEqual({ upper: 10, lower: -10 });
    expect(fitDeviations('js8', 25)).toEqual({ upper: 16, lower: -16 });
  });

  it('fits: clearance, transition and interference (H7 hole basis at Ø20)', () => {
    const H7 = fitDeviations('H7', 20);
    expect(fitKind(H7, fitDeviations('g6', 20))).toEqual({ kind: 'clearance', max: 41, min: 7 });
    expect(fitKind(H7, fitDeviations('k6', 20))).toEqual({ kind: 'transition', max: 19, min: -15 });
    expect(fitKind(H7, fitDeviations('p6', 20))).toEqual({ kind: 'interference', max: -1, min: -35 });
    expect(parseFit('H7/g6')).toEqual({ hole: { letter: 'H', grade: 7, hole: true }, shaft: { letter: 'g', grade: 6, hole: false } });
    expect(parseFit('g6/H7')).toBeNull();
    expect(parseFitClass('G7')).toBeNull();
    expect(parseFitClass('h12')).toBeNull();
    expect(classDeviations(parseFitClass(' f 7 ')!, 50)).toEqual({ upper: -25, lower: -50 });
  });
});
