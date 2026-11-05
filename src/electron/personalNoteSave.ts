import fs from 'node:fs/promises';
import path from 'node:path';
import type { UserNoteState } from '../types';
import { USER_STATE_FIELDS, USER_STATE_FILES, serializeUserStateFile } from '../services/userStateService';
import { samePersonalValue, storedPersonalValue, type PersonalNotePatch } from '../services/personalNoteState';
import { atomicWriteTextFile } from './atomicWrite';
import { withSavedVaultSnapshot } from './vaultSnapshot';
import { isValidTextbookReadingState } from '../services/textbook/readingState';

function closed(value: unknown, keys: string[]): value is Record<string, any> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key)));
}
function validate(input: unknown): PersonalNotePatch[] {
  if (!Array.isArray(input) || input.length > 1000) throw Error('个人状态请求无效');
  const text = JSON.stringify(input);
  if (text.length > 32_000_000) throw Error('个人状态请求无效');
  const normalized = JSON.parse(text);
  const ids = new Set<string>();
  for (const item of normalized) {
    if (!closed(item, ['noteId', 'noteType', 'changes']) || typeof item.noteId !== 'string' || !item.noteId || item.noteId.length > 300
      || ids.has(item.noteId) || typeof item.noteType !== 'string' || !Array.isArray(item.changes) || !item.changes.length
      || item.changes.length > USER_STATE_FIELDS.length) throw Error('个人状态目标无效');
    ids.add(item.noteId); const fields = new Set<string>();
    for (const change of item.changes) {
      if (!closed(change, ['field', 'before', 'after']) || !USER_STATE_FIELDS.includes(change.field) || fields.has(change.field)) throw Error('个人状态字段越权');
      fields.add(change.field);
      for (const value of [change.before, change.after]) {
        if (!closed(value, ['present', 'value']) || typeof value.present !== 'boolean'
          || (value.present ? !Object.hasOwn(value, 'value') || value.value === undefined : Object.hasOwn(value, 'value'))) throw Error('个人状态字段格式无效');
      }
      const value = change.after.present ? change.after.value : null;
      if (value !== null && ((['pinned', 'isFavorite'].includes(change.field) && typeof value !== 'boolean')
        || (['learningReviewRecords', 'questions'].includes(change.field) && !Array.isArray(value)))) throw Error('个人状态字段类型无效');
    }
  }
  return normalized;
}

/** Field-level compare-and-set under the same source lock as full snapshots. */
export async function savePersonalNoteState(vaultRoot: string, userStateDir: string, input: unknown,
  isCurrent?: () => boolean, write = (file: string, text: string) => atomicWriteTextFile(file, text, { allowCopyFallback: false })): Promise<void> {
  const patches = validate(input);
  if (!patches.length) return;
  await withSavedVaultSnapshot(vaultRoot, userStateDir, async () => {
    const metadata = JSON.parse(await fs.readFile(path.join(vaultRoot, 'metadata.json'), 'utf8'));
    if (metadata?.version !== 1 || !metadata.notesMeta || typeof metadata.notesMeta !== 'object' || Array.isArray(metadata.notesMeta)) throw Error('笔记目录无效，未覆盖个人状态');
    const file = path.join(userStateDir, USER_STATE_FILES.noteStates);
    let previous: string | undefined;
    try { previous = await fs.readFile(file, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const personal = previous === undefined ? { version: 1, noteStates: {} } : JSON.parse(previous);
    if (personal?.version !== 1 || !personal.noteStates || typeof personal.noteStates !== 'object' || Array.isArray(personal.noteStates)) throw Error('个人记录无效，未覆盖原文');
    for (const patch of patches) {
      const note = Object.hasOwn(metadata.notesMeta, patch.noteId) ? metadata.notesMeta[patch.noteId] : undefined;
      if (!note || (note.noteType || 'knowledge') !== patch.noteType) throw Error('笔记已删除或类型变化，未覆盖个人状态');
      const current = Object.hasOwn(personal.noteStates, patch.noteId) ? personal.noteStates[patch.noteId] : {};
      if (!current || typeof current !== 'object' || Array.isArray(current)) throw Error('个人记录无效，未覆盖原文');
      const next: UserNoteState = { ...current };
      for (const change of patch.changes) {
        const saved = storedPersonalValue(current, change.field);
        if (!samePersonalValue(saved, change.before) && !samePersonalValue(saved, change.after)) throw Error('个人状态已被更新，未覆盖较新的记录，请重新载入后重试');
        if (change.field === 'textbookReadingState' && change.after.present
          && (note.noteType !== 'project' || !isValidTextbookReadingState(change.after.value)
            || change.after.value.revisionId !== note.textbook?.revisionId)) throw Error('阅读状态无效或教材修订已变化，未覆盖原记录');
        if (change.after.present) Object.defineProperty(next, change.field, { value: change.after.value, enumerable: true, writable: true, configurable: true });
        else delete next[change.field];
      }
      Object.defineProperty(personal.noteStates, patch.noteId, { value: next, enumerable: true, writable: true, configurable: true });
    }
    const text = serializeUserStateFile(personal.noteStates);
    if (isCurrent && !isCurrent()) throw Error('rag_source_environment_changed');
    if (text !== previous) await write(file, text);
  }, isCurrent);
}
