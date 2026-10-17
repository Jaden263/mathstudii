// Text regions as paragraphs of styled runs, for formats with simpler text than Markdown:
// headings, bold, italic and code survive; lists become "•" paragraphs, TeX stays as its
// source, links keep their text, and tables are written row by row with tabs.
import { marked, type Token, type Tokens } from 'marked';

export interface Run {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
}

export interface Para {
  kind: 'h1' | 'h2' | 'h3' | 'p';
  runs: Run[];
}

/** Paragraphs of a Markdown text. */
export function paragraphs(md: string): Para[] {
  // $x^2$ is TeX here: keep its source rather than let Markdown read ^ or _ in it
  const src = md.replace(/\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$/g, (_m, d: string, i: string) => `\`${(d ?? i).trim()}\``);
  const out: Para[] = [];
  const add = (kind: Para['kind'], runs: Run[]) => {
    const merged = runs.reduce<Run[]>((acc, r) => {
      const last = acc[acc.length - 1];
      if (last && !!last.bold === !!r.bold && !!last.italic === !!r.italic && !!last.code === !!r.code) last.text += r.text;
      else if (r.text) acc.push({ ...r });
      return acc;
    }, []);
    if (merged.some((r) => r.text.trim())) out.push({ kind, runs: merged });
  };
  const block = (tokens: Token[]) => {
    for (const t of tokens) {
      switch (t.type) {
        case 'heading': {
          const h = t as Tokens.Heading;
          add(h.depth === 1 ? 'h1' : h.depth === 2 ? 'h2' : 'h3', inline(h.tokens, {}));
          break;
        }
        case 'paragraph':
          // a line break inside a paragraph starts a new one (Mathcad and SMath keep lines apart)
          for (const line of split(inline((t as Tokens.Paragraph).tokens, {}))) add('p', line);
          break;
        case 'list':
          (t as Tokens.List).items.forEach((item, k) => {
            const lead = (t as Tokens.List).ordered ? `${Number((t as Tokens.List).start || 1) + k}. ` : '• ';
            const inner: Run[] = [];
            for (const c of item.tokens) {
              if (c.type === 'text' || c.type === 'paragraph') inner.push(...inline((c as Tokens.Text).tokens ?? [c], {}));
            }
            add('p', [{ text: lead }, ...inner]);
          });
          break;
        case 'code':
          for (const line of (t as Tokens.Code).text.split('\n')) add('p', [{ text: line, code: true }]);
          break;
        case 'blockquote':
          block((t as Tokens.Blockquote).tokens);
          break;
        case 'table': {
          const tb = t as Tokens.Table;
          const row = (cells: Tokens.TableCell[]) => cells.flatMap((c, j) => [...(j ? [{ text: '\t' }] : []), ...inline(c.tokens, {})]);
          add('p', row(tb.header).map((r) => ({ ...r, bold: true })));
          for (const r of tb.rows) add('p', row(r));
          break;
        }
        case 'text':
          add('p', inline((t as Tokens.Text).tokens ?? [t], {}));
          break;
        default:
          break;
      }
    }
  };
  block(marked.lexer(src, { gfm: true, breaks: true }));
  return out;
}

function inline(tokens: Token[] | undefined, style: Omit<Run, 'text'>): Run[] {
  const out: Run[] = [];
  for (const t of tokens ?? []) {
    switch (t.type) {
      case 'strong':
        out.push(...inline((t as Tokens.Strong).tokens, { ...style, bold: true }));
        break;
      case 'em':
        out.push(...inline((t as Tokens.Em).tokens, { ...style, italic: true }));
        break;
      case 'codespan':
        out.push({ ...style, text: unescape((t as Tokens.Codespan).text), code: true });
        break;
      case 'br':
        out.push({ ...style, text: '\n' });
        break;
      case 'link':
        out.push(...inline((t as Tokens.Link).tokens, style));
        break;
      case 'del':
        out.push(...inline((t as Tokens.Del).tokens, style));
        break;
      case 'text':
        if ((t as Tokens.Text).tokens?.length) out.push(...inline((t as Tokens.Text).tokens, style));
        else out.push({ ...style, text: unescape((t as Tokens.Text).text) });
        break;
      case 'escape':
        out.push({ ...style, text: (t as Tokens.Escape).text });
        break;
      default:
        if ('text' in t && typeof t.text === 'string') out.push({ ...style, text: unescape(t.text) });
    }
  }
  return out;
}

/** Runs split at line breaks. */
function split(runs: Run[]): Run[][] {
  const lines: Run[][] = [[]];
  for (const r of runs) {
    const parts = r.text.split('\n');
    parts.forEach((p, i) => {
      if (i) lines.push([]);
      if (p) lines[lines.length - 1].push({ ...r, text: p });
    });
  }
  return lines;
}

const unescape = (s: string) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

/** The plain text of a paragraph. */
export const plain = (p: Para) => p.runs.map((r) => r.text).join('');
