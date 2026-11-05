import React from 'react';
import type { SyncStatus, ViewMode } from '../types';
import {
  BookOpen,
  CalendarRange,
  Clock3,
  FileText,
  FolderOpen,
  Home,
  Network,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Settings,
  ShieldCheck,
} from 'lucide-react';
import { WindowControls } from './WindowControls';
import { LogiNoteLogoMark } from './LogiNoteLogo';
import { CommunityEntry } from './CommunityEntry';

interface WorkspaceNavigationProps {
  currentView: ViewMode;
  onSelectView: (view: ViewMode) => void;
  onOpenLearn: () => void;
  onOpenReview: () => void;
  onOpenPrivacy: () => void;
}

interface WorkspaceTopbarProps {
  onOpenCommandPalette: () => void;
  syncStatus: SyncStatus;
  onTriggerSync: () => void;
}

interface NavigationItem {
  id: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  active: (view: ViewMode) => boolean;
  action: () => void;
}

const WORKSPACE_NAV_EXPANDED_KEY = 'loginote_workspace_nav_expanded_v1';

export const WorkspaceNavigation: React.FC<WorkspaceNavigationProps> = ({
  currentView,
  onSelectView,
  onOpenLearn,
  onOpenReview,
  onOpenPrivacy,
}) => {
  const [isExpanded, setIsExpanded] = React.useState(() => {
    try {
      return window.localStorage.getItem(WORKSPACE_NAV_EXPANDED_KEY) === 'true';
    } catch {
      return false;
    }
  });

  const toggleExpanded = () => {
    setIsExpanded((expanded) => {
      const next = !expanded;
      try {
        window.localStorage.setItem(WORKSPACE_NAV_EXPANDED_KEY, String(next));
      } catch {
        // The navigation still works when browser storage is unavailable.
      }
      return next;
    });
  };

  const items: NavigationItem[] = [
    { id: 'home', label: '首页', icon: Home, active: (view) => view === 'home' || view === 'profile' || view === 'profile-evidence', action: () => onSelectView('home') },
    { id: 'notes', label: '笔记', icon: FileText, active: (view) => view === 'editor', action: () => onSelectView('editor') },
    { id: 'learn', label: '学习', icon: BookOpen, active: (view) => view === 'learn', action: onOpenLearn },
    { id: 'review', label: '复习', icon: Clock3, active: (view) => view === 'bubble' || view === 'review', action: onOpenReview },
    { id: 'graph', label: '图谱', icon: Network, active: (view) => view === 'graph', action: () => onSelectView('graph') },
    { id: 'plan', label: '计划', icon: CalendarRange, active: (view) => view === 'timeline' || view === 'plan', action: () => onSelectView('timeline') },
    { id: 'documents', label: '资料', icon: FolderOpen, active: (view) => view === 'documents', action: () => onSelectView('documents') },
  ];

  return (
    <aside className={`workspace-navigation ${isExpanded ? 'is-expanded' : 'is-collapsed'}`} aria-label="全局功能导航">
      <button className="workspace-brand app-no-drag" onClick={() => onSelectView('home')} aria-label="返回 LogiNote 首页">
        <span className="workspace-brand-mark" aria-hidden="true"><LogiNoteLogoMark /></span>
        <span className="workspace-brand-name">LogiNote</span>
      </button>
      <button
        type="button"
        className="workspace-nav-toggle app-no-drag"
        onClick={toggleExpanded}
        aria-label={isExpanded ? '收起全局导航' : '展开全局导航'}
        aria-expanded={isExpanded}
        title={isExpanded ? '收起导航' : '展开导航'}
      >
        {isExpanded ? <PanelLeftClose aria-hidden="true" /> : <PanelLeftOpen aria-hidden="true" />}
      </button>

      <nav className="workspace-nav-list">
        {items.map((item) => {
          const Icon = item.icon;
          const selected = item.active(currentView);
          return (
            <button
              key={item.id}
              type="button"
              className={`workspace-nav-item${selected ? ' is-active' : ''}`}
              aria-current={selected ? 'page' : undefined}
              aria-label={item.label}
              title={item.label}
              onClick={item.action}
            >
              <Icon className="workspace-nav-icon" />
              <span>{item.label}</span>
            </button>
          );
        })}
        <CommunityEntry />
      </nav>

      <div className="workspace-nav-footer">
        <button type="button" className="workspace-nav-item" onClick={onOpenPrivacy} title="隐私与本地数据" aria-label="隐私与本地数据">
          <ShieldCheck className="workspace-nav-icon" />
          <span>隐私</span>
        </button>
        <button
          type="button"
          className={`workspace-nav-item${currentView === 'settings' ? ' is-active' : ''}`}
          onClick={() => onSelectView('settings')}
          aria-current={currentView === 'settings' ? 'page' : undefined}
          aria-label="设置"
          title="设置"
        >
          <Settings className="workspace-nav-icon" />
          <span>设置</span>
        </button>
        <div className="workspace-growth-signature" aria-hidden="true">
          <span className="workspace-growth-logic"><i /><i /><i /></span>
          <strong>静默生长</strong>
          <small>让知识在时间里形成结构</small>
        </div>
      </div>
    </aside>
  );
};

export const WorkspaceTopbar: React.FC<WorkspaceTopbarProps> = ({
  onOpenCommandPalette,
  syncStatus,
  onTriggerSync,
}) => {
  const searchShortcut = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/i.test(navigator.platform) ? '⌘K' : 'Ctrl+K';
  const handleTitleBarDoubleClick = (event: React.MouseEvent<HTMLElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest('button, a, input, select, textarea, .app-no-drag')) return;
    (window as any).electronAPI?.windowControls?.toggleMaximize();
  };

  return (
    <header className="workspace-topbar app-drag-region" onDoubleClick={handleTitleBarDoubleClick}>
      <button
        type="button"
        className="workspace-search app-no-drag"
        onClick={onOpenCommandPalette}
        aria-label="搜索笔记或选择快捷操作"
      >
        <Search aria-hidden="true" />
        <span>搜索笔记或选择快捷操作…</span>
        <kbd>{searchShortcut}</kbd>
      </button>

      <div className="workspace-topbar-actions">
        <button
          type="button"
          className="workspace-local-status app-no-drag"
          onClick={onTriggerSync}
          title={syncStatus.statusText || '打开本地数据目录'}
        >
          <ShieldCheck aria-hidden="true" />
          <span>{syncStatus.isSyncing ? '正在整理本地数据' : '学习数据仅在本地存储'}</span>
        </button>
        <WindowControls />
      </div>
    </header>
  );
};
