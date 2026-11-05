/** Display-only crop. Near-white margins only; never remove internal whitespace,
 * infer formula regions, or mutate the immutable source attachment. */
function checkRaster(data: Uint8ClampedArray, width: number, height: number) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1
    || width > 4096 || height > 4096 || width * height > 4_000_000 || data.length !== width * height * 4) throw new Error('预览像素超出安全范围');
}
type BoundsAccumulator = { left: number; top: number; right: number; bottom: number };
function scanRows(data: Uint8ClampedArray, width: number, from: number, to: number, bounds: BoundsAccumulator) {
  for (let y = from; y < to; y++) for (let x = 0; x < width; x++) {
    const offset = (y * width + x) * 4;
    // Ignore fully transparent/near-white pixels; retain even tiny decimal dots.
    if (data[offset + 3] < 16 || (data[offset] >= 250 && data[offset + 1] >= 250 && data[offset + 2] >= 250)) continue;
    bounds.left = Math.min(bounds.left, x); bounds.top = Math.min(bounds.top, y);
    bounds.right = Math.max(bounds.right, x); bounds.bottom = Math.max(bounds.bottom, y);
  }
}
function finishBounds({ left, top, right, bottom }: BoundsAccumulator, width: number, height: number) {
  if (right < left) return { x: 0, y: 0, width, height };
  const padding = 12;
  const x = Math.max(0, left - padding), y = Math.max(0, top - padding);
  return { x, y, width: Math.min(width, right + padding + 1) - x, height: Math.min(height, bottom + padding + 1) - y };
}
export function rasterContentBounds(data: Uint8ClampedArray, width: number, height: number) {
  checkRaster(data, width, height);
  const bounds = { left: width, top: height, right: -1, bottom: -1 };
  scanRows(data, width, 0, height, bounds);
  return finishBounds(bounds, width, height);
}
const yieldToReader = () => new Promise<void>(resolve => setTimeout(resolve, 0));
export async function rasterContentBoundsAsync(data: Uint8ClampedArray, width: number, height: number,
  yieldWork: () => Promise<void> = yieldToReader) {
  checkRaster(data, width, height);
  const bounds = { left: width, top: height, right: -1, bottom: -1 };
  for (let row = 0; row < height; row += 32) {
    await yieldWork();
    scanRows(data, width, row, Math.min(row + 32, height), bounds);
  }
  return finishBounds(bounds, width, height);
}


