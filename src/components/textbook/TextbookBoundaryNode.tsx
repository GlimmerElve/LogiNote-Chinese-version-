import React from 'react';
import { DecoratorNode, type NodeKey, type SerializedLexicalNode } from 'lexical';
import { realmPlugin, addLexicalNode$, addExportVisitor$, addImportVisitor$, addToMarkdownExtension$ } from '@mdxeditor/editor';
import { textbookRegionMarkers } from '../../services/textbook/noteContent';

interface SerializedBoundary extends SerializedLexicalNode { regionId: string; edge: 'start' | 'end' }
/** 将来源边界保存在编辑器往返中，不能依赖可能被 Markdown 规范化丢弃的注释。 */
class TextbookBoundaryNode extends DecoratorNode<React.ReactNode> {
  __regionId: string;
  __edge: 'start' | 'end';
  static getType() { return 'textbookBoundary'; }
  static clone(node: TextbookBoundaryNode) { return new TextbookBoundaryNode(node.__regionId, node.__edge, node.__key); }
  static importJSON(node: SerializedBoundary & Record<string, unknown>) { return new TextbookBoundaryNode(node.regionId, node.edge); }
  constructor(regionId: string, edge: 'start' | 'end', key?: NodeKey) { super(key); this.__regionId = regionId; this.__edge = edge; }
  exportJSON(): SerializedBoundary { return { type: 'textbookBoundary', version: 1, regionId: this.__regionId, edge: this.__edge }; }
  createDOM() {
    const element = document.createElement('div');
    element.dataset.textbookBoundary = this.__edge;
    return element;
  }
  updateDOM() { return false; }
  isInline() { return false; }
  decorate() { return <div contentEditable={false} style={{ fontSize: 10, opacity: .65, margin: '8px 0' }}>
    {this.__edge === 'start' ? '教材正文 · 参考资料' : '教材正文结束'}
  </div>; }
}

export const textbookBoundaryPlugin = realmPlugin({ init(realm) {
  realm.pubIn({
    [addLexicalNode$]: TextbookBoundaryNode,
    [addImportVisitor$]: { priority: 0,
      testNode: (node: any) => ['mdxJsxFlowElement', 'mdxJsxTextElement'].includes(node?.type) && node?.name === 'TextbookBoundary',
      visitNode({ lexicalParent, mdastNode }: any) {
        const value = (name: string) => mdastNode.attributes?.find((item: any) => item.type === 'mdxJsxAttribute' && item.name === name)?.value;
        const id = value('id'), edge = value('edge');
        if (typeof id !== 'string' || !['start', 'end'].includes(edge)) throw new Error('教材边界标记无效');
        lexicalParent.append(new TextbookBoundaryNode(decodeURIComponent(id), edge));
      } },
    [addExportVisitor$]: { testLexicalNode: (node: unknown) => node instanceof TextbookBoundaryNode,
      visitLexicalNode: ({ lexicalNode, actions }: any) => actions.addAndStepInto('textbookBoundary', { regionId: lexicalNode.__regionId, edge: lexicalNode.__edge }) },
    [addToMarkdownExtension$]: { handlers: { textbookBoundary(node: any) {
      return textbookRegionMarkers(node.regionId)[node.edge === 'start' ? 0 : 1];
    } } } as any,
  });
} });
