import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicWriteTextFile } from './atomicWrite.ts';
import { withRagSourceTransaction } from './ragSourceTransactions.ts';
import { adoptPendingReviewAnswers, applyCognitionMutation, emptyCognitionFile, parseCognitionFile } from '../services/cognition/core.ts';
import type { CognitionFile } from '../services/cognition/types.ts';

export const COGNITION_FILE_NAME = 'personal-cognition.json';
export const COGNITION_INDEX_FILE_NAME = 'personal-cognition-vectors.json';
const queues = new Map<string, Promise<unknown>>();
const targetFor = (directory: string) => path.resolve(directory, COGNITION_FILE_NAME);

async function read(target: string): Promise<CognitionFile> {
  try { return parseCognitionFile(JSON.parse(await fs.readFile(target, 'utf-8'))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyCognitionFile();
    throw error; // Corruption/permission errors must not authorize replacing history with an empty file.
  }
}

function assertCurrent(isCurrent: () => boolean) {
  if (!isCurrent()) throw new Error('认知存储环境已变化或正在迁移／重置，未写入，请重新读取后核对');
}

export async function loadCognition(directory: string, isCurrent: () => boolean = () => true): Promise<CognitionFile> {
  return withCognitionFile(directory, async file => {
    const next = adoptPendingReviewAnswers(file, { id: randomUUID(), at: new Date().toISOString() });
    if (next !== file) await persistCognition(directory, next, isCurrent);
    return next;
  }, isCurrent);
}

async function persistCognition(directory: string, next: CognitionFile, isCurrent: () => boolean, invalidateIndex = true): Promise<void> {
  assertCurrent(isCurrent);
  if (invalidateIndex) await fs.rm(path.resolve(directory, COGNITION_INDEX_FILE_NAME), { force: true });
  assertCurrent(isCurrent);
  await fs.mkdir(directory, { recursive: true });
  assertCurrent(isCurrent);
  await atomicWriteTextFile(targetFor(directory), JSON.stringify(next, null, 2), { operations: {
    writeFile: (file, content, encoding) => { assertCurrent(isCurrent); return fs.writeFile(file, content, encoding); },
    rename: (from, to) => { assertCurrent(isCurrent); return fs.rename(from, to); },
    copyFile: async () => { throw new Error('认知库文件被占用，未覆盖旧版本。请稍后重试。'); }, rm: (file, options) => fs.rm(file, options),
  }, allowCopyFallback: false });
}

/** Short critical sections shared by source mutations and derived-index publication. */
export async function withCognitionFile<T>(directory: string, action: (file: CognitionFile) => Promise<T>, isCurrent: () => boolean = () => true): Promise<T> {
  const target = targetFor(directory);
  const task = (queues.get(target) || Promise.resolve()).catch(() => {}).then(() => withRagSourceTransaction([path.resolve(directory)], async () => {
    assertCurrent(isCurrent);
    const file = await read(target);
    assertCurrent(isCurrent);
    return action(file);
  }));
  queues.set(target, task);
  try { return await task; }
  finally { if (queues.get(target) === task) queues.delete(target); }
}

/** Serialize the entire read/validate/write transaction across all renderer windows. */
export async function mutateCognition(directory: string, input: unknown, isCurrent: () => boolean = () => true): Promise<CognitionFile> {
  // Freeze both the caller's intent and directory before waiting on any store/reset lock.
  const root = path.resolve(directory), request = structuredClone(input);
  return withCognitionFile(root, async before => {
    const next = applyCognitionMutation(before, request, { id: randomUUID(), at: new Date().toISOString() });
    if (next === before) return before;
    // Invalidate before committing changed beliefs. If removal fails, do not claim deletion succeeded.
    // Candidate-only edits leave the current-belief index intact.
    await persistCognition(root, next, isCurrent, JSON.stringify(before.records) !== JSON.stringify(next.records));
    return next;
  }, isCurrent);
}
