import React, { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import {
  MDXEditor,
  MDXEditorMethods,
  headingsPlugin,
  listsPlugin,
  quotePlugin,
  thematicBreakPlugin,
  codeBlockPlugin,
  codeMirrorPlugin,
  linkPlugin,
  linkDialogPlugin,
  tablePlugin,
  imagePlugin,
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
import { wikiLinkPlugin } from "./WikiLinkNode";
import { mathPlugin } from "./MathNode";
import "@mdxeditor/editor/style.css";

export interface MdxNoteEditorHandle {
  getMarkdown: () => string;
  setMarkdown: (md: string) => void;
  insertMarkdown: (md: string) => void;
  getSelectionMarkdown: () => string;
  focus: () => void;
}

interface MdxNoteEditorProps {
  content: string;
  onChange?: (md: string) => void;
  className?: string;
  darkMode?: boolean;
  /** 注入到原生工具栏末尾的自定义按钮区（业务按钮） */
  toolbarExtra?: React.ReactNode;
  /** 双链 `[[...]]` 点击回调 */
  onWikiLinkClick?: (title: string) => void;
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
 * 注意：plugins 数组**不能**用 useMemo 缓存——toolbarContents 与 wikiLinkPlugin.onClick
 * 依赖最新闭包，RealmWithPlugins 每次渲染都会调用每个 plugin 的 update。
 */
export const MdxNoteEditor = forwardRef<MdxNoteEditorHandle, MdxNoteEditorProps>(
  ({ content, onChange, className = "", darkMode = false, toolbarExtra, onWikiLinkClick }, ref) => {
    const editorRef = useRef<MDXEditorMethods>(null);

    // MDXEditor 的 markdown 仅在挂载时读取；外部（父组件）更新 content
    // 时需主动 setMarkdown 同步（例如自动关联后的内容回填）。
    const isInternalChangeRef = useRef(false);
    const lastContentRef = useRef(content);
    useEffect(() => {
      if (isInternalChangeRef.current) {
        isInternalChangeRef.current = false;
        lastContentRef.current = content;
        return;
      }
      if (content !== lastContentRef.current && editorRef.current) {
        lastContentRef.current = content;
        editorRef.current.setMarkdown(content);
      }
    }, [content]);

    useImperativeHandle(ref, () => ({
      getMarkdown: () => editorRef.current?.getMarkdown() ?? "",
      setMarkdown: (md: string) => editorRef.current?.setMarkdown(md),
      insertMarkdown: (md: string) => editorRef.current?.insertMarkdown(md),
      getSelectionMarkdown: () => editorRef.current?.getSelectionMarkdown() ?? "",
      focus: () => editorRef.current?.focus(),
    }), []);

    // 每次渲染重建 plugins，保证 toolbarContents 与 onClick 拿到最新闭包
    const plugins = [
      headingsPlugin(),
      listsPlugin(),
      quotePlugin(),
      thematicBreakPlugin(),
      codeBlockPlugin(),
      codeMirrorPlugin(),
      linkPlugin(),
      linkDialogPlugin(),
      tablePlugin(),
      imagePlugin({
        imageUploadHandler: async (file: File) => fileToCompressedDataUrl(file),
      }),
      markdownShortcutPlugin(),
      diffSourcePlugin(),
      wikiLinkPlugin({ onClick: onWikiLinkClick }),
      mathPlugin({}),
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
            {toolbarExtra ? (
              <>
                <Separator />
                {toolbarExtra}
              </>
            ) : null}
            <div style={{ marginLeft: "auto" }}>
              <DiffSourceToggleWrapper>
                <span className="mdxeditor-diff-source-toggle" />
              </DiffSourceToggleWrapper>
            </div>
          </>
        ),
      }),
    ];

    return (
      <MDXEditor
        ref={editorRef}
        className={`mdxeditor-full-height ${className}`}
        markdown={content}
        onChange={(md, initialMarkdownNormalize) => {
          // 忽略 MDXEditor 挂载/初始化导入 markdown 时的回写（initialMarkdownNormalize=true），
          // 避免切换笔记时用旧笔记内容覆写新笔记
          if (initialMarkdownNormalize) return;
          isInternalChangeRef.current = true;
          onChange?.(md);
        }}
        plugins={plugins}
        contentEditableClassName={
          darkMode
            ? "mdxeditor-content-editable dark"
            : "mdxeditor-content-editable"
        }
        spellCheck={false}
        trim={false}
      />
    );
  }
);

MdxNoteEditor.displayName = "MdxNoteEditor";