/** Private validation evidence, never inferred from model/host error messages. */
export type S2ControlPath = ReadonlyArray<string | number>;
export interface S2ControlIssue { control: string; message: string }
const issues = new WeakMap<object, S2ControlIssue>();
export const s2ControlTarget = (path: S2ControlPath) => JSON.stringify(['declared', ...path]);
export function throwS2ControlIssue(message: string, path?: S2ControlPath): never {
  const error = new Error(message);
  if (path) issues.set(error, { control: s2ControlTarget(path), message });
  throw error;
}
export function s2ControlIssue(error: unknown): S2ControlIssue | undefined {
  const issue = error && typeof error === 'object' ? issues.get(error) : undefined;
  return issue ? { ...issue } : undefined;
}
