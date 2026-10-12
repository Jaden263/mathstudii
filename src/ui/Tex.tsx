import { memo, useMemo } from 'react';
import katex from 'katex';

const cache = new Map<string, string>();

export function renderTex(tex: string, display = true): string {
  const key = (display ? 'D' : 'I') + tex;
  let html = cache.get(key);
  if (html === undefined) {
    try {
      html = katex.renderToString(display ? `\\displaystyle ${tex}` : tex, {
        throwOnError: false,
        strict: 'ignore',
        trust: false,
        output: 'html',
        maxExpand: 2000,
      });
    } catch (e) {
      html = `<span class="tex-error">${String((e as Error).message)}</span>`;
    }
    if (cache.size > 4000) cache.clear();
    cache.set(key, html);
  }
  return html;
}

export const Tex = memo(function Tex({ tex, display = true, className }: { tex: string; display?: boolean; className?: string }) {
  const html = useMemo(() => renderTex(tex, display), [tex, display]);
  return <span className={className} dangerouslySetInnerHTML={{ __html: html }} />;
});
