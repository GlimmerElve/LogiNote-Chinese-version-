/** Offline raster images only. No SVG/HTML, file paths, remote URLs or automatic fetching. */
export const MAX_TEXTBOOK_IMAGE_BYTES = 1024 * 1024;
/** Reserved out-of-band pointer: render the original PDF page, not an OCR result. */
export const PDF_PAGE_IMAGE_INDEX = 1000;
export const PDF_FORMULA_IMAGE_INDEX = 1001;
export const MAX_PDF_FORMULA_REGIONS = 16;
const MAX_IMAGE_SIDE = 4096;
const MAX_IMAGE_PIXELS = 4_000_000;
export const MAX_TEXTBOOK_GIF_FRAMES = 40;
export const MAX_TEXTBOOK_GIF_TOTAL_PIXELS = 16_000_000;
const u16le = (bytes: Uint8Array, offset: number) => bytes[offset] + bytes[offset + 1] * 256;
const u24le = (bytes: Uint8Array, offset: number) => u16le(bytes, offset) + bytes[offset + 2] * 0x10000;
const u32le = (bytes: Uint8Array, offset: number) => u24le(bytes, offset) + bytes[offset + 3] * 0x1000000;
const fourCC = (bytes: Uint8Array, offset: number) => String.fromCharCode(...bytes.slice(offset, offset + 4));
function withinImageBounds(width: number, height: number): boolean {
  return width > 0 && height > 0 && width <= MAX_IMAGE_SIDE && height <= MAX_IMAGE_SIDE && width * height <= MAX_IMAGE_PIXELS;
}
/** Inspect every GIF image descriptor before a decoder can expand a forged logical canvas. */
function boundedGifDimensions(bytes: Uint8Array): boolean {
  if (bytes.length < 14) return false;
  const width = u16le(bytes, 6), height = u16le(bytes, 8);
  if (!withinImageBounds(width, height)) return false;
  let offset = 13 + ((bytes[10] & 0x80) ? 3 * (1 << ((bytes[10] & 7) + 1)) : 0);
  if (offset > bytes.length) return false;
  const skipSubBlocks = (start: number): { end: number; payload: boolean } | undefined => {
    let cursor = start, payload = false;
    while (cursor < bytes.length) {
      const size = bytes[cursor++];
      if (size === 0) return { end: cursor, payload };
      if (cursor + size > bytes.length) return undefined;
      payload = true; cursor += size;
    }
    return undefined;
  };
  let frames = 0, totalPixels = 0;
  while (offset < bytes.length) {
    const marker = bytes[offset++];
    if (marker === 0x3b) return frames > 0 && offset === bytes.length;
    if (marker === 0x21) {
      if (offset >= bytes.length) return false;
      offset++; // Extension label; all extension payloads are terminated sub-blocks.
      const extension = skipSubBlocks(offset);
      if (!extension) return false;
      offset = extension.end; continue;
    }
    if (marker !== 0x2c || offset + 9 > bytes.length) return false;
    const left = u16le(bytes, offset), top = u16le(bytes, offset + 2);
    const frameWidth = u16le(bytes, offset + 4), frameHeight = u16le(bytes, offset + 6), packed = bytes[offset + 8];
    if (!withinImageBounds(frameWidth, frameHeight) || left + frameWidth > width || top + frameHeight > height
      || (packed & 0x18)) return false;
    frames++; totalPixels += width * height; // Composited frames may allocate the entire logical canvas.
    if (frames > MAX_TEXTBOOK_GIF_FRAMES || totalPixels > MAX_TEXTBOOK_GIF_TOTAL_PIXELS) return false;
    offset += 9 + ((packed & 0x80) ? 3 * (1 << ((packed & 7) + 1)) : 0);
    if (offset >= bytes.length || bytes[offset] < 2 || bytes[offset] > 8) return false;
    const image = skipSubBlocks(offset + 1);
    if (!image?.payload) return false;
    offset = image.end;
  }
  return false; // Missing trailer, truncated table or unterminated image data.
}
/** WebP's VP8X canvas is only a claim: check the actual VP8/VP8L raster too. */
function boundedWebpDimensions(bytes: Uint8Array): boolean {
  if (bytes.length < 20 || u32le(bytes, 4) !== bytes.length - 8) return false;
  let offset = 12, canvas: { width: number; height: number } | undefined;
  let raster: { width: number; height: number; kind: string } | undefined;
  let alpha = false;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) return false;
    const kind = fourCC(bytes, offset), length = u32le(bytes, offset + 4), start = offset + 8;
    const end = start + length, next = end + (length & 1);
    if (next > bytes.length || ((length & 1) && bytes[end] !== 0)) return false;
    // Animation needs frame/compositing budgets; unsupported animation fails closed without decoding.
    if (kind === 'ANIM' || kind === 'ANMF') return false;
    if (kind === 'VP8X') {
      if (offset !== 12 || canvas || length !== 10 || (bytes[start] & 0xc3)
        || bytes[start + 1] || bytes[start + 2] || bytes[start + 3]) return false;
      canvas = { width: 1 + u24le(bytes, start + 4), height: 1 + u24le(bytes, start + 7) };
      if (!withinImageBounds(canvas.width, canvas.height)) return false;
    } else if (kind === 'VP8L' || kind === 'VP8 ') {
      if (raster) return false;
      if (kind === 'VP8L') {
        if (length < 5 || bytes[start] !== 0x2f || (bytes[start + 4] & 0xe0)) return false;
        const packed = u32le(bytes, start + 1);
        raster = { width: 1 + (packed & 0x3fff), height: 1 + ((packed >>> 14) & 0x3fff), kind };
      } else {
        if (length < 10 || (bytes[start] & 1) || bytes[start + 3] !== 0x9d || bytes[start + 4] !== 0x01
          || bytes[start + 5] !== 0x2a || (u16le(bytes, start + 6) & 0xc000) || (u16le(bytes, start + 8) & 0xc000)) return false;
        raster = { width: u16le(bytes, start + 6), height: u16le(bytes, start + 8), kind };
      }
      if (!withinImageBounds(raster.width, raster.height)) return false;
    } else if (kind === 'ALPH') {
      if (!canvas || alpha || raster || length < 1) return false;
      alpha = true;
    }
    offset = next;
  }
  return !!raster && (!canvas || (canvas.width === raster.width && canvas.height === raster.height))
    && (!alpha || raster.kind === 'VP8 ');
}
function boundedRasterDimensions(kind: string, bytes: Uint8Array): boolean {
  const u16be = (offset: number) => bytes[offset] * 256 + bytes[offset + 1];
  const u32be = (offset: number) => bytes[offset] * 0x1000000 + bytes[offset + 1] * 0x10000 + bytes[offset + 2] * 256 + bytes[offset + 3];
  if (kind === 'gif') return boundedGifDimensions(bytes);
  if (kind === 'webp') return boundedWebpDimensions(bytes);
  let width = 0, height = 0;
  if (kind === 'png' && bytes.length >= 33 && String.fromCharCode(...bytes.slice(12, 16)) === 'IHDR') {
    width = u32be(16); height = u32be(20);
  } else if (kind === 'jpeg') {
    // Read only container headers. Never decode raster pixels to determine the allocation bound.
    for (let offset = 2; offset + 4 < bytes.length;) {
      if (bytes[offset++] !== 0xff) break;
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
      if (offset + 2 > bytes.length) break;
      const length = u16be(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 8) {
        height = u16be(offset + 3); width = u16be(offset + 5); break;
      }
      offset += length;
    }
  }
  return withinImageBounds(width, height);
}
export function isLocalRasterDataUrl(value: string): boolean {
  const match = /^data:image\/(png|jpeg|gif|webp);base64,([A-Za-z0-9+/]+={0,2})$/u.exec(value);
  if (!match || match[2].length % 4 !== 0 || match[2].length > Math.ceil(MAX_TEXTBOOK_IMAGE_BYTES / 3) * 4) return false;
  // Magic bytes prevent an SVG/HTML payload being mislabeled as a raster image.
  const prefix = match[2];
  const signature = match[1] === 'png' ? prefix.startsWith('iVBORw0KGgo')
    : match[1] === 'jpeg' ? prefix.startsWith('/9j/')
    : match[1] === 'gif' ? prefix.startsWith('R0lGODdh') || prefix.startsWith('R0lGODlh')
    : prefix.startsWith('UklGR') && atob(prefix.slice(0, 16)).slice(8, 12) === 'WEBP';
  if (!signature) return false;
  try {
    const bytes = Uint8Array.from(atob(prefix), (char) => char.charCodeAt(0));
    return bytes.length <= MAX_TEXTBOOK_IMAGE_BYTES && boundedRasterDimensions(match[1], bytes);
  } catch { return false; }
}
export function embeddedLocalImages(text: string): Array<{ dataUrl: string; alt: string; index: number; start: number; end: number }> {
  const images: Array<{ dataUrl: string; alt: string; index: number; start: number; end: number }> = [];
  // Count all inline references for stable imageIndex, even when some are not available offline.
  let index = 0;
  let fence = '';
  let offset = 0;
  for (const line of text.split(/(?<=\n)/u)) {
    const delimiter = /^\s*(`{3,}|~{3,})(.*)$/u.exec(line.trimEnd());
    if (!fence && delimiter) fence = delimiter[1];
    else if (fence && delimiter && delimiter[1][0] === fence[0] && delimiter[1].length >= fence.length && !delimiter[2].trim()) fence = '';
    else if (!fence) {
      for (const match of line.matchAll(/!\[([^\]\n]*)\]\(([^\s)]+)\)/gu)) {
        const imageIndex = index++;
        if (isLocalRasterDataUrl(match[2])) images.push({ dataUrl: match[2], alt: match[1].slice(0, 300), index: imageIndex,
          start: offset + match.index!, end: offset + match.index! + match[0].length });
      }
    }
    offset += line.length;
  }
  return images;
}
