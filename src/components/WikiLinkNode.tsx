import React from "react";
import { parseWikiLink } from '../services/noteResolver';
import { MDX_IMPORT_TAG } from './mdxRuntime';
import { Cell, useCellValue } from '@mdxeditor/gurx';
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

// Cells belong to each editor's realm: retained source and reference editors must not
// overwrite one another's callbacks. React decorator portals inherit this context.
const wikiLinkHandlers$ = Cell<{ onClick?: (title: string) => void }>({});

function WikiLinkComponent({ title }: { title: string }) {
  const { onClick } = useCellValue(wikiLinkHandlers$);
  return (
    <span
      role="link"
      tabIndex={0}
      onMouseDownCapture={(e) => {
        if (e.button !== 0) return;
        // Do not let Lexical move the caret/recreate the decorator between down and click.
        e.preventDefault();
        e.stopPropagation();
      }}
      onClickCapture={(e) => {
        e.preventDefault();
        e.stopPropagation();
        e.currentTarget.focus({ preventScroll: true });
        onClick?.(title);
      }}
      onKeyDownCapture={(e) => {
        if (e.defaultPrevented || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229 || e.altKey || e.ctrlKey || e.metaKey) return;
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        e.stopPropagation();
        onClick?.(title);
      }}
      title={`预览关联笔记：${title}`}
      data-wiki-target={title}
      className="wiki-link-node inline font-semibold underline underline-offset-2 cursor-pointer select-none transition"
    >
      {parseWikiLink(title).label || title}
    </span>
  );
}
const StableWikiLinkComponent = React.memo(WikiLinkComponent);

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
    return <StableWikiLinkComponent title={this.__title} />;
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
  init(realm, params) {
    realm.pub(wikiLinkHandlers$, params || {});
    realm.pubIn({
      [addLexicalNode$]: WikiLinkNode,
      [addExportVisitor$]: WikiLinkExportVisitor,
      [addToMarkdownExtension$]: wikiLinkMarkdownExtension,
    });
    realm.pub(createRootEditorSubscription$, (editor: LexicalEditor) => {
      // Registering a transform normalizes already-imported text in a second
      // Lexical update. Keep that pass part of import, not a user edit/save.
      let unregister = () => {};
      editor.update(() => { unregister = editor.registerNodeTransform(TextNode, transformTextNode); }, { tag: MDX_IMPORT_TAG, discrete: true });
      return () => unregister();
    });
  },
  update(realm, params) {
    realm.pub(wikiLinkHandlers$, params || {});
  },
});
