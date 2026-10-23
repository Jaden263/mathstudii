import { describe, it, expect } from 'vitest';
import { pageBreakShift } from './pages';
import { PAGE_HEIGHT, PAGE_MARGIN } from '../model/types';

describe('page breaks', () => {
  it('what is below a break moves until the break is at the top of the next page', () => {
    const shift = pageBreakShift([300, 900]);
    expect(shift(200)).toBe(0);
    expect(shift(320)).toBe(PAGE_HEIGHT + PAGE_MARGIN - 300);
    // the second break, moved by the first, is on page 2 now: it starts page 3
    const second = 900 + shift(900);
    expect(shift(950) - shift(900)).toBe(2 * PAGE_HEIGHT + PAGE_MARGIN - second);
    expect(pageBreakShift([])(500)).toBe(0);
  });
});
