import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { renderTex } from './Tex';
import type { TextResult } from '../engine/evaluator';

marked.setOptions({ gfm: true, breaks: true });

/** Markdown with $inline$, $$display$$ TeX and {{live values}} from the worksheet. */
export function renderMarkdown(md: string, live?: TextResult): string {
  const stash: string[] = [];
  const keep = (html: string) => {
    stash.push(html);
    return `\uE000${stash.length - 1}\uE001`;
  };
  const src = md.replace(/(`+)([\s\S]*?[^`])\1(?!`)|\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$|\{\{([^}]+)\}\}/g, (m, ticks: string, code: string, disp: string, inl: string, liveKey: string) => {
    if (ticks !== undefined) return keep(`<code>${escapeHtml(code.trim() || m)}</code>`);
    if (disp !== undefined) return keep(`<span class="md-display">${renderTex(disp, true)}</span>`);
    if (inl !== undefined) return keep(renderTex(inl, false));
    const v = live?.values[liveKey];
    if (!v) return keep('<span class="md-live pending">…</span>');
    if (v.error) return keep(`<span class="md-live error" title="${escapeAttr(v.error)}">?</span>`);
    return keep(`<span class="md-live">${renderTex(v.tex ?? '', false)}</span>`);
  });
  const html = DOMPurify.sanitize(marked.parse(src, { async: false }) as string);
  return html.replace(/\uE000(\d+)\uE001/g, (_m, k: string) => stash[Number(k)]);
}

function escapeHtml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(s: string) {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
