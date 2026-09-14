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

/** 模块级处理器（decorate 渲染的组件不在 Gurx realm context 内，用全局变量） */
let argumentBlockClickHandler: (docId: string) => void = () => {};
let argumentBlockDeleteHandler: (docId: string) => void = () => {};
let argumentBlockGetDocHandler: (docId: string) => ArgDoc | undefined = () => undefined;

function ArgumentBlockComponent({ docId }: { docId: string }) {
  const doc = argumentBlockGetDocHandler(docId);

  return (
    <div className="group relative my-3 rounded-xl border-2 border-indigo-200 dark:border-indigo-700 bg-indigo-50/60 dark:bg-indigo-950/30 overflow-hidden">
      {doc ? (
        <ArgumentDocEmbed doc={doc} />
      ) : (
        <div
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            argumentBlockClickHandler(docId);
          }}
          title="点击进入论证结构编辑器"
          className="cursor-pointer p-4 flex items-center gap-3"
        >
          <Bot className="w-5 h-5 text-indigo-600 dark:text-indigo-400 shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold text-indigo-700 dark:text-indigo-300">论证结构图</div>
            <div className="text-[11px] text-slate-500 dark:text-slate-400 truncate">点击打开并编辑</div>
          </div>
        </div>
      )}

      {/* 右上角：编辑 + 删除 */}
      <div className="absolute top-2 right-2 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition">
        <button
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            argumentBlockClickHandler(docId);
          }}
          title="编辑此结构图"
          className="p-1.5 rounded-md bg-white/90 dark:bg-slate-800/90 text-indigo-500 hover:text-indigo-700 hover:bg-indigo-50 dark:hover:bg-indigo-950/50 border border-indigo-200 dark:border-indigo-700 shadow-sm transition"
        >
          <Edit3 className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            argumentBlockDeleteHandler(docId);
          }}
          title="删除此结构图"
          className="p-1.5 rounded-md bg-white/90 dark:bg-slate-800/90 text-slate-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950/40 border border-slate-200 dark:border-slate-700 shadow-sm transition"
        >
          <X className="w-3.5 h-3.5" />
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

export const argumentBlockPlugin = realmPlugin<{
  onClick?: (docId: string) => void;
  onDelete?: (docId: string) => void;
  getDoc?: (docId: string) => ArgDoc | undefined;
}>({
  init(realm) {
    realm.pubIn({
      [addLexicalNode$]: ArgumentBlockNode,
      [addImportVisitor$]: ArgumentBlockImportVisitor,
      [addExportVisitor$]: ArgumentBlockExportVisitor,
      [addToMarkdownExtension$]: argumentBlockMarkdownExtension,
    });
  },
  update(_realm, params) {
    argumentBlockClickHandler = params?.onClick ?? (() => {});
    argumentBlockDeleteHandler = params?.onDelete ?? (() => {});
    argumentBlockGetDocHandler = params?.getDoc ?? (() => undefined);
  },
});