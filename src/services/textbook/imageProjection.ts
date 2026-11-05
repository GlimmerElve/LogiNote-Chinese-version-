import { embeddedLocalImages } from './localImages.ts';

/** Text pagination keeps original UTF-16 positions, but transports image pointers
 * instead of base64. Atomic image spans are never split across textual pages. */
export function projectMaterialImageText(block: string, start: number, maxChars: number, allowImages = true) {
  const images = allowImages ? embeddedLocalImages(block) : [];
  const references: Array<{ imageIndex: number; alt: string }> = [];
  let text = '', cursor = start, omitted = false;
  const appendText = (end: number) => {
    let stop = Math.min(end, cursor + maxChars - text.length);
    if (stop < end && /[\uD800-\uDBFF]/u.test(block[stop - 1] || '')) stop--;
    text += block.slice(cursor, stop); cursor = stop;
  };
  for (const image of images) {
    if (image.end <= cursor) continue;
    appendText(Math.max(cursor, image.start));
    if (cursor < image.start || text.length >= maxChars) break;
    // Legacy cursors inside a base64 span restart its atomic pointer, not its bytes.
    const marker = `[本地图片素材 imageIndex=${image.index}；仅供显示，未做本地识别]`;
    if (text.length + marker.length > maxChars) break;
    text += marker; cursor = image.end; omitted = true;
    references.push({ imageIndex: image.index, alt: image.alt });
  }
  if (cursor < block.length && text.length < maxChars && !images.some(image => image.end > cursor)) appendText(block.length);
  return { text, rawEnd: cursor, imageDataOmitted: omitted, imageReferences: references };
}
