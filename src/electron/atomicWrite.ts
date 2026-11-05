import { randomUUID } from 'crypto';
import fs from 'fs/promises';

export type AtomicWriteStrategy = 'rename' | 'copy-fallback';

export interface AtomicWriteOperations {
  writeFile: (file: string, content: string, encoding: 'utf-8') => Promise<unknown>;
  rename: (from: string, to: string) => Promise<unknown>;
  copyFile: (from: string, to: string) => Promise<unknown>;
  rm: (file: string, options: { force: true }) => Promise<unknown>;
}

const defaultOperations: AtomicWriteOperations = {
  writeFile: (file, content, encoding) => fs.writeFile(file, content, encoding),
  rename: (from, to) => fs.rename(from, to),
  copyFile: (from, to) => fs.copyFile(from, to),
  rm: (file, options) => fs.rm(file, options),
};

const RETRYABLE_REPLACE_ERRORS = new Set(['EPERM', 'EACCES', 'EBUSY', 'EEXIST']);

function isRetryableReplaceError(error: unknown): boolean {
  return RETRYABLE_REPLACE_ERRORS.has((error as NodeJS.ErrnoException)?.code || '');
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function retryReplace(operation: () => Promise<unknown>, delays: number[]): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await operation();
      return;
    } catch (error) {
      if (!isRetryableReplaceError(error) || attempt >= delays.length) throw error;
      await wait(delays[attempt]);
    }
  }
}

/**
 * 优先用临时文件 rename 原子替换；Windows/同步盘持续锁定目标时，回退为临时文件覆盖复制。
 * ponytail: copy 回退不是断电原子操作，但保留旧文件直到完整临时文件写成，优于先删目标再 rename。
 */
export async function atomicWriteTextFile(
  target: string,
  content: string,
  options: {
    operations?: AtomicWriteOperations;
    retryDelays?: number[];
    /** Single-file state without a recovery journal must retain the old file on lock failure. */
    allowCopyFallback?: boolean;
  } = {},
): Promise<AtomicWriteStrategy> {
  const operations = options.operations || defaultOperations;
  const retryDelays = options.retryDelays || [20, 50, 100, 200];
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;

  try {
    await operations.writeFile(temporary, content, 'utf-8');
    try {
      await retryReplace(() => operations.rename(temporary, target), retryDelays);
      return 'rename';
    } catch (error) {
      if (!isRetryableReplaceError(error) || options.allowCopyFallback === false) throw error;
      await retryReplace(() => operations.copyFile(temporary, target), retryDelays);
      return 'copy-fallback';
    }
  } finally {
    await operations.rm(temporary, { force: true }).catch(() => {});
  }
}
