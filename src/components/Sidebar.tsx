import React, { useState, useEffect, useLayoutEffect, useRef, useId } from "react";
import { createPortal } from 'react-dom';
import { useDialog } from './useDialog';
import { NoteItem, NoteType, VaultSettings } from "../types";
import { matchesNoteSearch } from '../services/noteSearch';
import {
  FileText, Star, Folder, Plus, Trash2, ChevronRight, ChevronDown,
  Search, Layers, X, PanelLeftClose, PanelLeftOpen,
} from "lucide-react";

const NOTE_NAVIGATOR_COLLAPSED_KEY = 'loginote.note-navigator-collapsed.v1';

/** Owned by the workspace so visiting another page does not reset the tree. */
export interface SidebarTreeSnapshot {
  expandedIds: Set<string>;
  rootIds: Set<string>;
  activePath: string;
  revealRevision: number;
}

interface SidebarProps {
  notes: NoteItem[];
  /** Search may read the authoritative draft without publishing whole-App state. */
  getNotes?: () => NoteItem[];
  activeNoteId: string | null;
  onSelectNote: (id: string) => void;
  onNewNote: (type: NoteType, parentId?: string, title?: string) => void;
  onDeleteNote: (id: string, e: React.MouseEvent) => void;
  onToggleFavorite: (id: string, e: React.MouseEvent) => void;
  onTogglePin: (id: string, e: React.MouseEvent) => void;
  settings: VaultSettings;
  onDeleteProject?: (id: string) => void | Promise<void>;
  treeStateRef?: React.MutableRefObject<SidebarTreeSnapshot | null>;
  revealRevision?: number;
}

interface TreeNode {
  note: SidebarNoteProjection;
  children: TreeNode[];
  count: number;
}

/** Display identity excludes bodies/timestamps. Search reads the current source
 * through getters, so reusing a tree never freezes a newer saved body/alias. */
export interface SidebarNoteProjection extends Pick<NoteItem, 'id' | 'title' | 'parentId' | 'noteType' | 'tags' | 'isFavorite'> {
  readonly content: string;
  readonly aliases: NoteItem['aliases'];
}
export interface SidebarProjection {
  byId: Map<string, SidebarNoteProjection>;
  projectNotes: SidebarNoteProjection[];
  projectTree: TreeNode[];
  projectIds: Set<string>;
  rootIds: Set<string>;
  parentIds: Set<string | undefined>;
  descendantCounts: Map<string, number>;
  rootProjectCount: number;
  favoriteCount: number;
}
const sameSidebarList = <T,>(left: readonly T[], right: readonly T[]) => left === right
  || left.length === right.length && left.every((value, index) => value === right[index]);

/** Functional parent graphs admit a linear leaf reduction. Remaining vertices
 * are disjoint cycles; each member reaches that cycle and its attached trees.
 * No recursion or per-row descendant scan is needed, even for corrupt cycles. */
function sidebarDescendantCounts(notes: readonly SidebarNoteProjection[]): Map<string, number> {
  const byId = new Map(notes.map(note => [note.id, note]));
  const remaining = new Map(notes.map(note => [note.id, 0]));
  const sizes = new Map(notes.map(note => [note.id, 1]));
  for (const note of notes) if (note.parentId && byId.has(note.parentId))
    remaining.set(note.parentId, remaining.get(note.parentId)! + 1);
  const queue = notes.filter(note => remaining.get(note.id) === 0).map(note => note.id);
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const id = queue[cursor], parentId = byId.get(id)!.parentId;
    if (!parentId || !byId.has(parentId)) continue;
    sizes.set(parentId, sizes.get(parentId)! + sizes.get(id)!);
    remaining.set(parentId, remaining.get(parentId)! - 1);
    if (remaining.get(parentId) === 0) queue.push(parentId);
  }
  const visited = new Set<string>();
  for (const note of notes) {
    if (!remaining.get(note.id) || visited.has(note.id)) continue;
    const cycle: string[] = [];
    let id: string | undefined = note.id;
    while (id && !visited.has(id) && remaining.get(id)) {
      visited.add(id); cycle.push(id); id = byId.get(id)?.parentId;
    }
    const size = cycle.reduce((sum, key) => sum + sizes.get(key)!, 0);
    for (const key of cycle) sizes.set(key, size);
  }
  return new Map(notes.map(note => [note.id, sizes.get(note.id)! - 1]));
}

/** Instance-local immutable-snapshot projection; only source references change
 * on an ordinary body save. Unchanged display rows/tree retain their identity. */
export function createSidebarProjection() {
  let priorNotes: NoteItem[] | undefined, priorRows: SidebarNoteProjection[] = [];
  let latest = new Map<string, NoteItem>(), priorById = new Map<string, SidebarNoteProjection>();
  let projection: SidebarProjection | undefined;
  return (notes: NoteItem[]): SidebarProjection => {
    if (notes === priorNotes && projection) return projection;
    latest = new Map(notes.map(note => [note.id, note]));
    const rows: SidebarNoteProjection[] = [];
    for (const note of latest.values()) {
      const before = priorById.get(note.id), tags = note.tags || [];
      if (before && before.title === note.title && before.parentId === note.parentId && before.noteType === note.noteType
        && Boolean(before.isFavorite) === Boolean(note.isFavorite) && sameSidebarList(before.tags, tags)) rows.push(before);
      else {
        const id = note.id;
        rows.push({ id, title: note.title, parentId: note.parentId, noteType: note.noteType,
          tags: [...tags], isFavorite: Boolean(note.isFavorite),
          get content() { return latest.get(id)?.content || ''; },
          get aliases() { return latest.get(id)?.aliases; } });
      }
    }
    priorNotes = notes;
    if (projection && sameSidebarList(rows, priorRows)) return projection;
    priorRows = rows; priorById = new Map(rows.map(note => [note.id, note]));
    const projectNotes = rows.filter(note => note.noteType === 'project');
    const counts = sidebarDescendantCounts(projectNotes);
    const nodes = new Map(projectNotes.map(note => [note.id, { note, children: [] as TreeNode[], count: counts.get(note.id)! + 1 }]));
    const projectTree: TreeNode[] = [];
    for (const node of nodes.values()) {
      if (!node.note.parentId) projectTree.push(node);
      else nodes.get(node.note.parentId)?.children.push(node);
    }
    projection = { byId: priorById, projectNotes, projectTree,
      projectIds: new Set(projectNotes.map(note => note.id)), rootIds: new Set(projectTree.map(node => node.note.id)),
      parentIds: new Set(projectNotes.map(note => note.parentId)), descendantCounts: sidebarDescendantCounts(rows),
      rootProjectCount: projectTree.length, favoriteCount: projectNotes.filter(note => note.isFavorite).length };
    return projection;
  };
}

/** Keep search semantics shared with the ordinary note search. */
function filterSidebarProjects(projectNotes: SidebarNoteProjection[], searchQuery: string, selectedTag: string | null,
  filterMode: 'all' | 'project' | 'favorites') {
  const filteredNotes = projectNotes.filter((note) => {
    const matchesSearch = matchesNoteSearch(note, searchQuery);
    const matchesTag = !selectedTag || note.tags.includes(selectedTag);
    if (filterMode === "project") return !note.parentId && matchesSearch && matchesTag;
    if (filterMode === "favorites") return !!note.isFavorite && matchesSearch && matchesTag;
    return matchesSearch && matchesTag;
  });
  return filteredNotes;
}

interface NoteStatusMenuPosition {
  noteId: string;
  x: number;
  y: number;
  origin: HTMLButtonElement | null;
}

function NoteStatusMenu({ position, note, onClose, onToggleFavorite }: {
  position: NoteStatusMenuPosition;
  note: SidebarNoteProjection;
  onClose: () => void;
  onToggleFavorite: SidebarProps['onToggleFavorite'];
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useLayoutEffect(() => {
    const menu = menuRef.current!;
    const bounds = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(position.x, window.innerWidth - bounds.width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(position.y, window.innerHeight - bounds.height - 8))}px`;
    menu.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
    const dismissOutside = (event: Event) => {
      if (!menu.contains(event.target as Node)) closeRef.current();
    };
    const dismiss = () => closeRef.current();
    document.addEventListener('pointerdown', dismissOutside, true);
    document.addEventListener('focusin', dismissOutside);
    window.addEventListener('resize', dismiss);
    window.addEventListener('scroll', dismiss, true);
    return () => {
      document.removeEventListener('pointerdown', dismissOutside, true);
      document.removeEventListener('focusin', dismissOutside);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('scroll', dismiss, true);
    };
  }, [position]);

  const closeAndRestoreFocus = () => {
    onClose();
    if (position.origin?.isConnected) position.origin.focus({ preventScroll: true });
  };

  return createPortal(
    <div ref={menuRef} role="menu" aria-label={`「${note.title || '未命名项目'}」笔记状态`} className="note-status-menu" style={{ left: position.x, top: position.y }}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Escape' || event.key === 'Tab') {
          event.preventDefault();
          closeAndRestoreFocus();
          return;
        }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button'));
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items[next]?.focus();
      }}>
      <span className="note-status-menu-title">{note.title || '未命名项目'}</span>
      {note.noteType === 'knowledge' && <>
        <button type="button" role="menuitem" onClick={() => { closeAndRestoreFocus(); window.dispatchEvent(new CustomEvent('loginote:knowledge-maintenance', { detail: { kind: 'merge', ids: [note.id] } })); }}>合并知识点笔记…</button>
        <button type="button" role="menuitem" onClick={() => { closeAndRestoreFocus(); window.dispatchEvent(new CustomEvent('loginote:knowledge-maintenance', { detail: { kind: 'delete', ids: [note.id] } })); }}>删除知识点笔记…</button>
      </>}
      <button type="button" role="menuitemcheckbox" aria-checked={Boolean(note.isFavorite)} onClick={(event) => { closeAndRestoreFocus(); onToggleFavorite(note.id, event); }}>
        <span>{note.isFavorite ? '取消收藏' : '收藏'}</span><span aria-hidden="true">{note.isFavorite ? '✓' : ''}</span>
      </button>
    </div>, document.body,
  );
}

export const countProjectDescendants = (notes: NoteItem[], projectId: string): number => {
  const children = new Map<string, string[]>();
  for (const note of notes) if (note.parentId) {
    if (!children.has(note.parentId)) children.set(note.parentId, []);
    children.get(note.parentId)!.push(note.id);
  }
  const descendants = new Set<string>();
  const pending = [projectId];
  while (pending.length > 0) {
    const parentId = pending.pop()!;
    for (const childId of children.get(parentId) || [])
      if (childId !== projectId && !descendants.has(childId)) { descendants.add(childId); pending.push(childId); }
  }
  return descendants.size;
};

export const Sidebar: React.FC<SidebarProps> = ({
  notes, getNotes, activeNoteId, onSelectNote, onNewNote, onToggleFavorite, onDeleteProject,
  treeStateRef, revealRevision = 0,
}) => {
  const project = useRef<ReturnType<typeof createSidebarProjection> | null>(null);
  if (!project.current) project.current = createSidebarProjection();
  const callbacks = useRef({ onSelectNote, onNewNote, onToggleFavorite, onDeleteProject });
  callbacks.current = { onSelectNote, onNewNote, onToggleFavorite, onDeleteProject };
  const workspaceTree = useRef(treeStateRef); workspaceTree.current = treeStateRef;
  const [isCollapsed, setIsCollapsed] = useState(() => {
    try { return window.localStorage.getItem(NOTE_NAVIGATOR_COLLAPSED_KEY) === 'true'; }
    catch { return false; }
  });
  const [searchQuery, setSearchQuery] = useState("");
  const searchSource = searchQuery ? getNotes?.() || notes : notes;
  const directory = project.current(searchSource);
  const currentDirectory = useRef(directory); currentDirectory.current = directory;
  const [searchOpen, setSearchOpen] = useState(false);
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [filterMode, setFilterMode] = useState<"all" | "project" | "favorites">("all");
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [expandedIds, setExpandedIdsState] = useState<Set<string>>(() => new Set(treeStateRef?.current?.expandedIds));
  const treeExpansionRef = useRef({
    rootIds: treeStateRef?.current?.rootIds ?? new Set<string>(),
    activePath: treeStateRef?.current?.activePath ?? '',
    revealRevision: treeStateRef?.current?.revealRevision ?? revealRevision,
  });
  const setExpandedIds: React.Dispatch<React.SetStateAction<Set<string>>> = update => {
    setExpandedIdsState(previous => {
      const next = typeof update === 'function' ? update(previous) : update;
      if (workspaceTree.current) workspaceTree.current.current = { ...treeExpansionRef.current, expandedIds: next };
      return next;
    });
  };
  const [statusMenu, setStatusMenu] = useState<NoteStatusMenuPosition | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState<{ id: string; title: string; childCount: number } | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const sidebarRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const deleteDialogRef = useRef<HTMLDivElement>(null);
  const searchControlsId = useId();
  const navigatorContentId = useId();
  const deleteHeadingId = useId();
  const deleteDescriptionId = useId();
  useDialog(Boolean(showDeleteConfirm), deleteDialogRef, deleteBusy ? undefined : () => setShowDeleteConfirm(null));

  useEffect(() => {
    try { window.localStorage.setItem(NOTE_NAVIGATOR_COLLAPSED_KEY, String(isCollapsed)); }
    catch { /* Local persistence is optional; the in-memory interaction still works. */ }
  }, [isCollapsed]);

  useEffect(() => { setStatusMenu(null); }, [activeNoteId, isCollapsed, filterMode, searchQuery]);

  const openStatusMenu = (event: React.MouseEvent<HTMLDivElement> | React.KeyboardEvent<HTMLDivElement>, note: SidebarNoteProjection) => {
    event.preventDefault();
    event.stopPropagation();
    const origin = event.currentTarget.querySelector<HTMLButtonElement>('.note-tree-open, .note-leaf-open');
    const bounds = (origin || event.currentTarget).getBoundingClientRect();
    setStatusMenu({ noteId: note.id, origin, x: 'clientX' in event ? event.clientX : bounds.left + 16, y: 'clientY' in event ? event.clientY : bounds.bottom });
  };
  const handleStatusMenuKey = (event: React.KeyboardEvent<HTMLDivElement>, note: SidebarNoteProjection) => {
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) openStatusMenu(event, note);
  };
  const statusMenuNote = statusMenu ? directory.byId.get(statusMenu.noteId) : undefined;
  const { projectNotes, projectTree, rootProjectCount, favoriteCount } = directory;
  const projectCount = projectNotes.length;

  const filtered = useRef<{ source: NoteItem[]; projects: SidebarNoteProjection[]; query: string; tag: string | null;
    mode: typeof filterMode; value: SidebarNoteProjection[] } | null>(null);
  if (!filtered.current || filtered.current.projects !== projectNotes || filtered.current.query !== searchQuery
    || filtered.current.tag !== selectedTag || filtered.current.mode !== filterMode
    || Boolean(searchQuery.trim()) && filtered.current.source !== searchSource) {
    filtered.current = { source: searchSource, projects: projectNotes, query: searchQuery, tag: selectedTag, mode: filterMode,
      value: filterSidebarProjects(projectNotes, searchQuery, selectedTag, filterMode) };
  }

  const toggleExpand = (id: string) => setExpandedIds((prev) => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next; });

  const noteCountInTree = (node: TreeNode): number => node.count;
  const requestProjectDelete = (note: SidebarNoteProjection) => {
    if (!callbacks.current.onDeleteProject) return;
    setDeleteError('');
    setShowDeleteConfirm({ id: note.id, title: note.title || '未命名项目', childCount: currentDirectory.current.descendantCounts.get(note.id) || 0 });
  };
  const confirmProjectDelete = async () => {
    if (!showDeleteConfirm || !onDeleteProject || deleteBusy) return;
    setDeleteBusy(true);
    setDeleteError('');
    try {
      await onDeleteProject(showDeleteConfirm.id);
      setShowDeleteConfirm(null);
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : '项目删除失败，原内容仍保留，请重试。');
    } finally {
      setDeleteBusy(false);
    }
  };
  const openProject = (note: SidebarNoteProjection) => { setSelectedProjectId(note.id); callbacks.current.onSelectNote(note.id); };
  // Static masks preserve the Lucide artwork without a styled SVG/path tree
  // per button. Labels and keyboard targets remain on the original buttons.
  const actionIcon = (kind: 'add' | 'delete') => <span aria-hidden="true" className={`note-action-icon is-${kind}`} />;

  const renderTreeNode = (node: TreeNode, depth: number = 0): React.ReactNode => {
    const isActive = node.note.id === activeNoteId;
    const isSelected = node.note.id === selectedProjectId;
    return (
      <div key={node.note.id}>
        <div
          onContextMenu={(event) => openStatusMenu(event, node.note)}
          onKeyDown={(event) => handleStatusMenuKey(event, node.note)}
          className={`note-tree-row ${depth === 0 ? 'is-root' : 'is-child'} ${isActive ? 'is-active' : isSelected ? 'is-selected' : ''}`}
          style={{ paddingLeft: `${10 + depth * 18}px` }}>
          {node.children.length > 0 ? (
            <button type="button" onClick={() => toggleExpand(node.note.id)} className="note-tree-toggle" aria-expanded={expandedIds.has(node.note.id)} aria-label={`${expandedIds.has(node.note.id) ? '收起' : '展开'}「${node.note.title || '未命名项目'}」子项目`}>
              {expandedIds.has(node.note.id) ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
            </button>
          ) : <span className="note-tree-toggle-spacer" aria-hidden="true" />}
          <button type="button" className="note-tree-open" onClick={() => openProject(node.note)} aria-current={isActive ? 'page' : undefined} title={`打开「${node.note.title || '未命名项目'}」`}>
            {depth === 0
              ? <Folder aria-hidden="true" />
              : <FileText aria-hidden="true" />}
            <span>{node.note.title || "未命名项目"}</span>
            <span className="note-tree-count" aria-label={`含自身共 ${noteCountInTree(node)} 个项目`}>{noteCountInTree(node)}</span>
          </button>
          <div className="note-tree-actions">
            <button type="button" onClick={() => { callbacks.current.onNewNote("project", node.note.id, '新子项目'); setExpandedIds((prev) => new Set([...prev, node.note.id])); }} title="新建子项目" aria-label={`在「${node.note.title || '未命名项目'}」下新建子项目`}>{actionIcon('add')}</button>
            <button type="button" onClick={() => requestProjectDelete(node.note)} className="is-danger" disabled={!onDeleteProject} title="删除项目" aria-label={`删除项目「${node.note.title || '未命名项目'}」`}>{actionIcon('delete')}</button>
          </div>
        </div>
        {expandedIds.has(node.note.id) && node.children.map((c) => renderTreeNode(c, depth + 1))}
      </div>
    );
  };

  const renderProjectCard = (note: SidebarNoteProjection) => {
    const isActive = note.id === activeNoteId;
    return (
      <div key={note.id} className={`note-leaf-card ${isActive ? 'is-active' : ''}`} onContextMenu={(event) => openStatusMenu(event, note)} onKeyDown={(event) => handleStatusMenuKey(event, note)}>
        <div className="note-leaf-main">
          <button type="button" className="note-leaf-open" onClick={() => openProject(note)} aria-current={isActive ? 'page' : undefined} title={`打开「${note.title || '未命名项目'}」`}>
            <Folder className="note-leaf-icon is-folder" aria-hidden="true" />
            <span>{note.title || "未命名项目"}</span>
          </button>
          <div className="note-leaf-actions">
            <button type="button" onClick={() => requestProjectDelete(note)} className="is-danger" disabled={!onDeleteProject} title="删除项目" aria-label={`删除项目「${note.title || '未命名项目'}」`}>{actionIcon('delete')}</button>
          </div>
        </div>
      </div>
    );
  };

  const showTree = filterMode === "all" && !searchQuery && !selectedTag;
  const searchControlsVisible = searchOpen || Boolean(searchQuery) || filterMode !== 'all';

  const displayNotes = filtered.current.value;
  // Reuse the native element subtree as well as its data. React can bail out
  // unchanged rows on save/parent callback churn without freezing event actions.
  const treeView = useRef<{ directory: SidebarProjection; expanded: Set<string>; active: string | null; selected: string | null;
    deletable: boolean; value: React.ReactNode } | null>(null);
  const cardsView = useRef<{ notes: SidebarNoteProjection[]; active: string | null; deletable: boolean; value: React.ReactNode } | null>(null);
  const deletable = Boolean(onDeleteProject);
  if (showTree && (!treeView.current || treeView.current.directory !== directory || treeView.current.expanded !== expandedIds
    || treeView.current.active !== activeNoteId || treeView.current.selected !== selectedProjectId || treeView.current.deletable !== deletable)) {
    treeView.current = { directory, expanded: expandedIds, active: activeNoteId, selected: selectedProjectId, deletable,
      value: <div className="note-notebook-list">{projectTree.map(node => <section className="note-notebook-group" key={node.note.id}>{renderTreeNode(node)}</section>)}</div> };
  }
  if (!showTree && (!cardsView.current || !sameSidebarList(cardsView.current.notes, displayNotes)
    || cardsView.current.active !== activeNoteId || cardsView.current.deletable !== deletable)) {
    cardsView.current = { notes: displayNotes, active: activeNoteId, deletable,
      value: <div className="space-y-2">{displayNotes.map(renderProjectCard)}</div> };
  }

  // Only new roots receive the initial expansion. Later note writes and filter
  // changes must not undo a folder the user explicitly collapsed. Navigation
  // reveals the selected project's ancestors, including after a parent move.
  useEffect(() => {
    const { byId, projectNotes: projects, projectIds, rootIds, parentIds } = directory;
    const previous = treeExpansionRef.current;
    const newRoots = projects.filter(note => rootIds.has(note.id) && !previous.rootIds.has(note.id)
      && parentIds.has(note.id));
    const ancestors: string[] = [];
    const visited = new Set<string>();
    let parentId = activeNoteId ? byId.get(activeNoteId)?.parentId : undefined;
    while (parentId && !visited.has(parentId)) {
      visited.add(parentId);
      const parent = byId.get(parentId);
      if (!parent) break;
      if (parent.noteType === 'project') ancestors.push(parent.id);
      parentId = parent.parentId;
    }
    const activePath = JSON.stringify([activeNoteId, ...ancestors]);
    treeExpansionRef.current = { rootIds, activePath, revealRevision };
    setExpandedIds(prev => {
      const next = new Set([...prev].filter(id => projectIds.has(id)));
      newRoots.forEach(note => next.add(note.id));
      if (previous.activePath !== activePath || previous.revealRevision !== revealRevision) ancestors.forEach(id => next.add(id));
      return next.size === prev.size && [...next].every(id => prev.has(id)) ? prev : next;
    });
    setSelectedProjectId(activeNoteId && byId.get(activeNoteId)?.noteType === 'project' ? activeNoteId : null);
  }, [activeNoteId, directory, revealRevision]);

  return (
    <>
      <aside ref={sidebarRef} className={`note-navigator ${isCollapsed ? 'is-collapsed' : ''}`} aria-label="项目与笔记导航">
        <button
          type="button"
          className="note-navigator-expand"
          onClick={() => setIsCollapsed(false)}
          aria-label="展开笔记目录"
          aria-expanded={false}
          aria-controls={navigatorContentId}
          title="展开笔记目录"
        >
          <PanelLeftOpen aria-hidden="true" />
        </button>

        <div id={navigatorContentId} className="note-navigator-inner" inert={isCollapsed} aria-hidden={isCollapsed}>
          <div className="note-navigator-head">
            <strong>我的笔记</strong>
            <div className="note-navigator-head-actions">
              <button type="button" onClick={() => setSearchOpen((open) => !open)} aria-label="搜索项目笔记" aria-expanded={searchControlsVisible} aria-controls={searchControlsId} title="搜索项目笔记"><Search aria-hidden="true" /></button>
              <button type="button" onClick={() => setIsCollapsed(true)} aria-label="收起笔记目录" aria-expanded={true} aria-controls={navigatorContentId} title="收起笔记目录"><PanelLeftClose aria-hidden="true" /></button>
            </div>
          </div>

          {searchControlsVisible && (
            <div id={searchControlsId} className="note-navigator-controls">
              <div className="note-navigator-search-wrap">
                <Search aria-hidden="true" />
                <input ref={searchRef} autoFocus={searchOpen} type="text" aria-label="搜索项目笔记" placeholder="搜索项目笔记或 #标签…" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} className="note-navigator-search" />
                {searchQuery && <button type="button" className="note-search-clear" onClick={() => { setSearchOpen(true); setSearchQuery(''); searchRef.current?.focus(); }} aria-label="清除搜索" title="清除搜索"><X aria-hidden="true" /></button>}
              </div>
              <div className="note-filter-list" aria-label="筛选项目笔记">
              <button type="button" aria-pressed={filterMode === "all" && !selectedTag} onClick={() => { setFilterMode("all"); setSelectedTag(null); }} className={`note-filter ${filterMode === "all" && !selectedTag ? 'is-active' : ''}`}>全部<span>{projectCount}</span></button>
              <button type="button" aria-pressed={filterMode === "project"} onClick={() => { setFilterMode("project"); setSelectedTag(null); setSelectedProjectId(null); }} className={`note-filter ${filterMode === "project" ? 'is-active' : ''}`} title="仅显示最上层的根项目"><Layers aria-hidden="true" />根项目<span>{rootProjectCount}</span></button>
              <button type="button" aria-pressed={filterMode === "favorites"} onClick={() => { setFilterMode("favorites"); setSelectedTag(null); }} className={`note-filter ${filterMode === "favorites" ? 'is-active' : ''}`}><Star aria-hidden="true" />收藏<span>{favoriteCount}</span></button>
              </div>
            </div>
          )}

          <div className="note-navigator-scroll">
            {showTree && projectTree.length > 0 && treeView.current?.value}
            {/* Root projects, favorites and search results use a flat list. */}
            {!showTree && cardsView.current?.value}
            {displayNotes.length === 0 && !showTree && (<div className="p-8 text-center"><div className="w-14 h-14 mx-auto mb-3 rounded-2xl playful-empty-icon flex items-center justify-center"><Search className="w-6 h-6 text-slate-400 dark:text-slate-500" /></div><p className="text-slate-400 text-[11px] font-medium">没有找到相关笔记</p><p className="text-slate-400/60 text-[10px] mt-0.5">尝试更换筛选条件或搜索关键词</p></div>)}
            {showTree && projectTree.length === 0 && (<div className="p-8 text-center"><div className="w-14 h-14 mx-auto mb-3 rounded-2xl playful-empty-icon flex items-center justify-center"><Layers className="w-6 h-6 text-slate-400 dark:text-slate-500" /></div><p className="text-slate-400 text-[11px] font-medium">还没有学习项目</p><p className="text-slate-400/60 text-[10px] mt-0.5">点击下方按钮创建你的第一个项目</p></div>)}
          </div>

          <div className="note-navigator-footer">
            <button type="button" onClick={() => { const title = `新笔记本 ${projectCount + 1}`; onNewNote("project", undefined, title); }} title="新建根项目笔记本">
              <Plus aria-hidden="true" />新建根项目
            </button>
            <span>{projectCount} 篇项目笔记</span>
          </div>
        </div>
      </aside>

      {statusMenu && statusMenuNote && <NoteStatusMenu position={statusMenu} note={statusMenuNote} onClose={() => setStatusMenu(null)} onToggleFavorite={onToggleFavorite} />}

      {showDeleteConfirm && (
        <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-xs flex items-center justify-center p-4" onClick={() => { if (!deleteBusy) setShowDeleteConfirm(null); }}>
          <div ref={deleteDialogRef} role="alertdialog" aria-modal="true" aria-labelledby={deleteHeadingId} aria-describedby={deleteDescriptionId} aria-busy={deleteBusy} tabIndex={-1} className="bg-[var(--ln-bg-surface)] text-[var(--ln-text-primary)] rounded-2xl p-5 shadow-2xl border border-[var(--ln-border)] w-full max-w-sm space-y-4" onClick={(e) => e.stopPropagation()}>
            <h3 id={deleteHeadingId} className="text-sm font-bold text-[var(--ln-text-primary)] flex items-center gap-1.5">
              <Trash2 className="w-4 h-4 text-[var(--ln-danger)]" aria-hidden="true" />确认删除项目
            </h3>
            <p id={deleteDescriptionId} className="text-xs text-[var(--ln-text-secondary)]">
              确定要删除项目 <strong>{showDeleteConfirm.title}</strong> 吗？
              {showDeleteConfirm.childCount > 0 && (
                <span className="block mt-1 text-[var(--ln-danger)]">该项目下包含 <strong>{showDeleteConfirm.childCount}</strong> 条子项目或笔记，将一并删除。</span>
              )}
            </p>
            {deleteError && <p role="alert" className="text-xs text-[var(--ln-danger)]">{deleteError}</p>}
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" disabled={deleteBusy} onClick={() => setShowDeleteConfirm(null)} className="note-project-dialog-action">取消</button>
              <button type="button" disabled={deleteBusy} onClick={() => void confirmProjectDelete()} className="note-project-dialog-action is-danger"><Trash2 aria-hidden="true" />{deleteBusy ? '正在删除…' : deleteError ? '重试删除' : '确认删除'}</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};
