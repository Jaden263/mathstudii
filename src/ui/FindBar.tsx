import { useEffect, useMemo, useRef, useState, type Dispatch } from 'react';
import { ChevronDown, ChevronUp, X, Replace } from 'lucide-react';
import type { Worksheet } from '../model/types';
import type { Action } from './store';
import { findInWorksheet, replaceInRegion, type SearchOptions } from '../model/search';

interface Props {
  ws: Worksheet;
  dispatch: Dispatch<Action>;
  /** Start with the replace row open (Ctrl+H) and this text in the find box. */
  replace: boolean;
  initial?: string;
  onClose: () => void;
  /** Regions with matches and the current one, for highlighting. */
  onHits: (ids: Set<string>, current: string | null) => void;
  toast: (msg: string) => void;
}

/** Ctrl+F: find (and replace) in every region of the worksheet. */
export function FindBar({ ws, dispatch, replace: startReplace, initial = '', onClose, onHits, toast }: Props) {
  const [query, setQuery] = useState(initial);
  const [repl, setRepl] = useState('');
  const [showReplace, setShowReplace] = useState(startReplace);
  const [opts, setOpts] = useState<SearchOptions>({ caseSensitive: true, wholeName: false });
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  const hits = useMemo(() => findInWorksheet(ws, query, opts), [ws, query, opts]);
  const total = hits.reduce((n, h) => n + h.count, 0);
  const cur = hits.length ? hits[Math.min(index, hits.length - 1)] : null;

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  useEffect(() => setShowReplace((s) => s || startReplace), [startReplace]);
  useEffect(() => {
    onHits(new Set(hits.map((h) => h.id)), cur?.id ?? null);
  }, [hits, cur, onHits]);
  useEffect(() => () => onHits(new Set(), null), [onHits]);
  useEffect(() => {
    if (!cur) return;
    document.querySelector(`[data-region-id="${cur.id}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [cur]);

  const step = (d: number) => hits.length && setIndex((i) => (Math.min(i, hits.length - 1) + d + hits.length) % hits.length);

  const replaceOne = () => {
    if (!cur) return;
    const r = ws.regions.find((q) => q.id === cur.id);
    const res = r && replaceInRegion(r, query, repl, opts);
    if (!res) return;
    dispatch({ type: 'update', id: r!.id, patch: res.region });
  };
  const replaceAll = () => {
    let n = 0, regions = 0;
    for (const h of hits) {
      const r = ws.regions.find((q) => q.id === h.id);
      const res = r && replaceInRegion(r, query, repl, opts);
      if (!res) continue;
      // one undo step for the whole replace
      dispatch({ type: 'update', id: r!.id, patch: res.region, coalesce: `replace-all:${query}` });
      n += res.count;
      regions++;
    }
    toast(n ? `Replaced ${n} match${n > 1 ? 'es' : ''} in ${regions} region${regions > 1 ? 's' : ''}` : 'Nothing to replace');
  };

  return (
    <div className="find-bar" role="search" onMouseDown={(e) => {
      // buttons keep the focus in the find box, so Enter keeps stepping through matches
      if ((e.target as HTMLElement).closest('button')) e.preventDefault();
    }} onKeyDown={(e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
    }}>
      <div className="find-row">
        <button className="icon-btn" onClick={() => setShowReplace(!showReplace)} title="Toggle replace (Ctrl+H)" aria-label="Toggle replace"><Replace size={15} /></button>
        <input
          ref={input} value={query} placeholder="Find in worksheet" aria-label="Find"
          onChange={(e) => { setQuery(e.target.value); setIndex(0); }}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); step(e.shiftKey ? -1 : 1); } }}
        />
        <span className="find-count">{query ? (total ? `${Math.min(index, hits.length - 1) + 1} of ${hits.length} regions · ${total}` : 'No results') : ''}</span>
        <button className={`find-opt${opts.caseSensitive ? ' on' : ''}`} onClick={() => setOpts({ ...opts, caseSensitive: !opts.caseSensitive })} title="Match case" aria-pressed={opts.caseSensitive}>Aa</button>
        <button className={`find-opt${opts.wholeName ? ' on' : ''}`} onClick={() => setOpts({ ...opts, wholeName: !opts.wholeName })} title="Whole names only (L but not L_cr): Replace all renames a variable" aria-pressed={opts.wholeName}>ab|</button>
        <button className="icon-btn" onClick={() => step(-1)} disabled={!hits.length} title="Previous (Shift+Enter)" aria-label="Previous match"><ChevronUp size={15} /></button>
        <button className="icon-btn" onClick={() => step(1)} disabled={!hits.length} title="Next (Enter)" aria-label="Next match"><ChevronDown size={15} /></button>
        <button className="icon-btn" onClick={onClose} title="Close (Esc)" aria-label="Close find"><X size={15} /></button>
      </div>
      {showReplace && (
        <div className="find-row">
          <span className="find-gap" />
          <input value={repl} placeholder="Replace with" aria-label="Replace with" onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); replaceOne(); } }} onChange={(e) => setRepl(e.target.value)} />
          <button className="btn" onClick={replaceOne} disabled={!cur}>Replace</button>
          <button className="btn" onClick={replaceAll} disabled={!hits.length}>Replace all</button>
        </div>
      )}
    </div>
  );
}
