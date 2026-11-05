import { rasterContentBounds } from './rasterBounds';
import { isLocalRasterDataUrl, MAX_TEXTBOOK_IMAGE_BYTES } from './localImages';
self.onmessage = async (event: MessageEvent<string>) => {
  let bitmap: ImageBitmap | undefined;
  try {
    const source = event.data;
    if (!isLocalRasterDataUrl(source) || !/^data:image\/(png|jpeg);base64,/u.test(source)) throw Error('Invalid raster');
    const response = await fetch(source); bitmap = await createImageBitmap(await response.blob());
    const { width, height } = bitmap;
    if (width < 1 || height < 1 || width > 4096 || height > 4096 || width * height > 4_000_000) throw Error('Invalid preview dimensions');
    const canvas = new OffscreenCanvas(width, height), context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw Error('Preview canvas unavailable');
    context.drawImage(bitmap, 0, 0);
    const bounds = rasterContentBounds(context.getImageData(0, 0, width, height).data, width, height);
    if (bounds.width === width && bounds.height === height) { self.postMessage({ preview: source }); return; }
    const cropped = new OffscreenCanvas(bounds.width, bounds.height);
    cropped.getContext('2d')!.drawImage(canvas, bounds.x, bounds.y, bounds.width, bounds.height, 0, 0, bounds.width, bounds.height);
    const blob = await cropped.convertToBlob({ type: 'image/png' });
    if (blob.size > MAX_TEXTBOOK_IMAGE_BYTES) throw Error('Preview byte budget exceeded');
    const bytes = new Uint8Array(await blob.arrayBuffer()); let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 16_384) binary += String.fromCharCode(...bytes.subarray(offset, offset + 16_384));
    self.postMessage({ preview: `data:image/png;base64,${btoa(binary)}` });
  } catch (error) { self.postMessage({ error: error instanceof Error ? error.message : 'Preview failed' }); }
  finally { bitmap?.close(); }
};
