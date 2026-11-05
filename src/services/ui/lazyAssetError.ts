/** A missing application module is not a diagram syntax/content error.
 * Do not reload here: the editor/flow page may own unsaved user content. */
export function isLazyAssetLoadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Loading (?:CSS )?chunk\b[^\n]*failed|Unable to preload CSS|ChunkLoadError/iu.test(message);
}
export function mermaidFailureMessage(error: unknown): string {
  if (isLazyAssetLoadError(error)) return '图示组件加载失败，可能是程序更新后旧资源不可用。请先保存当前笔记或学习内容，再关闭并重新打开 LogiNote；无需重新生成教材或修改图示源码。原始源码仍保留在下方。';
  return error instanceof Error ? error.message : '图示渲染失败';
}
