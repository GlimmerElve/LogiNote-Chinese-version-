import React, { useRef, useState } from 'react';
import { $getNodeByKey, TextNode, DecoratorNode, type NodeKey, type SerializedLexicalNode, type LexicalEditor } from 'lexical';
import {
  realmPlugin, addLexicalNode$, addImportVisitor$, addExportVisitor$,
  addSyntaxExtension$, addMdastExtension$, addToMarkdownExtension$,
  createRootEditorSubscription$,
  type MdastImportVisitor, type LexicalExportVisitor,
} from '@mdxeditor/editor';
import type { Math, InlineMath } from 'mdast-util-math';
import { math } from 'micromark-extension-math';
import { mathFromMarkdown, mathToMarkdown } from 'mdast-util-math';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { MathField } from '../modules/derivationCanvas/components/MathField';
import { FormulaBlock } from './textbook/FormulaBlock';
import { useEditorInputLeave } from './useEditorInputLeave';

export interface SerializedMathNode extends SerializedLexicalNode {
  tex: string;
  displayMode: boolean;
}

export function $createMathNode(tex: string, displayMode: boolean, key?: NodeKey): MathNode {
  return new MathNode(tex, displayMode, key);
}

export function $isMathNode(node: unknown): node is MathNode { return node instanceof MathNode; }

/** Keep the existing toolbar's single-line $$ template as a display block. */
export function editorMathFromMarkdown() {
  const extension = mathFromMarkdown();
  const displayTemplates = new WeakSet<InlineMath>();
  const exitMathText = extension.exit!.mathText;
  extension.exit = { ...extension.exit, mathText(token) {
    // mathText uses a temporary buffer fragment above the actual inlineMath node.
    const node = [...this.stack].reverse().find((item) => item.type === 'inlineMath');
    if (node?.type === 'inlineMath' && this.sliceSerialize(token).startsWith('$$')) {
      displayTemplates.add(node);
    }
    exitMathText.call(this, token);
  } };
  extension.transforms = [(tree) => {
    const visit = (node: any) => {
      if (!Array.isArray(node.children)) return;
      node.children = node.children.map((child: any) => {
        if (child.type === 'paragraph' && child.children.length === 1 &&
          child.children[0].type === 'inlineMath' && displayTemplates.has(child.children[0])) {
          return { type: 'math', value: child.children[0].value, position: child.position };
        }
        visit(child); return child;
      });
    };
    visit(tree); return tree;
  }];
  return extension;
}

/** Each decorator keeps its own editor. History can redecorate every node; an
 * unchanged formula must not reset its MathML/HTML or disturb native selection. */
function MathComponent({ tex, displayMode, nodeKey, editor }: {
  tex: string; displayMode: boolean; nodeKey: NodeKey; editor: LexicalEditor;
}) {
  const [editing, setEditing] = useState(false);
  const host = useRef<HTMLElement>(null), input = useRef({ editing: false, committing: false, draft: tex, tex }); input.current.tex = tex;
  const leave = useEditorInputLeave(() => (input.current.editing || input.current.committing) && input.current.draft !== input.current.tex
    ? '公式有未暂存的输入，请先按 Enter、点击“暂存”或“取消”，再离开。' : null, host, editing || input.current.committing);
  const begin = () => { input.current = { editing: true, committing: false, draft: tex, tex }; setEditing(true); leave.clearNotice(); };
  const finish = () => { input.current.editing = false; if (!input.current.committing) input.current.draft = tex; setEditing(false); leave.clearNotice(); };
  const commit = (value: string) => {
    input.current.draft = value; input.current.committing = value !== tex;
    editor.update(() => {
      const node = $getNodeByKey(nodeKey);
      if ($isMathNode(node)) node.replace($createMathNode(value, node.__displayMode));
      else input.current.committing = false;
    });
  };
  const Container = displayMode ? 'div' : 'span';
  return <Container ref={host as any} contentEditable={false}>
    {editing ? <MathField value={tex} editing onInputDraft={value => { input.current.draft = value; }} onDraftSave={commit} onCancel={finish} />
      : displayMode ? <div>
        <button type="button" className="min-h-11 rounded px-3 py-2 text-xs underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ln-accent)]"
          onClick={(event) => { event.preventDefault(); event.stopPropagation(); begin(); }}>
          {tex.trim() ? '编辑公式' : '输入公式'}
        </button>
        {tex.trim() ? <FormulaBlock latex={tex} displayMode /> : <em>公式 · 点击输入</em>}
      </div> : <span role="button" tabIndex={0} aria-label={tex ? '编辑公式' : '输入公式'}
        className="cursor-pointer rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ln-accent)]"
        onClick={(event) => { event.preventDefault(); event.stopPropagation(); begin(); }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault(); event.stopPropagation(); begin();
          }
        }}>
        {tex.trim() ? <FormulaBlock latex={tex} displayMode={displayMode} /> : <em>公式 · 点击编辑</em>}
      </span>}
    {leave.notice && <span role="status" className="block text-sm text-[var(--ln-text-secondary)]">{leave.notice}</span>}
  </Container>;
}
const StableMathComponent = React.memo(MathComponent);

export class MathNode extends DecoratorNode<React.ReactNode> {
  __tex: string;
  __displayMode: boolean;
  static getType() { return 'math'; }
  static clone(node: MathNode) { return new MathNode(node.__tex, node.__displayMode, node.__key); }
  static importJSON(node: SerializedMathNode & Record<string, unknown>) { return $createMathNode(node.tex, node.displayMode); }
  constructor(tex: string, displayMode: boolean, key?: NodeKey) { super(key); this.__tex = tex; this.__displayMode = displayMode; }
  exportJSON(): SerializedMathNode { return { type: 'math', tex: this.__tex, displayMode: this.__displayMode, version: 1 }; }
  createDOM() { return document.createElement(this.__displayMode ? 'div' : 'span'); }
  updateDOM() { return false; }
  isInline() { return !this.__displayMode; }
  getTextContent() { return this.__tex; }
  decorate(editor: LexicalEditor) {
    return <StableMathComponent tex={this.__tex} displayMode={this.__displayMode} nodeKey={this.__key} editor={editor} />;
  }
}

/** Parse math before text transforms so multiline, escapes and code follow Markdown semantics. */
export const mathImportVisitor: MdastImportVisitor<Math | InlineMath> = {
  testNode: (node) => node.type === 'math' || node.type === 'inlineMath',
  visitNode({ mdastNode, actions }) { actions.addAndStepInto($createMathNode(mdastNode.value, mdastNode.type === 'math')); },
};

export const mathExportVisitor: LexicalExportVisitor<MathNode, Math | InlineMath> = {
  testLexicalNode: $isMathNode,
  visitLexicalNode({ lexicalNode, actions }) {
    actions.addAndStepInto(lexicalNode.__displayMode ? 'math' : 'inlineMath', { value: lexicalNode.__tex }, false);
  },
};

/** Only a newly typed closing dollar triggers a transform; imported escaped dollars stay text. */
function registerTypedMath(editor: LexicalEditor) {
  const observed = new Map<NodeKey, string>();
  const unregister = editor.registerNodeTransform(TextNode, (node) => {
    if (!node.isAttached()) return;
    const text = node.getTextContent(), previous = observed.get(node.getKey());
    observed.set(node.getKey(), text);
    if (previous === undefined || previous === text || node.hasFormat('code')) return;
    let prefix = 0, suffix = 0;
    while (prefix < Math.min(previous.length, text.length) && previous[prefix] === text[prefix]) prefix++;
    while (suffix < previous.length - prefix && suffix < text.length - prefix &&
      previous[previous.length - suffix - 1] === text[text.length - suffix - 1]) suffix++;
    const changedEnd = text.length - suffix;
    if (changedEnd <= prefix || text[changedEnd - 1] !== '$') return;
    const parsed = fromMarkdown(text, { extensions: [math()], mdastExtensions: [editorMathFromMarkdown()] });
    const block = parsed.children[0];
    if (block?.type === 'math' && parsed.children.length === 1 && node.getParent()?.getChildrenSize() === 1) {
      node.getParent()!.replace($createMathNode(block.value, true)); return;
    }
    if (block?.type !== 'paragraph') return;
    const formula = block.children.find((child) => child.type === 'inlineMath' && child.position?.end.offset === changedEnd);
    if (formula?.type !== 'inlineMath' || formula.position?.start.offset === undefined) return;
    const start = formula.position.start.offset, end = formula.position.end.offset!;
    const pieces = node.splitText(...[start, end].filter((offset) => offset > 0 && offset < text.length));
    const target = pieces[start === 0 ? 0 : 1];
    target?.replace($createMathNode(formula.value, false));
  });
  return () => { unregister(); observed.clear(); };
}

export const mathPlugin = realmPlugin({ init(realm) {
  realm.pubIn({
    [addLexicalNode$]: MathNode,
    [addImportVisitor$]: mathImportVisitor,
    [addExportVisitor$]: mathExportVisitor,
    [addSyntaxExtension$]: math(),
    [addMdastExtension$]: editorMathFromMarkdown(),
    [addToMarkdownExtension$]: mathToMarkdown(),
  });
  realm.pub(createRootEditorSubscription$, registerTypedMath);
} });
