import fs from 'node:fs/promises';
import path from 'node:path';
import type { TextbookReadingUpdate } from '../services/textbook/readingState';
import { USER_STATE_FILES, serializeUserStateFile } from '../services/userStateService';
import { atomicWriteTextFile } from './atomicWrite';
import { withSavedVaultSnapshot } from './vaultSnapshot';

function validateUpdates(input: unknown): TextbookReadingUpdate[] {
  if (!Array.isArray(input) || input.length > 1000) throw new Error('阅读进度请求无效');
  const ids = new Set<string>();
  return input.map(item => {
    const state = item?.state;
    if (typeof item?.noteId !== 'string' || !item.noteId || item.noteId.length > 300 || ids.has(item.noteId)
      || !state || typeof state.revisionId !== 'string' || !state.revisionId || state.revisionId.length > 300
      || typeof state.lastReadAt !== 'string' || state.lastReadAt.length > 64 || !Number.isFinite(Date.parse(state.lastReadAt))
      || (state.blockAnchor !== undefined && (typeof state.blockAnchor !== 'string' || state.blockAnchor.length > 240))
      || (state.scrollTop !== undefined && (!Number.isFinite(state.scrollTop) || state.scrollTop < 0 || state.scrollTop > 100_000_000)))
      throw new Error('阅读进度字段无效');
    ids.add(item.noteId);
    return { noteId: item.noteId, state: { revisionId: state.revisionId, lastReadAt: state.lastReadAt,
      ...(state.blockAnchor !== undefined ? { blockAnchor: state.blockAnchor } : {}),
      ...(state.scrollTop !== undefined ? { scrollTop: state.scrollTop } : {}),
    } };
  });
}

/** Single-file atomic patch: never read/write Markdown or trigger source indexing. */
export async function saveTextbookReadingPositions(vaultRoot: string, userStateDir: string, input: unknown,
  isCurrent?: () => boolean, write = (file: string, text: string) => atomicWriteTextFile(file, text, { allowCopyFallback: false })): Promise<void> {
  const updates = validateUpdates(input);
  if (!updates.length) return;
  await withSavedVaultSnapshot(vaultRoot, userStateDir, async () => {
    const metadata = JSON.parse(await fs.readFile(path.join(vaultRoot, 'metadata.json'), 'utf8'));
    if (metadata.version !== 1 || !metadata.notesMeta || Array.isArray(metadata.notesMeta) || typeof metadata.notesMeta !== 'object')
      throw new Error('笔记目录无效，未覆盖阅读进度');
    const file = path.join(userStateDir, USER_STATE_FILES.noteStates);
    let existing: string | undefined;
    try { existing = await fs.readFile(file, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const personal = existing === undefined ? { version: 1, noteStates: {} } : JSON.parse(existing);
    if (personal.version !== 1 || !personal.noteStates || typeof personal.noteStates !== 'object' || Array.isArray(personal.noteStates))
      throw new Error('个人记录无效，未覆盖阅读进度');
    for (const update of updates) {
      const note = Object.hasOwn(metadata.notesMeta, update.noteId) ? metadata.notesMeta[update.noteId] : undefined;
      if (note?.noteType !== 'project' || note.textbook?.revisionId !== update.state.revisionId)
        throw new Error('教材已删除或修订已变化，未覆盖阅读进度');
      const previous = Object.hasOwn(personal.noteStates, update.noteId) ? personal.noteStates[update.noteId] : {};
      if (!previous || typeof previous !== 'object' || Array.isArray(previous)) throw new Error('个人记录无效，未覆盖阅读进度');
      if (previous.textbookReadingState?.revisionId === update.state.revisionId
        && Date.parse(previous.textbookReadingState.lastReadAt) > Date.parse(update.state.lastReadAt)) continue;
      Object.defineProperty(personal.noteStates, update.noteId, { value: { ...previous, textbookReadingState: update.state },
        enumerable: true, writable: true, configurable: true });
    }
    const text = serializeUserStateFile(personal.noteStates);
    if (isCurrent && !isCurrent()) throw new Error('rag_source_environment_changed');
    if (text !== existing) await write(file, text);
  }, isCurrent);
}
