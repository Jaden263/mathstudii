// Panels of the CAD workspace for what parts are made of and how they look, and for the
// Inspect tab: physical materials and appearances of components, bodies and faces, the
// mass properties panel, the analyses' options and legends, and the render dialog.
import type { ReactNode } from 'react';
import type { CadComponent, CadDesign } from '../../cad/design';
import { identifier } from '../../cad/design';
import type { DesignResult } from '../../cad/evaluate';
import { CAD_MATERIALS, MATERIAL_FAMILIES, cadMaterial, materialOfBody } from '../../cad/materials';
import { APPEARANCES, APPEARANCE_GROUPS, appearance, bodyLook, type Look } from '../../cad/appearances';
import { massReport, type M3, type MassReport } from '../../cad/massProps';
import { DRAFT_COLOURS, divergingColour } from '../../cad/analysis';
import { PALETTE, hexColor } from './useDesign';
import { num } from './SketchPanel';
import type { Analysis, AxisDir } from './inspectView';
import type { RenderBackground } from './renderExport';

const css = (c: [number, number, number]) => `rgb(${c.map((x) => Math.round(Math.max(0, Math.min(1, x)) * 255)).join(',')})`;

/** A small swatch of a look: metals with a sheen, see-through ones chequered. */
export function LookSwatch({ look, title }: { look: Look; title?: string }) {
  const base = css(look.color);
  const sheen = look.metal ? `linear-gradient(135deg, rgba(255,255,255,${0.7 - 0.5 * look.rough}) 0%, ${base} 45%, rgba(0,0,0,0.35) 100%)` : `linear-gradient(135deg, rgba(255,255,255,${0.35 * (1 - look.rough)}) 0%, ${base} 40%)`;
  return <span className={`cadm-swatch${look.opacity < 1 ? ' clear' : ''}`} title={title} style={{ background: sheen, opacity: 0.35 + 0.65 * look.opacity }} />;
}

/** A library material, or the one inherited (`inherit` names where from). */
export function MaterialSelect({ value, inherit, onChange, label = 'Material' }: { value?: string; inherit: string; onChange: (id: string | undefined) => void; label?: string }) {
  const known = !value || cadMaterial(value);
  return (
    <select aria-label={label} value={value ?? ''} onChange={(e) => onChange(e.target.value || undefined)}>
      <option value="">{inherit}</option>
      {!known && <option value={value}>{value} (unknown)</option>}
      {MATERIAL_FAMILIES.map((f) => (
        <optgroup key={f} label={f}>
          {CAD_MATERIALS.filter((m) => m.family === f).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </optgroup>
      ))}
    </select>
  );
}

export function AppearanceSelect({ value, inherit, onChange, label = 'Appearance' }: { value?: string; inherit: string; onChange: (id: string | undefined) => void; label?: string }) {
  return (
    <select aria-label={label} value={value && appearance(value) ? value : ''} onChange={(e) => onChange(e.target.value || undefined)}>
      <option value="">{inherit}</option>
      {APPEARANCE_GROUPS.map((g) => (
        <optgroup key={g} label={g}>
          {APPEARANCES.filter((x) => x.group === g).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
        </optgroup>
      ))}
    </select>
  );
}

/** The colour a component shows without an appearance: its own, else the palette's. */
export const componentColour = (design: CadDesign, c: CadComponent): [number, number, number] =>
  hexColor(c.color) ?? PALETTE[Math.max(0, design.components.indexOf(c)) % PALETTE.length];

/** The density a component or body weighs with, as text (kg/m³). */
function densityText(dens: number | undefined, unit: string): string {
  if (dens === undefined) return 'no mass';
  const per = { mm: 1e-9, cm: 1e-6, m: 1, in: 0.0254 ** 3 }[unit] ?? 1e-9;
  return `ρ = ${num(dens / per, 5)} kg/m³`;
}

/**
 * A component's material, appearance and colour, and its density expression (it wins
 * over the material when set). Picking a material lets its appearance show.
 */
export function ComponentLook({ design, comp, dr, unit, onPatch }: { design: CadDesign; comp: CadComponent; dr?: DesignResult; unit: string; onPatch: (p: Partial<CadComponent>, coalesce?: string) => void }) {
  const look = bodyLook(design, comp, '', componentColour(design, comp));
  const partMat = cadMaterial(design.material);
  return (
    <>
      <label className="field"><span>Physical material</span>
        <MaterialSelect value={comp.material} inherit={partMat ? `Part material (${partMat.id})` : 'Part material'}
          onChange={(material) => onPatch({ material, density: material ? undefined : comp.density, appearance: material ? undefined : comp.appearance, color: material ? undefined : comp.color })} />
      </label>
      <div className="cadm-row">
        <label className="field"><span>Appearance</span>
          <AppearanceSelect value={comp.appearance} inherit={comp.color ? 'Colour' : 'From the material'} onChange={(appearance) => onPatch({ appearance })} />
        </label>
        <LookSwatch look={look} title="How its bodies look" />
        <label className="field cadm-colour"><span>Colour</span>
          <input type="color" value={comp.color ?? '#a3b0c4'} onChange={(e) => onPatch({ color: e.target.value, appearance: undefined }, `color:${comp.id}`)} />
        </label>
      </div>
      <p className="hint">{densityText(dr?.params[comp.id]?.density, unit)}{comp.density?.trim() ? ' from the density expression' : comp.material ? ` (${comp.material})` : ''}</p>
    </>
  );
}

/** A body's own material and appearance (they override its component's). */
export function BodyLook({ design, comp, body, dr, unit, onPatch }: { design: CadDesign; comp: CadComponent; body: string; dr?: DesignResult; unit: string; onPatch: (p: Partial<CadComponent>) => void }) {
  const set = (k: 'bodyMaterials' | 'bodyAppearances', id: string | undefined) => {
    const next = { ...comp[k] };
    if (id) next[body] = id;
    else delete next[body];
    return Object.keys(next).length ? next : undefined;
  };
  const inherited = materialOfBody(design, { ...comp, bodyMaterials: undefined }, body);
  const look = bodyLook(design, comp, body, componentColour(design, comp));
  const dens = dr?.params[comp.id]?.[`rho:${body}`] ?? dr?.params[comp.id]?.density;
  return (
    <>
      <label className="field"><span>Physical material</span>
        <MaterialSelect value={comp.bodyMaterials?.[body]} inherit={`As ${comp.name}${inherited ? ` (${inherited.id})` : ''}`} onChange={(id) => onPatch({ bodyMaterials: set('bodyMaterials', id) })} />
      </label>
      <div className="cadm-row">
        <label className="field"><span>Appearance</span>
          <AppearanceSelect value={comp.bodyAppearances?.[body]} inherit={comp.bodyMaterials?.[body] ? 'From its material' : `As ${comp.name}`} onChange={(id) => onPatch({ bodyAppearances: set('bodyAppearances', id) })} />
        </label>
        <LookSwatch look={look} />
      </div>
      <p className="hint">{densityText(dens, unit)}</p>
    </>
  );
}

/** Every component and body with its material and appearance: assigning them all in one place. */
export function MaterialsPanel({ design, dr, unit, onPatch, faces }: { design: CadDesign; dr?: DesignResult; unit: string; onPatch: (cid: string, p: Partial<CadComponent>) => void; faces?: ReactNode }) {
  return (
    <div className="cadm-list">
      {faces}
      {design.components.map((c) => (
        <section key={c.id} className="cadm-comp">
          <h4>{c.name}</h4>
          <ComponentLook design={design} comp={c} dr={dr} unit={unit} onPatch={(p) => onPatch(c.id, p)} />
          {(dr?.bodies[c.id] ?? []).filter((b) => !b.empty).length > 1 && (dr?.bodies[c.id] ?? []).filter((b) => !b.empty).map((b) => (
            <div key={b.id} className="cadm-body">
              <b>{b.name}</b>
              <BodyLook design={design} comp={c} body={b.id} dr={dr} unit={unit} onPatch={(p) => onPatch(c.id, p)} />
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}

// ------------------------------------------------------------ mass properties

/** What the mass panel measures: the assembly, a component (`c:id`) or a body (`b:component:body`). */
export type MassTarget = string;

export interface MassChoice {
  report: MassReport | null;
  /** Worksheet path of it (`asm.Flange.Body1`), null when the part has no name. */
  path: string | null;
  label: string;
  /** Its coordinates are the component's (placed by this occurrence in the view). */
  component?: string;
}

/** The report and worksheet path of a mass target. */
export function massChoice(design: CadDesign, dr: DesignResult | undefined, partName: string, target: MassTarget): MassChoice {
  const single = design.components.length === 1;
  const base = partName.trim() || null;
  const join = (...xs: (string | null)[]) => (base && xs.every(Boolean) ? [base, ...xs].join('.') : null);
  if (target.startsWith('c:')) {
    const c = design.components.find((q) => q.id === target.slice(2));
    if (!c) return { report: null, path: null, label: '?' };
    return { report: massReport(dr?.components[c.id]), path: single ? base : join(identifier(c.name)), label: c.name, component: c.id };
  }
  if (target.startsWith('b:')) {
    const [cid, bid] = target.slice(2).split(':');
    const c = design.components.find((q) => q.id === cid), b = dr?.bodies[cid]?.find((q) => q.id === bid);
    if (!c || !b) return { report: null, path: null, label: '?' };
    return { report: massReport(b.mass), path: single ? join(identifier(b.name)) : join(identifier(c.name), identifier(b.name)), label: `${c.name} · ${b.name}`, component: c.id };
  }
  return { report: massReport(dr?.total), path: base, label: 'Assembly' };
}

function Tensor({ J, unit }: { J: M3; unit: string }) {
  return (
    <table className="cadm-tensor" aria-label="Inertia tensor">
      <tbody>
        {[0, 1, 2].map((i) => <tr key={i}>{[0, 1, 2].map((j) => <td key={j}>{num(J[3 * i + j], 5)}</td>)}</tr>)}
      </tbody>
      <caption>kg·{unit}²</caption>
    </table>
  );
}

const AXIS_COLOURS = ['#e03131', '#2f9e44', '#1c7ed6'];

export function MassPanel({ design, dr, unit, partName, target, onTarget, show, onShow, onCopy }: {
  design: CadDesign; dr?: DesignResult; unit: string; partName: string; target: MassTarget; onTarget: (t: MassTarget) => void;
  show: { cog: boolean; axes: boolean }; onShow: (s: { cog: boolean; axes: boolean }) => void; onCopy: (choice: MassChoice) => void;
}) {
  const choice = massChoice(design, dr, partName, target);
  const r = choice.report;
  const v3 = (v: number[], d = 5) => v.map((x) => num(Math.abs(x) < 1e-12 ? 0 : x, d)).join(', ');
  return (
    <div className="cadm-mass">
      <label className="field"><span>Of</span>
        <select value={target} onChange={(e) => onTarget(e.target.value)} aria-label="Mass properties of">
          <option value="asm">Assembly (all visible occurrences)</option>
          {design.components.map((c) => (
            <optgroup key={c.id} label={c.name}>
              <option value={`c:${c.id}`}>{c.name} (component)</option>
              {(dr?.bodies[c.id] ?? []).filter((b) => !b.empty).map((b) => <option key={b.id} value={`b:${c.id}:${b.id}`}>{b.name}</option>)}
            </optgroup>
          ))}
        </select>
      </label>
      {!r ? <p className="hint">{dr ? 'No mass: give the part, the component or the body a material (or a density).' : 'Evaluating…'}</p> : (
        <>
          <table className="props-table">
            <tbody>
              <tr><td>Mass</td><td><b>{num(r.m, 5)}</b> kg</td></tr>
              <tr><td>Volume</td><td>{num(r.V, 5)} {unit}³</td></tr>
              {r.A !== undefined && <tr><td>Area</td><td>{num(r.A, 5)} {unit}²</td></tr>}
              <tr><td>Density</td><td>{densityText(r.rho, unit).replace('ρ = ', '')}{choice.component ? '' : ' (mean)'}</td></tr>
              <tr><td>Centre of gravity</td><td>{v3(r.c)} {unit}</td></tr>
            </tbody>
          </table>
          <h4 className="cadm-h">Inertia tensor at the centre of gravity</h4>
          <Tensor J={r.J} unit={unit} />
          <h4 className="cadm-h">… at the origin</h4>
          <Tensor J={r.JO} unit={unit} />
          <h4 className="cadm-h">Principal moments and axes</h4>
          <table className="props-table">
            <tbody>
              {r.moments.map((I, k) => (
                <tr key={k}>
                  <td><span className="cadm-axis" style={{ background: AXIS_COLOURS[k] }} />I<sub>{k + 1}</sub></td>
                  <td>{num(I, 5)} kg·{unit}² · ({v3(r.axes[k], 4)})</td>
                </tr>
              ))}
            </tbody>
          </table>
          <h4 className="cadm-h">Radii of gyration</h4>
          <table className="props-table">
            <tbody>
              <tr><td>k<sub>x</sub>, k<sub>y</sub>, k<sub>z</sub></td><td>{v3(r.k)} {unit}</td></tr>
              <tr><td>k<sub>1</sub>, k<sub>2</sub>, k<sub>3</sub></td><td>{v3(r.kp)} {unit}</td></tr>
            </tbody>
          </table>
          <p className="hint">
            {choice.component ? `In ${design.components.find((c) => c.id === choice.component)?.name}’s coordinates (about its origin).` : 'In assembly coordinates (about its origin).'}
            {' '}J<sub>xy</sub> = −∫xy dm off the diagonal; the worksheet’s Imxy is +∫xy dm.
          </p>
          <label className="check"><input type="checkbox" checked={show.cog} onChange={(e) => onShow({ ...show, cog: e.target.checked })} /> Show the centre of gravity</label>
          <label className="check"><input type="checkbox" checked={show.axes} onChange={(e) => onShow({ ...show, axes: e.target.checked })} /> Show the principal axes</label>
          <div className="cadd-actions">
            <button className="btn" onClick={() => onCopy(choice)} title={choice.path ? `Math regions reading ${choice.path}: paste them into the worksheet` : 'The values as definitions: paste them into the worksheet (name the part to read them live)'}>Copy to worksheet</button>
          </div>
          {choice.path && <p className="hint">In the worksheet: <code>{choice.path}.m</code>, <code>.Im1</code> … <code>.Im3</code>, <code>.e1</code>, <code>.k1</code>, <code>.ImOz</code>, <code>.S</code>.</p>}
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------ analyses

const DIRS: AxisDir[] = ['+Z', '-Z', '+X', '-X', '+Y', '-Y'];

/** The analysis bar over the view: its options and its legend. */
export function AnalysisBar({ analysis, onChange, range, unit, draftOf, onClose }: {
  analysis: Analysis; onChange: (a: Analysis) => void; range?: number; unit: string;
  /** The draft angle of the picked face against the pull direction (degrees), if a face is picked. */
  draftOf?: number | null; onClose: () => void;
}) {
  const close = <button className="icon-btn" onClick={onClose} aria-label="Close the analysis">×</button>;
  if (analysis.kind === 'zebra') {
    return (
      <div className="cadw-inspect cadm-analysis" onPointerDown={(e) => e.stopPropagation()}>
        <b>Zebra</b>
        <input type="range" min={4} max={40} step={1} value={analysis.stripes} aria-label="Stripes" onChange={(e) => onChange({ ...analysis, stripes: Number(e.target.value) })} />
        <span className="cadw-inspect-val">{analysis.stripes} stripes</span>
        <span className="cadm-note">continuous stripes: G2 · kinked: G1 · broken: G0</span>
        {close}
      </div>
    );
  }
  if (analysis.kind === 'draft') {
    return (
      <div className="cadw-inspect cadm-analysis" onPointerDown={(e) => e.stopPropagation()}>
        <b>Draft</b>
        <label>Pull <select value={analysis.pull} onChange={(e) => onChange({ ...analysis, pull: e.target.value as AxisDir })} aria-label="Pull direction">
          {DIRS.map((d) => <option key={d} value={d}>{d}</option>)}
        </select></label>
        <label>Least <input type="number" min={0} max={45} step={0.5} value={analysis.angle} aria-label="Least draft angle" onChange={(e) => onChange({ ...analysis, angle: Math.max(0, Number(e.target.value) || 0) })} /> °</label>
        <span className="cadm-legend">
          <span><i style={{ background: css(DRAFT_COLOURS.positive) }} /> ≥ +{analysis.angle}°</span>
          <span><i style={{ background: css(DRAFT_COLOURS.insufficient) }} /> too little</span>
          <span><i style={{ background: css(DRAFT_COLOURS.negative) }} /> ≤ −{analysis.angle}°</span>
        </span>
        {draftOf !== undefined && <span className="cadw-inspect-val">{draftOf === null ? 'picked face: curved' : `picked face: ${num(draftOf, 5)}°`}</span>}
        {close}
      </div>
    );
  }
  const r = range ?? 0;
  const per = analysis.which === 'mean' ? `1/${unit}` : `1/${unit}²`;
  const stops = [-1, -0.5, 0, 0.5, 1].map((t) => `${css(divergingColour(t * r, r))} ${(t + 1) * 50}%`).join(', ');
  return (
    <div className="cadw-inspect cadm-analysis" onPointerDown={(e) => e.stopPropagation()}>
      <b>Curvature</b>
      <select value={analysis.which} onChange={(e) => onChange({ ...analysis, which: e.target.value as 'mean' | 'gauss', range: undefined })} aria-label="Which curvature">
        <option value="mean">Mean H</option><option value="gauss">Gaussian K</option>
      </select>
      <span className="cadm-bar" style={{ background: `linear-gradient(90deg, ${stops})` }} />
      <span className="cadw-inspect-val">±{num(r, 3)} {per}</span>
      <label title="The value at the ends of the colour bar (empty: automatic)">Range <input type="number" min={0} step="any" value={analysis.range ?? ''} placeholder="auto" aria-label="Curvature range" onChange={(e) => onChange({ ...analysis, range: Number(e.target.value) > 0 ? Number(e.target.value) : undefined })} /></label>
      {close}
    </div>
  );
}

// ------------------------------------------------------------ render

export function RenderFields({ scale, background, plain, onChange }: { scale: number; background: RenderBackground; plain: boolean; onChange: (p: { scale?: number; background?: RenderBackground; plain?: boolean }) => void }) {
  return (
    <>
      <label className="field"><span>Size</span>
        <select value={scale} onChange={(e) => onChange({ scale: Number(e.target.value) })} aria-label="Render size">
          <option value={1}>1× the view</option><option value={2}>2× the view</option><option value={4}>4× the view</option>
        </select>
      </label>
      <label className="field"><span>Background</span>
        <select value={background} onChange={(e) => onChange({ background: e.target.value as RenderBackground })} aria-label="Background">
          <option value="transparent">Transparent</option><option value="white">White</option>
        </select>
      </label>
      <label className="check"><input type="checkbox" checked={plain} onChange={(e) => onChange({ plain: e.target.checked })} /> Bodies only (no planes, sketches or marks)</label>
      <p className="hint">The view as it is framed, with its appearances or analysis and edges, without the ViewCube and the labels, in the light theme.</p>
    </>
  );
}
