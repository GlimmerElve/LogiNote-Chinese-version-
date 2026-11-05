import assert from 'node:assert/strict';
import { atomicWriteTextFile, type AtomicWriteOperations } from '../src/electron/atomicWrite.ts';

const files = new Map<string, string>([['C:\\state\\settings.json', '{"old":true}']]);
let renameAttempts = 0;
let copyAttempts = 0;

const operations: AtomicWriteOperations = {
  async writeFile(file, content) { files.set(file, content); },
  async rename() {
    renameAttempts += 1;
    const error = new Error('locked') as NodeJS.ErrnoException;
    error.code = 'EPERM';
    throw error;
  },
  async copyFile(from, to) {
    copyAttempts += 1;
    const content = files.get(from);
    if (content === undefined) throw new Error('missing temporary file');
    files.set(to, content);
  },
  async rm(file) { files.delete(file); },
};

const strategy = await atomicWriteTextFile(
  'C:\\state\\settings.json',
  '{"new":true}',
  { operations, retryDelays: [0, 0] },
);

assert.equal(strategy, 'copy-fallback');
assert.equal(renameAttempts, 3, 'EPERM 应按配置重试后再回退');
assert.equal(copyAttempts, 1);
assert.equal(files.get('C:\\state\\settings.json'), '{"new":true}');
assert.equal([...files.keys()].some((file) => file.endsWith('.tmp')), false, '临时文件必须清理');

await assert.rejects(atomicWriteTextFile('C:\\state\\settings.json', '{"mustNotReplace":true}',
  { operations, retryDelays: [0, 0], allowCopyFallback: false }), /locked/);
assert.equal(copyAttempts, 1, '无journal的轻量个人状态只允许原子替换，锁失败不能非原子覆盖');
assert.equal(files.get('C:\\state\\settings.json'), '{"new":true}');
assert.equal([...files.keys()].some(file => file.endsWith('.tmp')), false);

console.log('atomic write check passed');
