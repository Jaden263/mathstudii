// Formatted text of imported worksheets (Mathcad Prime's XAML, Mathcad 15's text markup) as the
// Markdown of a text region. Bold, italic, headings, lists and links are Markdown; underline,
// strike-through, sub- and superscripts, colours, highlights, font sizes and families are inline
// HTML (<u>, <sub>, <span style>), which the text region shows; an aligned paragraph is an HTML
// paragraph. What most of a region's text has (its size, colour, highlight) becomes the region's
// own format instead, so the Markdown spells out only what differs.
import type { RegionStyle } from '../model/types';

export interface RunStyle {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  sub?: boolean;
  sup?: boolean;
  /** CSS colours (#rrggbb). */
  color?: string;
  background?: string;
  /** Font size, px. */
  size?: number;
  family?: string;
  link?: string;
}

export interface TextRun {
  text: string;
  style: RunStyle;
  /** Already Markdown (inline math as `code`): not escaped. */
  markup?: boolean;
}

export interface TextPara {
  runs: TextRun[];
  align?: 'center' | 'right' | 'justify';
  list?: 'bullet' | 'number';
  /** A heading by its style (Mathcad 15's "Heading 1" …), whatever its size. */
  heading?: 1 | 2 | 3;
}

/** What most of the text has, by characters. */
function dominant<T>(paras: TextPara[], key: (s: RunStyle) => T | undefined): T | undefined {
  const count = new Map<T | undefined, number>();
  for (const p of paras) for (const r of p.runs) count.set(key(r.style), (count.get(key(r.style)) ?? 0) + r.text.length);
  let best: T | undefined, n = -1;
  for (const [k, c] of count) if (c > n) [best, n] = [k, c];
  return best;
}

/** The size most of the text of all these regions has: the "normal" size, shown at the app's own. */
export function normalSize(all: TextPara[][]): number {
  return dominant(all.flat(), (s) => s.size) ?? 14;
}

const BLACK = /^#(000|000000)$/i;
const NO_BACKGROUND = /^(#fff|#ffffff|transparent)$/i;

/** A CSS colour from Mathcad's #AARRGGBB, #RRGGBB or #RGB, or a name; undefined when transparent. */
export function cssColor(c: string | null | undefined): string | undefined {
  if (!c) return undefined;
  const s = c.trim();
  let m = /^#([0-9a-f]{2})([0-9a-f]{6})$/i.exec(s);
  if (m) return m[1].toLowerCase() === '00' ? undefined : `#${m[2].toLowerCase()}`;
  m = /^#([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(s);
  if (m) return `#${m[1].toLowerCase()}`;
  if (/^[a-z]+$/i.test(s)) return /^transparent$/i.test(s) ? undefined : s.toLowerCase();
  return undefined;
}

/** Characters Markdown (and the text region's $TeX$ and {{values}}) would read as markup. */
function escape(s: string): string {
  return s
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/([\\`*[\]~$|{}])/g, '\\$1')
    // an underscore inside a word (f_ck) is no emphasis in Markdown
    .replace(/(?<![\p{L}\p{N}])_|_(?![\p{L}\p{N}])/gu, '\\_');
}

/** Escape what starts a block (#, -, 1.) at the start of a paragraph. */
function escapeStart(s: string): string {
  return s.replace(/^(\s*)([#+-]|\d+[.)])(?=\s|$)/, (_m, sp: string, mark: string) => `${sp}${mark.replace(/^([#+-]|\d+)/, '\\$1')}`);
}

const SIZE_STEP = 0.08;

/**
 * The Markdown of these paragraphs, and the region's own format: the size (against the normal
 * size of the whole worksheet's text), colour and highlight most of it has.
 */
export function toMarkdown(paras: TextPara[], normal: number): { markdown: string; style: RegionStyle } {
  const style: RegionStyle = {};
  const size = dominant(paras, (s) => s.size);
  const color = dominant(paras, (s) => s.color);
  const background = dominant(paras, (s) => s.background);
  const family = dominant(paras, (s) => s.family);
  if (size && Math.abs(size / normal - 1) >= SIZE_STEP) style.fontScale = Math.round((size / normal) * 20) / 20;
  if (color && !BLACK.test(color)) style.color = color;
  if (background && !NO_BACKGROUND.test(background)) style.background = background;
  const base = { size: size ?? normal, color, background, family };
  const blocks = paras.map((p) => paragraph(p, base)).filter((b) => b.trim());
  // list items stay together; other paragraphs apart
  let md = '';
  blocks.forEach((b, i) => {
    if (i) md += paras[i].list && paras[i - 1].list ? '\n' : '\n\n';
    md += b;
  });
  return { markdown: md, style };
}

type Base = { size: number; color?: string; background?: string; family?: string };

function paragraph(p: TextPara, base: Base): string {
  const runs = merge(p.runs.filter((r) => r.text));
  if (!runs.some((r) => r.text.trim())) return '';
  // a heading by its style, or by a size well above the rest of its region (whose own size is
  // the region's format) with no smaller text in it
  const sizes = runs.filter((r) => r.text.trim()).map((r) => r.style.size ?? base.size);
  const ratio = Math.min(...sizes) / base.size;
  const heading = p.heading ?? (p.list ? undefined : ratio >= 1.4 ? 1 : ratio >= 1.15 ? 2 : undefined);
  const html = !!p.align;
  // Markdown (and HTML) collapse spaces: the extra ones Mathcad keeps are no-break spaces
  // (not in inline math, which is `code`)
  let body = runs.map((r) => run(r, base, html, heading !== undefined)).join('')
    .split(/((?<!\\)`[^`]*`)/).map((part, i) => (i % 2 ? part : part.replace(/ {2,}/g, (m) => ` ${'\u00a0'.repeat(m.length - 1)}`))).join('');
  if (html) {
    body = body.replace(/\n/g, '<br>');
    const tag = heading ? `h${heading}` : 'p';
    return `<${tag} style="text-align:${p.align}">${body}</${tag}>`;
  }
  body = body.replace(/\n/g, '  \n');
  if (heading) return `${'#'.repeat(heading)} ${body.replace(/\*\*/g, '')}`;
  if (p.list === 'bullet') return `- ${body}`;
  if (p.list === 'number') return `1. ${body}`;
  return escapeStart(body);
}

const same = (a: RunStyle, b: RunStyle) => JSON.stringify(a) === JSON.stringify(b);

function merge(runs: TextRun[]): TextRun[] {
  const out: TextRun[] = [];
  for (const r of runs) {
    const last = out[out.length - 1];
    if (last && !last.markup && !r.markup && same(last.style, r.style)) last.text += r.text;
    else out.push({ ...r, style: { ...r.style } });
  }
  return out;
}

function run(r: TextRun, base: Base, html: boolean, heading: boolean): string {
  const s = r.style;
  if (r.markup) return r.text;
  // spaces around a run stay outside its markers (** x** is not bold in Markdown)
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(r.text)!;
  const [, lead, core, trail] = m;
  if (!core) return r.text;
  let t = escape(core);
  if (s.sub) t = `<sub>${t}</sub>`;
  if (s.sup) t = `<sup>${t}</sup>`;
  if (s.underline) t = `<u>${t}</u>`;
  if (s.strike) t = html ? `<s>${t}</s>` : `~~${t}~~`;
  const css: string[] = [];
  if (s.color && s.color !== base.color) css.push(`color:${s.color}`);
  if (s.background && s.background !== base.background && !NO_BACKGROUND.test(s.background)) css.push(`background:${s.background}`);
  if (!heading && s.size && Math.abs(s.size / base.size - 1) >= SIZE_STEP) css.push(`font-size:${Math.round((s.size / base.size) * 100) / 100}em`);
  if (s.family && base.family && s.family !== base.family && /mono|courier|consolas|symbol/i.test(s.family)) css.push(`font-family:${/symbol/i.test(s.family) ? 'Symbol' : 'monospace'}`);
  if (css.length) t = `<span style="${css.join(';')}">${t}</span>`;
  if (s.italic && !heading) t = html ? `<i>${t}</i>` : `*${t}*`;
  if (s.bold && !heading) t = html ? `<b>${t}</b>` : `**${t}**`;
  if (s.link) t = html ? `<a href="${s.link.replace(/"/g, '&quot;')}">${t}</a>` : `[${t}](<${s.link.replace(/[<>]/g, '')}>)`;
  return lead + t + trail;
}
