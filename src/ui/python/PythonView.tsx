import { useEffect, useLayoutEffect, useMemo, useRef, type Dispatch } from 'react';
import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import type { PythonRegion } from '../../model/types';
import type { PythonResult, RegionResult } from '../../engine/evaluator';
import type { Action } from '../store';
import { Tex } from '../Tex';
import { makeEditorHandle, type EditorHandle } from '../editing';
import { highlightPython } from './highlight';

interface Props {
  region: PythonRegion;
  result?: RegionResult;
  editing: boolean;
  dispatch: Dispatch<Action>;
  onDone: (moveBelow?: boolean) => void;
  registerEditor: (h: EditorHandle | null) => void;
  zoom: number;
}

const INDENT = '    ';

export function PythonView({ region, result, editing, dispatch, onDone, registerEditor, zoom }: Props) {
  const ta = useRef<HTMLTextAreaElement>(null);
  const r = result?.kind === 'python' ? (result as PythonResult) : undefined;
  const code = region.code;
  const lines = code.split('\n').length;
  const html = useMemo(() => highlightPython(code) + '\n', [code]);

  useEffect(() => {
    if (!editing) return;
    registerEditor(makeEditorHandle(() => ta.current));
    return () => registerEditor(null);
  }, [editing, registerEditor]);
  useLayoutEffect(() => {
    if (editing && ta.current && document.activeElement !== ta.current) {
      ta.current.focus({ preventScroll: true });
      const n = ta.current.value.length;
      ta.current.setSelectionRange(n, n);
    }
  }, [editing]);

  const set = (patch: Partial<PythonRegion>, coalesce = `py:${region.id}`) => dispatch({ type: 'update', id: region.id, patch, coalesce });

  /** Replace [s, e) with text and put the caret at `caret` (absolute, after the edit). */
  const edit = (el: HTMLTextAreaElement, s: number, e: number, text: string, caret = s + text.length, caretEnd = caret) => {
    el.setRangeText(text, s, e);
    el.setSelectionRange(caret, caretEnd);
    set({ code: el.value });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    const { selectionStart: s, selectionEnd: en, value } = el;
    const lineStart = value.lastIndexOf('\n', s - 1) + 1;
    if (e.key === 'Escape') {
      e.preventDefault();
      onDone(false);
      return;
    }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey || e.shiftKey)) {
      e.preventDefault();
      onDone(true);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const line = value.slice(lineStart, s);
      let indent = /^[ \t]*/.exec(line)![0];
      const trimmed = line.replace(/#.*$/, '').trimEnd();
      if (trimmed.endsWith(':')) indent += INDENT;
      else if (/^\s*(return|pass|break|continue|raise)\b/.test(line)) indent = indent.slice(0, Math.max(0, indent.length - 4));
      edit(el, s, en, '\n' + indent);
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      const multi = value.slice(s, en).includes('\n');
      if (!multi && !e.shiftKey) {
        edit(el, s, en, INDENT);
        return;
      }
      // indent or dedent every selected line
      const endLine = value.indexOf('\n', en - (en > s && value[en - 1] === '\n' ? 1 : 0));
      const blockEnd = endLine < 0 ? value.length : endLine;
      const block = value.slice(lineStart, blockEnd).split('\n');
      const changed = block.map((l) => (e.shiftKey ? l.replace(/^ {1,4}|^\t/, '') : INDENT + l)).join('\n');
      const delta0 = e.shiftKey ? -(block[0].length - block[0].replace(/^ {1,4}|^\t/, '').length) : INDENT.length;
      edit(el, lineStart, blockEnd, changed, Math.max(lineStart, s + delta0), lineStart + changed.length);
      return;
    }
    if (e.key === 'Backspace' && s === en && s > lineStart) {
      const before = value.slice(lineStart, s);
      if (/^ +$/.test(before)) {
        e.preventDefault();
        const n = before.length % 4 || 4;
        edit(el, s - n, s, '');
      }
    }
  };

  // drag the right edge to change the width
  const onResize = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const x0 = e.clientX, w0 = region.width;
    const move = (ev: PointerEvent) => set({ width: Math.max(240, Math.round((w0 + (ev.clientX - x0) / zoom) / 8) * 8) }, `pyw:${region.id}`);
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const status = r?.loading ? 'loading' : r?.error ? 'error' : r ? 'ok' : '';
  const showCode = editing || !region.collapsed;
  const hasOutput = !!(r && (r.stdout || r.outputs.length || r.error || r.loading));

  return (
    <div className={`py-region${editing ? ' editing' : ''}${status ? ' ' + status : ''}`} style={{ width: region.width }}>
      <div className="py-head">
        <button
          className="py-fold"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => set({ collapsed: !region.collapsed }, '')}
          title={region.collapsed ? 'Show the code' : 'Hide the code (show only the results)'}
          aria-label={region.collapsed ? 'Show code' : 'Hide code'}
        >
          {showCode ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </button>
        <span className="py-tag">Python</span>
        {r?.loading && <span className="py-status"><Loader2 className="spin" size={12} /> starting Python…</span>}
        {status === 'ok' && r!.outputs.length > 0 && <span className="py-status">→ {r!.outputs.filter((o) => !o.note || o.tex).map((o) => o.name).join(', ')}</span>}
        {editing && <span className="py-hint">Tab indents · Ctrl+Enter or Esc to finish</span>}
      </div>
      {showCode && (
        <div className="py-code">
          <div className="py-gutter" aria-hidden>
            {Array.from({ length: lines }, (_, i) => (
              <div key={i} className={r?.line === i + 1 ? 'err' : undefined}>{i + 1}</div>
            ))}
          </div>
          <div className="py-editor">
            <pre className="py-hl" aria-hidden dangerouslySetInnerHTML={{ __html: code ? html : '<span class="py-ph"># Python — worksheet variables above are available; what you assign is exported\n</span>' }} />
            {editing && (
              <textarea
                ref={ta}
                className="py-input"
                value={code}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                wrap="off"
                aria-label="Python code"
                onChange={(e) => set({ code: e.target.value })}
                onKeyDown={onKeyDown}
                onPointerDown={(e) => e.stopPropagation()}
              />
            )}
          </div>
        </div>
      )}
      {hasOutput && (
        <div className="py-out">
          {r!.stdout && <pre className="py-stdout">{r!.stdout.replace(/\n$/, '')}</pre>}
          {r!.error && (
            <div className="region-error py-error" role="alert">
              {r!.line ? `Line ${r!.line}: ` : ''}{r!.error}
            </div>
          )}
          {r!.outputs.length > 0 && (
            <div className="py-vars">
              {r!.outputs.map((o) => (
                <div key={o.name} className={`py-var${o.tex ? '' : ' skipped'}`} title={o.note}>
                  {o.tex ? <Tex tex={o.tex} /> : <code>{o.name}</code>}
                  {o.note && <span className="py-note">{o.note}</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {editing && <div className="py-resize" onPointerDown={onResize} title="Drag to change the width" />}
    </div>
  );
}
