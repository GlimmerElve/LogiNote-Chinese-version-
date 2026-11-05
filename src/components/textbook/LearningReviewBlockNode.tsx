import React from 'react';
import { Cell, useCellValue } from '@mdxeditor/gurx';
import { DecoratorNode, type NodeKey, type SerializedLexicalNode } from 'lexical';
import { realmPlugin, addLexicalNode$, addExportVisitor$, addImportVisitor$, addToMarkdownExtension$ } from '@mdxeditor/editor';
import type { LearningReviewPatch, LearningReviewRecord } from '../../services/textbook/types';
import { learningReviewMarker } from '../../services/textbook/noteContent';
import { ArgumentBlockComponent } from '../ArgumentBlockNode';
import { LearningReviewBlock } from './LearningReviewBlock';

interface Handlers {
  getRecord?: (id: string) => LearningReviewRecord | undefined;
  onPatch?: (id: string, patch: LearningReviewPatch) => void | Promise<void>;
}
const handlers$ = Cell<Handlers>({});
function RecordComponent({ id }: { id: string }) {
  const handlers = useCellValue(handlers$);
  const record = handlers.getRecord?.(id);
  if (!record) return <div contentEditable={false} className="learning-review-block" role="status">
    学习记录保存在个人状态中，当前未载入；原记录引用已保留。
  </div>;
  return <LearningReviewBlock record={record} onPatch={handlers.onPatch ? (patch) => handlers.onPatch!(id, patch) : undefined}>
    {record.argumentDocIds.map((docId) => <ArgumentBlockComponent key={docId} docId={docId} />)}
  </LearningReviewBlock>;
}

interface SerializedRecord extends SerializedLexicalNode { recordId: string }
export class LearningReviewBlockNode extends DecoratorNode<React.ReactNode> {
  __recordId: string;
  static getType() { return 'learningReviewBlock'; }
  static clone(node: LearningReviewBlockNode) { return new LearningReviewBlockNode(node.__recordId, node.__key); }
  static importJSON(node: SerializedRecord & Record<string, unknown>) { return new LearningReviewBlockNode(node.recordId); }
  constructor(id: string, key?: NodeKey) { super(key); this.__recordId = id; }
  exportJSON(): SerializedRecord { return { type: 'learningReviewBlock', version: 1, recordId: this.__recordId }; }
  createDOM() { const element = document.createElement('div'); return element; }
  updateDOM() { return false; }
  isInline() { return false; }
  decorate() { return <RecordComponent id={this.__recordId} />; }
}

export const learningReviewImportVisitor = {
  testNode: (node: any) => ['mdxJsxFlowElement', 'mdxJsxTextElement'].includes(node?.type) && node?.name === 'LearningReviewBlock',
  visitNode({ lexicalParent, mdastNode }: any) {
    const attribute = mdastNode.attributes?.find((item: any) => item.type === 'mdxJsxAttribute' && item.name === 'id');
    if (typeof attribute?.value !== 'string') throw new Error('学习记录缺少稳定 ID');
    const id = decodeURIComponent(attribute.value);
    if (!id) throw new Error('学习记录 ID 为空');
    lexicalParent.append(new LearningReviewBlockNode(id));
  },
  priority: 0,
};
export const learningReviewMarkdownExtension: any = { handlers: {
  learningReviewBlock(node: any) { return learningReviewMarker(node.recordId); },
} };
export const learningReviewBlockPlugin = realmPlugin<Handlers>({
  init(realm, params) {
    realm.pub(handlers$, params || {});
    realm.pubIn({
      [addLexicalNode$]: LearningReviewBlockNode,
      [addImportVisitor$]: learningReviewImportVisitor,
      [addExportVisitor$]: { testLexicalNode: (node: unknown) => node instanceof LearningReviewBlockNode,
        visitLexicalNode: ({ lexicalNode, actions }: any) => actions.addAndStepInto('learningReviewBlock', { recordId: lexicalNode.__recordId }) },
      [addToMarkdownExtension$]: learningReviewMarkdownExtension,
    });
  },
  update(realm, params) { realm.pub(handlers$, params || {}); },
});
