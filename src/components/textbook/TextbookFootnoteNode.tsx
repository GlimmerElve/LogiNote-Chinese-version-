import React, { useState } from 'react';
import { $getNodeByKey, $isElementNode, DecoratorNode, type LexicalEditor, type NodeKey, type SerializedLexicalNode } from 'lexical';
import {
  realmPlugin, addLexicalNode$, addImportVisitor$, addExportVisitor$,
  addSyntaxExtension$, addMdastExtension$, addToMarkdownExtension$,
  type MdastImportVisitor, type LexicalExportVisitor,
} from '@mdxeditor/editor';
import type { FootnoteDefinition, FootnoteReference } from 'mdast';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { toMarkdown } from 'mdast-util-to-markdown';
import { gfm } from 'micromark-extension-gfm';
import { gfmFromMarkdown, gfmToMarkdown } from 'mdast-util-gfm';
import { math } from 'micromark-extension-math';
import { mathFromMarkdown, mathToMarkdown } from 'mdast-util-math';

type FootnoteAst = FootnoteDefinition | FootnoteReference;
interface SerializedFootnoteNode extends SerializedLexicalNode { ast: FootnoteAst }

export function footnoteSource(ast: FootnoteAst): string {
  return toMarkdown(ast, { extensions: [gfmToMarkdown(), mathToMarkdown()] }).trimEnd();
}

/** A footnote remains a real GFM node; its rich children are kept rather than flattened. */
export function parseFootnoteDefinition(source: string, identifier: string): FootnoteDefinition {
  const parsed = fromMarkdown(source, {
    extensions: [gfm(), math()], mdastExtensions: [gfmFromMarkdown(), mathFromMarkdown()],
  });
  const node = parsed.children[0];
  if (parsed.children.length !== 1 || node?.type !== 'footnoteDefinition' || node.identifier !== identifier) {
    throw new Error('请保留脚注编号，并只编辑这一条脚注定义。');
  }
  return node;
}

function FootnoteEditor({ ast, nodeKey, editor }: { ast: FootnoteAst; nodeKey: NodeKey; editor: LexicalEditor }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(() => footnoteSource(ast));
  const [error, setError] = useState('');
  if (ast.type === 'footnoteReference') {
    return <sup contentEditable={false} title="脚注引用；可在源码模式修改编号">[{ast.label || ast.identifier}]</sup>;
  }
  const save = () => {
    try {
      const updated = parseFootnoteDefinition(draft, ast.identifier);
      editor.update(() => {
        const node = $getNodeByKey(nodeKey);
        if (node instanceof TextbookFootnoteNode) node.replace(new TextbookFootnoteNode(updated));
      });
      setError(''); setEditing(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '脚注格式无效，原内容已保留。'); }
  };
  return <section contentEditable={false} className="my-3 rounded-lg border border-slate-200 p-3 dark:border-slate-700">
    <div className="mb-2 flex items-center justify-between gap-2 text-xs text-slate-700 dark:text-slate-200">
      <span>脚注 [{ast.label || ast.identifier}] · 保留原始 Markdown</span>
      {!editing && <button type="button" className="rounded px-2 py-1 underline focus-visible:outline focus-visible:outline-2"
        onClick={() => { setDraft(footnoteSource(ast)); setError(''); setEditing(true); }}>编辑脚注</button>}
    </div>
    {editing ? <>
      <label className="block text-xs">脚注 Markdown
        <textarea autoFocus rows={5} value={draft} onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => { event.stopPropagation(); if (event.key === 'Escape') { setEditing(false); setError(''); } }}
          className="mt-1 w-full rounded border border-slate-300 bg-transparent p-2 font-mono text-sm focus-visible:outline focus-visible:outline-2 dark:border-slate-600"
          aria-invalid={Boolean(error)} />
      </label>
      {error && <p role="alert" className="mt-2 text-sm text-red-700 dark:text-red-300">{error}</p>}
      <div className="mt-2 flex gap-3 text-xs">
        <button type="button" onClick={save} className="rounded px-2 py-1 underline focus-visible:outline focus-visible:outline-2">保存脚注</button>
        <button type="button" onClick={() => { setEditing(false); setError(''); }} className="rounded px-2 py-1 underline focus-visible:outline focus-visible:outline-2">取消</button>
      </div>
    </> : <pre className="whitespace-pre-wrap break-words font-mono text-xs text-slate-700 dark:text-slate-200">{footnoteSource(ast)}</pre>}
  </section>;
}

export class TextbookFootnoteNode extends DecoratorNode<React.ReactNode> {
  __ast: FootnoteAst;
  static getType() { return 'textbookFootnote'; }
  static clone(node: TextbookFootnoteNode) { return new TextbookFootnoteNode(node.__ast, node.__key); }
  static importJSON(node: SerializedFootnoteNode & Record<string, unknown>) { return new TextbookFootnoteNode(node.ast); }
  constructor(ast: FootnoteAst, key?: NodeKey) { super(key); this.__ast = ast; }
  exportJSON(): SerializedFootnoteNode { return { type: 'textbookFootnote', version: 1, ast: this.__ast }; }
  isInline() { return this.__ast.type === 'footnoteReference'; }
  createDOM() { return document.createElement(this.isInline() ? 'span' : 'div'); }
  updateDOM() { return false; }
  getTextContent() { return footnoteSource(this.__ast); }
  decorate(editor: LexicalEditor) { return <FootnoteEditor ast={this.__ast} nodeKey={this.__key} editor={editor} />; }
}

export const footnoteImportVisitor: MdastImportVisitor<FootnoteAst> = {
  testNode: (node) => node.type === 'footnoteReference' || node.type === 'footnoteDefinition',
  // A definition owns its preserved mdast children; a decorator has no Lexical children.
  visitNode({ mdastNode, lexicalParent }) {
    if (!$isElementNode(lexicalParent)) throw new Error('脚注只能添加到 Markdown 段落或文档。');
    lexicalParent.append(new TextbookFootnoteNode(mdastNode));
  },
};
export const footnoteExportVisitor: LexicalExportVisitor<TextbookFootnoteNode, FootnoteAst> = {
  testLexicalNode: (node) => node instanceof TextbookFootnoteNode,
  visitLexicalNode({ lexicalNode, mdastParent, actions }) {
    if (mdastParent) actions.appendToParent(mdastParent, structuredClone(lexicalNode.__ast));
  },
};
export const textbookFootnotePlugin = realmPlugin({ init(realm) {
  realm.pubIn({
    [addLexicalNode$]: TextbookFootnoteNode,
    [addImportVisitor$]: footnoteImportVisitor,
    [addExportVisitor$]: footnoteExportVisitor,
    [addSyntaxExtension$]: gfm(),
    [addMdastExtension$]: gfmFromMarkdown(),
    [addToMarkdownExtension$]: gfmToMarkdown(),
  });
} });
