import type { S2PluginInvocation, S2PluginManifest, S2PluginOutcome } from '../../types/sceneS2Plugin';
import { S2PluginProtocolError } from './sceneS2PluginProtocol';

/** Pure declaration/bridge; the application supplies a scoped, already-loaded note reader. No storage or RAG import. */
export const S2_PROJECT_NOTES_PLUGIN: S2PluginManifest = {
  protocolVersion: 1, id: 'project-notes', version: '1.0.0', label: '本局项目笔记',
  meaning: '只读进入场景时所选项目范围中、用户逐项允许的知识笔记正文；不是全库检索、画像或论证文档。',
  dependencies: [{ id: 'core', version: '1.0.0' }], dataTypes: [],
  capabilities: [{ id: 'read-text', kind: 'action', effect: 'read', permissions: ['notes-read'], confirmation: 'per-run', retry: 'manual-only', timeoutMs: 5000,
    meaning: '确认运行后读取一份本局已批准的项目知识笔记完整原文，最多6000字符/24000字节；变更、删除、移出范围或过大时不截断、不替换、不缓存。',
    inputs: [{ id: 'resource', label: '你允许的笔记', meaning: '本局宿主提供的已批准笔记资源句柄，不是笔记名称、路径或任意笔记ID。', type: { id: 'core.text', version: 1 }, required: true, multiple: false }],
    outputs: [{ id: 'text', label: '笔记正文', meaning: '当前批准版本的完整知识笔记正文，未经事实核实；不包含画像、论证文档等附加数据。', type: { id: 'core.text', version: 1 }, required: true, multiple: false }],
  }],
};
export const isS2ProjectNotes = (ref: { pluginId: string; pluginVersion: string; capabilityId: string }) =>
  ref.pluginId === 'project-notes' && ref.pluginVersion === '1.0.0' && ref.capabilityId === 'read-text';
export interface S2ProjectNoteChoice { noteId: string; label: string; updatedAt: string }
export interface S2ProjectNoteResourceInfo extends S2ProjectNoteChoice { id: string; projectId: string }
export interface S2ProjectNoteSourceOptions {
  projectId: string;
  list: () => S2ProjectNoteChoice[];
  read: (noteId: string, signal: AbortSignal) => Promise<{ noteId: string; updatedAt: string; text: string }>;
}
export type S2NoteAvailabilityReason = 'note-changed' | 'note-missing' | 'note-scope-unavailable';
export type S2NoteContentFailureReason = 'note-empty' | 'note-text-limit' | 'note-non-text' | 'note-response-mismatch';
function fail(code: string, message: string): never { throw new S2PluginProtocolError(code, 'resource', message); }
function choices(raw: S2ProjectNoteChoice[]) {
  if (!Array.isArray(raw) || raw.length > 500) fail('INVALID_NOTE_SCOPE', '项目知识点范围无效或超过500项，请缩小范围。');
  const seen = new Set<string>();
  return raw.map(item => {
    if (!item || typeof item.noteId !== 'string' || !item.noteId.trim() || item.noteId.length > 500 || seen.has(item.noteId)
      || typeof item.label !== 'string' || !item.label.trim() || item.label.length > 240
      || typeof item.updatedAt !== 'string' || !item.updatedAt || item.updatedAt.length > 100) fail('INVALID_NOTE_SCOPE', '项目知识点元数据无效，未读取正文。');
    seen.add(item.noteId); return { noteId: item.noteId, label: item.label, updatedAt: item.updatedAt };
  });
}

/** Trusted app code issues this object. Serialized scene/request fields cannot construct it. */
export class S2ProjectNoteSource {
  readonly projectId: string;
  #list: S2ProjectNoteSourceOptions['list'];
  #read: S2ProjectNoteSourceOptions['read'];
  #ceiling: Set<string>;
  #availabilityFailures = new WeakMap<object, S2NoteAvailabilityReason>();
  #contentFailures = new WeakMap<object, { selection: string; signal: AbortSignal; reason: S2NoteContentFailureReason }>();
  constructor(options: S2ProjectNoteSourceOptions) {
    if (!options || typeof options.projectId !== 'string' || !options.projectId.trim() || options.projectId.length > 500
      || typeof options.list !== 'function' || typeof options.read !== 'function') fail('INVALID_NOTE_SCOPE', '本地项目笔记入口无效。');
    this.projectId = options.projectId; this.#list = options.list; this.#read = options.read;
    this.#ceiling = new Set(choices(this.#list()).map(item => item.noteId)); Object.freeze(this);
  }
  choices(): S2ProjectNoteChoice[] { return choices(this.#list()).filter(item => this.#ceiling.has(item.noteId)); }
  availabilityFailure(error: unknown): S2NoteAvailabilityReason | null {
    return error && typeof error === 'object' ? this.#availabilityFailures.get(error) ?? null : null;
  }
  assertCurrent(info: S2ProjectNoteChoice) {
    let current: S2ProjectNoteChoice | undefined;
    try { current = this.choices().find(item => item.noteId === info.noteId); }
    catch (error) {
      if (error && typeof error === 'object') this.#availabilityFailures.set(error, 'note-scope-unavailable');
      throw error;
    }
    if (!current || current.updatedAt !== info.updatedAt || current.label !== info.label) {
      const error = new S2PluginProtocolError('NOTE_CHANGED', 'resource', '笔记已更新、删除或不在原项目范围内，请撤回后重新选择；不会读取替代内容。');
      this.#availabilityFailures.set(error, current ? 'note-changed' : 'note-missing'); throw error;
    }
  }
  contentFailure(error: unknown, info: S2ProjectNoteChoice, signal: AbortSignal): S2NoteContentFailureReason | null {
    const failure = error && typeof error === 'object' ? this.#contentFailures.get(error) : undefined;
    return failure?.signal === signal && failure.selection === JSON.stringify(info) ? failure.reason : null;
  }
  #rejectContent(info: S2ProjectNoteChoice, signal: AbortSignal, reason: S2NoteContentFailureReason, code: string, message: string): never {
    const error = new S2PluginProtocolError(code, 'resource', message);
    this.#contentFailures.set(error, { selection: JSON.stringify(info), signal, reason }); throw error;
  }
  async readCurrent(info: S2ProjectNoteChoice, signal: AbortSignal): Promise<string> {
    if (signal.aborted) fail('CANCELLED', '笔记读取已取消。');
    this.assertCurrent(info);
    const result = await this.#read(info.noteId, signal);
    if (signal.aborted) fail('CANCELLED', '笔记读取已取消，未发布结果。');
    this.assertCurrent(info);
    if (!result || result.noteId !== info.noteId || result.updatedAt !== info.updatedAt || typeof result.text !== 'string') this.#rejectContent(info, signal, 'note-response-mismatch', 'NOTE_CHANGED', '笔记读取身份或版本不匹配，未发布结果。');
    if (!result.text.trim() || result.text.length > 6000 || new TextEncoder().encode(result.text).byteLength > 24000 || result.text.includes('\0'))
      this.#rejectContent(info, signal, !result.text.trim() ? 'note-empty' : result.text.length > 6000 || new TextEncoder().encode(result.text).byteLength > 24000 ? 'note-text-limit' : 'note-non-text',
        'INVALID_NOTE_TEXT', '笔记正文为空、过大或含非文本内容；未截断，请整理笔记后重新选择。');
    return result.text;
  }
}
export class S2ProjectNoteResource {
  #source: S2ProjectNoteSource;
  #info: S2ProjectNoteResourceInfo;
  #invalidated = false;
  #invalidatedReason: S2NoteAvailabilityReason | null = null;
  #availabilityFailures = new WeakMap<object, S2NoteAvailabilityReason>();
  #contentFailures = new WeakMap<object, { invocation: string; reason: S2NoteContentFailureReason }>();
  constructor(source: S2ProjectNoteSource, noteId: string) {
    if (!(source instanceof S2ProjectNoteSource)) fail('INVALID_NOTE_SCOPE', '需要当前本地应用提供的项目笔记入口。');
    const selected = source.choices().find(item => item.noteId === noteId);
    if (!selected) fail('SCOPE_DENIED', '笔记不在进入场景时的项目范围内，未授权。');
    this.#source = source; this.#info = { ...selected, id: `projectnote-${crypto.randomUUID()}`, projectId: source.projectId }; Object.freeze(this);
  }
  info(): S2ProjectNoteResourceInfo { return structuredClone(this.#info); }
  availabilityFailure(error: unknown): S2NoteAvailabilityReason | null {
    return error && typeof error === 'object' ? this.#availabilityFailures.get(error) ?? null : null;
  }
  contentFailure(error: unknown, call: S2PluginInvocation): S2NoteContentFailureReason | null {
    const failure = error && typeof error === 'object' ? this.#contentFailures.get(error) : undefined;
    return failure?.invocation === JSON.stringify(call) ? failure.reason : null;
  }
  assertAvailable() {
    if (this.#invalidated) {
      const error = new S2PluginProtocolError('NOTE_CHANGED', 'resource', '此前已检测到笔记变更或范围失效；恢复旧内容不会恢复授权，请撤回后重新选择。');
      if (this.#invalidatedReason) this.#availabilityFailures.set(error, this.#invalidatedReason); throw error;
    }
    try { this.#source.assertCurrent(this.#info); }
    catch (error) {
      this.#invalidated = true; this.#invalidatedReason = this.#source.availabilityFailure(error);
      if (error && typeof error === 'object' && this.#invalidatedReason) this.#availabilityFailures.set(error, this.#invalidatedReason);
      throw error;
    }
  }
  async read(call: S2PluginInvocation, signal: AbortSignal): Promise<S2PluginOutcome> {
    this.assertAvailable();
    let text: string;
    try { text = await this.#source.readCurrent(this.#info, signal); this.assertAvailable(); }
    catch (error) {
      const reason = this.#source.availabilityFailure(error);
      if (error && typeof error === 'object' && reason) this.#availabilityFailures.set(error, reason);
      const contentReason = this.#source.contentFailure(error, this.#info, signal);
      if (error && typeof error === 'object' && contentReason) this.#contentFailures.set(error, { invocation: JSON.stringify(call), reason: contentReason });
      if (!signal.aborted) { try { this.assertAvailable(); } catch { /* Sticky invalidation; retain the original failure. */ } }
      throw error;
    }
    return { status: 'succeeded', outputs: { text: [{ protocolVersion: 1, id: `artifact-${crypto.randomUUID()}`,
      type: { id: 'core.text', version: 1 }, complete: true,
      source: { sceneId: call.sceneId, runId: call.runId, nodeId: call.nodeId, revision: call.revision, kind: 'plugin', invocationId: call.id },
      payload: { kind: 'inline', value: text } }] } };
  }
}
