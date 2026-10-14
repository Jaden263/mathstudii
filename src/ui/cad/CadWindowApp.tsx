// Root of a separate CAD window (index.html#cad=<region>&s=<session>). It shows the part
// it receives from the worksheet window and sends every edit back there, so undo,
// saving and evaluation stay with the worksheet.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CadRegion } from '../../model/types';
import type { CadResult } from '../../cad/evaluate';
import type { Action } from '../store';
import { SketchContext, INITIAL_SKETCH_UI, type SketchUI } from '../sketch/context';
import { loadPref } from '../../platform/files';
import { closeThisWindow, openChannel, type CadChannel, type CadMsg } from './cadWindow';
import { CadWorkspace } from './CadWorkspace';

export function CadWindowApp({ id, session }: { id: string; session: string }) {
  const [region, setRegion] = useState<CadRegion | null>(null);
  const [result, setResult] = useState<CadResult | undefined>(undefined);
  const [lastSeen, setLastSeen] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [gone, setGone] = useState(false);
  const [ui, setUiState] = useState<SketchUI>({ ...INITIAL_SKETCH_UI, regionId: id });
  const channel = useRef<CadChannel | null>(null);
  const seq = useRef(0);

  // theme follows the worksheet's preference (same origin, same storage)
  useEffect(() => {
    const apply = () => {
      const theme = loadPref<string>('theme', 'system');
      if (theme === 'system') document.documentElement.removeAttribute('data-theme');
      else document.documentElement.setAttribute('data-theme', theme);
    };
    apply();
    window.addEventListener('storage', apply);
    return () => window.removeEventListener('storage', apply);
  }, []);

  useEffect(() => {
    const ch = openChannel((m: CadMsg) => {
      if (m.s !== session || m.id !== id) return;
      if (m.t === 'state') {
        setLastSeen(Date.now());
        setResult(m.result);
        // an echo of an older edit must not undo a newer local one
        if (m.ack >= seq.current) setRegion(m.region);
      } else if (m.t === 'gone') {
        setGone(true);
        window.setTimeout(() => void closeThisWindow(), 1500);
      }
    });
    channel.current = ch;
    const hello = () => ch.post({ t: 'hello', s: session, id, seq: seq.current });
    hello();
    const beat = window.setInterval(() => {
      hello();
      setNow(Date.now());
    }, 2000);
    const bye = () => ch.post({ t: 'bye', s: session, id });
    window.addEventListener('beforeunload', bye);
    return () => {
      window.clearInterval(beat);
      window.removeEventListener('beforeunload', bye);
      bye();
      ch.close();
    };
  }, [id, session]);

  useEffect(() => {
    document.title = `${region?.name || 'Part'} — mathstudii CAD`;
  }, [region?.name]);

  const dispatch = useCallback((a: Action) => {
    if (a.type !== 'update' || a.id !== id) return;
    const patch = a.patch as Partial<CadRegion>;
    setRegion((r) => (r ? { ...r, ...patch } : r));
    channel.current?.post({ t: 'patch', s: session, id, seq: ++seq.current, patch, coalesce: a.coalesce, history: a.history });
  }, [id, session]);

  const ctx = useMemo(() => ({
    ui,
    setUi: (patch: Partial<SketchUI>) => setUiState((u) => ({ ...u, ...patch })),
    getWorksheet: () => ({ format: 'mathstudii' as const, version: 1 as const, title: '', settings: {} as never, regions: region ? [region] : [] }),
    showProperties: () => {},
    separate: () => {},
  }), [ui, region]);

  const connected = now - lastSeen < 6000;
  if (gone) return <div className="cadw-wait">This part was removed from the worksheet. Closing…</div>;
  if (!region) {
    return (
      <div className="cadw-wait">
        <b>Connecting to the worksheet…</b>
        <span>Keep the worksheet window open: the CAD window edits a part that lives there.</span>
      </div>
    );
  }
  return (
    <SketchContext.Provider value={ctx}>
      <CadWorkspace region={region} result={result} dispatch={dispatch} connected={connected} onClose={() => void closeThisWindow()} />
    </SketchContext.Provider>
  );
}
