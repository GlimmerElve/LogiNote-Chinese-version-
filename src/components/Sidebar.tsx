import React, { useState, useEffect, useMemo } from "react";
import { NoteItem, NoteType, VaultSettings } from "../types";
import {
  FileText, Pin, Star, Tag, Folder, Plus, Trash2, ChevronRight, ChevronDown,
  Search, Hash, Clock, BookOpen, Layers, ArrowRight, Link2,
} from "lucide-react";

interface SidebarProps {
  notes: NoteItem[];
  activeNoteId: string | null;
  onSelectNote: (id: string) => void;
  onNewNote: (type: NoteType, parentId?: string, title?: string) => void;
  onDeleteNote: (id: string, e: React.MouseEvent) => void;
  onToggleFavorite: (id: string, e: React.MouseEvent) => void;
  onTogglePin: (id: string, e: React.MouseEvent) => void;
  settings: VaultSettings;
  onDeleteProject?: (id: string) => void;
}

interface TreeNode {
  note: NoteItem;
  children: TreeNode[];
  depth: number;
}

export const Sidebar: React.FC<SidebarProps> = ({
  notes, activeNoteId, onSelectNote, onNewNote, onDeleteNote, onToggleFavorite, onTogglePin, settings, onDeleteProject
}) => {
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [filterMode, setFilterMode] = useState<"all" | "project" | "pinned" | "favorites">("all");
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [showNewProjectModal, setShowNewProjectModal] = useState(false);
  const [newProjectTitle, setNewProjectTitle] = useState("");
  const [newProjectRelation, setNewProjectRelation] = useState<"sibling" | "child">("child");
  const [newProjectTargetId, setNewProjectTargetId] = useState<string | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState<{ id: string; title: string; childCount: number } | null>(null);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.altKey) {
        if (e.key.toLowerCase() === "s") { e.preventDefault(); setNewProjectRelation("sibling"); setNewProjectTargetId(activeNoteId); setShowNewProjectModal(true); }
        else if (e.key.toLowerCase() === "d") { e.preventDefault(); setNewProjectRelation("child"); setNewProjectTargetId(activeNoteId); setShowNewProjectModal(true); }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [activeNoteId]);

  const allTags = Array.from(new Set(notes.flatMap((n) => n.tags || []))).filter(Boolean);

  const buildTree = (parentId: string | undefined): TreeNode[] => {
    return notes
      .filter((n) => n.noteType === "project" && (parentId ? n.parentId === parentId : !n.parentId))
      .map((note) => ({ note, children: buildTree(note.id), depth: 0 }));
  };

  const projectTree = buildTree(undefined);
  const knowledgeNotes = notes.filter((n) => n.noteType === "knowledge");
  const projectCount = notes.filter((n) => n.noteType === "project").length;
  const knowledgeCount = knowledgeNotes.length;

  const filteredNotes = notes.filter((note) => {
    const q = searchQuery.trim().toLowerCase();
    const matchesSearch = !q || note.title.toLowerCase().includes(q) || note.content.toLowerCase().includes(q) || (note.aliases || []).some((a) => a.toLowerCase().includes(q));
    const matchesTag = !selectedTag || note.tags.includes(selectedTag);
    if (filterMode === "project") return note.noteType === "project" && matchesSearch && matchesTag;
    if (filterMode === "pinned") return !!note.pinned && matchesSearch && matchesTag;
    if (filterMode === "favorites") return !!note.isFavorite && matchesSearch && matchesTag;
    return matchesSearch && matchesTag;
  });

  // 追溯至一级根项目
  const getRootProjectId = (projectId: string): string => {
    let currentId: string | undefined = projectId;
    while (currentId) {
      const note = notes.find((n) => n.id === currentId);
      if (!note || !note.parentId) return currentId;
      currentId = note.parentId;
    }
    return projectId; // 兜底
  };

  // 递归收集项目及其所有子孙项目的关联链接
  const collectAllProjectLinks = (projectId: string): Set<string> => {
    const linksSet = new Set<string>();
    const project = notes.find((n) => n.id === projectId);
    if (!project) return linksSet;
    // 加入当前项目的全部 links
    project.links.forEach((l) => linksSet.add(l));
    // 递归收集所有子项目的 links
    const children = notes.filter((n) => n.noteType === "project" && n.parentId === projectId);
    children.forEach((child) => {
      collectAllProjectLinks(child.id).forEach((l) => linksSet.add(l));
    });
    return linksSet;
  };

  // Compute knowledge notes linked to the selected project (追溯至一级根项目)
  const rootProjectId = selectedProjectId ? getRootProjectId(selectedProjectId) : null;
  const selectedProject = rootProjectId ? notes.find((n) => n.id === rootProjectId) : null;
  
  // Memoize link aggregation to avoid re-crawling the project tree on every render
  const projectLinksCache = useMemo(() => {
    if (!selectedProject) return new Set<string>();
    return collectAllProjectLinks(selectedProject.id);
  }, [selectedProject?.id, notes]);
  
  const linkedKnowledgeNotes = selectedProject
    ? knowledgeNotes.filter((kn) => projectLinksCache.has(kn.title))
    : [];

  const toggleExpand = (id: string) => setExpandedIds((prev) => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next; });

  const handleCreateProject = () => {
    if (!newProjectTitle.trim()) return;
    let parentId: string | undefined;
    if (newProjectRelation === "child" && newProjectTargetId) parentId = newProjectTargetId;
    else if (newProjectRelation === "sibling" && newProjectTargetId) { const t = notes.find((n) => n.id === newProjectTargetId); parentId = t?.parentId; }
    onNewNote("project", parentId, newProjectTitle.trim());
    setNewProjectTitle(""); setShowNewProjectModal(false);
    if (parentId) setExpandedIds((prev) => new Set([...prev, parentId!]));
  };

  const getAccentClass = () => {
    switch (settings.accentColor) {
      case "purple": return "bg-purple-50 dark:bg-purple-950/40 text-purple-700 dark:text-purple-300 border-purple-200 dark:border-purple-800";
      case "emerald": return "bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800";
      case "coral": return "bg-orange-50 dark:bg-orange-950/40 text-orange-700 dark:text-orange-300 border-orange-200 dark:border-orange-800";
      case "rose": return "bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 border-rose-200 dark:border-rose-800";
      case "amber": return "bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-800";
      case "teal": return "bg-teal-50 dark:bg-teal-950/40 text-teal-700 dark:text-teal-300 border-teal-200 dark:border-teal-800";
      case "slate": return "bg-slate-100 dark:bg-slate-800/60 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-700";
      default: return "bg-indigo-50 dark:bg-indigo-950/40 text-indigo-700 dark:text-indigo-300 border-indigo-200/80 dark:border-indigo-800/60 font-medium";
    }
  };

  const noteCountInTree = (node: TreeNode): number => 1 + node.children.reduce((s, c) => s + noteCountInTree(c), 0);

  const getLinkedKnowledgeCount = (projectId: string): number => {
    const proj = notes.find((n) => n.id === projectId);
    if (!proj) return 0;
    return knowledgeNotes.filter((kn) => proj.links.includes(kn.title)).length;
  };

  const renderTreeNode = (node: TreeNode, depth: number = 0): React.ReactNode => {
    const isActive = node.note.id === activeNoteId;
    const isSelected = node.note.id === selectedProjectId;
    const linkedCount = getLinkedKnowledgeCount(node.note.id);
    return (
      <div key={node.note.id}>
        <div
          onClick={() => { setSelectedProjectId(node.note.id); onSelectNote(node.note.id); }}
          className={`group relative py-1.5 pr-2 rounded-lg transition cursor-pointer border text-xs w-full text-left ${isActive ? `${getAccentClass()} shadow-sm font-medium` : isSelected ? "bg-emerald-50/60 dark:bg-emerald-950/30 border-emerald-200/60 dark:border-emerald-800/40" : "bg-white/40 dark:bg-slate-800/40 border-transparent hover:bg-white/80 dark:hover:bg-slate-800/80 hover:border-slate-200 dark:hover:border-slate-700"}`}
          style={{ paddingLeft: `${12 + depth * 18}px` }}>
          <div className="flex items-center gap-1.5">
            <button onClick={(e) => { e.stopPropagation(); toggleExpand(node.note.id); }} className="p-0.5 rounded hover:bg-slate-200 dark:hover:bg-slate-700 flex-shrink-0">
              {node.children.length > 0 ? (expandedIds.has(node.note.id) ? <ChevronDown className="w-3 h-3 text-slate-400" /> : <ChevronRight className="w-3 h-3 text-slate-400" />) : <span className="w-3 h-3" />}
            </button>
            <Folder className="w-3 h-3 text-emerald-500 flex-shrink-0" />
            <span className="truncate">{node.note.title || "未命名项目"}</span>
            {linkedCount > 0 && <span className="text-[10px] text-indigo-500 dark:text-indigo-400 ml-1 flex-shrink-0">({linkedCount})</span>}
            <span className="text-[10px] text-slate-400 ml-auto opacity-0 group-hover:opacity-100 flex-shrink-0 mr-2">{noteCountInTree(node)}项</span>
            <button onClick={(e) => { e.stopPropagation(); const title = `新子项目`; onNewNote("project", node.note.id, title); setExpandedIds((prev) => new Set([...prev, node.note.id])); }} className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-emerald-100 dark:hover:bg-emerald-900/40 text-emerald-600 dark:text-emerald-400 flex-shrink-0" title="新建子项目"><Plus className="w-3 h-3" /></button>
            <button onClick={(e) => { e.stopPropagation(); const count = noteCountInTree(node) - 1; setShowDeleteConfirm({ id: node.note.id, title: node.note.title, childCount: count }); }} className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-red-100 dark:hover:bg-red-900/40 text-red-500 dark:text-red-400 flex-shrink-0" title="删除项目"><Trash2 className="w-3 h-3" /></button>
          </div>
        </div>
        {expandedIds.has(node.note.id) && node.children.map((c) => renderTreeNode(c, depth + 1))}
      </div>
    );
  };

  const renderNoteCard = (note: NoteItem) => {
    const isActive = note.id === activeNoteId;
    const isKnowledge = note.noteType === "knowledge";
    return (
      <div key={note.id} onClick={() => onSelectNote(note.id)}
        className={`group relative p-3 transition-all duration-200 ${isActive ? "knowledge-note-card-active" : "knowledge-note-card"}`}>
        <div className="flex items-start justify-between gap-1.5">
          <div className="flex items-center gap-1.5 flex-1 min-w-0">
            {isKnowledge ? <BookOpen className="w-3.5 h-3.5 text-indigo-500 flex-shrink-0" /> : <Folder className="w-3.5 h-3.5 text-emerald-500 flex-shrink-0" />}
            <h3 className="text-xs font-bold text-slate-900 dark:text-slate-100 truncate">{note.title || "未命名笔记"}</h3>
          </div>
          <div className="flex items-center gap-0.5 opacity-60 group-hover:opacity-100 transition-opacity flex-shrink-0">
            <button onClick={(e) => onTogglePin(note.id, e)} className={`p-0.5 rounded hover:bg-slate-200/80 dark:hover:bg-slate-700 ${note.pinned ? "text-amber-500 opacity-100" : "text-slate-400"}`} title={note.pinned ? "取消置顶" : "置顶"}><Pin className="w-2.5 h-2.5" /></button>
            <button onClick={(e) => onToggleFavorite(note.id, e)} className={`p-0.5 rounded hover:bg-slate-200/80 dark:hover:bg-slate-700 ${note.isFavorite ? "text-yellow-500 opacity-100" : "text-slate-400"}`} title={note.isFavorite ? "取消收藏" : "收藏"}><Star className="w-2.5 h-2.5 fill-current" /></button>
            <button onClick={(e) => onDeleteNote(note.id, e)} className="p-0.5 rounded text-red-500 hover:bg-red-50 dark:hover:bg-red-950/40" title="删除"><Trash2 className="w-2.5 h-2.5" /></button>
          </div>
        </div>
        <p className="text-[10px] text-slate-400 dark:text-slate-500 line-clamp-1 mt-1 leading-relaxed">{note.content.replace(/#+\s/g, "").slice(0, 60) || "暂无文字内容..."}</p>
        <div className="card-soft-divider" />
        <div className="flex items-center justify-between text-[9px] text-slate-400 dark:text-slate-500">
          <div className="flex items-center gap-1.5 overflow-hidden">
            {note.links.length > 0 && <span className="flex items-center gap-0.5 text-slate-500 dark:text-slate-400 font-medium"><Link2 className="w-2.5 h-2.5" />{note.links.length}</span>}
            {note.dueDates.filter((d) => !d.completed).length > 0 && <span className="flex items-center gap-0.5 text-amber-600 dark:text-amber-400 font-medium"><Clock className="w-2 h-2" />{note.dueDates.filter((d) => !d.completed).length}</span>}
          </div>
          <span>{new Date(note.updatedAt).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" })}</span>
        </div>
      </div>
    );
  };

  const showTree = (filterMode === "all" || filterMode === "project") && !searchQuery && !selectedTag;

  // Log all project notes for debugging
  useEffect(() => {
    const projs = notes.filter(n => n.noteType === "project");
    console.log("[Sidebar] All projects:", projs.map(n => ({ id: n.id, title: n.title, noteType: n.noteType, parentId: n.parentId })));
  }, [notes]);

  // When showing tree, exclude project notes from flat list; when project selected, show only linked knowledge
  const displayNotes = showTree
    ? filteredNotes.filter((n) => n.noteType !== "project")  // all non-project, if "all" mode
    : filteredNotes;

  // Auto-expand first-level nodes that have children
  useEffect(() => {
    if (showTree && projectTree.length > 0) {
      const toExpand = new Set<string>();
      projectTree.forEach((node) => {
        if (node.children.length > 0) toExpand.add(node.note.id);
      });
      setExpandedIds((prev) => {
        const next = new Set(prev);
        toExpand.forEach((id) => next.add(id));
        return next;
      });
    }
  }, [notes.length, filterMode, searchQuery]);

  // Sync selectedProjectId: if active note is a project, auto-select it
  useEffect(() => {
    if (activeNoteId) {
      const activeNote = notes.find((n) => n.id === activeNoteId);
      if (activeNote?.noteType === "project") {
        setSelectedProjectId(activeNoteId);
      }
    }
  }, [activeNoteId, notes]);

  return (
    <>
      <aside className="w-72 flex-shrink-0 h-full min-h-0 comic-sidebar backdrop-blur-md flex flex-col select-none">
        <div className="flex-shrink-0 p-3 border-b border-gray-200/80 dark:border-slate-800/80 space-y-2 playful-accent-bar">
          <div className="relative">
            <Search className="w-3 h-3 absolute left-2.5 top-2 text-gray-400" />
            <input type="text" placeholder="搜索笔记与双链..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} className="w-full pl-8 pr-3 py-1.5 text-[11px] rounded-lg bg-gray-50 dark:bg-slate-800 border border-gray-200 dark:border-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 text-gray-900 dark:text-slate-100 placeholder-gray-400 transition" />
          </div>
          <div className="flex items-center gap-1 text-[10px] flex-wrap">
            <button onClick={() => { setFilterMode("all"); setSelectedTag(null); }} className={`relative px-2.5 py-1 rounded-lg font-medium transition-all ${filterMode === "all" && !selectedTag ? "bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 comic-filter-active" : "text-slate-500 hover:text-slate-700 dark:hover:text-slate-200"}`}>全部<span className="ml-1 opacity-50">({notes.length})</span></button>
            <button onClick={() => { setFilterMode("project"); setSelectedTag(null); setSelectedProjectId(null); }} className={`relative px-2.5 py-1 rounded-lg font-medium transition-all flex items-center gap-0.5 ${filterMode === "project" ? "bg-white dark:bg-slate-700 comic-filter-active" : "comic-filter-secondary hover:opacity-80"}`}><Layers className="w-2.5 h-2.5" />项目</button>
            <button onClick={() => { setFilterMode("pinned"); setSelectedTag(null); }} className={`relative px-2.5 py-1 rounded-lg font-medium transition-all flex items-center gap-0.5 ${filterMode === "pinned" ? "bg-white dark:bg-slate-700 comic-filter-active" : "comic-filter-accent hover:opacity-80"}`}><Pin className="w-2.5 h-2.5" />置顶</button>
            <button onClick={() => { setFilterMode("favorites"); setSelectedTag(null); }} className={`relative px-2.5 py-1 rounded-lg font-medium transition-all flex items-center gap-0.5 ${filterMode === "favorites" ? "bg-white dark:bg-slate-700 comic-filter-active" : "comic-filter-primary hover:opacity-80"}`}><Star className="w-2.5 h-2.5" />收藏</button>
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-1.5 space-y-1">
          {showTree && projectTree.length > 0 && (
            <>
              <div className="px-2 py-1.5 rounded-lg playful-header-block"><span className="text-[10px] font-bold uppercase tracking-wider text-slate-700 dark:text-slate-200 flex items-center gap-1"><Layers className="w-3 h-3 text-orange-400" />学习项目</span></div>
              <div className="space-y-0.5 mb-2 border-b border-slate-200/60 dark:border-slate-800/60 pb-2">
                {projectTree.map((node) => renderTreeNode(node))}
              </div>
            </>
          )}
          {/* Knowledge notes linked to selected project */}
          {showTree && selectedProject && linkedKnowledgeNotes.length > 0 && (
            <>
              <div className="px-2 py-1 flex items-center justify-between">
                <span className="text-[10px] font-bold uppercase tracking-wider text-indigo-600 dark:text-indigo-400 flex items-center gap-1">
                  <BookOpen className="w-3 h-3" />{selectedProject.title} 关联知识
                </span>
                <span className="text-[9px] text-indigo-400">{linkedKnowledgeNotes.length}项</span>
              </div>
              <div className="space-y-2 border-b border-slate-200/60 dark:border-slate-800/60 pb-2 mb-2">
                {linkedKnowledgeNotes.map((kn) => renderNoteCard(kn))}
              </div>
            </>
          )}
          {/* Show selectedProject placeholder when no linked knowledge */}
          {showTree && selectedProject && linkedKnowledgeNotes.length === 0 && (
            <>
              <div className="px-2 py-1 flex items-center justify-between">
                <span className="text-[10px] font-bold uppercase tracking-wider text-indigo-600 dark:text-indigo-400 flex items-center gap-1">
                  <BookOpen className="w-3 h-3" />{selectedProject.title} 关联知识
                </span>
              </div>
              <div className="px-2 py-3 text-center text-slate-400 text-[10px] border-b border-slate-200/60 dark:border-slate-800/60 pb-2 mb-2">
                暂无关联知识点，在项目笔记中用 [[...]] 引用即可
              </div>
            </>
          )}
          {/* Show all other notes when NOT in tree mode (pinned/favorites/search) */}
          {!showTree && (
            <div className="space-y-2">
              {displayNotes.map((note) => renderNoteCard(note))}
            </div>
          )}
          {displayNotes.length === 0 && !showTree && (<div className="p-8 text-center"><div className="w-14 h-14 mx-auto mb-3 rounded-2xl playful-empty-icon flex items-center justify-center"><Search className="w-6 h-6 text-slate-400 dark:text-slate-500" /></div><p className="text-slate-400 text-[11px] font-medium">没有找到相关笔记</p><p className="text-slate-400/60 text-[10px] mt-0.5">尝试更换筛选条件或搜索关键词</p></div>)}
          {showTree && projectTree.length === 0 && (<div className="p-8 text-center"><div className="w-14 h-14 mx-auto mb-3 rounded-2xl playful-empty-icon flex items-center justify-center"><Layers className="w-6 h-6 text-slate-400 dark:text-slate-500" /></div><p className="text-slate-400 text-[11px] font-medium">还没有学习项目</p><p className="text-slate-400/60 text-[10px] mt-0.5">点击下方按钮创建你的第一个项目</p></div>)}
        </div>

        <div className="flex-shrink-0 p-2.5 playful-footer-bar flex items-center justify-between text-[10px] text-gray-600 dark:text-slate-400">
          <div className="flex items-center gap-1.5"><span className="text-emerald-500 font-medium">{projectCount} 项目</span><span className="opacity-40">·</span><span className="text-indigo-500 font-medium">{knowledgeCount} 知识</span></div>
          <div className="flex items-center gap-1">
            <button onClick={() => { const title = `新项目 ${projectCount + 1}`; onNewNote("project", undefined, title); }} className="text-[10px] font-semibold text-emerald-600 dark:text-emerald-400 hover:underline flex items-center gap-0.5" title="新建一级项目"><Folder className="w-3 h-3" />项目</button>
            <span className="opacity-30">|</span>
            <button onClick={() => onNewNote("knowledge")} className="text-[10px] font-semibold text-indigo-600 dark:text-indigo-400 hover:underline flex items-center gap-0.5" title="新建知识笔记"><BookOpen className="w-3 h-3" />知识</button>
          </div>
        </div>
      </aside>

      {showNewProjectModal && (
        <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-xs flex items-center justify-center p-4" onClick={() => setShowNewProjectModal(false)}>
          <div className="bg-white dark:bg-slate-900 rounded-2xl p-5 shadow-2xl border border-slate-200 dark:border-slate-800 w-full max-w-sm space-y-4" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100 flex items-center gap-1.5">
              <Folder className="w-4 h-4 text-emerald-600" />
              {newProjectRelation === "sibling" ? "同级新建" : "下级新建"}
              {newProjectTargetId && <span className="text-[11px] font-normal text-slate-500 ml-1">于「{notes.find((n) => n.id === newProjectTargetId)?.title || ""}」</span>}
            </h3>
            <input type="text" autoFocus value={newProjectTitle} onChange={(e) => setNewProjectTitle(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") handleCreateProject(); }} placeholder="项目标题" className="w-full p-2.5 text-xs rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 focus:outline-none focus:ring-2 focus:ring-emerald-500 text-slate-800 dark:text-slate-200" />
            <div className="text-[10px] text-slate-400 text-center">快捷键: Ctrl+Alt+S (同级) | Ctrl+Alt+D (下级)</div>
            <div className="flex justify-end gap-2 pt-2">
              <button onClick={() => setShowNewProjectModal(false)} className="px-3.5 py-1.5 text-xs font-medium text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-xl transition">取消</button>
              <button onClick={handleCreateProject} disabled={!newProjectTitle.trim()} className="px-4 py-1.5 text-xs font-medium rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white shadow-md shadow-emerald-600/20 transition flex items-center gap-1 disabled:opacity-50"><Plus className="w-3 h-3" />创建</button>
            </div>
          </div>
        </div>
      )}

      {showDeleteConfirm && (
        <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-xs flex items-center justify-center p-4" onClick={() => setShowDeleteConfirm(null)}>
          <div className="bg-white dark:bg-slate-900 rounded-2xl p-5 shadow-2xl border border-slate-200 dark:border-slate-800 w-full max-w-sm space-y-4" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100 flex items-center gap-1.5">
              <Trash2 className="w-4 h-4 text-red-500" />确认删除项目
            </h3>
            <p className="text-xs text-slate-600 dark:text-slate-300">
              确定要删除项目 <strong>{showDeleteConfirm.title}</strong> 吗？
              {showDeleteConfirm.childCount > 0 && (
                <span className="block mt-1 text-red-500">该项目下包含 <strong>{showDeleteConfirm.childCount}</strong> 个子项目，将一并删除。</span>
              )}
            </p>
            <div className="flex justify-end gap-2 pt-2">
              <button onClick={() => setShowDeleteConfirm(null)} className="px-3.5 py-1.5 text-xs font-medium text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-xl transition">取消</button>
              <button onClick={() => { if (onDeleteProject) onDeleteProject(showDeleteConfirm.id); setShowDeleteConfirm(null); }} className="px-4 py-1.5 text-xs font-medium rounded-xl bg-red-600 hover:bg-red-700 text-white shadow-md shadow-red-600/20 transition flex items-center gap-1"><Trash2 className="w-3 h-3" />删除</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};