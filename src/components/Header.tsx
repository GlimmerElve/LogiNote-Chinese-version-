import React from "react";
import { ViewMode, VaultSettings, SyncStatus } from "../types";
import {
  FileText,
  Network,
  Calendar,
  Settings,
  Search,
  ShieldCheck,
  BookOpen,
  FolderOpen,
} from "lucide-react";
import { WindowControls } from "./WindowControls";

interface HeaderProps {
  currentView: ViewMode;
  onSelectView: (view: ViewMode) => void;
  onOpenCommandPalette: () => void;
  onOpenLearn: () => void;
  onNewNote: () => void;
  settings: VaultSettings;
  onUpdateSettings: (s: Partial<VaultSettings>) => void;
  syncStatus: SyncStatus;
  onTriggerSync: () => void;
  onOpenPrivacy: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  currentView,
  onSelectView,
  onOpenCommandPalette,
  onOpenLearn,
  onNewNote,
  settings,
  onUpdateSettings,
  syncStatus,
  onTriggerSync,
  onOpenPrivacy
}) => {
  const getAccentBg = (mode: ViewMode) => {
    if (currentView !== mode) return "text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800";
    switch (settings.accentColor) {
      case "purple":
        return "bg-purple-600 text-white shadow-sm font-semibold";
      case "emerald":
        return "bg-emerald-600 text-white shadow-sm font-semibold";
      case "coral":
        return "bg-[#FF8C69] text-white shadow-sm font-semibold";
      case "rose":
        return "bg-[#FB7185] text-white shadow-sm font-semibold";
      case "amber":
        return "bg-amber-600 text-white shadow-sm font-semibold";
      case "teal":
        return "bg-[#14B8A6] text-white shadow-sm font-semibold";
      case "slate":
        return "bg-slate-800 text-white shadow-sm font-semibold";
      default:
        return "bg-indigo-600 text-white shadow-sm font-semibold";
    }
  };

  const handleTitleBarDoubleClick = (e: React.MouseEvent<HTMLElement>) => {
    const target = e.target as HTMLElement;
    if (target.closest("button, a, input, select, textarea, .app-no-drag")) return;
    (window as any).electronAPI?.windowControls?.toggleMaximize();
  };

  return (
    <header
      className="sticky top-0 z-30 h-14 backdrop-blur-md bg-white/80 dark:bg-slate-900/80 border-b border-gray-200/80 dark:border-slate-800/80 px-4 flex items-center justify-between transition-colors app-drag-region"
      onDoubleClick={handleTitleBarDoubleClick}
    >
      {/* Left section: App Icon & Brand */}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2.5 cursor-pointer" onClick={() => onSelectView("editor")}>
          <div className="w-8 h-8 flex items-center justify-center text-slate-700 dark:text-slate-200">
            <BookOpen className="w-5 h-5" />
          </div>
          <div>
            <h1 className="text-sm font-semibold tracking-tight text-slate-900 dark:text-slate-100 flex items-center gap-1.5" style={{ fontFamily: 'var(--font-display)' }}>
              LogiNote <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full text-slate-500 dark:text-slate-400 border border-slate-300/70 dark:border-slate-600/70">Pro</span>
            </h1>
            <p className="text-[10px] text-slate-500 dark:text-slate-400 -mt-0.5 hidden sm:block">
              智能分词 · 双向链接 · 时序提醒
            </p>
          </div>
        </div>

      </div>

      {/* Middle section: iOS Segmented Control Navigation */}
      <div className="flex items-center p-1 bg-slate-100/90 dark:bg-slate-900/90 rounded-xl border border-gray-200/80 dark:border-slate-800/80 shadow-xs">
        <button
          onClick={() => onSelectView("editor")}
          className={`px-3 py-1 rounded-lg text-xs transition flex items-center gap-1.5 ${getAccentBg("editor")}`}
        >
          <FileText className="w-3.5 h-3.5" />
          <span>笔记</span>
        </button>
        <button
          onClick={onOpenLearn}
          className={`px-3 py-1 rounded-lg text-xs transition flex items-center gap-1.5 ${getAccentBg("learn")}`}
        >
          <BookOpen className="w-3.5 h-3.5" />
          <span>学习</span>
        </button>
        <button
          onClick={() => onSelectView("graph")}
          className={`px-3 py-1 rounded-lg text-xs transition flex items-center gap-1.5 ${getAccentBg("graph")}`}
        >
          <Network className="w-3.5 h-3.5" />
          <span>知识图谱</span>
        </button>
        <button
          onClick={() => onSelectView("timeline")}
          className={`px-3 py-1 rounded-lg text-xs transition flex items-center gap-1.5 ${getAccentBg("timeline")}`}
        >
          <Calendar className="w-3.5 h-3.5" />
          <span>时序计划</span>
        </button>
        <button
          onClick={() => onSelectView("documents")}
          className={`px-3 py-1 rounded-lg text-xs transition flex items-center gap-1.5 ${getAccentBg("documents")}`}
        >
          <FolderOpen className="w-3.5 h-3.5" />
          <span>资料</span>
        </button>
      </div>

      {/* Right section: Global Actions */}
      <div className="flex items-center gap-2">
        {/* Global Search Command Palette */}
        <button
          onClick={onOpenCommandPalette}
          className="p-2 rounded-xl text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition flex items-center gap-1 text-xs border border-transparent hover:border-slate-200 dark:hover:border-slate-700"
          title="搜索与搜索命令 (Cmd+K)"
        >
          <Search className="w-4 h-4" />
          <kbd className="hidden sm:inline-block px-1.5 py-0.5 text-[10px] font-semibold text-slate-500 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded">
            ⌘K
          </kbd>
        </button>

        {/* Open Data Folder */}
        <button
          onClick={onTriggerSync}
          className="p-2 rounded-xl text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition flex items-center gap-1"
          title={syncStatus.statusText || "打开数据目录（本地备份）"}
        >
          <FolderOpen className="w-4 h-4" />
        </button>

        {/* Privacy Protocol Badge */}
        <button
          onClick={onOpenPrivacy}
          className="p-2 rounded-xl text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition"
          title="隐私协议与协议规范"
        >
          <ShieldCheck className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
        </button>

        {/* Settings View */}
        <button
          onClick={() => onSelectView("settings")}
          className={`p-2 rounded-xl text-xs transition ${
            currentView === "settings"
              ? "bg-slate-200 dark:bg-slate-800 text-slate-900 dark:text-slate-100"
              : "text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
          }`}
          title="系统与云端配置"
        >
          <Settings className="w-4 h-4" />
        </button>

        {/* Windows 风格窗口控制（仅 Electron 渲染） */}
        <WindowControls />
      </div>
    </header>
  );
};