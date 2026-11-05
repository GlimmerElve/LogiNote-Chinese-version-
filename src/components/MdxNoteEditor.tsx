import React, { createContext, forwardRef, useCallback, useContext, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import {
  MDXEditor,
  MDXEditorMethods,
  markdownShortcutPlugin,
  diffSourcePlugin,
  toolbarPlugin,
  // toolbar building blocks
  UndoRedo,
  Separator,
  BoldItalicUnderlineToggles,
  StrikeThroughSupSubToggles,
  HighlightToggle,
  ListsToggle,
  BlockTypeSelect,
  CreateLink,
  InsertTable,
  InsertImage,
  InsertThematicBreak,
  InsertCodeBlock,
  DiffSourceToggleWrapper,
} from "@mdxeditor/editor";
import { mdxNoteContentPlugins } from './mdxNoteContentPlugins';
import { mdxMarkdownCompatibilityPlugin } from './MdxMarkdownCompatibilityPlugin';
import { incrementalMarkdownPlugin } from './IncrementalMarkdownPlugin';
import { editorCompositionPlugin } from './EditorCompositionPlugin';
import type { GeneratedMathScope } from '../services/textbook/generatedMath';
import { insertMdxMarkdownSafely, prepareMdxEditorInput } from './mdxNotePreflight';
import type { LearningReviewRecord, LearningReviewPatch, TextbookManifest } from '../services/textbook/types';
import type { NoteItem } from '../types';
import type { MdxNoteEditorHandle } from './noteEditorHandle';
import { ReadingWorkerProvider } from './textbook/ReadingWorkerContext';
import { TextbookEditorLiveContext } from './textbook/TextbookCodeEditor';
import { createMdxEditorRuntime } from './MdxEditorRuntime';
export type { MdxNoteEditorHandle } from './noteEditorHandle';
import "@mdxeditor/editor/style.css";

const StableMDXEditor = React.memo(MDXEditor);
const ToolbarBusinessContext = createContext<React.ReactNode>(null);
const ToolbarSourceSwitchContext = createContext<React.ReactNode>(null);
function ToolbarBusinessContents() {
  const extra = useContext(ToolbarBusinessContext);
  return extra ? <><Separator />{extra}</> : null;
}
function ToolbarSourceSwitch() {
  const custom = useContext(ToolbarSourceSwitchContext);
  return <div style={{ marginLeft: 'auto' }}>{custom || <DiffSourceToggleWrapper><span className="mdxeditor-diff-source-toggle" /></DiffSourceToggleWrapper>}</div>;
}

interface MdxNoteEditorProps {
  content: string;
  onChange?: (md: string) => void;
  className?: string;
  darkMode?: boolean;
  active?: boolean;
  mathRecovery?: GeneratedMathScope;
  /** 注入到原生工具栏末尾的自定义按钮区（业务按钮） */
  toolbarExtra?: React.ReactNode;
  /** Long notes can connect the toolbar to their viewport-based source editor. */
  sourceModeSwitch?: React.ReactNode;
  /** 双链 `[[...]]` 点击回调 */
  onWikiLinkClick?: (title: string) => void;
  /** 论证图块 `<ArgumentBlock id="..."/>` 点击回调 */
  onArgumentBlockEdit?: (docId: string) => void;
  /** 论证图块删除回调 */
  onArgumentBlockDelete?: (docId: string) => void;
  /** 论证图块数据解析器（用于正文内嵌只读结构图） */
  getArgumentDoc?: (docId: string) => import('../services/argumentDoc/types').ArgDoc | undefined;
  getLearningReviewRecord?: (id: string) => LearningReviewRecord | undefined;
  onLearningReviewPatch?: (id: string, patch: LearningReviewPatch) => void | Promise<void>;
  textbookManifest?: TextbookManifest;
  allNotes?: NoteItem[];
  onOpenKnowledge?: (noteId: string) => void;
  onOpenDocument?: (docId: string) => void;
}

/**
 * 基于文件读取：把用户选择的图片压缩后转为 data URL（内嵌到 markdown）。
 * 沿用 NoteEditor 原有的「大图压缩」策略，避免 base64 过大。
 */
async function fileToCompressedDataUrl(file: File): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("图片读取失败"));
    reader.onload = () => {
      const dataUrl = reader.result as string;
      if (file.size <= 500 * 1024 || !dataUrl.startsWith("data:image/")) {
        resolve(dataUrl);
        return;
      }
      const img = new window.Image();
      img.onload = () => {
        let w = img.width;
        let h = img.height;
        const maxW = 1200;
        if (w > maxW) {
          h = Math.round((h * maxW) / w);
          w = maxW;
        }
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          resolve(dataUrl);
          return;
        }
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/jpeg", 0.85));
      };
      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    };
    reader.readAsDataURL(file);
  });
}

/**
 * 基于 MDXEditor 的 Markdown 富文本编辑器封装。
 *
 * - 原生工具栏：标题/加粗斜体/删除线/下划线/高亮/引用/列表/代码块/表格/图片/链接/源码模式。
 * - 双链 `[[...]]`：经 wikiLinkPlugin 渲染为可点击高亮节点，导出仍为纯 `[[标题]]`。
 *
 * Callback forwarding refs are instance-local. Content plugins can be reused
 * during typing without freezing old callbacks or sharing another editor's state.
 */
export const MdxNoteEditor = forwardRef<MdxNoteEditorHandle, MdxNoteEditorProps>(
  ({ content, onChange, className = "", darkMode = false, active = true, mathRecovery = 'knowledge-section', toolbarExtra, sourceModeSwitch, onWikiLinkClick, onArgumentBlockEdit, onArgumentBlockDelete, getArgumentDoc, getLearningReviewRecord, onLearningReviewPatch, textbookManifest, allNotes, onOpenKnowledge, onOpenDocument }, ref) => {
    const editorRef = useRef<MDXEditorMethods>(null);
    const changeCallback = useRef(onChange); changeCallback.current = onChange;
    const insertionReporterRef = useRef<(source: string | null) => void>(() => {});
    const emittedMarkdownRef = useRef<string | null>(null);
    const normalizedMarkdownRef = useRef<string | null>(null);
    const importedMarkdownRef = useRef<string | null>(null);
    const compatibleContent = useMemo(() => {
      if (!active && importedMarkdownRef.current !== null) return importedMarkdownRef.current;
      // The editor already owns/exported this document. Do not parse/import its
      // own keystrokes again (especially long textbook marker documents).
      if (content === emittedMarkdownRef.current && importedMarkdownRef.current !== null) return importedMarkdownRef.current;
      const prepared = prepareMdxEditorInput(content);
      importedMarkdownRef.current = prepared;
      return prepared;
    }, [content, active]);
    const callbacksRef = useRef({ onWikiLinkClick, onArgumentBlockEdit, onArgumentBlockDelete, getArgumentDoc,
      getLearningReviewRecord, onLearningReviewPatch, onOpenKnowledge, onOpenDocument });
    callbacksRef.current = { onWikiLinkClick, onArgumentBlockEdit, onArgumentBlockDelete, getArgumentDoc,
      getLearningReviewRecord, onLearningReviewPatch, onOpenKnowledge, onOpenDocument };
    const runtime = useMemo(() => createMdxEditorRuntime(() => callbacksRef.current), []);
    const importOptionsRef = useRef({ scope: mathRecovery, textbook: Boolean(textbookManifest) });
    importOptionsRef.current = { scope: mathRecovery, textbook: Boolean(textbookManifest) };
    const textbookContext = useMemo(() => ({ manifest: textbookManifest, allNotes, active,
      onOpenKnowledge: onOpenKnowledge ? (id: string) => callbacksRef.current.onOpenKnowledge?.(id) : undefined,
      onOpenDocument: onOpenDocument ? (id: string) => callbacksRef.current.onOpenDocument?.(id) : undefined,
    }), [textbookManifest, allNotes, active, Boolean(onOpenKnowledge), Boolean(onOpenDocument)]);
    // Run after every committed prop snapshot: only already-used graph/review
    // IDs are resolved, including in-place edits and deleted source records.
    useEffect(() => { runtime.refresh(); });
    // No external subscription/timer is owned here. Do not disconnect from a
    // React effect cleanup: StrictMode can replay that cleanup while the same
    // editor/Realm is still retained. The instance-local cycle is GC-owned.

    // MDXEditor 的 markdown 仅在挂载时读取；外部（父组件）更新 content
    // 时需主动 setMarkdown 同步（例如自动关联后的内容回填）。
    const lastContentRef = useRef(content);
    useEffect(() => {
      if (!active) return;
      if (content === emittedMarkdownRef.current) {
        lastContentRef.current = content;
        return;
      }
      if (content !== lastContentRef.current && editorRef.current) {
        lastContentRef.current = content;
        emittedMarkdownRef.current = null;
        editorRef.current.setMarkdown(compatibleContent);
      }
    }, [content, compatibleContent, active]);

    useImperativeHandle(ref, () => ({
      getMarkdown: () => editorRef.current?.getMarkdown() ?? "",
      setMarkdown: (md: string) => {
        const prepared = prepareMdxEditorInput(md);
        // An explicit replacement invalidates the old self-emission shortcut.
        // A following parent snapshot must not import the same document twice.
        emittedMarkdownRef.current = null;
        importedMarkdownRef.current = prepared;
        lastContentRef.current = md;
        editorRef.current?.setMarkdown(prepared);
      },
      insertMarkdown: (md: string) => {
        if (editorRef.current) insertMdxMarkdownSafely(md, prepared => editorRef.current?.insertMarkdown(prepared),
          source => insertionReporterRef.current(source));
      },
      getSelectionMarkdown: () => editorRef.current?.getSelectionMarkdown() ?? "",
      focus: () => editorRef.current?.focus(),
    }), []);

    const contentPlugins = useMemo(() => [
      runtime.plugin,
      incrementalMarkdownPlugin({ onImport: md => { normalizedMarkdownRef.current = md; } }),
      editorCompositionPlugin(),
      ...mdxNoteContentPlugins({ image: { imageUploadHandler: fileToCompressedDataUrl },
        mathRecovery,
        liveImportOptions: () => importOptionsRef.current,
        source: () => importedMarkdownRef.current || '',
        ...runtime.nodeCallbacks,
        // The live React provider owns business data. Never retain the initial
        // whole-library snapshot inside the editor's lifetime-long schema.
        textbook: {},
      }),
      markdownShortcutPlugin(),
      diffSourcePlugin(),
      mdxMarkdownCompatibilityPlugin({ onInsertionReporter: report => { insertionReporterRef.current = report; } }),
    ], [runtime]);
    // Business controls update through context, not by reinstalling every Realm
    // plugin on every keystroke. Their disabled/actions state remains current.
    const plugins = useMemo(() => [...contentPlugins,
      toolbarPlugin({
        toolbarContents: () => (
          <>
            <UndoRedo />
            <Separator />
            <BoldItalicUnderlineToggles />
            <StrikeThroughSupSubToggles />
            <HighlightToggle />
            <Separator />
            <BlockTypeSelect />
            <ListsToggle />
            <CreateLink />
            <InsertImage />
            <InsertTable />
            <InsertThematicBreak />
            <InsertCodeBlock />
            <ToolbarBusinessContents />
            <ToolbarSourceSwitch />
          </>
        ),
      }),
    ], [contentPlugins]);
    const editorChange = useCallback((md: string, initialMarkdownNormalize: boolean) => {
      if (initialMarkdownNormalize) { normalizedMarkdownRef.current = md; return; }
      // Focus/selection can dirty Lexical nodes without changing content. Its
      // normalized import is a display baseline, not an edit to the stored file.
      if (md === normalizedMarkdownRef.current) return;
      normalizedMarkdownRef.current = md;
      emittedMarkdownRef.current = md;
      changeCallback.current?.(md);
    }, []);

    return (
      <ReadingWorkerProvider><TextbookEditorLiveContext.Provider value={textbookContext}><ToolbarBusinessContext.Provider value={toolbarExtra}><ToolbarSourceSwitchContext.Provider value={sourceModeSwitch}>
      <StableMDXEditor
        ref={editorRef}
        className={`mdxeditor-full-height ${darkMode ? 'dark-theme' : ''} ${className}`}
        markdown={compatibleContent}
        onChange={editorChange}
        plugins={plugins}
        contentEditableClassName={`mdxeditor-content-editable${darkMode ? ' dark' : ''}${textbookManifest ? ' mdxeditor-textbook-content' : ''}`}
        spellCheck={false}
        trim={false}
      />
      </ToolbarSourceSwitchContext.Provider></ToolbarBusinessContext.Provider></TextbookEditorLiveContext.Provider></ReadingWorkerProvider>
    );
  }
);

MdxNoteEditor.displayName = "MdxNoteEditor";
