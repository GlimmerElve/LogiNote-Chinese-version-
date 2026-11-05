import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { Cell, useCellValue } from '@mdxeditor/gurx';
import { CodeMirrorEditor, realmPlugin, useCodeBlockEditorContext, type CodeBlockEditorProps, type CodeBlockEditorDescriptor } from '@mdxeditor/editor';
import { RenderedTextbookBlock, type TextbookBlockProps } from './TextbookReader';
import { TextbookSourceContext } from './TextbookSourceContext';
import { useEditorInputLeave } from '../useEditorInputLeave';

export type TextbookEditorContext = Omit<TextbookBlockProps, 'language' | 'code'>;
// UI editors inherit live business data without changing their Realm plugins.
// The Cell remains the standalone/headless plugin's backwards-compatible path.
export const TextbookEditorLiveContext = createContext<TextbookEditorContext | null>(null);
const textbookEditorContext$ = Cell<TextbookEditorContext>({});
const blockLabels: Record<string, string> = {
  mermaid: '示意图', chart: '统计图表', 'function-plot': '函数与面积图', 'textbook-tip': '教学提示',
  'textbook-answer': '折叠答案', 'textbook-image': '教材图片', 'textbook-references': '参考资料',
};
const FormatPreview = React.memo(function FormatPreview(props: Pick<TextbookBlockProps, 'code' | 'language' | 'manifest' | 'active'>) {
  return <RenderedTextbookBlock {...props} />;
});

/** The markdown fence is the data source; previews never rewrite or execute its source. */
export function TextbookCodeEditor({ code, language, focusEmitter }: CodeBlockEditorProps) {
  const pluginContext = useCellValue(textbookEditorContext$);
  const context = useContext(TextbookEditorLiveContext) ?? pluginContext;
  const { setCode } = useCodeBlockEditorContext();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(code);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const input = useRef({ editing: false, saving: false, draft: code, code }); input.current.code = code;
  const leave = useEditorInputLeave(() => input.current.editing && input.current.draft !== input.current.code
    ? '图示或教材格式块有未提交的源码，请先点击“保存源码”或“取消”，再离开。' : null, textareaRef, editing);
  const label = blockLabels[language] || language;
  useEffect(() => {
    if (!editing) { input.current.draft = code; setDraft(code); }
    if (input.current.saving && code === input.current.draft) {
      input.current.editing = false; input.current.saving = false; setEditing(false); leave.clearNotice();
    }
  }, [code, editing]);
  const begin = () => { input.current = { editing: true, saving: false, draft: code, code }; setDraft(code); setEditing(true); leave.clearNotice(); };
  const cancel = () => { input.current = { editing: false, saving: false, draft: code, code }; setDraft(code); setEditing(false); leave.clearNotice(); };
  useEffect(() => {
    let frame: number | undefined;
    focusEmitter.subscribe(() => {
      input.current.editing = true; setEditing(true);
      frame = requestAnimationFrame(() => textareaRef.current?.focus());
    });
    return () => {
      // MDX's voidEmitter is a single callback slot, not a subscription list.
      // subscribe returns void, so replacing that slot is its cleanup API.
      focusEmitter.subscribe(() => {});
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [focusEmitter]);
  return <section contentEditable={false} className="my-4 rounded-lg border border-slate-200 p-3 dark:border-slate-700">
    <div className="mb-2 flex items-center justify-between gap-3 text-xs text-slate-700 dark:text-slate-200">
      <span>{label} · {language}</span>
      {!editing && <button type="button" onClick={begin}
        className="rounded px-2 py-1 underline focus-visible:outline focus-visible:outline-2">编辑源码</button>}
    </div>
    {editing ? <>
      <label className="block text-xs text-slate-700 dark:text-slate-200">{label}源码
        <textarea ref={textareaRef} autoFocus value={draft} rows={Math.min(18, Math.max(5, draft.split('\n').length + 1))}
          spellCheck={false} onChange={(event) => { input.current.draft = event.target.value; setDraft(event.target.value); leave.clearNotice(); }}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
            if (event.key === 'Escape') cancel();
          }}
          className="mt-1 w-full rounded border border-slate-300 bg-transparent p-2 font-mono text-sm focus-visible:outline focus-visible:outline-2 dark:border-slate-600" />
      </label>
      <div className="mt-2 flex gap-3 text-xs text-slate-700 dark:text-slate-200">
        <button type="button" onClick={() => {
          if (input.current.draft === code) { cancel(); return; }
          input.current.saving = true; setCode(input.current.draft);
        }}
          className="rounded px-2 py-1 underline focus-visible:outline focus-visible:outline-2">保存源码</button>
        <button type="button" onClick={cancel}
          className="rounded px-2 py-1 underline focus-visible:outline focus-visible:outline-2">取消</button>
      </div>
    </> : <TextbookSourceContext.Provider value={context}>
      <FormatPreview language={language} code={code} manifest={context.manifest} active={context.active} />
    </TextbookSourceContext.Provider>}
    {leave.notice && <p role="status" className="mt-2 text-sm text-[var(--ln-text-secondary)]">{leave.notice}</p>}
  </section>;
}

export const textbookCodeEditorDescriptor: CodeBlockEditorDescriptor = {
  priority: 100,
  match: (language) => Object.hasOwn(blockLabels, language || ''),
  Editor: TextbookCodeEditor,
};

// Unknown language/meta combinations keep their original code, language and metadata.
export const recoverableCodeEditorDescriptor: CodeBlockEditorDescriptor = {
  priority: 0, match: () => true, Editor: CodeMirrorEditor,
};

/** Context belongs to the MDX realm so multiple retained editors cannot overwrite it. */
export const textbookEditorContextPlugin = realmPlugin<TextbookEditorContext>({
  init(realm, context) { realm.pub(textbookEditorContext$, context || {}); },
  update(realm, context) { realm.pub(textbookEditorContext$, context || {}); },
});
