/** SVG remains an image document: its stylesheet and thousands of internal
 * nodes must not join the formula-rich application's DOM/style tree. */
export function createMermaidImage(svg: string, readingWidth: number) {
  if (svg.length > 1_000_000 || !/^\s*<svg\b/u.test(svg) || !Number.isFinite(readingWidth)) throw new Error('图示图像无效');
  const width = Math.max(1, Math.min(4096, Math.ceil(readingWidth)));
  const viewBox = /^\s*<svg\b[^>]*\bviewBox="([^"]+)"/u.exec(svg)?.[1].trim().split(/[\s,]+/u).map(Number);
  const height = viewBox?.length === 4 && viewBox.every(Number.isFinite) && viewBox[2] > 0 && viewBox[3] > 0
    ? Math.max(1, Math.min(16384, Math.ceil(width * viewBox[3] / viewBox[2]))) : 300;
  // Blob URL registration can synchronously wait for Chromium's browser
  // process (182ms in a captured native profile). A bounded, escaped data image
  // needs no cross-process registration and keeps SVG outside the app DOM.
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  // Lifetime follows the owning image/state references; there is no external
  // Blob handle to revoke when a cached sibling uses the same immutable image.
  return { svg, url, width, height, dispose() {} };
}
