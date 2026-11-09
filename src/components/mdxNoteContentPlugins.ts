import {
  headingsPlugin, listsPlugin, quotePlugin, thematicBreakPlugin, codeBlockPlugin,
  codeMirrorPlugin, linkPlugin, linkDialogPlugin, tablePlugin, imagePlugin,
  addImportVisitor$, importVisitors$, jsxComponentDescriptors$, directiveDescriptors$, codeBlockEditorDescriptors$, defaultCodeBlockLanguage$, realmPlugin,
} from '@mdxeditor/editor';
import { wikiLinkPlugin } from './WikiLinkNode';
import { mathPlugin } from './MathNode';
import { argumentBlockPlugin } from './ArgumentBlockNode';
import { learningReviewBlockPlugin } from './textbook/LearningReviewBlockNode';
import { textbookBoundaryPlugin } from './textbook/TextbookBoundaryNode';
import { textbookFootnotePlugin } from './textbook/TextbookFootnoteNode';
import { textbookCodeEditorDescriptor, recoverableCodeEditorDescriptor, textbookEditorContextPlugin } from './textbook/TextbookCodeEditor';
import { mdxRuntime, MDX_IMPORT_TAG } from './mdxRuntime';
import { $addUpdateTag } from 'lexical';
import { recoverGeneratedMathTree, type GeneratedMathScope } from '../services/textbook/generatedMath';
import { recoverGeneratedFormattingTree } from '../services/textbook/generatedFormatting';

const generatedMathPlugin = realmPlugin<{ scope: GeneratedMathScope; source?: () => string; textbook?: boolean; citationIds?: readonly string[];
  live?: () => { scope: GeneratedMathScope; textbook: boolean; citationIds?: readonly string[] } }>({ init(realm, params) {
  realm.pub(addImportVisitor$, { priority: 11000, testNode: 'root', visitNode({ mdastNode, actions }) {
    $addUpdateTag(MDX_IMPORT_TAG);
    const current = params?.live?.() ?? { scope: params?.scope || 'knowledge-section', textbook: Boolean(params?.textbook), citationIds: params?.citationIds };
    recoverGeneratedFormattingTree(mdastNode as import('mdast').Root, params?.source?.() || '', current.textbook ? 'all' : current.scope);
    recoverGeneratedMathTree(mdastNode as import('mdast').Root, current.scope, { source: params?.source?.(), citationIds: current.citationIds }); actions.nextVisitor();
  } });
} });

// Run on the actual parsed root before any node is inserted. Table rows/cells
// are owned by TableNode, but their inline content is later imported by nested
// editors, so check that content here as well instead of discovering it on render.
const compatibleTreePlugin = realmPlugin({ init(realm) {
  realm.pub(addImportVisitor$, { testNode: 'root', priority: 1000,
    visitNode({ mdastNode, actions }) {
      const descriptors = { jsxComponentDescriptors: realm.getValue(jsxComponentDescriptors$),
        directiveDescriptors: realm.getValue(directiveDescriptors$), codeBlockEditorDescriptors: realm.getValue(codeBlockEditorDescriptors$),
        defaultCodeBlockLanguage: realm.getValue(defaultCodeBlockLanguage$) };
      const visitors = realm.getValue(importVisitors$);
      const visit = (node: any) => {
        const fail = () => { throw new mdxRuntime.MarkdownParseError('笔记包含不支持或损坏的结构，原文已保留', node.position?.start); };
        if (!['tableRow', 'tableCell'].includes(node.type) && !visitors.some(visitor =>
          typeof visitor.testNode === 'string' ? visitor.testNode === node.type : visitor.testNode(node, descriptors))) fail();
        if (['mdxJsxTextElement', 'mdxJsxFlowElement'].includes(node.type)
          && ['TextbookBoundary', 'LearningReviewBlock', 'ArgumentBlock'].includes(node.name)) {
          const attribute = (name: string) => node.attributes?.find((item: any) => item.type === 'mdxJsxAttribute' && item.name === name)?.value;
          const id = attribute('id');
          if (typeof id !== 'string' || !id || node.children?.length) fail();
          if (node.name === 'TextbookBoundary' && !['start', 'end'].includes(attribute('edge'))) fail();
          if (node.name !== 'ArgumentBlock') { try { if (!decodeURIComponent(id)) fail(); } catch { fail(); } }
        }
        if (!['code', 'math', 'inlineMath', 'footnoteDefinition'].includes(node.type)) node.children?.forEach(visit);
      };
      visit(mdastNode); actions.nextVisitor();
    },
  });
} });

// Upstream only preserves source for MarkdownParseError/unsupported syntax.
// A malformed application block otherwise throws a plain Error and can crash
// the editor. Wrap visitor errors, never alter or discard the original block.
const recoverableImportPlugin = realmPlugin({ init(realm) {
  realm.pub(importVisitors$, realm.getValue(importVisitors$).map(visitor => ({ ...visitor,
    visitNode(params) {
      try { visitor.visitNode(params); }
      catch (error) {
        if (error instanceof mdxRuntime.MarkdownParseError) throw error;
        throw new mdxRuntime.MarkdownParseError('笔记结构导入失败，原文已保留', params.mdastNode.position?.start);
      }
    },
  })));
} });

/** One content schema for the visible editor AND the headless publication check.
 * Toolbar, source view and shortcuts have no import nodes and stay in the UI. */
export function mdxNoteContentPlugins(options: {
  mathRecovery?: GeneratedMathScope;
  citationIds?: readonly string[];
  /** UI-only live import options; the headless publication schema stays static. */
  liveImportOptions?: () => { scope: GeneratedMathScope; textbook: boolean; citationIds?: readonly string[] };
  source?: () => string;
  image?: Parameters<typeof imagePlugin>[0];
  wiki?: Parameters<typeof wikiLinkPlugin>[0];
  argument?: Parameters<typeof argumentBlockPlugin>[0];
  review?: Parameters<typeof learningReviewBlockPlugin>[0];
  textbook?: Parameters<typeof textbookEditorContextPlugin>[0];
} = {}) {
  return [headingsPlugin(), listsPlugin(), quotePlugin(), thematicBreakPlugin(),
    codeBlockPlugin({ codeBlockEditorDescriptors: [textbookCodeEditorDescriptor, recoverableCodeEditorDescriptor] }),
    codeMirrorPlugin(), linkPlugin(), linkDialogPlugin(), tablePlugin(), imagePlugin(options.image),
    wikiLinkPlugin(options.wiki), mathPlugin({}), generatedMathPlugin({ scope: options.mathRecovery || 'knowledge-section', citationIds: options.citationIds, source: options.source, textbook: Boolean(options.textbook?.manifest), live: options.liveImportOptions }), textbookFootnotePlugin(), textbookEditorContextPlugin(options.textbook),
    argumentBlockPlugin(options.argument), learningReviewBlockPlugin(options.review), textbookBoundaryPlugin(), compatibleTreePlugin(), recoverableImportPlugin()];
}
