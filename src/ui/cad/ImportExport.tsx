// Insert → Import and File → Export in the CAD workspace, as in Fusion: pick (or drop) a
// STEP, STL, OBJ or 3MF file, see what it holds and how it comes in (the unit of a mesh,
// mesh body or solid), and it becomes an import feature; Replace file on that feature puts
// a new version under it. Export writes STEP, STL, 3MF, OBJ or glTF of a body, a component
// or the assembly; a picked flat face goes out as a DXF profile for cutting.
import { useCallback, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { FileUp, FileDown, FileBox, Download, PenLine, Upload } from 'lucide-react';
import type { CadRegion } from '../../model/types';
import type { CadResult } from '../../cad/evaluate';
import type { CadDesign, ImportFeature } from '../../cad/design';
import type { CadUnit } from '../../cad/model';
import type { BuildResult } from '../../cad/buildResult';
import type { ExportScope } from '../../cad/kernel/protocol';
import type { Selection } from '../../cad/selection';
import type { ImportPlan } from '../../cad/importDesign';
import { importFormatOf, sizeWords, type ImportedFile } from '../../cad/imported';
import { SEW_LIMIT } from '../../cad/importFeature';
import { designNumbers } from '../../cad/keys';
import { exportFile, pickImportFiles } from '../../platform/files';
import { Dialog, Pick } from './FeatureDialogs';
import { FORMATS, defaultScope, exportPart, type PartFormat } from './exportPart';
import { kernelRequest } from './kernelClient';

type Files = { name: string; bytes: Uint8Array }[];

interface Props {
  region: CadRegion;
  result?: CadResult;
  build: BuildResult | null;
  /** The design as it is now (edits in the same event included). */
  design: () => CadDesign;
  setDesign: (d: CadDesign) => void;
  /** The active component (a single part goes into it). */
  active?: string;
  setActive: (cid: string) => void;
  picks: Selection;
  setMsg: (m: string) => void;
  busy: string;
  setBusy: (b: string) => void;
}

type Panel =
  | { kind: 'import'; plan: ImportPlan; fileUnit: CadUnit; solid: boolean }
  | { kind: 'export'; format: PartFormat; scope: string };

const UNITS: [CadUnit, string][] = [['mm', 'millimetres'], ['cm', 'centimetres'], ['m', 'metres'], ['in', 'inches']];
const FORMAT_NAMES: Record<ImportedFile['format'], string> = { step: 'STEP', stl: 'STL', obj: 'OBJ', '3mf': '3MF' };
/** A file's unit in words, from millimetres per unit. */
const unitWords = (mm: number) => ({ 0.001: 'microns', 1: 'millimetres', 10: 'centimetres', 1000: 'metres', 25.4: 'inches', 304.8: 'feet' } as Record<number, string>)[mm] ?? `units of ${mm} mm`;

/** Read the MTL colours that came with an OBJ (Kd of each material). */
async function materialsOf(files: Files): Promise<Record<string, string> | undefined> {
  const mtl = files.find((f) => /\.mtl$/i.test(f.name));
  if (!mtl) return undefined;
  const { readMtl } = await import('../../cad/meshFiles');
  return readMtl(new TextDecoder().decode(mtl.bytes));
}

const scopeKey = (s: ExportScope) => (s.kind === 'assembly' ? 'assembly' : s.kind === 'component' ? `c:${s.component}` : `b:${s.component}:${s.body}`);
const scopeOf = (k: string): ExportScope => {
  if (k === 'assembly') return { kind: 'assembly' };
  const [kind, component, body] = k.split(':');
  return kind === 'c' ? { kind: 'component', component } : { kind: 'body', component, body };
};

export function useImportExport(p: Props) {
  const [panel, setPanel] = useState<Panel | null>(null);
  const [dragging, setDragging] = useState(false);
  const live = useRef(p);
  live.current = p;

  // ------------------------------------------------------------ import

  /** Read picked or dropped files and show what the first CAD file holds. */
  const readFiles = useCallback(async (files: Files) => {
    const { setMsg, setBusy } = live.current;
    const file = files.find((f) => importFormatOf(f.name));
    if (!file) {
      if (files.length) setMsg(`Not a file the CAD imports: ${files.map((f) => f.name).join(', ')} (STEP, STL, OBJ, 3MF)`);
      return;
    }
    const format = importFormatOf(file.name)!;
    setBusy(`Reading ${file.name}…`);
    try {
      const { planImport } = await import('../../cad/importDesign');
      const plan = planImport(file.name, format, file.bytes, await materialsOf(files));
      setPanel({ kind: 'import', plan, fileUnit: 'mm', solid: false });
    } catch (e) {
      setMsg(`Could not read ${file.name}: ${(e as Error).message}`);
    } finally {
      setBusy('');
    }
  }, []);

  const pickImport = useCallback(async () => {
    const files = await pickImportFiles();
    if (files.length) await readFiles(files);
  }, [readFiles]);

  const doImport = async (pn: Extract<Panel, { kind: 'import' }>) => {
    const { insertImport } = await import('../../cad/importDesign');
    const { region, design, setDesign, setActive, setMsg, active } = live.current;
    const plan = { ...pn.plan, warnings: [...pn.plan.warnings] };
    const out = insertImport(design(), plan, { unit: region.unit, active, fileUnit: pn.fileUnit, solid: pn.solid });
    setDesign(out.design);
    if (out.components[0]) setActive(out.components[0]);
    setPanel(null);
    const n = plan.parts.length, k = plan.instances.length;
    setMsg(`Imported ${plan.file.name}${n > 1 || k > 1 ? `: ${n} component${n > 1 ? 's' : ''}, ${k} occurrence${k > 1 ? 's' : ''}` : ''}${plan.warnings.length ? ` · ${plan.warnings.join('; ')}` : ''}`);
  };

  /** Replace the file under an import feature (and every other import of the same file). */
  const replaceFile = useCallback(async (f: ImportFeature) => {
    const { region, design, setDesign, setMsg, setBusy } = live.current;
    const old = design().files?.[f.file];
    const files = await pickImportFiles();
    const file = files.find((x) => importFormatOf(x.name));
    if (!file) return;
    const format = importFormatOf(file.name)!;
    if (old && (format === 'step') !== (old.format === 'step')) return setMsg(`${file.name} is a ${FORMAT_NAMES[format]} file: replace a ${FORMAT_NAMES[old.format]} import with ${old.format === 'step' ? 'a STEP file' : 'a mesh file'}`);
    setBusy(`Reading ${file.name}…`);
    try {
      const { planImport, replaceImport } = await import('../../cad/importDesign');
      const plan = planImport(file.name, format, file.bytes, await materialsOf(files));
      const out = replaceImport(design(), f.file, plan, { unit: region.unit });
      setDesign(out.design);
      setMsg(`Replaced by ${file.name}${out.added.length ? ` · new: ${out.added.join(', ')}` : ''}${out.missing.length ? ` · not in the new file: ${out.missing.join(', ')}` : ''}${out.kept.length ? ` · left where you moved them: ${out.kept.join(', ')}` : ''}${plan.warnings.length ? ` · ${plan.warnings.join('; ')}` : ''}`);
    } catch (e) {
      setMsg(`Could not read ${file.name}: ${(e as Error).message}`);
    } finally {
      setBusy('');
    }
  }, []);

  // ------------------------------------------------------------ drag and drop

  const hasFiles = (e: DragEvent) => [...e.dataTransfer.types].includes('Files');
  const dropProps = {
    onDragOver: (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      if (!dragging) setDragging(true);
    },
    onDragLeave: (e: DragEvent) => {
      // leaving the workspace, not moving between its children
      if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)) setDragging(false);
    },
    onDrop: (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      setDragging(false);
      const list = [...e.dataTransfer.files];
      void Promise.all(list.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) }))).then(readFiles);
    },
  };
  const dropOverlay = dragging ? (
    <div className="cadx-drop" aria-hidden><Upload size={28} /><b>Drop to import</b><span>STEP · STL · OBJ (with its MTL) · 3MF</span></div>
  ) : null;

  // ------------------------------------------------------------ export

  const scopes = (): [string, string][] => {
    const d = live.current.design();
    const out: [string, string][] = [['assembly', `Assembly (${d.occurrences.length} occurrence${d.occurrences.length === 1 ? '' : 's'})`]];
    const res = live.current.result?.design;
    for (const c of d.components) {
      out.push([`c:${c.id}`, `Component ${c.name}`]);
      for (const b of res?.bodies[c.id] ?? []) if (!b.empty || b.mesh) out.push([`b:${c.id}:${b.id}`, `Body ${c.name} › ${b.name}${b.mesh ? ' (mesh)' : ''}`]);
    }
    return out;
  };

  const runExport = async (format: PartFormat, scope?: ExportScope) => {
    const { region, result, setMsg, setBusy } = live.current;
    setBusy(`Writing ${FORMATS[format].label}…`);
    try {
      await exportPart(region, result, format, scope);
      setPanel(null);
    } catch (e) {
      setMsg(`Export failed: ${(e as Error).message}`);
    } finally {
      setBusy('');
    }
  };

  /** The one flat face picked, for the face DXF. */
  const pickedFace = () => {
    const { picks, build, design } = live.current;
    const f = picks.length === 1 && picks[0].kind === 'face' ? picks[0] : null;
    const occ = f && design().occurrences.find((o) => o.id === f.occ);
    const body = occ && build?.components[occ.component]?.bodies.find((b) => b.id === f!.body);
    return f && occ && body?.faces[f.index]?.type === 'plane' && !body.meshOnly ? { component: occ.component, body, face: f.index } : null;
  };
  const faceDxf = async () => {
    const { region, result, design, setMsg, setBusy } = live.current;
    const at = pickedFace();
    if (!at) return setMsg('Pick one flat face of a solid body in the view, then Face DXF');
    const dr = result?.design;
    if (!dr) return setMsg('The part is still being evaluated');
    setBusy('Writing DXF…');
    try {
      const dxf = await kernelRequest({ op: 'faceDxf', design: design(), numbers: designNumbers(dr), component: at.component, body: at.body.id, face: at.face, unit: region.unit });
      const file = (region.name.trim() || 'part').replace(/[^\w.-]+/g, '_');
      await exportFile(`${file}-${at.body.name.replace(/[^\w.-]+/g, '_')}-face.dxf`, dxf, 'application/dxf');
    } catch (e) {
      setMsg(`Face DXF failed: ${(e as Error).message}`);
    } finally {
      setBusy('');
    }
  };

  // ------------------------------------------------------------ ribbon and panels

  const { busy, build } = p;
  const meshKernel = build?.kernel === 'mesh';
  const importButton = (
    <button className="cadw-rbtn" title="Import a STEP, STL, OBJ or 3MF file (or drop one on the workspace)" aria-label="Import" disabled={!!busy} onClick={() => void pickImport()}>
      <FileUp size={20} /><span>Import</span>
    </button>
  );
  const ribbon = (
    <>
      <div className="cadw-group" role="group" aria-label="Import">
        <div className="cadw-group-items">{importButton}</div>
        <div className="cadw-group-label">Import</div>
      </div>
      <div className="cadw-group" role="group" aria-label="Export">
        <div className="cadw-group-items">
          <button className={`cadw-rbtn${panel?.kind === 'export' ? ' on' : ''}`} title="Export a body, a component or the assembly as STEP, STL, 3MF, OBJ or glTF" aria-label="Export" disabled={!!busy}
            onClick={() => setPanel({ kind: 'export', format: meshKernel ? 'stl' : 'step', scope: scopeKey(defaultScope(live.current.region)) })}>
            <FileDown size={20} /><span>Export…</span>
          </button>
          <button className="cadw-rbtn" title={meshKernel ? 'STEP needs the exact B-rep kernel, which could not load' : FORMATS.step.title} aria-label="STEP" disabled={!!busy || meshKernel} onClick={() => void runExport('step')}>
            <FileBox size={20} /><span>STEP</span>
          </button>
          <button className="cadw-rbtn" title={FORMATS.stl.title} aria-label="STL" disabled={!!busy} onClick={() => void runExport('stl')}><Download size={20} /><span>STL</span></button>
          <button className="cadw-rbtn" title={FORMATS['3mf'].title} aria-label="3MF" disabled={!!busy} onClick={() => void runExport('3mf')}><Download size={20} /><span>3MF</span></button>
          <button className="cadw-rbtn" title="A picked flat face as a DXF profile (outer loop and holes, true arcs and circles) for laser, waterjet or plasma cutting" aria-label="Face DXF"
            disabled={!!busy || meshKernel} onClick={() => void faceDxf()}>
            <PenLine size={20} /><span>Face DXF</span>
          </button>
        </div>
        <div className="cadw-group-label">Export</div>
      </div>
    </>
  );

  let dialog: ReactNode = null;
  if (panel?.kind === 'import') {
    const { plan } = panel;
    const f = plan.file, mesh = f.format !== 'step';
    const triangles = plan.parts.reduce((n, q) => n + (q.triangles ?? 0), 0);
    const one = plan.parts.length === 1 && plan.instances.length === 1;
    const into = live.current.design().components.find((c) => c.id === live.current.active);
    dialog = (
      <Dialog title={`Import ${FORMAT_NAMES[f.format]}`} okLabel="Import" onOk={() => void doImport(panel)} onCancel={() => setPanel(null)}>
        <p className="cadx-file"><b>{f.name}</b> · {sizeWords(f.size)} ({sizeWords(f.data.length)} in the worksheet)</p>
        <ul className="cadx-parts">
          {plan.parts.slice(0, 12).map((q) => (
            <li key={`${q.key}/${q.name}`}>
              <span className="cadx-swatch" style={q.color ? { background: q.color } : undefined} />
              {q.name}
              <span className="cadw-muted">
                {mesh ? ` · ${q.triangles} triangle${q.triangles === 1 ? '' : 's'}` : q.bodies.length > 1 ? ` · ${q.bodies.length} solids` : ''}
                {plan.instances.filter((x) => plan.parts[x.part] === q).length > 1 ? ` · ×${plan.instances.filter((x) => plan.parts[x.part] === q).length}` : ''}
              </span>
            </li>
          ))}
          {plan.parts.length > 12 && <li className="cadw-muted">… and {plan.parts.length - 12} more</li>}
        </ul>
        <p className="hint">
          {one ? `Into the active component${into ? `, ${into.name}` : ''}, as an Import feature in its timeline.`
            : `${plan.parts.length} component${plan.parts.length > 1 ? 's' : ''} with ${plan.instances.length} grounded occurrence${plan.instances.length > 1 ? 's' : ''} where the file places them.`}
        </p>
        {mesh && plan.unit === null && (
          <Pick label="The file's numbers are in" value={panel.fileUnit} options={UNITS} onChange={(fileUnit) => setPanel({ ...panel, fileUnit })} />
        )}
        {mesh && plan.unit !== null && <p className="hint">The file is in {unitWords(plan.unit)}; it is converted to {live.current.region.unit}.</p>}
        {f.format === 'step' && <p className="hint">Its numbers are converted from the file's unit to {live.current.region.unit}; names and colours come along.</p>}
        {mesh && (
          <label className="check" title={triangles > SEW_LIMIT ? `Only meshes of up to ${SEW_LIMIT} triangles are sewn into solids` : 'Sew each closed mesh into a B-rep solid whose flat faces the features can work on (seconds: about 10 s for 20 000 triangles)'}>
            <input type="checkbox" checked={panel.solid} disabled={triangles > SEW_LIMIT} onChange={(e) => setPanel({ ...panel, solid: e.target.checked })} />
            Convert to solid{triangles > SEW_LIMIT ? ` (up to ${SEW_LIMIT} triangles)` : ''}
          </label>
        )}
        {mesh && !panel.solid && <p className="hint">A mesh body is shown, measured, placed and drawn, but the features do not work on it.</p>}
        {plan.warnings.map((w) => <div key={w} className="region-warn">{w}</div>)}
      </Dialog>
    );
  } else if (panel?.kind === 'export') {
    const fmt = FORMATS[panel.format];
    dialog = (
      <Dialog title="Export" okLabel="Export" onOk={() => void runExport(panel.format, scopeOf(panel.scope))} onCancel={() => setPanel(null)}>
        <Pick label="Format" value={panel.format} options={(Object.keys(FORMATS) as PartFormat[]).filter((k) => k !== 'step' || !meshKernel).map((k) => [k, `${FORMATS[k].label} (.${FORMATS[k].ext})`])}
          onChange={(format) => setPanel({ ...panel, format })} />
        <Pick label="What" value={panel.scope} options={scopes()} onChange={(scope) => setPanel({ ...panel, scope })} />
        <p className="hint">{fmt.title}.{panel.format === 'step' ? ' Mesh bodies are left out (STEP holds exact solids).' : ''}{panel.format === 'obj' ? ' Saved as two files, the .obj and its .mtl.' : ''}</p>
      </Dialog>
    );
  }

  /** The import feature's own dialog: its file, how it reads it, Replace file. */
  const featureDialog = (f: ImportFeature, o: { error?: string; warning?: string; onChange: (patch: Partial<ImportFeature>) => void; onOk: () => void; onCancel: () => void }) => {
    const file = live.current.design().files?.[f.file];
    const mesh = file && file.format !== 'step';
    return (
      <Dialog title={`Import — ${f.name}`} error={o.error} onOk={o.onOk} onCancel={o.onCancel}>
        <p className="cadx-file">{file ? <><b>{file.name}</b> · {FORMAT_NAMES[file.format]} · {sizeWords(file.size)}</> : 'The file is missing from the document'}</p>
        {f.part?.key && <p className="hint">Part “{f.part.key}” of the file.</p>}
        {mesh && (
          <>
            <Pick label="Numbers without a unit are in" value={f.unit ?? 'mm'} options={UNITS} onChange={(unit) => o.onChange({ unit: unit === 'mm' ? undefined : unit })} />
            <label className="check" title={`Sew closed meshes of up to ${SEW_LIMIT} triangles into B-rep solids`}>
              <input type="checkbox" checked={!!f.solid} onChange={(e) => o.onChange({ solid: e.target.checked || undefined })} /> Convert to solid
            </label>
          </>
        )}
        <button className="btn" onClick={() => void replaceFile(f)} title="Read a new version of the file into this import: references to faces whose surface is the same are kept"><FileUp size={14} /> Replace file…</button>
        {o.warning && <div className="region-warn">{o.warning}</div>}
      </Dialog>
    );
  };

  return { ribbon, importButton, dialog, dropProps, dropOverlay, featureDialog, pickImport, readFiles };
}
