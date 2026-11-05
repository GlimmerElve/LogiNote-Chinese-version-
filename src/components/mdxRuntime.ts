import * as mdx from '@mdxeditor/editor';
import type { NodeRef } from '@mdxeditor/gurx';
import type { Extension } from 'mdast-util-from-markdown';
import type { LexicalEditor } from 'lexical';
export const MDX_IMPORT_TAG = 'loginote-markdown-import';

// MDXEditor 4.2 exports these APIs at runtime but omits their .d.ts entries.
// Keep the version-sensitive seam in one place, covered by real import tests.
export const mdxRuntime = mdx as typeof mdx & {
  corePlugin: (params: Record<string, unknown>) => mdx.RealmPlugin;
  importMarkdownToLexical: (params: Record<string, unknown>) => void;
  MarkdownParseError: new (message: string, cause: unknown) => Error;
  mdastExtensions$: NodeRef<Extension[]>;
  rootEditorSubscriptions$: NodeRef<Array<(editor: LexicalEditor) => () => void>>;
  toMarkdownExtensions$: NodeRef<any[]>;
  toMarkdownOptions$: NodeRef<Record<string, unknown>>;
};
