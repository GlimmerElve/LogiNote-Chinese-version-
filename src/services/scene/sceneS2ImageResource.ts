import type { LlmImageInput } from '../../types';
import type { S2Json, S2PluginInvocation, S2PluginOutcome } from '../../types/sceneS2Plugin';
import { MAX_LLM_IMAGE_BYTES, validateLlmImages } from '../llmImages';
import { MAX_TEXTBOOK_IMAGE_BYTES } from '../textbook/localImages';
import { S2PluginProtocolError } from './sceneS2PluginProtocol';

export interface S2ImageResourceInfo { id: string; label: string; bytes: number; mimeType: 'image/png' | 'image/jpeg' | 'image/webp'; lastModified: number }
/** Local confirmation UI only. Never serialize this into a scene, Agent frame or template. */
export interface S2ImageResourcePreview extends S2ImageResourceInfo { dataUrl: string }
export const isS2ImageResource = (value: { pluginId: string; pluginVersion: string; capabilityId: string }) =>
  value.pluginId === 'local-material' && value.pluginVersion === '1.0.0' && value.capabilityId === 'read-image';
export function s2ImageResourceId(value: S2Json): string {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1
    || !Object.hasOwn(value, 'resourceId') || typeof value.resourceId !== 'string' || !/^imagefile-[\w-]+$/u.test(value.resourceId))
    throw new S2PluginProtocolError('INVALID_IMAGE_HANDLE', 'image', '图片输入必须是本局选择器提供的图片句柄，不能用路径、URL或文本代替。');
  return value.resourceId;
}

/** Immutable native File bytes. No path lookup, URL loading, OCR, decoding or implicit model access. */
export class S2ImageResource {
  #info: S2ImageResourceInfo;
  #image: LlmImageInput;
  private constructor(info: S2ImageResourceInfo, image: LlmImageInput) { this.#info = info; this.#image = image; Object.freeze(this); }
  static async select(file: File): Promise<S2ImageResource> {
    if (typeof File === 'undefined' || !(file instanceof File)) throw new Error('请选择本地 PNG、JPEG 或 WebP 图片，不能使用路径或对象代替。');
    if (!file.name || file.name.length > 240 || /[\\/\x00-\x1f]/u.test(file.name) || !/\.(png|jpe?g|webp)$/iu.test(file.name)) throw new Error('仅支持名称有效的 PNG、JPEG、WebP 静态图片。');
    if (file.size <= 0 || file.size > MAX_TEXTBOOK_IMAGE_BYTES) throw new Error('单张图片必须非空且不超过 1 MiB；不会压缩、截断或自动 OCR。');
    const bytes = new Uint8Array(await File.prototype.arrayBuffer.call(file));
    if (bytes.byteLength !== file.size) throw new Error('图片读取不完整，请重新选择。');
    const mimeType = /\.png$/iu.test(file.name) ? 'image/png' : /\.webp$/iu.test(file.name) ? 'image/webp' : 'image/jpeg';
    if (file.type && file.type !== mimeType && !(file.type === 'image/jpg' && mimeType === 'image/jpeg')) throw new Error('图片扩展名与媒体类型不一致，未接入本局。');
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 16384) binary += String.fromCharCode(...bytes.subarray(offset, offset + 16384));
    const id = `imagefile-${crypto.randomUUID()}`, image = { assetId: id, dataUrl: `data:${mimeType};base64,${btoa(binary)}` };
    validateLlmImages([image]); // Reuse the actual transport's signatures, raster bounds and format checks.
    return new S2ImageResource({ id, label: file.name, bytes: file.size, mimeType, lastModified: file.lastModified }, image);
  }
  info(): S2ImageResourceInfo { return structuredClone(this.#info); }
  contentFailure(): null { return null; }
  image(): LlmImageInput { return structuredClone(this.#image); }
  preview(): S2ImageResourcePreview { return { ...this.info(), dataUrl: this.#image.dataUrl }; }
  read(call: S2PluginInvocation, signal: AbortSignal): Promise<S2PluginOutcome> {
    if (signal.aborted) throw new DOMException('图片读取已取消', 'AbortError');
    return Promise.resolve({ status: 'succeeded', outputs: { image: [{ protocolVersion: 1, id: `artifact-${crypto.randomUUID()}`,
      type: { id: 'core.image', version: 1 }, complete: true,
      source: { sceneId: call.sceneId, runId: call.runId, nodeId: call.nodeId, revision: call.revision, kind: 'plugin', invocationId: call.id },
      payload: { kind: 'inline', value: { resourceId: this.#info.id } } }] } });
  }
}
export { MAX_LLM_IMAGE_BYTES };
