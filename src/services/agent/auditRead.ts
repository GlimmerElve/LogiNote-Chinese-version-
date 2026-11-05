/** An audit refresh is read-only: never mask native failure with an old browser cache. */
export async function readFreshAuditFile<T>(
  key: string,
  nativeRead: (() => Promise<unknown>) | undefined,
  validate: (value: unknown) => void,
  normalize: (value: unknown) => T,
): Promise<T> {
  let value: unknown;
  if (nativeRead) {
    value = await nativeRead();
    // Only an explicitly missing native file is empty. No browser fallback here.
    if (value === null) return normalize(undefined);
  } else {
    if (typeof window !== 'undefined' && (window as unknown as { electronAPI?: { isElectron?: boolean } }).electronAPI?.isElectron) {
      throw new Error('审计读取接口不可用');
    }
    const text = typeof localStorage === 'undefined' ? null : localStorage.getItem(key);
    if (text === null) return normalize(undefined);
    value = JSON.parse(text);
  }
  validate(value);
  return normalize(value);
}

export function auditRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('审计记录格式错误');
  return value as Record<string, unknown>;
}

export function assertAudit(condition: unknown): asserts condition {
  if (!condition) throw new Error('审计记录格式错误');
}
