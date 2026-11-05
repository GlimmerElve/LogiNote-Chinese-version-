/**
 * 正文中的论证结构图块 `<ArgumentBlock id="doc_xxx" />` 自定义 Lexical 节点。
 *
 * - 导入：mdast 解析 `<ArgumentBlock id="..."/>` 得到 mdxJsxFlowElement，
 *   由 ArgumentBlockImportVisitor 认领并转为本节点（否则 MDXEditor 报 Parsing failed）。
 * - 渲染：优先用 getDoc(docId) 取 ArgDoc，内嵌只读可缩放结构图（ArgumentDocEmbed）；
 *   拿不到数据则回退为占位卡片。右上角提供「编辑」「删除」两个按钮。
 * - 导出：原样输出 `<ArgumentBlock id="..."/>`，保证 markdown 零断裂、可分享。
 */

import React from 'react';
import { Cell, useCellValue } from '@mdxeditor/gurx';
import {
  DecoratorNode,
  NodeKey,
  SerializedLexicalNode,
} from 'lexical';
import {
  realmPlugin,
  addLexicalNode$,
  addExportVisitor$,
  addImportVisitor$,
  addToMarkdownExtension$,
} from '@mdxeditor/editor';
import { Bot, X, Edit3 } from 'lucide-react';
import type { ArgDoc } from '../services/argumentDoc/types';
import { ArgumentDocEmbed } from '../modules/argumentCanvas/components/ArgumentDocEmbed';

export interface SerializedArgumentBlockNode extends SerializedLexicalNode {
  docId: string;
}

interface ArgumentBlockHandlers {
  onClick?: (docId: string) => void;
  onDelete?: (docId: string) => void;
  getDoc?: (docId: string) => ArgDoc | undefined;
}
const argumentBlockHandlers$ = Cell<ArgumentBlockHandlers>({});

export function ArgumentBlockComponent({ docId }: { docId: string }) {
  const handlers = useCellValue(argumentBlockHandlers$);
  const doc = handlers.getDoc?.(docId);

  return (
    <div className="argument-block-card group">
      {doc ? (
        <ArgumentDocEmbed doc={doc} />
      ) : (
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            handlers.onClick?.(docId);
          }}
          title="点击进入论证结构编辑器"
          aria-label="打开论证结构图进行编辑"
          className="argument-block-placeholder"
        >
          <Bot aria-hidden="true" />
          <div>
            <strong>论证结构图</strong>
            <span>打开并继续编辑</span>
          </div>
        </button>
      )}

      {/* 右上角：编辑 + 删除 */}
      <div className="argument-block-actions">
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            handlers.onClick?.(docId);
          }}
          aria-label="编辑此论证结构图"
          title="编辑此结构图"
          className="argument-block-action"
        >
          <Edit3 aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            handlers.onDelete?.(docId);
          }}
          aria-label="删除此论证结构图"
          title="删除此结构图"
          className="argument-block-action is-danger"
        >
          <X aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

export class ArgumentBlockNode extends DecoratorNode<React.ReactNode> {
  __docId: string;

  static getType(): string {
    return 'argumentBlock';
  }

  static clone(node: ArgumentBlockNode): ArgumentBlockNode {
    return new ArgumentBlockNode(node.__docId, node.__key);
  }

  static importJSON(serializedNode: SerializedArgumentBlockNode & Record<string, unknown>): ArgumentBlockNode {
    return $createArgumentBlockNode(serializedNode.docId);
  }

  constructor(docId: string, key?: NodeKey) {
    super(key);
    this.__docId = docId;
  }

  exportJSON(): SerializedArgumentBlockNode {
    return { type: 'argumentBlock', docId: this.__docId, version: 1 };
  }

  createDOM(): HTMLElement {
    const el = document.createElement('span');
    el.style.display = 'block';
    return el;
  }

  updateDOM(): false {
    return false;
  }

  isInline(): boolean {
    return false;
  }

  decorate(): React.ReactNode {
    return <ArgumentBlockComponent docId={this.__docId} />;
  }
}

export function $createArgumentBlockNode(docId: string, key?: NodeKey): ArgumentBlockNode {
  return new ArgumentBlockNode(docId, key);
}

export function $isArgumentBlockNode(node: unknown): node is ArgumentBlockNode {
  return node instanceof ArgumentBlockNode;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ArgumentBlockExportVisitor = {
  testLexicalNode: $isArgumentBlockNode,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  visitLexicalNode: ({ lexicalNode, actions }: any) => {
    actions.addAndStepInto('argumentBlock', { docId: (lexicalNode as ArgumentBlockNode).__docId });
  },
};

/**
 * 导入：认领 mdast 的 `<ArgumentBlock id="..."/>`（mdxJsxFlowElement），转为本节点。
 * core 的 jsx 语法扩展会把该标记解析为 JSX 节点，若无认领则报 Parsing failed。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ArgumentBlockImportVisitor = {
  testNode: (node: any) => {
    return (
      (node?.type === 'mdxJsxFlowElement' || node?.type === 'mdxJsxTextElement') &&
      node?.name === 'ArgumentBlock'
    );
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  visitNode({ lexicalParent, mdastNode }: any) {
    const attrs = Array.isArray(mdastNode?.attributes) ? mdastNode.attributes : [];
    const idAttr = attrs.find(
      (a: any) => a && a.type === 'mdxJsxAttribute' && a.name === 'id',
    );
    const docId = idAttr && typeof idAttr.value === 'string' ? idAttr.value : '';
    if (docId) {
      lexicalParent.append($createArgumentBlockNode(docId));
    }
  },
  // 高于 jsxPlugin 内置 visitor（priority -200），确保本块被优先认领
  priority: 0,
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const argumentBlockMarkdownExtension: any = {
  handlers: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    argumentBlock(node: any) {
      return `<ArgumentBlock id="${node.docId}" />`;
    },
  },
};

export const argumentBlockPlugin = realmPlugin<ArgumentBlockHandlers>({
  init(realm, params) {
    realm.pub(argumentBlockHandlers$, params || {});
    realm.pubIn({
      [addLexicalNode$]: ArgumentBlockNode,
      [addImportVisitor$]: ArgumentBlockImportVisitor,
      [addExportVisitor$]: ArgumentBlockExportVisitor,
      [addToMarkdownExtension$]: argumentBlockMarkdownExtension,
    });
  },
  update(realm, params) {
    realm.pub(argumentBlockHandlers$, params || {});
  },
});
