import * as mdx from '@mdxeditor/editor';
import { Realm } from '@mdxeditor/gurx';
import { createEditor, $getRoot } from 'lexical';
import { mdxNoteContentPlugins } from './mdxNoteContentPlugins';
import { mdxCompatibilityLocation, prepareMarkdownForMdx } from '../services/markdownMdxCompatibility';
import { mdxRuntime as adapter } from './mdxRuntime';

export class MdxNoteCompatibilityError extends Error {
  readonly line?: number;
  readonly column?: number;
  constructor(error: unknown) {
    const location = mdxCompatibilityLocation(error);
    super(`富文本兼容性检查未通过${location.line ? `（第 ${location.line} 行${location.column ? `，第 ${location.column} 列` : ''}）` : ''}；原文与已生成章节保留，请在源码模式检查，不需重新生成教材`);
    this.name = 'MdxNoteCompatibilityError'; this.line = location.line; this.column = location.column;
  }
}

/** Real parser + real visitors + real Lexical nodes; no DOM, rendering, vault,
 * image reads, writes or model calls. Never returns/replaces the author's source. */
export function assertMdxNoteImportable(source: string): void {
  try {
    if (typeof adapter.corePlugin !== 'function' || typeof adapter.importMarkdownToLexical !== 'function'
      || typeof adapter.MarkdownParseError !== 'function') throw new Error('Editor adapter unavailable');
    const markdown = prepareMarkdownForMdx(source).markdown;
    const realm = new Realm();
    for (const plugin of [adapter.corePlugin({ initialMarkdown: '', trim: false }), ...mdxNoteContentPlugins()]) plugin.init?.(realm);
    const descriptors = { jsxComponentDescriptors: realm.getValue(mdx.jsxComponentDescriptors$),
      directiveDescriptors: realm.getValue(mdx.directiveDescriptors$),
      codeBlockEditorDescriptors: realm.getValue(mdx.codeBlockEditorDescriptors$),
      defaultCodeBlockLanguage: realm.getValue(mdx.defaultCodeBlockLanguage$) };
    const syntaxExtensions = realm.getValue(mdx.syntaxExtensions$), mdastExtensions = realm.getValue(adapter.mdastExtensions$);
    const visitors = realm.getValue(mdx.importVisitors$);
    let failure: Error | undefined;
    const editor = createEditor({ namespace: 'loginote-mdx-preflight', nodes: realm.getValue(mdx.usedLexicalNodes$), onError(error) { failure = error; } });
    editor.update(() => adapter.importMarkdownToLexical({ root: $getRoot(), markdown, visitors,
      syntaxExtensions, mdastExtensions, ...descriptors }), { discrete: true });
    if (failure) throw failure;
  } catch (error) { throw error instanceof MdxNoteCompatibilityError ? error : new MdxNoteCompatibilityError(error); }
}

/** A partially fixable document must still show its EXACT original source if
 * another unknown structure prevents rich-text import. No partial source rewrite. */
export function prepareMdxEditorInput(source: string): string {
  const prepared = prepareMarkdownForMdx(source);
  if (!prepared.patches.length) return source;
  try { assertMdxNoteImportable(prepared.markdown); return prepared.markdown; }
  catch { return source; }
}

/** Upstream insertMarkdown reports fragment errors through the whole-document
 * markdown channel. Validate BEFORE dispatch so an invalid fragment can never
 * replace the note's source. The rejected fragment stays available in the UI. */
export function insertMdxMarkdownSafely(source: string, insert: (markdown: string) => void, report: (source: string | null) => void): boolean {
  const prepared = prepareMarkdownForMdx(source).markdown;
  try { assertMdxNoteImportable(prepared); }
  catch { report(source); return false; }
  report(null); insert(prepared); return true;
}
