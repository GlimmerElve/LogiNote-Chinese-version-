import React from "react";
import {
  TextNode,
  DecoratorNode,
  NodeKey,
  SerializedLexicalNode,
  LexicalEditor,
} from "lexical";
import {
  realmPlugin,
  addLexicalNode$,
  addExportVisitor$,
  addToMarkdownExtension$,
  createRootEditorSubscription$,
} from "@mdxeditor/editor";

/**
 * LogiNote 双链 `[[标题]]` 自定义 Lexical 节点。
 *
 * - 渲染：可点击高亮 span（decorate 返回 React 组件）。
 * - 导出：通过自定义 mdast handler 原样输出 `[[标题]]`，避免 `[` 被转义，
 *   从而保证 `parseNoteMetadata` 的 linkRegex、反向链接、知识图谱零断裂。
 * - 导入：`[[...]]` 本身就是纯文本，mdast 解析为 text 节点，由
 *   `registerNodeTransform(TextNode, ...)` 实时拆分为 `TextNode + WikiLinkNode + TextNode`。
 */

export interface SerializedWikiLinkNode extends SerializedLexicalNode {
  title: string;
}

/**
 * 模块级可变点击处理器（decorate 渲染的组件不在 Gurx realm context 内，
 * 不能用 useCellValue，改用全局变量保存最新回调）。
 */
let wikiLinkClickHandler: (title: string) => void = () => {};

function WikiLinkComponent({ title }: { title: string }) {
  return (
    <span
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        wikiLinkClickHandler(title);
      }}
      title={`点击跳转至关联笔记: ${title}`}
      className="inline text-indigo-600 dark:text-indigo-400 font-semibold underline decoration-indigo-400/80 underline-offset-2 cursor-pointer hover:text-indigo-700 dark:hover:text-indigo-300 select-none transition"
    >
      {title}
    </span>
  );
}

export class WikiLinkNode extends DecoratorNode<React.ReactNode> {
  __title: string;

  static getType(): string {
    return "wikilink";
  }

  static clone(node: WikiLinkNode): WikiLinkNode {
    return new WikiLinkNode(node.__title, node.__key);
  }

  static importJSON(serializedNode: SerializedWikiLinkNode & Record<string, unknown>): WikiLinkNode {
    return $createWikiLinkNode(serializedNode.title);
  }

  constructor(title: string, key?: NodeKey) {
    super(key);
    this.__title = title;
  }

  exportJSON(): SerializedWikiLinkNode {
    return { type: "wikilink", title: this.__title, version: 1 };
  }

  createDOM(): HTMLElement {
    return document.createElement("span");
  }

  updateDOM(): false {
    return false;
  }

  isInline(): boolean {
    return true;
  }

  decorate(): React.ReactNode {
    return <WikiLinkComponent title={this.__title} />;
  }
}

export function $createWikiLinkNode(title: string, key?: NodeKey): WikiLinkNode {
  return new WikiLinkNode(title, key);
}

export function $isWikiLinkNode(node: unknown): node is WikiLinkNode {
  return node instanceof WikiLinkNode;
}

/**
 * 把含 `[[标题]]` 的 TextNode 拆分为 `TextNode + WikiLinkNode + TextNode`。
 * 每次只处理第一个匹配，拆分后产生的新 TextNode 会再次触发 transform 继续处理。
 */
function transformTextNode(node: TextNode): void {
  if (!node.isAttached()) return;
  const text = node.getTextContent();
  if (!text.includes("[[")) return;
  const match = /\[\[([^\]]+)\]\]/.exec(text);
  if (!match) return;
  const title = match[1];
  const start = match.index;
  const end = match.index + match[0].length;

  let targetNode: TextNode;
  if (start === 0) {
    if (end === text.length) {
      targetNode = node; // 节点整体就是 [[标题]]
    } else {
      targetNode = node.splitText(end)[0];
    }
  } else {
    const [, right] = node.splitText(start);
    if (right.getTextContent().length === end - start) {
      targetNode = right; // [[标题]] 后无尾随文本
    } else {
      targetNode = right.splitText(end - start)[0];
    }
  }
  targetNode.replace($createWikiLinkNode(title));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const WikiLinkExportVisitor = {
  testLexicalNode: $isWikiLinkNode,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  visitLexicalNode: ({ lexicalNode, actions }: any) => {
    // 导出为自定义 mdast 节点 'wikilink'，配合下方 handler 原样输出 [[标题]]
    actions.addAndStepInto("wikilink", { value: (lexicalNode as WikiLinkNode).__title });
  },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const wikiLinkMarkdownExtension: any = {
  handlers: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    wikilink(node: any) {
      return `[[${node.value}]]`;
    },
  },
};

export const wikiLinkPlugin = realmPlugin<{ onClick?: (title: string) => void }>({
  init(realm) {
    realm.pubIn({
      [addLexicalNode$]: WikiLinkNode,
      [addExportVisitor$]: WikiLinkExportVisitor,
      [addToMarkdownExtension$]: wikiLinkMarkdownExtension,
    });
    realm.pub(createRootEditorSubscription$, (editor: LexicalEditor) => {
      return editor.registerNodeTransform(TextNode, transformTextNode);
    });
  },
  update(_realm, params) {
    wikiLinkClickHandler = params?.onClick ?? (() => {});
  },
});