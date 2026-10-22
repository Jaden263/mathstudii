// A page's own header and footer lines (ReportSettings.header / footer): the fields in them.
import type { PageBand } from './types';

export interface PageFields {
  page: number;
  pages: number;
  /** As printed (ISO date). */
  date: string;
  title: string;
}

/** Whether a band has any text. */
export function hasBand(b: PageBand | undefined): b is PageBand {
  return !!b && [b.left, b.center, b.right].some((t) => !!t?.trim());
}

/** The text with {page}, {pages}, {date} and {title} filled in; other braces stay as they are. */
export function fillFields(text: string, f: PageFields): string {
  return text.replace(/\{(page|pages|date|title)\}/g, (_m, k: keyof PageFields) => String(f[k]));
}
