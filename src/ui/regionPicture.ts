// Pictures of regions for files of programs that do not have them (Mathcad, SMath): what the
// page drew of a region — its canvases (plots, the 3-D view) and SVG drawings (beams, frames,
// plates, sketches, drawings) — composed into one PNG as they lie in the region. An SVG's look
// comes from the page's style sheet, so each element's computed style is written into it.
import type { Picture } from '../exporters';
import type { Region } from '../model/types';

/** Kinds whose picture can stand in for them (plots are written natively to Prime, pictured otherwise). */
const PICTURED = new Set<Region['kind']>(['plot', 'beam', 'frame3d', 'plate', 'sketch', 'cad', 'drawing']);

const STYLE_PROPS = [
  'fill', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-dasharray', 'stroke-linecap', 'stroke-linejoin',
  'opacity', 'font-family', 'font-size', 'font-weight', 'font-style', 'text-anchor', 'dominant-baseline', 'visibility', 'display',
  // labels drawn with a halo (a wide white stroke under the letters)
  'paint-order', 'letter-spacing',
];

/** A copy of an SVG drawing with the page's styles in it, as an image. */
async function svgImage(svg: SVGSVGElement, w: number, h: number): Promise<HTMLImageElement> {
  const copy = svg.cloneNode(true) as SVGSVGElement;
  const from = [svg, ...svg.querySelectorAll('*')], to = [copy, ...copy.querySelectorAll('*')];
  from.forEach((el, i) => {
    const cs = getComputedStyle(el);
    (to[i] as SVGElement).setAttribute('style', STYLE_PROPS.map((p) => `${p}:${cs.getPropertyValue(p)}`).join(';'));
  });
  copy.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  copy.setAttribute('width', String(w));
  copy.setAttribute('height', String(h));
  const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(copy)], { type: 'image/svg+xml' }));
  try {
    return await loadImage(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('The picture could not be drawn'));
    img.src = src;
  });
}

const png = (c: HTMLCanvasElement) => new Promise<Uint8Array>((resolve, reject) => c.toBlob((b) => (b ? b.arrayBuffer().then((a) => resolve(new Uint8Array(a)), reject) : reject(new Error('No picture'))), 'image/png'));

/** The picture of one region element, at twice its size on the page; null when it draws nothing. */
export async function regionPicture(el: HTMLElement): Promise<Picture | null> {
  const box = el.getBoundingClientRect();
  const W = el.offsetWidth, H = el.offsetHeight;
  if (!W || !H || !box.width) return null;
  // the page may be zoomed: screen pixels per page pixel
  const zoom = box.width / W;
  const parts = [...el.querySelectorAll<HTMLCanvasElement | SVGSVGElement>('canvas, svg')].filter((d) => {
    // icons in toolbars and drawings inside drawings are not pictures of the region
    if (d instanceof SVGSVGElement && (d.classList.contains('lucide') || d.parentElement?.closest('svg'))) return false;
    const r = d.getBoundingClientRect();
    return r.width / zoom >= 40 && r.height / zoom >= 30;
  });
  if (!parts.length) return null;
  const k = 2;
  const c = document.createElement('canvas');
  c.width = Math.round(W * k);
  c.height = Math.round(H * k);
  const g = c.getContext('2d');
  if (!g) return null;
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, c.width, c.height);
  g.scale(k, k);
  let drawn = 0;
  for (const d of parts) {
    const r = d.getBoundingClientRect();
    const x = (r.left - box.left) / zoom, y = (r.top - box.top) / zoom, w = r.width / zoom, h = r.height / zoom;
    try {
      g.drawImage(d instanceof SVGSVGElement ? await svgImage(d, w, h) : d, x, y, w, h);
      drawn++;
    } catch {
      /* a canvas from another origin or a broken drawing: left out */
    }
  }
  if (!drawn) return null;
  // trim the empty margin below the drawings (a region's box is often taller than what it draws)
  const bottom = Math.max(...parts.map((d) => (d.getBoundingClientRect().bottom - box.top) / zoom));
  const h = Math.min(H, Math.ceil(bottom) + 4);
  if (h < H) {
    const t = document.createElement('canvas');
    t.width = c.width;
    t.height = Math.round(h * k);
    t.getContext('2d')!.drawImage(c, 0, 0);
    return { png: await png(t), width: W, height: h };
  }
  return { png: await png(c), width: W, height: H };
}

/** A picture in another format (JPEG, SVG …) as a PNG. */
async function asPng(src: string): Promise<Picture | null> {
  try {
    const img = await loadImage(src);
    const c = document.createElement('canvas');
    c.width = img.naturalWidth || 400;
    c.height = img.naturalHeight || 300;
    c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
    return { png: await png(c), width: c.width, height: c.height };
  } catch {
    return null;
  }
}

/** Pictures of the regions of a worksheet that an export may need, by region id. */
export async function regionPictures(regions: Region[], root: ParentNode = document): Promise<Map<string, Picture>> {
  const out = new Map<string, Picture>();
  for (const r of regions) {
    try {
      if (r.kind === 'image' && r.src && !r.src.startsWith('data:image/png')) {
        const p = await asPng(r.src);
        if (p) out.set(r.id, p);
        continue;
      }
      if (!PICTURED.has(r.kind)) continue;
      const el = root.querySelector<HTMLElement>(`.sheet [data-region-id="${r.id}"]`) ?? root.querySelector<HTMLElement>(`[data-region-id="${r.id}"]`);
      const p = el ? await regionPicture(el) : null;
      if (p) out.set(r.id, p);
    } catch {
      /* the region becomes a note without its picture */
    }
  }
  return out;
}
