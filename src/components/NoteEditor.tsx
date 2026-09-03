import React, { useState, useEffect, useRef } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { NoteItem, VaultSettings, AnalysisResult, ResourceItem } from "../types";
import { callLLM } from "../services/llmService";
import { loadLlmSettings } from "../services/llmStorage";
import {
  Link2,
  Sparkles,
  Zap,
  Tag,
  AlertTriangle,
  Loader2,
  Globe,
  X,
  ExternalLink,
  RefreshCw,
  BookOpen,
  Trash2,
  Edit3,
  ArrowUpRight,
  Plus,
  Sigma,
  ListChecks,
  MoreHorizontal,
  FolderOpen,
} from "lucide-react";
import { MdxNoteEditor, MdxNoteEditorHandle } from "./MdxNoteEditor";
import { basename, pathToFileUrl, detectLocalFileType } from "../services/localResource";
import { KnowledgePreview } from "./KnowledgePreview";
import { createPortal } from "react-dom";
import { resolveNoteByTitleOrAlias, parseWikiLinkTarget, matchesTitleOrAlias } from "../services/noteResolver";

interface NoteEditorProps {
  note: NoteItem | null;
  allNotes: NoteItem[];
  onUpdateNote: (updated: NoteItem) => void;
  onOpenAiSegment: (note: NoteItem) => void;
  onSelectNoteByTitle: (title: string) => void;
  onOpenConceptFill?: (note: NoteItem) => void;
  settings: VaultSettings;
  /** 内容版本号，外部（如 AI 分词应用）更新后自增，用于强制刷新编辑器 */
  contentVersion?: number;
}

export const NoteEditor: React.FC<NoteEditorProps> = ({
  note,
  allNotes,
  onUpdateNote,
  onOpenAiSegment,
  onSelectNoteByTitle,
  onOpenConceptFill,
  settings,
  contentVersion,
}) => {
  const [content, setContent] = useState(note?.content ?? "");
  const [title, setTitle] = useState(note?.title ?? "");
  const [tagsText, setTagsText] = useState((note?.tags || []).join(", "));
  const [aliasesText, setAliasesText] = useState((note?.aliases || []).join(", "));

  const [showAddLinkModal, setShowAddLinkModal] = useState(false);
  const [savedSelectionText, setSavedSelectionText] = useState("");
  const [linkSearchQuery, setLinkSearchQuery] = useState("");
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [previewingNote, setPreviewingNote] = useState<NoteItem | null>(null);
  const reduceMotion = useReducedMotion();

  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [logicResult, setLogicResult] = useState<AnalysisResult | null>(null);
  const [logicError, setLogicError] = useState<string | null>(null);

  const [isRecommending, setIsRecommending] = useState(false);
  const [isGeneratingTasks, setIsGeneratingTasks] = useState(false);
  const [resources, setResources] = useState<ResourceItem[]>(note?.resources ?? []);
  const [showResourcePanel, setShowResourcePanel] = useState(false);
  const [resourceError, setResourceError] = useState<string | null>(null);

  const mdxEditorRef = useRef<MdxNoteEditorHandle>(null);

  // 「更多」扩展菜单状态（收拢 5 个业务功能按钮）
  const [moreOpen, setMoreOpen] = useState(false);
  const moreBtnRef = useRef<HTMLButtonElement>(null);
  const [moreMenuPos, setMoreMenuPos] = useState<{ top: number; right: number } | null>(null);

  const parseResourcesFromMarkdown = (md: string): ResourceItem[] => {
    const items: ResourceItem[] = [];
    const lines = md.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      const match = trimmed.match(/^[-*]\s*\[([^\]]+)\]\(((?:https?:\/\/)[^)\s]+)\)(?:\s*[—\-–]\s*(.+))?$/);
      if (!match) continue;
      const title = match[1].trim();
      const url = match[2].trim();
      const platform = match[3]?.trim() || undefined;
      if (!title || !url) continue;
      items.push({ title, url, platform });
    }
    return items;
  };

  /** 向上遍历 parentId，返回根级 → 直接父级的标题链（不含当前笔记自身） */
  const buildAncestorTitles = (start: NoteItem): string[] => {
    const chain: string[] = [];
    const seen = new Set<string>();
    let cur = start;
    while (cur.parentId && !seen.has(cur.parentId)) {
      seen.add(cur.parentId);
      const parent = allNotes.find((n) => n.id === cur.parentId);
      if (!parent) break;
      chain.unshift(parent.title);
      cur = parent;
    }
    return chain;
  };

  /** Capture and immediately return selection text (synchronous, no state dependency) */
  const captureSelectionText = (): string => {
    if (mdxEditorRef.current) {
      const text = mdxEditorRef.current.getSelectionMarkdown().trim();
      if (text) {
        setSavedSelectionText(text);
        return text;
      }
    }
    return '';
  };

  const handleLogicalAnalysis = async () => {
    if (!note || isAnalyzing) return;
    const freshSelection = captureSelectionText();
    const targetText = freshSelection || content;
    if (!targetText.trim()) return;
    setIsAnalyzing(true);
    setLogicResult(null);
    setLogicError(null);
    try {
      const resp = await callLLM({
        workflow: 'logic-check',
        userInput: `请分析以下文本的逻辑性和认知漏洞：\n${targetText}`,
        providerId: '',
        model: '',
      });
      let parsed: AnalysisResult;
      if (resp.parsedJson) {
        parsed = resp.parsedJson as AnalysisResult;
      } else {
        const raw = (resp.content || '').trim();
        if (!raw) throw new Error('AI 未返回有效内容');
        const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
        const jsonText = (jsonMatch?.[1] || raw).trim();
        try {
          parsed = JSON.parse(jsonText) as AnalysisResult;
        } catch {
          const start = jsonText.indexOf('{');
          const end = jsonText.lastIndexOf('}');
          if (start === -1 || end === -1 || end <= start) {
            throw new Error('AI 返回格式无法解析，请重试或缩短复盘文本');
          }
          let slice = jsonText.slice(start, end + 1);
          let open = 0;
          for (const ch of slice) { if (ch === '{' || ch === '[') open++; else if (ch === '}' || ch === ']') open--; }
          while (open > 0) { slice += (open === 1 ? '}' : ']'); open--; }
          try {
            parsed = JSON.parse(slice) as AnalysisResult;
          } catch {
            throw new Error('AI 返回内容被截断，请重试');
          }
        }
      }
      setLogicResult(parsed);
    } catch (err: any) {
      setLogicError(err?.message || '逻辑分析失败');
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleGenerateStudyTasks = async () => {
    if (!note || note.noteType !== 'project' || isGeneratingTasks) return;
    const currentTitle = title.trim() || note.title.trim();
    if (!currentTitle) { showToast('请先填写笔记标题'); return; }
    setIsGeneratingTasks(true);
    try {
      const ancestorTitles = buildAncestorTitles(note);
      const latestContent = content.trim() || note.content.trim();
      const userInput = `【笔记信息】\n笔记标题：${currentTitle}\n所属层级：${note.parentId ? '子项目' : '根项目'}\n祖先链：${ancestorTitles.join(' → ') || '无'}\n笔记正文（可能为空）：\n${latestContent.slice(0, 2000)}`;
      const resp = await callLLM({ providerId: '', model: '', workflow: 'study-task-generation', userInput });
      let tasks: string[] = [];
      const extractTasks = (obj: any): string[] => Array.isArray(obj?.tasks) ? obj.tasks.map((t: any) => String(t).trim()).filter(Boolean) : [];
      if (resp.parsedJson) {
        tasks = extractTasks(resp.parsedJson);
      } else {
        const raw = (resp.content || '').trim();
        if (!raw) throw new Error('AI 未返回有效内容');
        const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
        const jsonText = (jsonMatch?.[1] || raw).trim();
        try {
          tasks = extractTasks(JSON.parse(jsonText));
        } catch {
          const start = jsonText.indexOf('{');
          const end = jsonText.lastIndexOf('}');
          if (start === -1 || end === -1 || end <= start) throw new Error('AI 返回格式无法解析，请重试');
          let slice = jsonText.slice(start, end + 1);
          let open = 0;
          for (const ch of slice) { if (ch === '{' || ch === '[') open++; else if (ch === '}' || ch === ']') open--; }
          while (open > 0) { slice += (open === 1 ? '}' : ']'); open--; }
          try {
            tasks = extractTasks(JSON.parse(slice));
          } catch {
            throw new Error('AI 返回内容被截断，请重试');
          }
        }
      }
      if (tasks.length === 0) { showToast('AI 未返回有效任务，请重试'); return; }
      const list = tasks.map(t => `- [ ] ${t}`).join('\n');
      const updatedContent = `${list}\n\n${content}`;
      onUpdateNote({ ...note, content: updatedContent, updatedAt: new Date().toISOString() });
      setContent(updatedContent);
      if (mdxEditorRef.current) {
        isLocalTypingRef.current = true;
        mdxEditorRef.current.setMarkdown(updatedContent);
      }
      showToast(`已生成 ${tasks.length} 条学习任务`);
    } catch (err: any) {
      showToast(err?.message || '学习任务生成失败');
    } finally {
      setIsGeneratingTasks(false);
    }
  };

  const handleResourceRecommendation = async (forceRefresh: boolean = false) => {
    if (!note || isRecommending) return;
    if (!forceRefresh && note.resources && note.resources.length > 0) {
      setResources(note.resources);
      setResourceError(null);
      setShowResourcePanel(true);
      return;
    }
    const currentTitle = title.trim() || note.title.trim();
    if (!currentTitle) { showToast('请先填写笔记标题'); return; }
    setIsRecommending(true);
    setResourceError(null);
    setShowResourcePanel(true);
    try {
      const llmSettings = loadLlmSettings();
      const provider = llmSettings.providers.find(p => p.enabled && (p.baseUrl || '').includes('deepseek'));
      if (!provider || !provider.apiKey) {
        throw new Error('请先在设置中配置并启用 DeepSeek 服务商');
      }
      const ai = (window as any).electronAPI?.ai;
      if (!ai) {
        throw new Error('当前环境不支持 IPC 调用（仅桌面版可用）');
      }
      const searchData = await ai.resourceSearch({
        title: currentTitle,
        pathText: buildAncestorTitles(note).join(' » ') || currentTitle,
        provider: {
          apiKey: provider.apiKey,
          baseUrl: provider.baseUrl,
          selectedModel: provider.selectedModel || provider.models?.[0] || 'deepseek-chat',
          models: provider.models || [],
        },
      });
      const rawMarkdown = String(searchData.markdown || '');
      if (!rawMarkdown.trim()) {
        setResourceError(searchData?.error || '未能获取到推荐内容');
        return;
      }
      let list: ResourceItem[] = [];
      if (Array.isArray(searchData.resources) && searchData.resources.length > 0) {
        list = searchData.resources as ResourceItem[];
      } else {
        list = parseResourcesFromMarkdown(rawMarkdown);
      }
      if (list.length === 0) {
        setResourceError('未能解析出有效资源链接');
        return;
      }
      // 保留本地资源，仅替换在线推荐结果；本地资源追加在前部
      const localResources = resources.filter(r => r.kind === 'local');
      const mergedResources = [...localResources, ...list];
      setResources(mergedResources);
      setResourceError(null);
      onUpdateNote({ ...note, resources: mergedResources, updatedAt: new Date().toISOString() });
    } catch (err: any) {
      setResourceError(err?.message || '资源推荐失败');
    } finally {
      setIsRecommending(false);
    }
  };

  const handleDeleteResource = (index: number) => {
    if (!note) return;
    const next = resources.filter((_, i) => i !== index);
    setResources(next);
    onUpdateNote({ ...note, resources: next, updatedAt: new Date().toISOString() });
  };

  /** 添加本地学习资源：系统文件选择框（多选）→ 转 file:// URL → 追加到 resources 并持久化 */
  const handleAddLocalResource = async () => {
    if (!note) return;
    const api = (window as any).electronAPI;
    if (!api?.chooseLocalFiles) {
      showToast('本地资源加载仅支持桌面版');
      return;
    }
    let paths: string[] = [];
    try {
      paths = (await api.chooseLocalFiles()) || [];
    } catch (err: any) {
      showToast(err?.message || '选择本地资源失败');
      return;
    }
    if (!paths || paths.length === 0) return;
    const newItems: ResourceItem[] = paths.map((p) => ({
      title: basename(p),
      url: pathToFileUrl(p),
      platform: '本地',
      kind: 'local',
      fileType: detectLocalFileType(p),
    }));
    const next = [...resources, ...newItems];
    setResources(next);
    setShowResourcePanel(true);
    onUpdateNote({ ...note, resources: next, updatedAt: new Date().toISOString() });
    showToast(`已添加 ${newItems.length} 个本地资源`);
  };

  const showToast = (msg: string) => {
    setToastMessage(msg);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToastMessage(null), 4000);
  };

  const prevNoteIdRef = useRef<string | null>(null);
  const latestNoteRef = useRef(note);
  const latestContentRef = useRef(content);
  const allNotesRef = useRef(allNotes);
  const isLocalTypingRef = useRef(false);
  const localTypingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editingNoteIdRef = useRef(note?.id ?? null);

  useEffect(() => { editingNoteIdRef.current = note?.id ?? null; }, [note?.id]);
  useEffect(() => { latestNoteRef.current = note; latestContentRef.current = content; allNotesRef.current = allNotes; });

  // 外部内容版本号变化（如 AI 分词应用结果）时，强制刷新编辑器内容，绕过 isLocalTypingRef 拦截
  useEffect(() => {
    if (contentVersion === undefined) return;
    if (!note) return;
    setIsNoteChangedRefForce();
    if (mdxEditorRef.current) {
      mdxEditorRef.current.setMarkdown(note.content);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contentVersion]);

  const setIsNoteChangedRefForce = () => {
    isLocalTypingRef.current = false;
    if (localTypingTimeoutRef.current) { clearTimeout(localTypingTimeoutRef.current); localTypingTimeoutRef.current = null; }
  };

  useEffect(() => {
    if (!note) return;
    const isNoteChanged = prevNoteIdRef.current !== note.id;
    prevNoteIdRef.current = note.id;
    if (isNoteChanged) {
      isLocalTypingRef.current = false;
      if (localTypingTimeoutRef.current) { clearTimeout(localTypingTimeoutRef.current); localTypingTimeoutRef.current = null; }
      setTitle(note.title);
      setContent(note.content);
      setTagsText((note.tags || []).join(", "));
      setAliasesText((note.aliases || []).join(", "));
      setResources(note.resources ?? []);
      setShowResourcePanel(false);
      setResourceError(null);
    } else {
      if (note.content !== content && !isLocalTypingRef.current) {
        setContent(note.content);
      }
      if (note.title !== title) setTitle(note.title);
    }
  }, [note]);

  // 点击菜单外部关闭（监听 document mousedown）——置于条件返回之前，保证 Hook 数量稳定
  useEffect(() => {
    if (!moreOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (moreBtnRef.current && moreBtnRef.current.contains(t)) return;
      setMoreOpen(false);
      setMoreMenuPos(null);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [moreOpen]);

  if (!note) {
    return (
      <div className="flex-1 h-full flex flex-col items-center justify-center text-slate-400 bg-white dark:bg-slate-950 p-8">
        <Edit3 className="w-12 h-12 mb-3 opacity-20" />
        <p className="text-sm font-medium">请从左侧选择一篇笔记，或点击"新建笔记"</p>
      </div>
    );
  }

  const handleTitleChange = (newTitle: string) => {
    if (editingNoteIdRef.current !== note?.id) return;
    setTitle(newTitle);
    onUpdateNote({ ...note, title: newTitle, updatedAt: new Date().toISOString() });
  };
  const handleContentChange = (newContent: string) => {
    if (editingNoteIdRef.current !== note?.id) return;
    setContent(newContent);
    onUpdateNote({ ...note, content: newContent, updatedAt: new Date().toISOString() });
  };
  /** 分隔符统一：顿号 、 / 中文逗号 ， / 英文逗号 , / 中文分号 ； / 英文分号 ; */
  const splitAliasTokens = (text: string): string[] =>
    text.split(/[、，,；;]/).map((t) => t.trim()).filter(Boolean);

  const handleTagsChange = (text: string) => {
    if (editingNoteIdRef.current !== note?.id) return;
    setTagsText(text);
    const tagsArray = splitAliasTokens(text).map((t) => t.replace(/^#/, "")).filter(Boolean);
    onUpdateNote({ ...note, tags: tagsArray, updatedAt: new Date().toISOString() });
  };

  const handleAliasesChange = (text: string) => {
    if (editingNoteIdRef.current !== note?.id) return;
    setAliasesText(text);
    const aliasesArray = splitAliasTokens(text);
    onUpdateNote({ ...note, aliases: aliasesArray, updatedAt: new Date().toISOString() });
  };

  const handleOpenAddLinkModal = () => {
    let selText = "";
    if (mdxEditorRef.current) {
      selText = mdxEditorRef.current.getSelectionMarkdown().trim();
    }
    const initialQuery = selText || savedSelectionText;
    setSavedSelectionText(initialQuery);
    setLinkSearchQuery(initialQuery);
    setShowAddLinkModal(true);
  };

  const handleCreateAndLinkNewNote = (newTitle: string) => {
    const cleanTitle = newTitle.trim(); if (!cleanTitle) return;
    const existing = resolveNoteByTitleOrAlias(cleanTitle, allNotes);
    if (existing) { insertWikiLink(existing.title); showToast(`已关联已有笔记《${existing.title}》`); return; }
    const newNote: NoteItem = { id: `note-${Date.now()}`, title: cleanTitle, content: "请对该知识点进行定义描述", noteType: "knowledge", tags: ["关联知识点"], links: note ? [note.title] : [], backlinks: [], dueDates: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    onUpdateNote(newNote); insertWikiLink(cleanTitle); showToast(`已在目录成功新建笔记《${cleanTitle}》，并关联为知识点。`);
  };

  const insertWikiLink = (targetTitle: string) => {
    if (mdxEditorRef.current) {
      mdxEditorRef.current.insertMarkdown(`[[${targetTitle}]]`);
      mdxEditorRef.current.focus();
    }
    setShowAddLinkModal(false);
    setSavedSelectionText("");
  };

  /** 插入行内公式 `$...$`；若已有选区则自动包裹，否则插入空模板（点击公式节点编辑） */
  const insertInlineMath = () => {
    if (!mdxEditorRef.current) return;
    const sel = mdxEditorRef.current.getSelectionMarkdown().trim();
    mdxEditorRef.current.insertMarkdown(sel ? `$${sel}$` : `$ $`);
    mdxEditorRef.current.focus();
  };

  /** 插入块级公式 `$$...$$`（单行）；若已有选区则自动包裹，否则插入空模板 */
  const insertBlockMath = () => {
    if (!mdxEditorRef.current) return;
    const sel = mdxEditorRef.current.getSelectionMarkdown().trim();
    mdxEditorRef.current.insertMarkdown(sel ? `$$${sel}$$` : `$$ $$`);
    mdxEditorRef.current.focus();
  };

  const handleAutoLinkScan = (silent: boolean = false) => {
    const activeNote = latestNoteRef.current;
    const activeContent = latestContentRef.current;
    if (!activeNote || !activeContent) return;
    const currentAllNotes = allNotesRef.current || [];
    const otherNotes = currentAllNotes.filter((n) => n.id !== activeNote.id && n.noteType === "knowledge" && n.title && n.title.trim().length >= 2);
    if (otherNotes.length === 0) { if (!silent) showToast("目录中暂无其他可比对关联的已有笔记"); return; }
    // 每篇笔记构造「标题 + 别名」的匹配词表；长度降序，避免短别名误伤子串
    const matchEntries = otherNotes
      .flatMap((n) => {
        const title = n.title.trim();
        const aliases = (n.aliases || []).map((a) => a.trim()).filter(Boolean);
        return [
          { token: title, target: title, isAlias: false },
          ...aliases.map((a) => ({ token: a, target: title, isAlias: true })),
        ];
      })
      .sort((a, b) => b.token.length - a.token.length);
    let updatedContent = activeContent;
    const newLinkedTitles: string[] = [];
    for (const entry of matchEntries) {
      const escaped = entry.token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = new RegExp(`(?<!\\[\\[)${escaped}(?!\\]\\])`, "g");
      if (pattern.test(updatedContent)) {
        // 标题字面匹配 → [[标题]]；别名匹配 → [[标题|别名]]（保留原文显示）
        const replacement = entry.isAlias ? `[[${entry.token}]]` : `[[${entry.target}]]`;
        updatedContent = updatedContent.replace(pattern, replacement);
        if (!newLinkedTitles.includes(entry.target)) newLinkedTitles.push(entry.target);
      }
    }
    if (updatedContent !== activeContent) {
      const newLinks = [...(activeNote.links || [])];
      for (const t of newLinkedTitles) { if (!newLinks.includes(t)) newLinks.push(t); }
      onUpdateNote({ ...activeNote, content: updatedContent, links: newLinks, updatedAt: new Date().toISOString() });
      setContent(updatedContent);
      if (mdxEditorRef.current) {
        isLocalTypingRef.current = true;
        mdxEditorRef.current.setMarkdown(updatedContent);
      }
      if (!silent) showToast(`自动关联扫描完成：已将 ${newLinkedTitles.map((t) => `《${t}》`).join("、")} 转化为关联知识点`);
      else showToast(`自动补全关联：已将 ${newLinkedTitles.map((t) => `《${t}》`).join("、")} 转化为知识点链接`);
    } else if (!silent) showToast("✓ 自动关联扫描完成，文中暂无新的未关联已有笔记名称");
  };

  /** 展开/收起「更多」菜单，并计算定位坐标（右对齐，避免越出屏幕右缘） */
  const toggleMoreMenu = () => {
    if (moreOpen) {
      closeMoreMenu();
      return;
    }
    const rect = moreBtnRef.current?.getBoundingClientRect();
    if (rect) {
      const right = Math.max(8, window.innerWidth - rect.right);
      setMoreMenuPos({ top: rect.bottom + 6, right });
    } else {
      setMoreMenuPos({ top: 40, right: 8 });
    }
    setMoreOpen(true);
  };

  const closeMoreMenu = () => {
    setMoreOpen(false);
    setMoreMenuPos(null);
  };

  /** 工具栏尾部注入：公式按钮保持平铺 + 「更多」扩展按钮 */
  const toolbarBusinessButtons = (
    <>
      <button
        onClick={insertInlineMath}
        className="mx-0.5 flex items-center gap-1 rounded-md bg-slate-50 px-2 py-1 text-[11px] font-semibold text-slate-700 border border-slate-200 transition hover:bg-slate-100"
        title="插入行内公式 $...$（选中文本则自动包裹）"
      >
        <Sigma className="h-3 w-3 text-slate-600" />
        <span>行内公式</span>
      </button>
      <button
        onClick={insertBlockMath}
        className="mx-0.5 flex items-center gap-1 rounded-md bg-slate-50 px-2 py-1 text-[11px] font-semibold text-slate-700 border border-slate-200 transition hover:bg-slate-100"
        title="插入块级公式 $$...$$（选中文本则自动包裹）"
      >
        <Sigma className="h-3 w-3 text-slate-600" />
        <span>块级公式</span>
      </button>
      <button
        ref={moreBtnRef}
        onClick={toggleMoreMenu}
        className="mx-0.5 flex items-center gap-1 rounded-md bg-slate-100 dark:bg-slate-800 px-2 py-1 text-[11px] font-semibold text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-600 transition hover:bg-slate-200 dark:hover:bg-slate-700"
        title="更多功能"
      >
        <MoreHorizontal className="h-3.5 w-3.5" />
        <span>更多</span>
      </button>
    </>
  );

  return (
    <div className="flex-1 h-[calc(100vh-3.5rem)] flex flex-col bg-white dark:bg-slate-950 overflow-hidden">
      <div className="px-8 pt-6 pb-2 bg-white dark:bg-slate-950">
        <input
          type="text"
          value={title}
          onChange={(e) => handleTitleChange(e.target.value)}
          placeholder="笔记标题 (例如: [[量子力学基础]])"
          className="w-full text-3xl font-bold tracking-tight bg-transparent border-b border-transparent hover:border-slate-200 dark:hover:border-slate-800 focus:border-indigo-500 focus:outline-none pb-2 text-slate-900 dark:text-slate-100 transition"
        />
        <div className="flex items-center gap-2 mt-3 text-xs">
          <Tag className="w-3.5 h-3.5 text-slate-400 shrink-0" />
          <input
            type="text"
            value={tagsText}
            onChange={(e) => handleTagsChange(e.target.value)}
            placeholder="添加分类标签 (分隔符: 、 ， ,)"
            className="flex-1 bg-transparent text-slate-600 dark:text-slate-400 focus:outline-none placeholder-slate-400"
          />
          {note.noteType === 'knowledge' && (
            <>
              <span className="w-px h-3.5 bg-slate-200 dark:bg-slate-700 shrink-0" />
              <Link2 className="w-3.5 h-3.5 text-slate-400 shrink-0" />
              <input
                type="text"
                value={aliasesText}
                onChange={(e) => handleAliasesChange(e.target.value)}
                placeholder="添加别名 (如: LLM, 大语言模型)"
                className="flex-1 bg-transparent text-slate-600 dark:text-slate-400 focus:outline-none placeholder-slate-400"
              />
            </>
          )}
        </div>
        <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-3">本文已关联 {note.links.length} 个知识点，{resources.length} 个资源推荐</p>
        {note.noteType === 'knowledge' && onOpenConceptFill && (content.trim() === '' || content === '请对该知识点进行定义描述') && (
          <button
            onClick={() => onOpenConceptFill(note)}
            className="mt-3 flex items-center gap-2 px-3 py-2 rounded-xl bg-indigo-50 dark:bg-indigo-950/40 border border-indigo-200 dark:border-indigo-800 text-xs font-semibold text-indigo-600 dark:text-indigo-300 hover:bg-indigo-100 dark:hover:bg-indigo-900/50 transition"
          >
            <Sparkles className="w-3.5 h-3.5" />
            补全概念（联网或本地资料）
          </button>
        )}
      </div>

      <div className="flex-1 flex flex-col overflow-hidden relative" style={{ backgroundColor: "#F0F5E8" }}>
        <div className="flex-1 min-h-0 flex flex-col">
          <div className="w-full flex-1 min-h-0 flex flex-col">
            <MdxNoteEditor
              key={note?.id}
              ref={mdxEditorRef}
              content={content}
              onChange={(md) => {
                isLocalTypingRef.current = true;
                if (localTypingTimeoutRef.current) clearTimeout(localTypingTimeoutRef.current);
                localTypingTimeoutRef.current = setTimeout(() => { isLocalTypingRef.current = false; }, 1000);
                handleContentChange(md);
              }}
              darkMode={settings.theme === "dark"}
              className="h-full"
              toolbarExtra={toolbarBusinessButtons}
              onWikiLinkClick={(rawTitle) => {
                const targetTitle = parseWikiLinkTarget(rawTitle);
                const found = resolveNoteByTitleOrAlias(targetTitle, allNotes);
                if (found) {
                  if (previewingNote && previewingNote.title.toLowerCase() === found.title.toLowerCase()) {
                    setPreviewingNote(null);
                    onSelectNoteByTitle(found.title);
                  } else {
                    setPreviewingNote(found);
                  }
                } else {
                  onSelectNoteByTitle(targetTitle);
                }
              }}
            />
          </div>
        </div>

        {previewingNote && (
          <KnowledgePreview
            note={previewingNote}
            darkMode={settings.theme === "dark"}
            onClose={() => setPreviewingNote(null)}
            onEdit={() => { const t = previewingNote.title; setPreviewingNote(null); onSelectNoteByTitle(t); }}
          />
        )}

        <AnimatePresence>
          {showResourcePanel && (
            <>
              <motion.div
                key="resource-overlay"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: reduceMotion ? 0 : 0.2 }}
                className="absolute inset-0 bg-black/25 dark:bg-black/40 z-40"
                onClick={() => setShowResourcePanel(false)}
              />
              <motion.aside
                key="resource-panel"
                initial={{ x: "100%" }}
                animate={{ x: 0 }}
                exit={{ x: "100%" }}
                transition={{ type: "spring", stiffness: 320, damping: 32 }}
                className="absolute inset-y-0 right-0 z-50 w-full sm:w-[400px] bg-white dark:bg-slate-900 shadow-2xl border-l border-slate-200 dark:border-slate-800 flex flex-col"
              >
                <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200 dark:border-slate-800">
                  <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100 flex items-center gap-2">
                    <BookOpen className="w-4 h-4 text-indigo-500" />学习资源推荐
                  </h3>
                  <div className="flex items-center gap-1">
                    <button onClick={() => handleAddLocalResource()} className="p-1.5 rounded-lg text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition" title="添加本地资源">
                      <FolderOpen className="w-4 h-4" />
                    </button>
                    <button onClick={() => handleResourceRecommendation(true)} disabled={isRecommending} className="p-1.5 rounded-lg text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition disabled:opacity-50" title="重新推荐">
                      <RefreshCw className={`w-4 h-4 ${isRecommending ? "animate-spin" : ""}`} />
                    </button>
                    <button onClick={() => setShowResourcePanel(false)} className="p-1.5 rounded-lg text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition" title="关闭">
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                </div>

                <div className="flex-1 overflow-y-auto p-4 space-y-3">
                  {isRecommending && (
                    <div className="flex flex-col items-center justify-center py-12 text-slate-400 dark:text-slate-500">
                      <Loader2 className="w-8 h-8 animate-spin text-indigo-500 mb-3" />
                      <p className="text-xs">正在联网搜索学习资源…</p>
                    </div>
                  )}
                  {!isRecommending && resourceError && (
                    <div className="px-4 py-3 rounded-xl bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 text-xs text-red-700 dark:text-red-300">
                      {resourceError}
                    </div>
                  )}
                  {!isRecommending && !resourceError && resources.length === 0 && (
                    <div className="flex flex-col items-center justify-center py-12 text-slate-400 dark:text-slate-500">
                      <BookOpen className="w-8 h-8 mb-3 opacity-30" />
                      <p className="text-xs">暂无资源，点击「资源推荐」获取</p>
                    </div>
                  )}
                  {!isRecommending && resources.length > 0 && (
                    <>
                      <p className="text-[10px] text-slate-400 dark:text-slate-500">{resources.length} 条推荐 · 点击卡片在新标签页打开</p>
                      {resources.map((r, i) => (
                        <div key={`${r.url}-${i}`} className="group relative flex items-start gap-2 p-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/40 hover:border-indigo-300 dark:hover:border-indigo-700 hover:bg-indigo-50/50 dark:hover:bg-indigo-950/30 transition">
                          <a href={r.url} target="_blank" rel="noopener noreferrer" className="flex-1 min-w-0 flex items-start gap-3">
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium text-slate-800 dark:text-slate-100 leading-snug group-hover:text-indigo-700 dark:group-hover:text-indigo-300 transition line-clamp-2">{r.title}</p>
                              {r.platform && (
                                <span className={`inline-block mt-1.5 text-[10px] px-1.5 py-0.5 rounded-full font-medium ${
                                  /知乎/.test(r.platform) ? "bg-blue-100 text-blue-600 dark:bg-blue-900/40 dark:text-blue-300"
                                  : /Bilibili|哔哩/.test(r.platform) ? "bg-pink-100 text-pink-600 dark:bg-pink-900/40 dark:text-pink-300"
                                  : /Bohrium/.test(r.platform) ? "bg-purple-100 text-purple-600 dark:bg-purple-900/40 dark:text-purple-300"
                                  : /MOOC|学堂|公开课|Coursera|高校/.test(r.platform) ? "bg-emerald-100 text-emerald-600 dark:bg-emerald-900/40 dark:text-emerald-300"
                                  : "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400"
                                }`}>{r.platform}</span>
                              )}
                            </div>
                            <ExternalLink className="w-4 h-4 text-indigo-500 shrink-0 mt-0.5 group-hover:scale-110 transition" />
                          </a>
                          <button onClick={(e) => { e.stopPropagation(); handleDeleteResource(i); }} className="shrink-0 self-start p-1.5 rounded-lg text-slate-400 dark:text-slate-500 hover:bg-red-100 dark:hover:bg-red-900/40 hover:text-red-600 dark:hover:text-red-400 transition" title="删除此资源">
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      ))}
                    </>
                  )}
                </div>
              </motion.aside>
            </>
          )}
        </AnimatePresence>

        <AnimatePresence>
          {toastMessage && (
            <motion.div
              key={toastMessage}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: reduceMotion ? 0 : 0.2 }}
              className="absolute top-4 right-8 z-50 px-4 py-2.5 rounded-2xl bg-indigo-900/90 text-white text-xs font-semibold shadow-2xl border border-indigo-700/80 backdrop-blur-md flex items-center gap-2 pointer-events-none"
              role="status"
              aria-live="polite"
            >
              <Zap className="w-4 h-4 text-amber-400" /><span>{toastMessage}</span>
            </motion.div>
          )}
        </AnimatePresence>

        {/* 划词关联弹窗 */}
        {showAddLinkModal && (
          <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={() => setShowAddLinkModal(false)}>
            <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-800 w-full max-w-md p-5 mx-4" onClick={e => e.stopPropagation()}>
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100 flex items-center gap-1.5">
                  <Link2 className="w-4 h-4 text-indigo-500" />划词关联知识点
                </h3>
                <button onClick={() => setShowAddLinkModal(false)} className="p-1 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200">✕</button>
              </div>
              {savedSelectionText && (
                <div className="mb-3 px-3 py-2 bg-indigo-50 dark:bg-indigo-950/40 rounded-xl border border-indigo-200 dark:border-indigo-800 text-xs text-indigo-800 dark:text-indigo-200">
                  已选中: <span className="font-semibold">"{savedSelectionText}"</span>
                </div>
              )}
              <input
                type="text"
                autoFocus
                value={linkSearchQuery}
                onChange={e => setLinkSearchQuery(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && linkSearchQuery.trim()) { handleCreateAndLinkNewNote(linkSearchQuery.trim()); } }}
                placeholder="搜索已有笔记，或输入名称创建新笔记..."
                className="w-full px-3 py-2 text-xs rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 text-slate-800 dark:text-slate-200 mb-2"
              />
              {linkSearchQuery.trim() && (
                <div className="mb-2">
                  <button onClick={() => handleCreateAndLinkNewNote(linkSearchQuery.trim())} className="w-full text-left px-3 py-2 rounded-xl bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800 text-xs flex items-center gap-2 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-100 dark:hover:bg-emerald-900/60 transition">
                    <Plus className="w-3.5 h-3.5" /> 新建笔记「{linkSearchQuery.trim()}」并关联
                  </button>
                </div>
              )}
              <div className="max-h-48 overflow-y-auto space-y-1">
                {allNotes
                  .filter(n => matchesTitleOrAlias(n, linkSearchQuery))
                  .slice(0, 12)
                  .map(n => (
                    <button key={n.id} onClick={() => insertWikiLink(n.title)} className="w-full text-left px-3 py-2 rounded-lg hover:bg-indigo-50 dark:hover:bg-indigo-950/50 flex items-center justify-between text-xs text-slate-700 dark:text-slate-300 transition">
                      <span className="truncate font-medium">{n.title}</span>
                      <ArrowUpRight className="w-3 h-3 opacity-40 text-indigo-500" />
                    </button>
                  ))}
                {allNotes.filter(n => matchesTitleOrAlias(n, linkSearchQuery)).length === 0 && linkSearchQuery.trim() && (
                  <p className="text-xs text-slate-400 text-center py-2">无匹配笔记，输入名称创建新笔记</p>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {(logicResult || logicError || isAnalyzing) && (
        <div className="border-t border-amber-200/80 dark:border-amber-800 bg-amber-50/80 dark:bg-amber-950/30 p-4 overflow-y-auto max-h-72">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-xs font-bold text-amber-800 dark:text-amber-300 flex items-center gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5 text-amber-500" />逻辑谬误检测
            </h3>
            <button onClick={() => { setLogicResult(null); setLogicError(null); }} className="text-[10px] text-amber-600 dark:text-amber-400 hover:underline">关闭</button>
          </div>
          {isAnalyzing && (
            <div className="flex items-center gap-2 text-xs text-amber-700 dark:text-amber-300 py-2">
              <Loader2 className="w-4 h-4 animate-spin" /> AI 正在分析文本逻辑性...
            </div>
          )}
          {logicError && (
            <div className="px-3 py-2 rounded-xl bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 text-xs text-red-700 dark:text-red-300">
              {logicError}
            </div>
          )}
          {logicResult && (
            <div className="space-y-3 text-xs">
              {logicResult.summary && (
                <div className="px-3 py-2 rounded-xl bg-indigo-50 dark:bg-indigo-950/30 border border-indigo-100 dark:border-indigo-900/50">
                  <span className="font-semibold text-indigo-700 dark:text-indigo-400">整体分析:</span>
                  <p className="text-slate-600 dark:text-slate-400 mt-1 leading-relaxed">{logicResult.summary}</p>
                </div>
              )}
              {logicResult.logicGaps && logicResult.logicGaps.length > 0 && (
                <div className="px-3 py-2 rounded-xl bg-orange-50 dark:bg-orange-950/30 border border-orange-100 dark:border-orange-900/50">
                  <span className="font-semibold text-orange-700 dark:text-orange-400">逻辑漏洞 ({logicResult.logicGaps.length}):</span>
                  <div className="mt-1 space-y-1.5">
                    {logicResult.logicGaps.map((g, i) => (
                      <div key={i}>
                        <div className="flex items-start gap-1.5">
                          <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold shrink-0 ${g.severity === 'critical' ? 'bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300' : g.severity === 'major' ? 'bg-orange-100 dark:bg-orange-900/40 text-orange-700 dark:text-orange-300' : 'bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300'}`}>{g.severity === 'critical' ? '严重' : g.severity === 'major' ? '重要' : '次要'}</span>
                          <span className="text-slate-700 dark:text-slate-300">{g.description}</span>
                        </div>
                        {g.suggestion && <p className="text-slate-500 dark:text-slate-400 ml-6 text-[11px]">{g.suggestion}</p>}
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {logicResult.originalStatement && (
                <div className="px-3 py-2 rounded-xl bg-white dark:bg-slate-800/60 border border-amber-200 dark:border-amber-700/60">
                  <span className="font-semibold text-amber-700 dark:text-amber-400">原文:</span>
                  <p className="text-slate-700 dark:text-slate-300 mt-1 leading-relaxed">{logicResult.originalStatement}</p>
                </div>
              )}
              {logicResult.logicalFallacies && logicResult.logicalFallacies.length > 0 && (
                <div className="px-3 py-2 rounded-xl bg-red-50 dark:bg-red-950/30 border border-red-100 dark:border-red-900/50">
                  <span className="font-semibold text-red-700 dark:text-red-400">逻辑谬误 ({logicResult.logicalFallacies.length}):</span>
                  <div className="mt-1 space-y-1.5">
                    {logicResult.logicalFallacies.map((f, i) => (
                      <div key={i}>
                        <span className="px-1.5 py-0.5 rounded bg-red-100 dark:bg-red-900/40 text-red-800 dark:text-red-300 font-medium">{f.type}</span>
                        {f.explanation && <p className="text-slate-600 dark:text-slate-400 mt-1 leading-relaxed">{f.explanation}</p>}
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {logicResult.missingFactors && logicResult.missingFactors.length > 0 && (
                <div className="px-3 py-2 rounded-xl bg-blue-50 dark:bg-blue-950/30 border border-blue-100 dark:border-blue-900/50">
                  <span className="font-semibold text-blue-700 dark:text-blue-400">缺失因素:</span>
                  <ul className="mt-1 space-y-0.5 list-disc list-inside text-slate-600 dark:text-slate-400">
                    {logicResult.missingFactors.map((f, i) => <li key={i}>{f}</li>)}
                  </ul>
                </div>
              )}
              {logicResult.supplementaryKnowledge && logicResult.supplementaryKnowledge.length > 0 && (
                <div className="px-3 py-2 rounded-xl bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-100 dark:border-emerald-900/50">
                  <span className="font-semibold text-emerald-700 dark:text-emerald-400">补充知识:</span>
                  <ul className="mt-1 space-y-0.5 list-disc list-inside text-slate-600 dark:text-slate-400">
                    {logicResult.supplementaryKnowledge.map((k, i) => <li key={i}>{k}</li>)}
                  </ul>
                </div>
              )}
              {logicResult.suggestedCorrection && (
                <div className="px-3 py-2 rounded-xl bg-green-50 dark:bg-green-950/30 border border-green-100 dark:border-green-900/50">
                  <span className="font-semibold text-green-700 dark:text-green-400">修正建议:</span>
                  <p className="text-slate-600 dark:text-slate-400 mt-1 leading-relaxed">{logicResult.suggestedCorrection}</p>
                </div>
              )}
              {logicResult.narrativeErrors && logicResult.narrativeErrors.length > 0 && (
                <div className="px-3 py-2 rounded-xl bg-purple-50 dark:bg-purple-950/30 border border-purple-100 dark:border-purple-900/50">
                  <span className="font-semibold text-purple-700 dark:text-purple-400">叙述错误 ({logicResult.narrativeErrors.length}):</span>
                  <div className="mt-1 space-y-1.5">
                    {logicResult.narrativeErrors.map((e, i) => (
                      <div key={i}>
                        <div className="text-slate-700 dark:text-slate-300">{e.error}</div>
                        {e.fix && <p className="text-slate-500 dark:text-slate-400 ml-4 text-[11px]">{e.fix}</p>}
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {logicResult.relatedKnowledge && logicResult.relatedKnowledge.length > 0 && (
                <div className="px-3 py-2 rounded-xl bg-cyan-50 dark:bg-cyan-950/30 border border-cyan-100 dark:border-cyan-900/50">
                  <span className="font-semibold text-cyan-700 dark:text-cyan-400">关联知识 ({logicResult.relatedKnowledge.length}):</span>
                  <div className="mt-1 space-y-1">
                    {logicResult.relatedKnowledge.map((k, i) => (
                      <div key={i} className="text-slate-600 dark:text-slate-400">
                        <span className="font-medium text-slate-700 dark:text-slate-300">{k.term}</span> — {k.relation}
                        {k.suggestedWikiLink && <span className="text-indigo-500 dark:text-indigo-400"> → [[{k.suggestedWikiLink}]]</span>}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* 「更多」扩展功能下拉菜单（Portal 到 body，避免被工具栏 overflow 裁剪） */}
      {moreOpen && moreMenuPos &&
        createPortal(
          <div
            className="fixed z-[100] min-w-[180px] rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-xl py-1"
            style={{ top: moreMenuPos.top, right: moreMenuPos.right }}
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => { closeMoreMenu(); handleAutoLinkScan(false); }}
              className="w-full flex items-center gap-2 px-3 py-2 text-xs text-slate-700 dark:text-slate-200 hover:bg-amber-50 dark:hover:bg-amber-950/40 transition"
            >
              <Zap className="w-3.5 h-3.5 text-amber-600" />
              <span>自动关联</span>
            </button>
            <button
              onClick={() => { closeMoreMenu(); handleOpenAddLinkModal(); }}
              className="w-full flex items-center gap-2 px-3 py-2 text-xs text-slate-700 dark:text-slate-200 hover:bg-indigo-50 dark:hover:bg-indigo-950/40 transition"
            >
              <Link2 className="w-3.5 h-3.5 text-indigo-600" />
              <span>关联</span>
            </button>
            <button
              onClick={() => { closeMoreMenu(); onOpenAiSegment(note!); }}
              className="w-full flex items-center gap-2 px-3 py-2 text-xs text-slate-700 dark:text-slate-200 hover:bg-indigo-50 dark:hover:bg-indigo-950/40 transition"
            >
              <Sparkles className="w-3.5 h-3.5 text-indigo-600" />
              <span>AI 分词</span>
            </button>
            <button
              onClick={() => { closeMoreMenu(); handleLogicalAnalysis(); }}
              disabled={isAnalyzing}
              className="w-full flex items-center gap-2 px-3 py-2 text-xs text-slate-700 dark:text-slate-200 hover:bg-amber-50 dark:hover:bg-amber-950/40 transition disabled:opacity-50"
            >
              {isAnalyzing ? <Loader2 className="w-3.5 h-3.5 animate-spin text-amber-600" /> : <AlertTriangle className="w-3.5 h-3.5 text-amber-600" />}
              <span>{isAnalyzing ? '分析中…' : '逻辑检查'}</span>
            </button>
            {note.noteType === 'project' && (
              <button
                onClick={() => { closeMoreMenu(); handleGenerateStudyTasks(); }}
                disabled={isGeneratingTasks}
                className="w-full flex items-center gap-2 px-3 py-2 text-xs text-slate-700 dark:text-slate-200 hover:bg-indigo-50 dark:hover:bg-indigo-950/40 transition disabled:opacity-50"
              >
                {isGeneratingTasks ? <Loader2 className="w-3.5 h-3.5 animate-spin text-indigo-600" /> : <ListChecks className="w-3.5 h-3.5 text-indigo-600" />}
                <span>{isGeneratingTasks ? '生成中…' : '生成学习任务'}</span>
              </button>
            )}
            <button
              onClick={() => { closeMoreMenu(); handleResourceRecommendation(); }}
              disabled={isRecommending}
              className="w-full flex items-center gap-2 px-3 py-2 text-xs text-slate-700 dark:text-slate-200 hover:bg-emerald-50 dark:hover:bg-emerald-950/40 transition disabled:opacity-50"
            >
              {isRecommending ? <Loader2 className="w-3.5 h-3.5 animate-spin text-emerald-600" /> : <Globe className="w-3.5 h-3.5 text-emerald-600" />}
              <span>{isRecommending ? '推荐中…' : '资源推荐'}</span>
            </button>
            <button
              onClick={() => { closeMoreMenu(); handleAddLocalResource(); }}
              className="w-full flex items-center gap-2 px-3 py-2 text-xs text-slate-700 dark:text-slate-200 hover:bg-emerald-50 dark:hover:bg-emerald-950/40 transition"
            >
              <FolderOpen className="w-3.5 h-3.5 text-emerald-600" />
              <span>添加本地资源</span>
            </button>
          </div>,
          document.body
        )}
    </div>
  );
};
