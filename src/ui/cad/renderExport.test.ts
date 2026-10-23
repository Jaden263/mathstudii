import { describe, expect, it } from 'vitest';
import { MAX_PIXELS, MAX_SIDE, renderSize, tileMatrix } from './renderExport';

/** Clip x, y of a point after the tile transform (column-major 4×4, w = 1). */
const apply = (m: Float32Array, x: number, y: number) => [m[0] * x + m[12], m[5] * y + m[13]];

describe('rendering a view in tiles', () => {
  it('a tile shows its part of the image: the top-right quarter of a 200 × 100 image in a 100 × 50 viewport', () => {
    const m = tileMatrix({ x: 100, y: 0, W: 200, H: 100 }, 100, 50);
    // the image's top-right corner is the tile's, the image's centre the tile's bottom-left
    expect(apply(m, 1, 1)).toEqual([1, 1]);
    expect(apply(m, 0, 0)).toEqual([-1, -1]);
    // a pixel keeps its size: 2/W of the image's clip space is 2/w of the tile's
    const [x0] = apply(m, 0.5, 0), [x1] = apply(m, 0.5 + 2 / 200, 0);
    expect(x1 - x0).toBeCloseTo(2 / 100, 12);
  });

  it('the bottom-left tile of a 3 × 3 tiling, with the last row and column only partly inside', () => {
    // 250 × 250 image in 100 × 100 tiles: the tile at (0, 200) holds image rows 200–249
    const m = tileMatrix({ x: 0, y: 200, W: 250, H: 250 }, 100, 100);
    // the image's bottom-left corner (−1, −1) sits half way up the tile (row 250 of 200…300)
    const [x, y] = apply(m, -1, -1);
    expect(x).toBeCloseTo(-1, 12);
    expect(y).toBeCloseTo(0, 12);
  });

  it('keeps an image within what canvases allow', () => {
    expect(renderSize(1400, 800, 4)).toEqual({ W: 5600, H: 3200, scale: 4 });
    const big = renderSize(3000, 2000, 8);
    expect(big.W).toBeLessThanOrEqual(MAX_SIDE);
    expect(big.W * big.H).toBeLessThanOrEqual(MAX_PIXELS);
    expect(big.W / big.H).toBeCloseTo(1.5, 3);
  });
});
