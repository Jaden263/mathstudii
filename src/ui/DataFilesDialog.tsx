import { useEffect, useRef, useState, type Dispatch } from 'react';
import { X, FileText, AlertTriangle } from 'lucide-react';
import type { Worksheet } from '../model/types';
import type { Action } from './store';
import { dataFileKey, dataFilesIn } from '../model/dataFiles';
import { pickFile } from '../platform/files';
import { toBase64 } from '../importers/common';
import { XLSX_MIME } from '../sheet/xlsx';

/** Larger files are refused: the worksheet keeps what it reads, and saves it with itself. */
const MAX_BYTES = 8 * 1024 * 1024;

/** The data files a worksheet reads (READPRN("…") …) and those it keeps. */
export function dataFileNames(ws: Worksheet): { name: string; attached: boolean; size: number }[] {
  const kept = ws.settings.dataFiles ?? {};
  const keys = new Map(Object.keys(kept).map((k) => [dataFileKey(k), k]));
  const out = new Map<string, { name: string; attached: boolean; size: number }>();
  for (const r of ws.regions) {
    if (r.kind !== 'math') continue;
    for (const path of dataFilesIn(r.source)) {
      const key = dataFileKey(path);
      if (out.has(key)) continue;
      const k = keys.get(key);
      out.set(key, { name: k ?? path.split(/[\\/]/).pop() ?? path, attached: k !== undefined, size: k !== undefined ? kept[k].length : 0 });
    }
  }
  for (const [key, k] of keys) if (!out.has(key)) out.set(key, { name: k, attached: true, size: kept[k].length });
  return [...out.values()];
}

/** A file's contents as the worksheet keeps it: text, or a data: URL for an Excel workbook. */
export async function keptContents(f: File): Promise<string> {
  const bytes = new Uint8Array(await f.arrayBuffer());
  if (bytes.length > MAX_BYTES) throw new Error(`${f.name} is ${(bytes.length / 1048576).toFixed(1)} MB; data files up to ${MAX_BYTES / 1048576} MB can be kept in a worksheet`);
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) return `data:${XLSX_MIME};base64,${toBase64(bytes)}`;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

export function DataFilesDialog({ ws, dispatch, onClose }: { ws: Worksheet; dispatch: Dispatch<Action>; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);
  const files = dataFileNames(ws);
  const kept = ws.settings.dataFiles ?? {};
  const attach = async (name: string) => {
    setError('');
    const f = await pickFile('.txt,.prn,.dat,.csv,.tsv,.xlsx,text/plain,text/csv');
    if (!f) return;
    try {
      const text = await keptContents(f);
      // kept under the name the worksheet reads it by (whatever the picked file is called)
      const rest = Object.fromEntries(Object.entries(kept).filter(([k]) => dataFileKey(k) !== dataFileKey(name)));
      dispatch({ type: 'settings', patch: { dataFiles: { ...rest, [name]: text } } });
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const remove = (name: string) => {
    const rest = Object.fromEntries(Object.entries(kept).filter(([k]) => dataFileKey(k) !== dataFileKey(name)));
    dispatch({ type: 'settings', patch: { dataFiles: Object.keys(rest).length ? rest : undefined } });
  };
  return (
    <dialog ref={ref} className="dialog" onClose={onClose} onClick={(e) => e.target === ref.current && onClose()} aria-labelledby="df-title">
      <div className="dialog-head">
        <h2 id="df-title">Data files</h2>
        <button className="icon-btn" onClick={onClose} aria-label="Close"><X size={18} /></button>
      </div>
      <div className="dialog-body">
        <p className="hint">
          READPRN, READCSV, READFILE and READEXCEL read files the worksheet keeps: attach each one here and it is saved with the worksheet, so the
          calculation needs no file on disk. A file is found by its name, whatever folder the worksheet names.
        </p>
        {!files.length && <p className="hint">This worksheet reads no data files.</p>}
        <ul className="data-files">
          {files.map((f) => (
            <li key={f.name}>
              {f.attached ? <FileText size={15} /> : <AlertTriangle size={15} className="warn" />}
              <span className="df-name">{f.name}</span>
              <small>{f.attached ? (kept[f.name]?.startsWith('data:') ? 'Excel workbook' : `${f.size.toLocaleString()} characters`) : 'not attached'}</small>
              <button className="btn" onClick={() => void attach(f.name)}>{f.attached ? 'Replace…' : 'Attach…'}</button>
              {f.attached && <button className="btn" onClick={() => remove(f.name)}>Remove</button>}
            </li>
          ))}
        </ul>
        {error && <p className="region-error" role="alert">{error}</p>}
      </div>
    </dialog>
  );
}
