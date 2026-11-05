/** Public diagnostics only. Never send filesystem paths, JSON fragments or stacks to an agent. */
const PRIVATE_STORAGE_PATH = /(?:[a-z]:[\\/]|\\\\|private-user-state|textbook-jobs|web-snapshots|(?:^|[\s"'(])\/[^\s"']+)/iu;
const FILESYSTEM_ERROR = /\b(?:EPERM|EACCES|ENOENT|ENOSPC|EROFS|EIO|EBADF|lstat|stat|readFile|writeFile|mkdir|rename|unlink|open)\b|(?:读取|保存|快照|缓存|写入|存储).{0,12}(?:失败|异常|错误|损坏)/iu;
/** Legacy progress labels may contain raw filesystem errors. Keep ordinary teaching feedback exact. */
export function safeTextbookProgressDiagnostic(value: string): string {
  if ((PRIVATE_STORAGE_PATH.test(value) && (FILESYSTEM_ERROR.test(value) || /private-user-state|textbook-jobs|web-snapshots/iu.test(value)))
    || /\n\s*at\s.+(?:[a-z]:[\\/]|\/)/iu.test(value)) return '本机存储操作失败，请检查权限或可用空间；已保存检查点保留';
  return value;
}
/** A task can fail after acquiring URLs; that does not make its error a web error. */
export function safeTextbookTaskError(value: string): string {
  const diagnostic = safeTextbookProgressDiagnostic(value);
  if (diagnostic !== value) return diagnostic;
  if (/TextDecoder|(?:parameter|argument).{0,80}ArrayBuffer/iu.test(value)) return '教材内容解析出现类型错误；已保存章节保留，请更新程序后继续校验';
  if (PRIVATE_STORAGE_PATH.test(value)) return '教材生成或校验失败；已保存检查点保留';
  return value.replace(/[\r\n\u0000-\u001f]/gu, ' ').slice(0, 400);
}
export function safeTextbookWebError(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  if (['EPERM', 'EACCES', 'EROFS', 'ENOSPC', 'EIO', 'EBADF', 'ENOENT'].includes(code)) return '本机网页快照读写失败，请检查存储权限或可用空间；该来源未被作为证据';
  if (['ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'].includes(code)) return '公开资源连接失败，请检查网络或站点可用性；未取得可用正文';
  const name = error && typeof error === 'object' && 'name' in error ? String(error.name) : '';
  if (name === 'AbortError' || name === 'TimeoutError') return '公开资源读取已取消或超时，已保存快照保留';
  const raw = typeof error === 'string' ? error : error instanceof Error ? error.message : '';
  // Electron wraps rejected IPC messages. Show the actual public diagnostic,
  // rather than spending the display limit on the transport prefix.
  const message = raw.replace(/^(?:Error:\s*)?Error invoking remote method ['"]textbook:read-bound-url['"]:\s*(?:Error:\s*)?/u, '');
  if (!message || /(?:[a-z]:[\\/]|\\\\|private-user-state|textbook-jobs|web-snapshots|(?:^|\s)(?:EPERM|EACCES|ENOENT|ENOSPC)\b|\/(?:Users|home|tmp|var|private|Volumes|mnt|opt|root|workspace)\/|\n\s*at\s)/iu.test(message)
    || !/[\u4e00-\u9fff]/u.test(message)) return '公开资源或本机快照读取失败，未取得可用正文；请检查资源与存储';
  return message.replace(/[\r\n\u0000-\u001f]/gu, ' ').slice(0, 200);
}

/** Unreadable public pages are optional; broken frozen evidence or approval is not. */
export function isBlockingTextbookWebError(error: unknown): boolean {
  return /(?:许可|批准范围).*(?:失效|无效|变化)|不在批准读取范围|项目或绑定 URL 已变化|网页快照与批准来源不一致|网页快照(?:格式无效|版本校验失败|已损坏)|已保存的网页快照丢失|本机网页快照读写失败|本机存储操作失败|教材任务不存在或不可读取/u.test(safeTextbookWebError(error));
}
