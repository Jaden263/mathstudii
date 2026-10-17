// Assembly motion in the workspace's panels: a joint's DOFs (driven or solved, limits and
// rest values), the drive dialog, motion links, rigid groups, motion studies with their
// player and clearance chart, explode offsets and the bill of materials. The workspace
// owns the document and the view; these only show and edit.
import { useEffect, useRef, useState } from 'react';
import { Pause, Play, Repeat, StepBack, StepForward } from 'lucide-react';
import { JOINT_DOFS, dofLabel, isAngleDof, type DofKey, type ExplodeOffset, type MotionLink, type MotionStudy, type MotionTrack } from '../../cad/assembly';
import type { BomTable } from '../../cad/bom';
import { fmtMass } from '../../cad/annotations';
import type { CadDesign, CadJoint } from '../../cad/design';
import type { DofValues } from '../../cad/kinematics';
import type { MotionResult } from '../../cad/motion';
import type { Vec3 } from '../../cad/solid';
import { Expr, Pick } from './FeatureDialogs';
import { fmtNum } from './cadRender';

const DEG = 180 / Math.PI;

/** A DOF's value as the panels write it: degrees for angles, the part unit for lengths. */
export const dofText = (k: DofKey, v: number | undefined, unit: string) => (v === undefined || !Number.isFinite(v) ? '–' : isAngleDof(k) ? `${fmtNum(v * DEG)}°` : `${fmtNum(v)} ${unit}`);

/** …and as an expression for the document. */
export const dofExpr = (k: DofKey, v: number, unit: string) => (isAngleDof(k) ? `${+(v * DEG).toFixed(4)} deg` : `${+v.toPrecision(10)} ${unit}`);

const FIELD: Record<DofKey, 'angle' | 'offset' | 'x' | 'y' | 'angle2' | 'angle3'> = { angle: 'angle', offset: 'offset', x: 'x', y: 'y', angle2: 'angle2', angle3: 'angle3' };

/**
 * The values of a joint: each DOF it moves by, driven by its expression or solved by the
 * assembly (then the value it was found at shows), with its limits and rest value; and the
 * fixed angle or offset of its frame.
 */
export function JointDofFields({ joint: j, values, unit, onChange, onDrive }: {
  joint: CadJoint;
  /** As placed (solved ones as found). */
  values?: DofValues;
  unit: string;
  onChange: (patch: Partial<CadJoint>, coalesce?: string) => void;
  onDrive?: (dof: DofKey) => void;
}) {
  const dofs = JOINT_DOFS[j.type];
  const fixed = (['angle', 'offset'] as const).filter((k) => !dofs.includes(k));
  const setDof = (k: DofKey, patch: Partial<NonNullable<CadJoint['dofs']>[DofKey]>) => {
    const d = { ...j.dofs?.[k], ...patch };
    for (const key of Object.keys(d) as (keyof typeof d)[]) if (d[key] === undefined || d[key] === '' || d[key] === false) delete d[key];
    const all = { ...j.dofs, [k]: d };
    if (!Object.keys(d).length) delete all[k];
    onChange({ dofs: Object.keys(all).length ? all : undefined });
  };
  return (
    <>
      {dofs.map((k) => {
        const d = j.dofs?.[k];
        const solved = !!d?.free;
        return (
          <fieldset key={k} className="cadd-side cadj-dof">
            <legend>{dofLabel(j.type, k)} · {dofText(k, values?.[k], unit)}</legend>
            <div className="cadj-row">
              {solved
                ? <label className="field"><span>Value</span><input value={`(${dofText(k, values?.[k], unit)})`} readOnly title="Solved: the assembly finds it (a loop of joints)" /></label>
                : <Expr label="Value" value={j[FIELD[k]] ?? ''} placeholder="0" onChange={(v) => onChange({ [FIELD[k]]: v } as Partial<CadJoint>, FIELD[k])} />}
              <label className="check" title="The assembly finds the value: a joint in a closed loop (a four-bar's pins)">
                <input type="checkbox" checked={solved} onChange={(e) => setDof(k, { free: e.target.checked || undefined })} /> Solved
              </label>
              {!solved && onDrive && <button className="btn" title="Move it by hand: the document changes only on Set" onClick={() => onDrive(k)}>Drive…</button>}
            </div>
            <div className="row3">
              <Expr label="Min" value={d?.min ?? ''} placeholder="none" onChange={(v) => setDof(k, { min: v || undefined })} />
              <Expr label="Max" value={d?.max ?? ''} placeholder="none" onChange={(v) => setDof(k, { max: v || undefined })} />
              <Expr label="Rest" value={d?.rest ?? ''} placeholder="0" hint="Where the DOF starts from: a solved one is looked for from here (and stays here when nothing sets it)" onChange={(v) => setDof(k, { rest: v || undefined })} />
            </div>
          </fieldset>
        );
      })}
      {fixed.length > 0 && (
        <div className="row2">
          {fixed.map((k) => <Expr key={k} label={k === 'angle' ? 'Angle (fixed)' : 'Offset along Z (fixed)'} value={j[k]} onChange={(v) => onChange({ [k]: v } as Partial<CadJoint>, k)} />)}
        </div>
      )}
    </>
  );
}

/**
 * Drive a DOF by hand: a slider over its limits (or a turn either way, or the model's size)
 * and a field to type in. The view follows; the document only changes on Set as value.
 */
export function DrivePanel({ joint: j, dof, value, unit, size, values, onValue }: {
  joint: CadJoint;
  dof: DofKey;
  value: number;
  unit: string;
  size: number;
  /** Limits and rest (radians, part units). */
  values: { min?: number; max?: number; rest?: number };
  onValue: (v: number) => void;
}) {
  const ang = isAngleDof(dof);
  const k = ang ? DEG : 1;
  const lo = values.min ?? (ang ? -Math.PI : -size), hi = values.max ?? (ang ? Math.PI : size);
  const [typed, setTyped] = useState<string | null>(null);
  return (
    <>
      <p className="hint">{j.name} · {dofLabel(j.type, dof)}: the view follows the slider and the other joints solve; nothing changes in the worksheet until <b>Set as value</b>.</p>
      <input className="cadj-slider" type="range" min={lo * k} max={hi * k} step={ang ? 0.5 : (hi - lo) / 400} value={Math.min(hi, Math.max(lo, value)) * k}
        aria-label="Drive" onChange={(e) => onValue(Number(e.target.value) / k)} />
      <div className="row2">
        <label className="field"><span>Value ({ang ? '°' : unit})</span>
          <input type="number" step="any" value={typed ?? String(+(value * k).toFixed(ang ? 3 : 4))} onChange={(e) => setTyped(e.target.value)}
            onBlur={() => { if (typed !== null && Number.isFinite(Number(typed))) onValue(Number(typed) / k); setTyped(null); }}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
        </label>
        <div className="cadd-actions">
          {values.rest !== undefined && <button className="btn" onClick={() => onValue(values.rest!)}>Rest</button>}
          <button className="btn" onClick={() => onValue(lo)} title="To the lower limit">Min</button>
          <button className="btn" onClick={() => onValue(hi)} title="To the upper limit">Max</button>
        </div>
      </div>
      <p className="hint">{values.min !== undefined || values.max !== undefined ? `Limits ${dofText(dof, values.min, unit)} … ${dofText(dof, values.max, unit)}` : 'No limits: the slider goes a turn either way.'}</p>
    </>
  );
}

/** The joints' moving DOFs as choices: `${joint}/${dof}`. */
export function dofChoices(design: CadDesign): [string, string][] {
  return design.joints.flatMap((j) => JOINT_DOFS[j.type].map((k) => [`${j.id}/${k}`, `${j.name} · ${dofLabel(j.type, k)}`] as [string, string]));
}

const splitDof = (v: string) => {
  const i = v.lastIndexOf('/');
  return { joint: v.slice(0, i), dof: v.slice(i + 1) as DofKey };
};

/** A motion link: which DOF follows which, by how much. */
export function LinkFields({ design, link: l, onChange }: { design: CadDesign; link: MotionLink; onChange: (patch: Partial<MotionLink>, coalesce?: string) => void }) {
  const choices = dofChoices(design);
  const angle = (v: { dof: DofKey }) => isAngleDof(v.dof);
  return (
    <>
      <Pick label="Drives (a)" value={`${l.a.joint}/${l.a.dof}`} options={choices} onChange={(v) => onChange({ a: splitDof(v) })} />
      <Pick label="Follows (b)" value={`${l.b.joint}/${l.b.dof}`} options={choices} onChange={(v) => onChange({ b: splitDof(v) })} />
      <div className="row2">
        <Expr label="Ratio: b per a" value={l.ratio} onChange={(ratio) => onChange({ ratio }, 'ratio')}
          hint={angle(l.a) === angle(l.b) ? 'A plain number: −z₁/z₂ for a pair of gears (they turn opposite ways)' : 'The pitch radius (25 mm: x = r·θ), or a unit per unit (mm/deg)'} />
        <Expr label="Offset (b at a = 0)" value={l.offset ?? ''} placeholder="0" onChange={(offset) => onChange({ offset: offset || undefined }, 'offset')} />
      </div>
      <p className="hint">b = ratio · a + offset. {angle(l.a) === angle(l.b) ? 'Gears: ratio −z₁/z₂ (external), +z₁/z₂ (internal or a belt).' : 'Rack and pinion: the ratio is the pinion’s pitch radius d/2.'} b’s own value is not used while it follows.</p>
    </>
  );
}

/** A motion study: its tracks of keyframes and how it is sampled. */
export function MotionFields({ design, study: m, unit, onChange }: { design: CadDesign; study: MotionStudy; unit: string; onChange: (patch: Partial<MotionStudy>, coalesce?: string) => void }) {
  const choices = dofChoices(design);
  const setTrack = (i: number, t: Partial<MotionTrack>) => onChange({ tracks: m.tracks.map((x, k) => (k === i ? { ...x, ...t } : x)) });
  return (
    <>
      <div className="row3">
        <label className="field"><span>Duration (s)</span><input type="number" min={0.1} step="any" value={m.duration} onChange={(e) => onChange({ duration: Math.max(0.01, Number(e.target.value) || 1) }, 'duration')} /></label>
        <label className="field" title="Frames the results (the worksheet's table, the clearance) are sampled at"><span>Steps</span><input type="number" min={1} max={2000} value={m.steps ?? 36} onChange={(e) => onChange({ steps: Math.max(1, Math.min(2000, Math.round(Number(e.target.value)) || 36)) }, 'steps')} /></label>
        <Pick label="Between keys" value={m.interp ?? 'linear'} options={[['linear', 'Linear'], ['smooth', 'Smooth']]} onChange={(interp) => onChange({ interp })} />
      </div>
      {m.tracks.map((tr, i) => (
        <fieldset key={i} className="cadd-side">
          <legend>Track {i + 1}{i === 0 ? ' (the input)' : ''}</legend>
          <Pick label="DOF" value={`${tr.joint}/${tr.dof}`} options={choices} onChange={(v) => setTrack(i, splitDof(v))} />
          <table className="props-table cadj-keys"><tbody>
            <tr><td>t (s)</td><td>Value ({isAngleDof(tr.dof) ? '°, or with a unit' : unit})</td><td /></tr>
            {tr.keys.map((k, n) => (
              <tr key={n}>
                <td><input type="number" step="any" value={k.t} aria-label="Key time" onChange={(e) => setTrack(i, { keys: tr.keys.map((q, z) => (z === n ? { ...q, t: Number(e.target.value) || 0 } : q)) })} /></td>
                <td><Expr label="Key value" value={k.v} onChange={(v) => setTrack(i, { keys: tr.keys.map((q, z) => (z === n ? { ...q, v } : q)) })} /></td>
                <td><button className="icon-btn" aria-label="Remove the key" disabled={tr.keys.length < 2} onClick={() => setTrack(i, { keys: tr.keys.filter((_, z) => z !== n) })}>×</button></td>
              </tr>
            ))}
          </tbody></table>
          <div className="cadd-actions">
            <button className="btn" onClick={() => setTrack(i, { keys: [...tr.keys, { t: m.duration, v: tr.keys[tr.keys.length - 1]?.v ?? '0' }] })}>Add key</button>
            {m.tracks.length > 1 && <button className="btn" onClick={() => onChange({ tracks: m.tracks.filter((_, k) => k !== i) })}>Remove track</button>}
          </div>
        </fieldset>
      ))}
      <div className="cadd-actions">
        {choices.length > 0 && <button className="btn" onClick={() => onChange({ tracks: [...m.tracks, { ...splitDof(choices[0][0]), keys: [{ t: 0, v: '0' }, { t: m.duration, v: '0' }] }] })}>Add track</button>}
      </div>
      <label className="check" title="The least clearance between occurrences and any overlap, frame by frame, on the exact shapes"><input type="checkbox" checked={!!m.clearance} onChange={(e) => onChange({ clearance: e.target.checked || undefined })} /> Track clearance</label>
      {m.clearance && <label className="check" title="A pin touches its hole by design"><input type="checkbox" checked={m.skipJoined !== false} onChange={(e) => onChange({ skipJoined: e.target.checked ? undefined : false })} /> Skip the pairs a joint joins</label>}
    </>
  );
}

/** Play a study: the time, playing or not, looping, how fast. */
export function useMotionPlayer(duration: number) {
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [loop, setLoop] = useState(true);
  const [speed, setSpeed] = useState(1);
  const last = useRef(0);
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    last.current = performance.now();
    const tick = (now: number) => {
      const dt = ((now - last.current) / 1000) * speed;
      last.current = now;
      setT((cur) => {
        const next = cur + dt;
        if (next < duration) return next;
        if (loop) return duration > 0 ? next % duration : 0;
        setPlaying(false);
        return duration;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, loop, speed, duration]);
  return { t: Math.min(t, duration), setT, playing, setPlaying, loop, setLoop, speed, setSpeed };
}

/** Play, pause, step, loop, speed and the scrubber. */
export function MotionTransport({ player, duration, steps }: { player: ReturnType<typeof useMotionPlayer>; duration: number; steps: number }) {
  const { t, setT, playing, setPlaying, loop, setLoop, speed, setSpeed } = player;
  const step = duration / Math.max(1, steps);
  return (
    <div className="cadj-transport">
      <button className="icon-btn" aria-label="Back a frame" title="Back a frame" onClick={() => { setPlaying(false); setT(Math.max(0, t - step)); }}><StepBack size={15} /></button>
      <button className={`icon-btn${playing ? ' on' : ''}`} aria-label={playing ? 'Pause' : 'Play'} title={playing ? 'Pause' : 'Play'} onClick={() => { if (!playing && t >= duration) setT(0); setPlaying(!playing); }}>
        {playing ? <Pause size={15} /> : <Play size={15} />}
      </button>
      <button className="icon-btn" aria-label="On a frame" title="On a frame" onClick={() => { setPlaying(false); setT(Math.min(duration, t + step)); }}><StepForward size={15} /></button>
      <button className={`icon-btn${loop ? ' on' : ''}`} aria-label="Loop" title="Loop" aria-pressed={loop} onClick={() => setLoop(!loop)}><Repeat size={15} /></button>
      <select value={speed} aria-label="Speed" onChange={(e) => setSpeed(Number(e.target.value))}>
        {[0.25, 0.5, 1, 2, 4].map((s) => <option key={s} value={s}>{s}×</option>)}
      </select>
      <span className="cadw-inspect-val">{t.toFixed(2)} / {fmtNum(duration)} s</span>
      <input type="range" className="cadj-scrub" min={0} max={duration} step={duration / 1000 || 0.001} value={t} aria-label="Time" onChange={(e) => { setPlaying(false); setT(Number(e.target.value)); }} />
    </div>
  );
}

/** The clearance through a study: a line over time, red where parts overlap, the time now marked. */
export function ClearanceChart({ result, t, duration, unit }: { result: MotionResult; t: number; duration: number; unit: string }) {
  const c = result.clearance;
  if (!c?.length) return null;
  const W = 300, H = 72, pad = 4;
  const ds = c.map((f) => (Number.isFinite(f.d) ? f.d : NaN));
  const top = Math.max(1e-9, ...ds.filter(Number.isFinite));
  const x = (s: number) => pad + ((W - 2 * pad) * s) / (duration || 1);
  const y = (d: number) => H - pad - ((H - 2 * pad) * d) / top;
  const pts = result.t.map((s, i) => (Number.isFinite(ds[i]) ? `${x(s).toFixed(1)},${y(ds[i]).toFixed(1)}` : '')).filter(Boolean).join(' ');
  const i = ds.reduce((b, v, k) => (v < ds[b] ? k : b), 0);
  const dt = result.t.length > 1 ? result.t[1] - result.t[0] : duration;
  return (
    <figure className="cadj-chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Clearance over time">
        {c.map((f, k) => (f.v > 0 ? <rect key={k} className="hit" x={x(result.t[k] - dt / 2)} y={pad} width={Math.max(1, x(dt) - pad)} height={H - 2 * pad} /> : null))}
        <polyline points={pts} />
        <line className="now" x1={x(t)} x2={x(t)} y1={0} y2={H} />
      </svg>
      <figcaption>
        Least clearance <b>{fmtNum(ds[i])} {unit}</b> at {fmtNum(result.t[i])} s
        {c.some((f) => f.v > 0) && <> · <span className="cadj-bad">overlap in {c.filter((f) => f.v > 0).length} frames (up to {fmtNum(Math.max(...c.map((f) => f.v)))} {unit}³)</span></>}
      </figcaption>
    </figure>
  );
}

/** Tab-separated frames of a study (t, every moving joint's DOFs, the clearance), to paste into the worksheet. */
export function motionTsv(design: CadDesign, result: MotionResult, unit: string): string {
  const cols: { head: string; at: (f: number) => string }[] = [{ head: 't [s]', at: (f) => String(+result.t[f].toPrecision(10)) }];
  for (const j of design.joints) {
    const v = result.values[j.id];
    if (!v) continue;
    for (const k of JOINT_DOFS[j.type]) {
      const xs = v[k];
      if (xs) cols.push({ head: `${j.name}.${k} [${isAngleDof(k) ? 'deg' : unit}]`, at: (f) => String(+(isAngleDof(k) ? xs[f] * DEG : xs[f]).toPrecision(10)) });
    }
  }
  if (result.clearance) cols.push({ head: `c [${unit}]`, at: (f) => String(+result.clearance![f].d.toPrecision(10)) });
  return [cols.map((c) => c.head).join('\t'), ...result.t.map((_, f) => cols.map((c) => c.at(f)).join('\t'))].join('\n');
}

const DIRS: [string, Vec3][] = [['+X', [1, 0, 0]], ['−X', [-1, 0, 0]], ['+Y', [0, 1, 0]], ['−Y', [0, -1, 0]], ['+Z', [0, 0, 1]], ['−Z', [0, 0, -1]]];

/** Where an occurrence goes in the exploded view: a direction and a distance. */
export function ExplodeFields({ value, onChange }: { value?: ExplodeOffset; onChange: (v: ExplodeOffset | undefined) => void }) {
  const named = value && DIRS.find(([, d]) => d.every((x, i) => Math.abs(x - value.dir[i]) < 1e-9));
  return (
    <fieldset className="cadd-side">
      <legend>Exploded view</legend>
      <div className="row2">
        <label className="field"><span>Direction</span>
          <select value={!value ? '' : named ? named[0] : 'custom'} onChange={(e) => {
            const d = DIRS.find(([n]) => n === e.target.value);
            onChange(d ? { dir: d[1], d: value?.d ?? '20' } : undefined);
          }}>
            <option value="">Stays</option>
            {DIRS.map(([n]) => <option key={n} value={n}>{n}</option>)}
            {value && !named && <option value="custom">({value.dir.map((v) => fmtNum(v)).join(', ')})</option>}
          </select>
        </label>
        {value && <Expr label="Distance" value={value.d} onChange={(d) => onChange({ ...value, d: d || '0' })} />}
      </div>
    </fieldset>
  );
}

/** The bill of materials: each component once with how often it occurs, its material and mass. */
export function BomPanel({ table, onCopy, onCsv }: { table: BomTable; onCopy: () => void; onCsv: () => void }) {
  return (
    <>
      <table className="props-table cadj-bom"><thead>
        <tr><th>#</th><th>Component</th><th>Qty</th><th>Material</th><th>Mass each</th></tr>
      </thead><tbody>
        {table.rows.map((r) => (
          <tr key={r.component}><td>{r.item}</td><td>{r.name}</td><td className="num">{r.qty}</td><td>{r.material || '–'}</td><td className="num">{r.mass !== undefined ? `${fmtMass(r.mass)} kg` : '–'}</td></tr>
        ))}
      </tbody></table>
      {table.total !== undefined && <p className="hint">Total {fmtMass(table.total)} kg (each item’s mass times its quantity; hidden occurrences are left out).</p>}
      <div className="cadd-actions">
        <button className="btn" onClick={onCopy} title="Tab-separated with a header row: paste it into the worksheet for a table">Copy as table</button>
        <button className="btn" onClick={onCsv}>CSV…</button>
      </div>
    </>
  );
}
