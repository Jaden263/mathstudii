// ISO thread sizes in dialogs: the choices of a size field and the table of a size's
// dimensions (threads and tapped holes).
import { parseThread, threadSizes } from '../../cad/threads';
import { num } from './SketchPanel';

/** The ISO sizes as choices, coarse and fine by diameter. */
export const sizeChoices = (): [string, string][] => threadSizes().map((s) => [s.name, `${s.name.replace('x', ' × ')}${s.fine ? ' (fine)' : ''}`]);

/** The ISO dimensions of a size, as a short table (mm). */
export function ThreadTable({ size }: { size: string }) {
  let s;
  try {
    s = parseThread(size);
  } catch (e) {
    return <div className="region-error">{(e as Error).message}</div>;
  }
  return (
    <table className="props-table"><tbody>
      <tr><td>Pitch P</td><td>{num(s.P)} mm</td></tr>
      <tr><td>Pitch Ø d₂</td><td>{num(s.d2, 5)} mm</td></tr>
      <tr><td>Minor Ø d₁ / d₃</td><td>{num(s.d1, 5)} / {num(s.d3, 5)} mm</td></tr>
      <tr><td>Stress area A_s</td><td>{num(s.As, 4)} mm²</td></tr>
      <tr><td>Tap drill</td><td>{num(s.drill)} mm</td></tr>
    </tbody></table>
  );
}

