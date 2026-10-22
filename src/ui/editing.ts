import type React from 'react';
import { GREEK_KEYS } from './catalog';

export interface EditorHandle {
  /** Insert text at the caret; a "|" in the text marks the new caret position. */
  insert(text: string): void;
  focus(): void;
}

/** Replace the selection of a textarea and fire React's onChange. */
export function insertAtCaret(ta: HTMLTextAreaElement, text: string, selectFrom?: number, selectTo?: number) {
  ta.focus();
  const caretMark = text.indexOf('|');
  const clean = caretMark >= 0 ? text.slice(0, caretMark) + text.slice(caretMark + 1) : text;
  const start = selectFrom ?? ta.selectionStart;
  const end = selectTo ?? ta.selectionEnd;
  ta.setRangeText(clean, start, end, 'end');
  if (caretMark >= 0) {
    const pos = start + caretMark;
    ta.setSelectionRange(pos, pos);
  }
  ta.dispatchEvent(new Event('input', { bubbles: true }));
}

export function makeEditorHandle(get: () => HTMLTextAreaElement | null): EditorHandle {
  return {
    insert(text) {
      const ta = get();
      if (ta) insertAtCaret(ta, text);
    },
    focus() {
      get()?.focus();
    },
  };
}

const LHS_BEFORE_COLON = /^\s*[\p{L}_Ͱ-Ͽ][\p{L}\wͰ-Ͽ']*\s*(\([^()]*\)|\[[^\]]*\])?\s*$/u;

export interface MathKeyOptions {
  /** Called on plain Enter (commit). Return true if handled. */
  onCommit?: () => void;
  onEscape?: () => void;
  /** Allow multi-line content (programs, solve blocks). Shift+Enter always inserts a newline. */
  multiline?: boolean;
}

/**
 * Mathcad-style typing helpers:
 *  ":" after a name → ":="     "~" → "≡"     Ctrl+. → "→"
 *  Ctrl+G turns the previous letter Greek    Tab indents in programs
 *  Enter commits, Shift+Enter starts a new (auto-indented) line
 */
export function handleMathKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>, opts: MathKeyOptions): void {
  const ta = e.currentTarget;
  const { selectionStart: s, selectionEnd: en, value } = ta;
  const mod = e.ctrlKey || e.metaKey;
  if (e.key === 'Escape') {
    e.preventDefault();
    opts.onEscape?.();
    return;
  }
  if (e.key === 'Enter' && mod) {
    e.preventDefault();
    opts.onCommit?.();
    return;
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
    if (!opts.multiline) {
      e.preventDefault();
      opts.onCommit?.();
      return;
    }
  }
  if (e.key === 'Enter' && (e.shiftKey || opts.multiline)) {
    e.preventDefault();
    const lineStart = value.lastIndexOf('\n', s - 1) + 1;
    const line = value.slice(lineStart, s);
    let indent = /^\s*/.exec(line)![0];
    const t = line.trim();
    if (/(:=|≡)\s*$/.test(t) || /^(if|else|elif|for|while|try|on\s*error|otherwise)\b/.test(t)) indent += '  ';
    insertAtCaret(ta, '\n' + indent);
    return;
  }
  if (e.key === 'Tab' && value.includes('\n')) {
    e.preventDefault();
    const lineStart = value.lastIndexOf('\n', s - 1) + 1;
    if (e.shiftKey) {
      if (value.slice(lineStart, lineStart + 2) === '  ') insertAtCaret(ta, '', lineStart, lineStart + 2);
    } else insertAtCaret(ta, '  ', lineStart, lineStart);
    return;
  }
  if (mod && e.key === '.') {
    e.preventDefault();
    insertAtCaret(ta, ' → ');
    return;
  }
  if (mod && (e.key === 'g' || e.key === 'G')) {
    e.preventDefault();
    const ch = value[s - 1];
    if (s === en && ch && GREEK_KEYS[ch]) insertAtCaret(ta, GREEK_KEYS[ch], s - 1, s);
    return;
  }
  if (mod || e.altKey) return;
  // type through an auto-inserted closing bracket
  if ((e.key === ')' || e.key === ']') && s === en && value[s] === e.key) {
    e.preventDefault();
    ta.setSelectionRange(s + 1, s + 1);
    return;
  }
  // typing ":=" in full: the ":" already became ":= ", so swallow the "="
  if (e.key === '=' && s === en && /:= $/.test(value.slice(0, s))) {
    e.preventDefault();
    return;
  }
  if (e.key === ':' && s === en && value[s] !== '=') {
    const lineStart = value.lastIndexOf('\n', s - 1) + 1;
    const before = value.slice(lineStart, s);
    if (!value.slice(lineStart).includes(':=') && LHS_BEFORE_COLON.test(before)) {
      e.preventDefault();
      insertAtCaret(ta, (before.endsWith(' ') ? '' : ' ') + ':= ');
      return;
    }
  }
  if (e.key === '~') {
    e.preventDefault();
    insertAtCaret(ta, ' ≡ ');
  }
}

/** Grow a textarea to fit its content. */
export function autosize(ta: HTMLTextAreaElement | null) {
  if (!ta) return;
  ta.style.height = '0px';
  ta.style.height = `${ta.scrollHeight}px`;
  ta.style.width = '0px';
  ta.style.width = `${Math.max(60, ta.scrollWidth + 4)}px`;
}
