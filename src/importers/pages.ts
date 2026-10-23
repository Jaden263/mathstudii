// Page breaks of imported worksheets: a page break starts a new page. Here pages are A4
// (PAGE_HEIGHT apart), so what follows a break moves down until the break falls at the top of
// the next page; everything below moves as much. The shift depends only on where the breaks
// are, so the corpus harness maps the file's positions the same way.
import { PAGE_HEIGHT, PAGE_MARGIN } from '../model/types';

/** How far a position moves for these page breaks (positions below a break move). */
export function pageBreakShift(breaks: number[]): (y: number) => number {
  const steps: { at: number; by: number }[] = [];
  let moved = 0;
  for (const b of [...breaks].sort((p, q) => p - q)) {
    const here = b + moved;
    const by = (Math.floor(here / PAGE_HEIGHT) + 1) * PAGE_HEIGHT + PAGE_MARGIN - here;
    steps.push({ at: b, by });
    moved += by;
  }
  return (y: number) => steps.reduce((s, st) => (y > st.at ? s + st.by : s), 0);
}
