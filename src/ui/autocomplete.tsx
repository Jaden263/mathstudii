import { createContext, useContext, useMemo, useState } from 'react';
import type { Region } from '../model/types';
import { FUNCTIONS } from './catalog';
import { insertAtCaret } from './editing';

export interface Completion {
  name: string;
  /** Text inserted (with "|" for the caret). */
  insert: string;
  detail: string;
  kind: 'function' | 'variable';
}

const BUILTIN: Completion[] = FUNCTIONS.map((f) => ({
  name: f.name,
  insert: f.sig.includes('→') ? f.sig.replace(/\(.*\)/, '(|)').replace(/\s*→$/, '') : `${f.name}(|)`,
  detail: `${f.sig} — ${f.desc}`,
  kind: 'function',
}));

const DEF = /^\s*([A-Za-z_Ͱ-Ͽ][\wͰ-Ͽ']*)\s*(?:\(([^)]*)\))?\s*(?::=|≡)/;

/** Names defined anywhere in the worksheet. */
export function worksheetCompletions(regions: Region[]): Completion[] {
  const out = new Map<string, Completion>();
  const add = (src: string) => {
    const m = DEF.exec(src);
    if (!m) return;
    const [, name, params] = m;
    out.set(name, params !== undefined
      ? { name, insert: `${name}(|)`, detail: `${name}(${params}) — your function`, kind: 'function' }
      : { name, insert: name, detail: 'your variable', kind: 'variable' });
  };
  for (const r of regions) {
    if (r.kind === 'math') add(r.source.split('\n')[0]);
    else if (r.kind === 'solve') {
      r.guesses.split('\n').forEach(add);
      add(r.solver);
    } else if (r.kind === 'table' && r.name) out.set(r.name, { name: r.name, insert: r.name, detail: 'table', kind: 'variable' });
  }
  return [...out.values()];
}

export const CompletionContext = createContext<Completion[]>([]);

function wordBefore(value: string, caret: number): { start: number; word: string } {
  let i = caret;
  while (i > 0 && /[\wͰ-Ͽ]/.test(value[i - 1])) i--;
  return { start: i, word: value.slice(i, caret) };
}

/** Completion popup state for a textarea. */
export function useAutocomplete() {
  const user = useContext(CompletionContext);
  const [state, setState] = useState<{ word: string; start: number; index: number; navigated?: boolean } | null>(null);
  const all = useMemo(() => [...user, ...BUILTIN], [user]);
  const items = useMemo(() => {
    if (!state || state.word.length < 2) return [];
    const w = state.word.toLowerCase();
    const starts = all.filter((c) => c.name.toLowerCase().startsWith(w) && c.name !== state.word);
    const seen = new Set<string>();
    return starts.filter((c) => (seen.has(c.name) ? false : (seen.add(c.name), true))).slice(0, 8);
  }, [all, state]);

  const update = (ta: HTMLTextAreaElement) => {
    if (ta.selectionStart !== ta.selectionEnd) return setState(null);
    const { start, word } = wordBefore(ta.value, ta.selectionStart);
    // only after letters, not in the middle of a number like 1e5
    if (word.length >= 2 && /^[A-Za-z_Ͱ-Ͽ]/.test(word)) setState((s) => ({ word, start, index: s && s.word.startsWith(word.slice(0, -1)) ? Math.min(s.index, 7) : 0 }));
    else setState(null);
  };

  const accept = (ta: HTMLTextAreaElement, c: Completion) => {
    if (!state) return;
    insertAtCaret(ta, c.insert, state.start, ta.selectionStart);
    setState(null);
  };

  /** Returns true when the key was consumed by the popup. */
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!state || items.length === 0) return false;
    const idx = Math.min(state.index, items.length - 1);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const d = e.key === 'ArrowDown' ? 1 : -1;
      setState({ ...state, index: (idx + d + items.length) % items.length, navigated: true });
      return true;
    }
    // Enter only accepts after choosing with the arrows, so it still finishes the region otherwise
    if (e.key === 'Tab' || (e.key === 'Enter' && state.navigated && !e.shiftKey && !e.ctrlKey && !e.metaKey)) {
      e.preventDefault();
      accept(e.currentTarget, items[idx]);
      return true;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      setState(null);
      return true;
    }
    return false;
  };

  const popup = (ta: HTMLTextAreaElement | null) =>
    state && items.length > 0 && ta ? (
      <ul className="completions" role="listbox" onPointerDown={(e) => e.stopPropagation()}>
        {items.map((c, i) => (
          <li
            key={c.name}
            role="option"
            aria-selected={i === Math.min(state.index, items.length - 1)}
            className={i === Math.min(state.index, items.length - 1) ? 'active' : ''}
            onMouseDown={(e) => {
              e.preventDefault();
              accept(ta, c);
            }}
          >
            <span className={`ck ck-${c.kind}`}>{c.kind === 'function' ? 'ƒ' : 'x'}</span>
            <code>{c.name}</code>
            <span className="cd">{c.detail}</span>
          </li>
        ))}
      </ul>
    ) : null;

  return { update, onKeyDown, popup, close: () => setState(null) };
}
