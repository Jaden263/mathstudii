// Page headers and footers of Mathcad worksheets as the page's own lines (ReportSettings.header and
// footer). Mathcad 15 keeps three RTF texts (left, centre, right) with fields in braces: {n} the
// page, {nn} the number of pages, {d} the date, {f} the file name. Prime places text regions in
// the header and footer, some of them fields (page number, date saved, file name).
import type { PageBand } from '../model/types';

/** A Windows code page's decoder (RTF's \ansicpgN), or windows-1252 when the runtime lacks it. */
function decoder(cp: number): TextDecoder {
  const label = cp === 936 ? 'gbk' : cp === 932 ? 'shift_jis' : cp === 949 ? 'euc-kr' : cp === 950 ? 'big5' : cp === 65001 ? 'utf-8' : `windows-${cp}`;
  try {
    return new TextDecoder(label);
  } catch {
    return new TextDecoder('windows-1252');
  }
}

/** Groups whose text is not the document's (font and colour tables, styles, \* destinations). */
const SKIP_GROUP = /^(fonttbl|colortbl|stylesheet|info|pict|object|header|footer|listtable|listoverridetable|rsidtbl|generator|themedata|colorschememapping|latentstyles|datastore)$/;

/** The plain text of an RTF document: paragraphs as lines; \'hh in the document's code page. */
export function rtfText(rtf: string): string {
  let out = '';
  let bytes: number[] = [];
  let dec = decoder(1252);
  const flush = () => {
    if (bytes.length) out += dec.decode(Uint8Array.from(bytes));
    bytes = [];
  };
  const emit = (s: string) => {
    flush();
    out += s;
  };
  // per group: skipping its text, and how many characters follow a \u as its fallback
  const stack: { skip: boolean; uc: number }[] = [];
  let skip = false, uc = 1, pendingSkip = 0;
  let i = 0;
  while (i < rtf.length) {
    const c = rtf[i];
    if (c === '{') {
      stack.push({ skip, uc });
      i++;
      // {\* …} and the tables are not text
      const m = /^\\(\*|[a-z]+)/.exec(rtf.slice(i, i + 40));
      if (m && (m[1] === '*' || SKIP_GROUP.test(m[1]))) skip = true;
      continue;
    }
    if (c === '}') {
      const st = stack.pop();
      if (st) ({ skip, uc } = st);
      i++;
      continue;
    }
    if (c === '\r' || c === '\n') {
      i++;
      continue;
    }
    if (c !== '\\') {
      if (pendingSkip > 0) pendingSkip--;
      else if (!skip) emit(c);
      i++;
      continue;
    }
    // a control symbol or word
    const next = rtf[i + 1] ?? '';
    if (next === '\\' || next === '{' || next === '}') {
      if (pendingSkip > 0) pendingSkip--;
      else if (!skip) emit(next);
      i += 2;
      continue;
    }
    if (next === "'") {
      const hex = rtf.slice(i + 2, i + 4);
      if (pendingSkip > 0) pendingSkip--;
      else if (!skip && /^[0-9a-f]{2}$/i.test(hex)) bytes.push(parseInt(hex, 16));
      i += 4;
      continue;
    }
    if (next === '~') {
      if (!skip) emit(' ');
      i += 2;
      continue;
    }
    if (!/[a-z]/i.test(next)) {
      i += 2; // \-, \_, \| and the like
      continue;
    }
    const m = /^\\([a-z]+)(-?\d+)? ?/i.exec(rtf.slice(i, i + 64))!;
    i += m[0].length;
    const word = m[1], arg = m[2] === undefined ? undefined : Number(m[2]);
    if (word === 'ansicpg' && arg) dec = decoder(arg);
    else if (word === 'uc' && arg !== undefined) uc = arg;
    else if (word === 'u' && arg !== undefined) {
      if (!skip) emit(String.fromCharCode(arg < 0 ? arg + 65536 : arg));
      pendingSkip = uc;
    } else if (!skip && (word === 'par' || word === 'line')) emit('\n');
    else if (!skip && word === 'tab') emit(' ');
  }
  flush();
  return out.replace(/[ \t]+\n/g, '\n').replace(/\n+$/, '').replace(/^\n+/, '');
}

/** A Mathcad 15 header text: RTF, or (in some files) plain text. */
export function mc15Text(s: string): string {
  return /^\s*\{\\rtf/.test(s) ? rtfText(s) : s.trim();
}

/** Mathcad 15's header fields as ours ({fd}, the date the file was saved, as the date); {image} (the logo) is dropped. */
export function mc15Fields(text: string): string {
  return text
    .replace(/\{nn\}/g, '{pages}').replace(/\{n\}/g, '{page}')
    .replace(/\{f?d\}/g, '{date}').replace(/\{f\}/g, '{title}')
    .replace(/\{image\}/g, '').replace(/^\s*\n|\n\s*$/g, '').trim();
}

/** Prime's field templates ("Page_@PageNo_of_@PagesTotal") as text with our fields. */
export function primeField(kind: string, template: string | null): string {
  if (kind === 'pageNumber') return (template ?? '@PageNo').replace(/_/g, ' ').replace(/@PagesTotal/g, '{pages}').replace(/@PageNo/g, '{page}');
  if (kind === 'dateSaved') return '{date}';
  if (kind === 'fileName') return '{title}';
  return '';
}

/** One piece of a Prime header or footer: its text where it sits across the page. */
export interface BandPiece {
  text: string;
  left: number;
  top: number;
  width: number;
  align?: string;
}

/** Pieces sorted into the left, centre and right of the band by where they sit on a page this wide. */
export function bandOf(pieces: BandPiece[], pageWidth: number): PageBand | undefined {
  const slots: Record<'left' | 'center' | 'right', BandPiece[]> = { left: [], center: [], right: [] };
  for (const p of pieces) {
    if (!p.text.trim()) continue;
    const mid = p.left + p.width / 2;
    // a piece across most of the page goes where its text is aligned
    const wide = p.width > pageWidth * 0.6;
    const at = wide
      ? /center/i.test(p.align ?? '') ? 'center' : /right/i.test(p.align ?? '') ? 'right' : 'left'
      : mid < pageWidth * 0.36 ? 'left' : mid > pageWidth * 0.64 ? 'right' : 'center';
    slots[at].push(p);
  }
  // pieces on one line (a label and a field beside it) run on; lines below start a new line
  const join = (ps: BandPiece[]) => {
    let text = '', last: BandPiece | undefined;
    for (const p of ps.sort((a, b) => a.top - b.top || a.left - b.left)) {
      const t = p.text.trim();
      if (last) text += Math.abs(p.top - last.top) < 4 ? (p.left - (last.left + last.width) < 3 ? '' : ' ') : '\n';
      text += t;
      last = p;
    }
    return text || undefined;
  };
  const band: PageBand = { left: join(slots.left), center: join(slots.center), right: join(slots.right) };
  return band.left || band.center || band.right ? band : undefined;
}
