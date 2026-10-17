import { createContext, useContext, useMemo, useState } from 'react';
import type { Region } from '../model/types';
import { FUNCTIONS } from './catalog';
import { insertAtCaret } from './editing';
import { findEvalEquals } from '../engine/syntax';
import { UNIT_SUGGESTIONS } from '../engine/unitList';

export interface Completion {
  name: string;
  /** Text inserted (with "|" for the caret). */
  insert: string;
  detail: string;
  kind: 'function' | 'variable' | 'unit';
}

const BUILTIN: Completion[] = FUNCTIONS.map((f) => ({
  name: f.name,
  insert: f.sig.includes('→') ? f.sig.replace(/\(.*\)/, '(|)').replace(/\s*→$/, '') : `${f.name}(|)`,
  detail: `${f.sig} — ${f.desc}`,
  kind: 'function',
}));

const UNITS: Completion[] = UNIT_SUGGESTIONS.map((u) => ({ name: u.u, insert: u.u, detail: u.name, kind: 'unit' }));
const UNIT_NAMES = new Set(UNIT_SUGGESTIONS.map((u) => u.u));

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
    else if (r.kind === 'spreadsheet') {
      for (const o of r.outputs) if (o.name.trim()) out.set(o.name.trim(), { name: o.name.trim(), insert: o.name.trim(), detail: `spreadsheet ${o.ref}`, kind: 'variable' });
    }
    else if ((r.kind === 'sketch' || r.kind === 'cad' || r.kind === 'beam' || r.kind === 'frame3d' || r.kind === 'plate') && r.name) out.set(r.name, { name: r.name, insert: r.name, detail: `${r.kind === 'frame3d' ? '3-D frame' : r.kind} results`, kind: 'variable' });
  }
  return [...out.values()];
}

export const CompletionContext = createContext<Completion[]>([]);

/** What the caret is typing: a name, a unit, or the display unit after "=". */
type Mode = 'name' | 'unit' | 'target';

interface State {
  mode: Mode;
  word: string;
  /** Replace from here to the caret when accepting. */
  start: number;
  index: number;
  navigated?: boolean;
}

/** Units of the result being shown, from the last evaluation. */
export interface ResultUnits {
  units?: string[];
  unitValues?: string[];
  quantity?: string;
}

const compact = (s: string) => s.replace(/\s+/g, '').replace(/\*/g, '').toLowerCase();

function analyse(value: string, caret: number, userNames: Set<string>): Omit<State, 'index'> | null {
  const lineStart = value.lastIndexOf('\n', caret - 1) + 1;
  const line = value.slice(lineStart, caret);
  // after a top-level "=": the unit the result is shown in
  const eq = findEvalEquals(line);
  if (eq >= 0 && !/^\s*$/.test(line.slice(0, eq))) {
    const after = line.slice(eq + 1);
    const lead = after.length - after.trimStart().length;
    return { mode: 'target', word: after.trim(), start: lineStart + eq + 1 + lead };
  }
  let i = caret;
  while (i > 0 && /[\wͰ-Ͽ]/.test(value[i - 1])) i--;
  let start = i;
  let word = value.slice(i, caret);
  // "10kN": the letters after the number
  const glued = /^(\d+(?:\.\d+)?)([A-Za-z]\w*)$/.exec(word);
  if (glued) {
    if (glued[2] === 'e' || glued[2] === 'E') return null; // could be an exponent
    start += glued[1].length;
    word = glued[2];
    return { mode: 'unit', word, start };
  }
  if (!word || !/^[A-Za-z_Ͱ-Ͽ]/.test(word)) return null;
  const before = value.slice(lineStart, start);
  if (/\d\s*$/.test(before) && !/[A-Za-z_]\d*\s*$/.test(before)) return { mode: 'unit', word, start };
  const op = /([A-Za-z]\w*(?:\^\d+)?)\s*[/*·]\s*$/.exec(before);
  if (op) {
    const prev = op[1].replace(/\^\d+$/, '');
    if (UNIT_NAMES.has(prev) && !userNames.has(prev)) return { mode: 'unit', word, start };
  }
  return { mode: 'name', word, start };
}

/** The function call the caret is inside, for a signature hint. */
function callAt(value: string, caret: number): string | null {
  let depth = 0;
  for (let i = caret - 1; i >= 0 && value[i] !== '\n'; i--) {
    const ch = value[i];
    if (ch === ')' || ch === ']') depth++;
    else if (ch === '(' || ch === '[') {
      if (depth === 0) {
        if (ch === '[') return null;
        const m = /([A-Za-z_Ͱ-Ͽ][\wͰ-Ͽ]*)$/.exec(value.slice(0, i));
        return m ? m[1] : null;
      }
      depth--;
    }
  }
  return null;
}

/** Completion popup state for a textarea. */
export function useAutocomplete(result?: ResultUnits) {
  const user = useContext(CompletionContext);
  const [state, setState] = useState<State | null>(null);
  const [call, setCall] = useState<string | null>(null);
  const userNames = useMemo(() => new Set(user.map((c) => c.name)), [user]);
  const names = useMemo(() => [...user, ...BUILTIN], [user]);
  const resultUnits = result?.units;
  const unitValues = result?.unitValues;
  const quantity = result?.quantity;

  const items = useMemo((): Completion[] => {
    if (!state) return [];
    const w = state.word;
    const lw = w.toLowerCase();
    const dedupe = (list: Completion[]) => {
      const seen = new Set<string>();
      return list.filter((c) => (seen.has(c.name) ? false : (seen.add(c.name), true)));
    };
    if (state.mode === 'target') {
      if (!resultUnits?.length) return [];
      const compatible = resultUnits.map((u, i): Completion => ({
        name: u, insert: u, kind: 'unit',
        detail: unitValues?.[i] ? `= ${unitValues[i]}` : quantity ?? "same dimension",
      }));
      // a unit already typed in full: offer the alternatives
      if (!w || compatible.some((c) => compact(c.name) === compact(w))) return compatible.slice(0, 10);
      const cw = compact(w);
      return compatible.filter((c) => compact(c.name).startsWith(cw)).slice(0, 10);
    }
    if (state.mode === 'unit') {
      const exact = UNITS.filter((c) => c.name.startsWith(w) && c.name !== w);
      const loose = UNITS.filter((c) => c.name.toLowerCase().startsWith(lw) && c.name !== w);
      return dedupe([...exact, ...loose]).slice(0, 8);
    }
    const starts = names.filter((c) => c.name.toLowerCase().startsWith(lw) && c.name !== w);
    // your own names first, then exact-case matches
    starts.sort((a, b) => Number(b.name.startsWith(w)) - Number(a.name.startsWith(w)));
    const units = w.length >= 2 ? UNITS.filter((c) => c.name.startsWith(w) && c.name !== w) : [];
    return dedupe([...starts, ...units]).slice(0, 8);
  }, [names, state, resultUnits, unitValues, quantity]);

  const hint = useMemo(() => {
    if (!call) return null;
    const f = FUNCTIONS.find((x) => x.name === call);
    if (f) return `${f.sig} — ${f.desc}`;
    const u = user.find((x) => x.name === call && x.kind === 'function');
    return u ? u.detail : null;
  }, [call, user]);

  const update = (ta: HTMLTextAreaElement) => {
    if (ta.selectionStart !== ta.selectionEnd) {
      setState(null);
      setCall(null);
      return;
    }
    const a = analyse(ta.value, ta.selectionStart, userNames);
    setCall(callAt(ta.value, ta.selectionStart));
    if (!a) return setState(null);
    setState((s) => ({ ...a, index: s && s.mode === a.mode && s.start === a.start ? Math.min(s.index, 9) : 0 }));
  };

  const accept = (ta: HTMLTextAreaElement, c: Completion) => {
    if (!state) return;
    // the display unit replaces everything after "=" on the line
    const end = state.mode === 'target' ? Math.max(ta.selectionStart, lineEnd(ta.value, ta.selectionStart)) : ta.selectionStart;
    insertAtCaret(ta, (state.mode === 'target' && ta.value[state.start - 1] === '=' ? ' ' : '') + c.insert, state.start, end);
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

  const popup = (ta: HTMLTextAreaElement | null) => {
    if (!ta) return null;
    if (state && items.length > 0) {
      const active = Math.min(state.index, items.length - 1);
      return (
        <ul className="completions" role="listbox" onPointerDown={(e) => e.stopPropagation()}>
          {state.mode === 'target' && <li className="completions-head" aria-hidden>Show the result in…{quantity ? ` (${quantity})` : ''}</li>}
          {items.map((c, i) => (
            <li
              key={c.name}
              role="option"
              aria-selected={i === active}
              className={i === active ? 'active' : ''}
              onMouseDown={(e) => {
                e.preventDefault();
                accept(ta, c);
              }}
            >
              <span className={`ck ck-${c.kind}`}>{c.kind === 'function' ? 'ƒ' : c.kind === 'unit' ? 'u' : 'x'}</span>
              <code>{c.kind === 'unit' ? c.name.replace(/ /g, '·') : c.name}</code>
              <span className="cd">{c.detail}</span>
            </li>
          ))}
          <li className="completions-foot" aria-hidden>Tab to insert · ↑↓ to choose</li>
        </ul>
      );
    }
    if (hint) return <div className="sig-hint" role="status">{hint}</div>;
    return null;
  };

  return { update, onKeyDown, popup, close: () => { setState(null); setCall(null); } };
}

function lineEnd(value: string, from: number): number {
  const i = value.indexOf('\n', from);
  return i < 0 ? value.length : i;
}
