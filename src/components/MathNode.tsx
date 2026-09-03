import React, { useState } from "react";
import katex from "katex";
import {
  $getNodeByKey,
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
 * LogiNote 数学公式自定义 Lexical 节点（基于 KaTeX）。
 *
 * - 行内公式 `$...$`：inline 渲染（displayMode=false）。
 * - 块级公式 `$$...$$`：KaTeX displayMode=true 渲染，视觉居中大号。
 * - 点击公式进入内联编辑（input），回车/失焦提交，Esc 取消。
 * - 导出：自定义 mdast handler 原样输出 `$...$` / `$$...$$`，保证 markdown 零断裂。
 * - 导入：`$...$` 本身是纯文本，mdast 解析为 text，由
 *   `registerNodeTransform(TextNode, ...)` 实时拆分为 `TextNode + MathNode + TextNode`。
 */

export interface SerializedMathNode extends SerializedLexicalNode {
  tex: string;
  displayMode: boolean;
}

export function $createMathNode(tex: string, displayMode: boolean, key?: NodeKey): MathNode {
  return new MathNode(tex, displayMode, key);
}

export function $isMathNode(node: unknown): node is MathNode {
  return node instanceof MathNode;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&").replace(/</g, "<").replace(/>/g, ">");
}

/** 模块级 editor 引用（decorate 渲染的组件不在 Gurx realm context 内，改用全局变量） */
let mathEditorRef: LexicalEditor | null = null;

function MathComponent({
  tex,
  displayMode,
  nodeKey,
}: {
  tex: string;
  displayMode: boolean;
  nodeKey: NodeKey;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(tex);

  if (editing) {
    return (
      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commitEdit(nodeKey, draft);
            setEditing(false);
          } else if (e.key === "Escape") {
            setDraft(tex);
            setEditing(false);
          }
        }}
        onBlur={() => {
          commitEdit(nodeKey, draft);
          setEditing(false);
        }}
        placeholder="LaTeX，如 E=mc^2"
        style={{
          fontFamily: "monospace",
          fontSize: "0.9em",
          padding: "2px 8px",
          border: "1px solid #93c5fd",
          borderRadius: "5px",
          background: "transparent",
          color: "inherit",
          outline: "none",
          minWidth: "120px",
        }}
      />
    );
  }

  const isBlank = !tex.trim();
  let html: string;
  if (isBlank) {
    // 空模板：显示可见占位，提示点击编辑
    html = `<span style="opacity:.45;font-style:italic;font-family:monospace">公式</span>`;
  } else {
    try {
      // throwOnError:false 时 KaTeX 会把解析错误渲染为红色标注，而非抛异常
      html = katex.renderToString(tex, { throwOnError: false, strict: false, displayMode });
    } catch {
      html = `<span style="color:#dc2626">$${escapeHtml(tex)}$</span>`;
    }
  }

  return (
    <span
      contentEditable={false}
      title="点击编辑公式"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setDraft(tex);
        setEditing(true);
      }}
      style={
        displayMode
          ? { display: "block", textAlign: "center", margin: "0.5em 0" }
          : { display: "inline" }
      }
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

/** 通过 editor.update 替换节点为新的 MathNode，正确触发重渲染与撤销栈 */
function commitEdit(nodeKey: NodeKey, newTex: string): void {
  const editor = mathEditorRef;
  if (!editor) return;
  const trimmed = newTex.trim();
  try {
    editor.update(() => {
      const node = $getNodeByKey(nodeKey);
      if (node instanceof MathNode) {
        node.replace($createMathNode(trimmed, node.__displayMode));
      }
    });
  } catch {
    // 编辑器已销毁（例如切笔记瞬间），忽略
  }
}

export class MathNode extends DecoratorNode<React.ReactNode> {
  __tex: string;
  __displayMode: boolean;

  static getType(): string {
    return "math";
  }

  static clone(node: MathNode): MathNode {
    return new MathNode(node.__tex, node.__displayMode, node.__key);
  }

  static importJSON(serializedNode: SerializedMathNode & Record<string, unknown>): MathNode {
    return $createMathNode(serializedNode.tex, serializedNode.displayMode);
  }

  constructor(tex: string, displayMode: boolean, key?: NodeKey) {
    super(key);
    this.__tex = tex;
    this.__displayMode = displayMode;
  }

  exportJSON(): SerializedMathNode {
    return { type: "math", tex: this.__tex, displayMode: this.__displayMode, version: 1 };
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
    return <MathComponent tex={this.__tex} displayMode={this.__displayMode} nodeKey={this.__key} />;
  }
}

/**
 * 把含 `$...$` / `$$...$$` 的 TextNode 拆分为 `TextNode + MathNode + TextNode`。
 * 每次只处理第一个匹配，拆分后产生的新 TextNode 会再次触发 transform 继续处理。
 */
function splitMath(
  node: TextNode,
  text: string,
  start: number,
  length: number,
  tex: string,
  displayMode: boolean
): void {
  const end = start + length;
  let targetNode: TextNode;
  if (start === 0) {
    if (end === text.length) {
      targetNode = node; // 节点整体就是公式
    } else {
      targetNode = node.splitText(end)[0];
    }
  } else {
    const [, right] = node.splitText(start);
    if (right.getTextContent().length === end - start) {
      targetNode = right; // 公式后无尾随文本
    } else {
      targetNode = right.splitText(end - start)[0];
    }
  }
  targetNode.replace($createMathNode(tex, displayMode));
}

function transformTextNode(node: TextNode): void {
  if (!node.isAttached()) return;
  const text = node.getTextContent();
  // 块级 $$...$$ 优先（同一行文本内，不含 `$` 与换行）
  const block = /\$\$([^$\n]+)\$\$/.exec(text);
  if (block) {
    splitMath(node, text, block.index, block[0].length, block[1], true);
    return;
  }
  const inline = /\$([^$\n]+)\$/.exec(text);
  if (inline) {
    splitMath(node, text, inline.index, inline[0].length, inline[1], false);
    return;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const MathExportVisitor = {
  testLexicalNode: $isMathNode,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  visitLexicalNode: ({ lexicalNode, actions }: any) => {
    const mathNode = lexicalNode as MathNode;
    actions.addAndStepInto(mathNode.__displayMode ? "blockMath" : "inlineMath", {
      value: mathNode.__tex,
    });
  },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mathMarkdownExtension: any = {
  handlers: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    inlineMath(node: any) {
      return `$${node.value}$`;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    blockMath(node: any) {
      return `$$${node.value}$$`;
    },
  },
};

export const mathPlugin = realmPlugin<{}>({
  init(realm) {
    realm.pubIn({
      [addLexicalNode$]: MathNode,
      [addExportVisitor$]: MathExportVisitor,
      [addToMarkdownExtension$]: mathMarkdownExtension,
    });
    realm.pub(createRootEditorSubscription$, (editor: LexicalEditor) => {
      mathEditorRef = editor;
      return editor.registerNodeTransform(TextNode, transformTextNode);
    });
  },
});