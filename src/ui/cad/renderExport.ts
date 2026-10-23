// High-resolution renders of a 3-D view: the scene is drawn again tile by tile into the
// view's own antialiased canvas at the export scale, each tile copied into one large 2-D
// canvas, which is encoded as PNG and released at once (a 4× render of a full-screen
// view is some 60 Mpx: nothing of it may stay around).

/** Tile (x, y) of a W × H image, x and y from its top-left corner (image pixels). */
export interface Tile {
  x: number;
  y: number;
  W: number;
  H: number;
}

export type RenderBackground = 'transparent' | 'white';

export interface RenderOptions {
  /** Image pixels per CSS pixel of the view. */
  scale: number;
  background: RenderBackground;
  /** Only the bodies (no planes, sketches or marks). */
  plain?: boolean;
}

/** What a view hands out to render itself to a PNG (null: nothing drawn). */
export type SceneCapture = (o: RenderOptions) => Promise<Blob | null>;

/** Browsers refuse canvases past these (Chrome 16384 per side; Safari far less in area). */
export const MAX_SIDE = 16384;
export const MAX_PIXELS = 64e6;

/** The image size for a view of w × h CSS pixels at a scale, kept within what canvases allow. */
export function renderSize(w: number, h: number, scale: number): { W: number; H: number; scale: number } {
  let s = scale;
  s = Math.min(s, MAX_SIDE / Math.max(w, 1), MAX_SIDE / Math.max(h, 1), Math.sqrt(MAX_PIXELS / Math.max(w * h, 1)));
  return { W: Math.max(1, Math.floor(w * s)), H: Math.max(1, Math.floor(h * s)), scale: s };
}

/**
 * Column-major clip-space transform that shows tile `t` of the image in a viewport of
 * w × h pixels: x′ = x·W/w + W/w − 1 − 2x₀/w, and y′ the same from the top (clip y is up).
 */
export function tileMatrix(t: Tile, w: number, h: number): Float32Array {
  const sx = t.W / w, sy = t.H / h;
  const out = new Float32Array(16);
  out[0] = sx;
  out[5] = sy;
  out[10] = 1;
  out[15] = 1;
  out[12] = sx - 1 - (2 * t.x) / w;
  out[13] = 1 - sy + (2 * t.y) / h;
  return out;
}

/**
 * Draw the image tile by tile into `gl` (its canvas w × h device pixels) and collect the
 * tiles into a PNG. `draw(tile)` renders one tile into the canvas.
 */
export async function renderTiles(canvas: HTMLCanvasElement, W: number, H: number, background: RenderBackground, draw: (t: Tile) => void): Promise<Blob | null> {
  const out = document.createElement('canvas');
  out.width = W;
  out.height = H;
  const g = out.getContext('2d');
  if (!g) return null;
  try {
    if (background === 'white') {
      g.fillStyle = '#ffffff';
      g.fillRect(0, 0, W, H);
    }
    const w = canvas.width, h = canvas.height;
    for (let y = 0; y < H; y += h) {
      for (let x = 0; x < W; x += w) {
        draw({ x, y, W, H });
        // the drawing buffer is preserved: what was just drawn is what is copied
        g.drawImage(canvas, 0, 0, w, h, x, y, w, h);
      }
    }
    return await new Promise<Blob | null>((resolve) => out.toBlob(resolve, 'image/png'));
  } finally {
    out.width = out.height = 0;
  }
}
