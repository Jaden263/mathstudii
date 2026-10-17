// A motion study out of the 3-D view: its frames as a PNG sequence in a zip, or played
// once and recorded as WebM video from the canvas (MediaRecorder, where the browser has
// it). The view draws each frame as the player sets its time; these wait for it.
import { zipSync } from 'fflate';
import { exportFile } from '../../platform/files';

/** Two animation frames: React has rendered the new time and the canvas has drawn it. */
const drawn = () => new Promise<void>((ok) => requestAnimationFrame(() => requestAnimationFrame(() => ok())));

const pngOf = (canvas: HTMLCanvasElement) => new Promise<Uint8Array>((ok, fail) => canvas.toBlob((b) => (b ? b.arrayBuffer().then((x) => ok(new Uint8Array(x)), fail) : fail(new Error('the view could not be captured'))), 'image/png'));

/** Every frame at `times` as name-0001.png …, zipped and saved. */
export async function exportPngFrames(canvas: HTMLCanvasElement, times: number[], setT: (t: number) => void, name: string, progress?: (done: number) => void): Promise<void> {
  const files: Record<string, Uint8Array> = {};
  for (const [i, t] of times.entries()) {
    setT(t);
    await drawn();
    files[`${name}-${String(i + 1).padStart(4, '0')}.png`] = await pngOf(canvas);
    progress?.(i + 1);
  }
  // PNGs are compressed already
  await exportFile(`${name}-frames.zip`, zipSync(files, { level: 0 }), 'application/zip');
}

/** Whether this browser can record the view as WebM. */
export const canRecord = () => typeof MediaRecorder !== 'undefined' && typeof HTMLCanvasElement !== 'undefined' && 'captureStream' in HTMLCanvasElement.prototype
  && ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].some((m) => MediaRecorder.isTypeSupported(m));

/** Play the study once in real time (setT through the duration) and record it as WebM. */
export async function recordWebm(canvas: HTMLCanvasElement, duration: number, setT: (t: number) => void, name: string, fps = 30): Promise<void> {
  const type = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m))!;
  const stream = canvas.captureStream(fps);
  const rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 6e6 });
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const stopped = new Promise<void>((ok) => (rec.onstop = () => ok()));
  setT(0);
  await drawn();
  rec.start(250);
  const t0 = performance.now();
  for (;;) {
    const t = (performance.now() - t0) / 1000;
    setT(Math.min(t, duration));
    await drawn();
    if (t >= duration) break;
  }
  rec.stop();
  await stopped;
  stream.getTracks().forEach((tr) => tr.stop());
  const blob = new Blob(chunks, { type: 'video/webm' });
  await exportFile(`${name}.webm`, new Uint8Array(await blob.arrayBuffer()), 'video/webm');
}
