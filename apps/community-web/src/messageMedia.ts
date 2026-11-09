import type { MessageImage } from './model';
import {stripAnimationMetadata} from './imageMetadata';

export const MESSAGE_IMAGE_LIMIT = 4;
export const MESSAGE_STORAGE_BUDGET = 2_200_000;
const MAX_IMAGE_DATA_LENGTH = 1_500_000;
const STATIC_FILE_LIMIT = 5 * 1024 * 1024;
const ANIMATED_FILE_LIMIT = 1024 * 1024;
const MAX_IMAGE_EDGE = 1600;

export function validMessageImageData(value: unknown): value is string {
    if (typeof value !== 'string' || value.length > MAX_IMAGE_DATA_LENGTH)
        return false;
    const prefix = /^data:image\/(?:png|jpeg|webp|gif);base64,/.exec(value);
    if (!prefix)
        return false;
    const encoded = value.slice(prefix[0].length);
    return encoded.length > 0 && encoded.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(encoded);
}

function readDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => typeof reader.result === 'string'
            ? resolve(reader.result)
            : reject(Error('图片读取失败，请重新选择。'));
        reader.onerror = () => reject(Error('图片读取失败，请重新选择。'));
        reader.onabort = () => reject(Error('图片读取已取消。'));
        reader.readAsDataURL(file);
    });
}

function decodeImage(data: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => {
            image.onload = null;
            image.onerror = null;
            if (image.naturalWidth > 0 && image.naturalHeight > 0)
                resolve(image);
            else
                reject(Error('无法识别这张图片，请选择有效的 PNG、JPG、GIF 或 WebP 图片。'));
        };
        image.onerror = () => {
            image.onload = null;
            image.onerror = null;
            reject(Error('无法识别这张图片，请选择有效的 PNG、JPG、GIF 或 WebP 图片。'));
        };
        image.src = data;
    });
}

function resizeImage(image: HTMLImageElement, type: string): string {
    const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext('2d');
    if (!context)
        throw Error('当前浏览器无法处理图片，请选择更小的图片。');
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    // Keep screenshot text lossless whenever the resized PNG fits local storage.
    if (type === 'image/png') {
        const png = canvas.toDataURL('image/png');
        if (validMessageImageData(png))
            return png;
    }
    // JPEG has no alpha channel; give transparent screenshots a readable background.
    context.globalCompositeOperation = 'destination-over';
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.globalCompositeOperation = 'source-over';
    for (const quality of [0.92, 0.84, 0.76]) {
        const jpeg = canvas.toDataURL('image/jpeg', quality);
        if (validMessageImageData(jpeg))
            return jpeg;
    }
    throw Error('图片压缩后仍然过大，请裁剪图片或选择更小的图片。');
}

export async function readMessageImage(file: File): Promise<MessageImage> {
    const type = file.type.toLowerCase();
    if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(type))
        throw Error('仅支持 PNG、JPG、GIF 和 WebP 图片。');
    const preserveBytes = type === 'image/gif' || type === 'image/webp';
    const limit = preserveBytes ? ANIMATED_FILE_LIMIT : STATIC_FILE_LIMIT;
    if (file.size <= 0)
        throw Error('图片为空，请重新选择。');
    if (file.size > limit)
        throw Error(preserveBytes ? 'GIF 和 WebP 图片请控制在 1 MB 以内，以保留原始动画。' : 'PNG 和 JPG 图片请控制在 5 MB 以内。');
    const original = await readDataUrl(file);
    const image = await decodeImage(original);
    try {
        // Re-encode every static image, including small photos, to remove EXIF.
        // Animation keeps its frames; metadata chunks are removed without flattening.
        const data = preserveBytes
            ? await readDataUrl(new File([stripAnimationMetadata(new Uint8Array(await file.arrayBuffer()),type as 'image/gif'|'image/webp')],file.name,{type}))
            : resizeImage(image, type);
        if (!validMessageImageData(data))
            throw Error('图片过大或格式无效，请选择更小的图片。');
        return {
            id: `chat-image-${crypto.randomUUID()}`,
            name: (file.name || '聊天图片').slice(0, 160),
            data,
        };
    }
    finally {
        image.src = '';
    }
}
