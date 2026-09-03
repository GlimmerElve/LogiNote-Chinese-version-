import React, { useState } from "react";
import { NoteItem, DueDateItem, VaultSettings } from "../types";
import confetti from "canvas-confetti";
import {
  Calendar as CalendarIcon,
  Clock,
  CheckCircle2,
  AlertCircle,
  Plus,
  ArrowRight,
  Sparkles,
  Check,
  Tag,
  ChevronLeft,
  ChevronRight,
  ListTodo
} from "lucide-react";

interface TimelineCalendarViewProps {
  notes: NoteItem[];
  onToggleTaskCompleted: (noteId: string, taskId: string) => void;
  onSelectNoteByTitle: (title: string) => void;
  onAddNewScheduleTask: (noteId: string, taskText: string, dateStr: string) => void;
  onOpenPlanBuilder: () => void;
  settings: VaultSettings;
}

export const TimelineCalendarView: React.FC<TimelineCalendarViewProps> = ({
  notes,
  onToggleTaskCompleted,
  onSelectNoteByTitle,
  onAddNewScheduleTask,
  onOpenPlanBuilder,
  settings
}) => {
  const [selectedNoteIdForNewTask, setSelectedNoteIdForNewTask] = useState<string>(notes[0]?.id || "");
  const [newTaskText, setNewTaskText] = useState("");
  const [newTaskDate, setNewTaskDate] = useState(new Date().toISOString().split("T")[0]);
  const [showAddModal, setShowAddModal] = useState(false);

  // Collect all DueDateItems from notes
  const allDueItems: DueDateItem[] = notes.flatMap((n) => n.dueDates || []);

  const todayStr = new Date().toISOString().split("T")[0];

  // Group due items
  const todayItems = allDueItems.filter((i) => i.dueDate === todayStr);
  const overdueItems = allDueItems.filter((i) => i.dueDate < todayStr && !i.completed);
  const upcomingItems = allDueItems.filter((i) => i.dueDate > todayStr && !i.completed);
  const completedItems = allDueItems.filter((i) => i.completed);

  const handleTaskCheck = (item: DueDateItem) => {
    if (!item.completed) {
      // Fire celebration confetti!
      confetti({
        particleCount: 50,
        spread: 60,
        origin: { y: 0.7 }
      });
    }
    onToggleTaskCompleted(item.noteId, item.id);
  };

  const handleCreateTask = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTaskText.trim() || !selectedNoteIdForNewTask) return;
    onAddNewScheduleTask(selectedNoteIdForNewTask, newTaskText, newTaskDate);
    setNewTaskText("");
    setShowAddModal(false);
  };

  return (
    <div className="flex-1 h-[calc(100vh-3.5rem)] p-6 bg-[#F2F2F7] dark:bg-slate-950 overflow-y-auto space-y-6">
      {/* iOS Widget Header Cards */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-slate-900 dark:text-slate-100 flex items-center gap-2">
            <CalendarIcon className="w-5 h-5 text-indigo-600" />
            时序计划与到期提醒中心
          </h1>
          <p className="text-xs text-slate-500 mt-0.5">
            笔记文本内 `@due(YYYY-MM-DD)` 日期标签自动聚合管理
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={onOpenPlanBuilder}
            className="px-4 py-2 rounded-xl border-2 border-indigo-300 dark:border-indigo-700 bg-white dark:bg-slate-800 text-indigo-600 dark:text-indigo-400 text-xs font-semibold hover:bg-indigo-50 dark:hover:bg-indigo-950/40 shadow-sm transition flex items-center gap-1.5"
          >
            <ListTodo className="w-4 h-4" />
            <span>制定学习计划项目</span>
          </button>
          <button
            onClick={() => setShowAddModal(true)}
            className="px-4 py-2 rounded-xl bg-indigo-600 text-white text-xs font-semibold hover:bg-indigo-700 shadow-sm transition flex items-center gap-1.5"
          >
            <Plus className="w-4 h-4" />
            <span>添加时序学习计划</span>
          </button>
        </div>
      </div>

      {/* Summary Widgets Row */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Today's Tasks */}
        <div className="p-4 rounded-2xl bg-white dark:bg-slate-900 shadow-sm flex items-center justify-between comic-stat-card">
          <div>
            <span className="text-[10px] font-bold uppercase tracking-widest text-indigo-600 dark:text-indigo-400">
              Today Plan
            </span>
            <div className="text-2xl font-bold text-slate-900 dark:text-slate-100 mt-0.5">
              {todayItems.length} 项
            </div>
            <p className="text-[10px] text-slate-400 mt-1">今日到期的学习任务</p>
          </div>
          <div className="p-3 rounded-2xl bg-indigo-50 dark:bg-indigo-950/50 text-indigo-500 dark:text-indigo-400 playful-stat-icon">
            <Clock className="w-6 h-6" />
          </div>
        </div>

        {/* Overdue */}
        <div className="p-4 rounded-2xl bg-white dark:bg-slate-900 shadow-sm flex items-center justify-between comic-stat-card">
          <div>
            <span className="text-[10px] font-bold uppercase tracking-wider text-rose-600 dark:text-rose-400">
              Overdue
            </span>
            <div className="text-2xl font-bold text-rose-600 dark:text-rose-400 mt-0.5">
              {overdueItems.length} 项
            </div>
            <p className="text-[10px] text-slate-400 mt-1">需要尽快补完的学习工作</p>
          </div>
          <div className="p-3 rounded-2xl bg-rose-50 dark:bg-rose-950/50 text-rose-500 dark:text-rose-400 playful-stat-icon">
            <AlertCircle className="w-6 h-6" />
          </div>
        </div>

        {/* Upcoming */}
        <div className="p-4 rounded-2xl bg-white dark:bg-slate-900 shadow-sm flex items-center justify-between comic-stat-card">
          <div>
            <span className="text-[10px] font-bold uppercase tracking-wider text-indigo-600 dark:text-indigo-400">
              Upcoming
            </span>
            <div className="text-2xl font-bold text-slate-900 dark:text-slate-100 mt-0.5">
              {upcomingItems.length} 项
            </div>
            <p className="text-[10px] text-slate-400 mt-1">未来计划</p>
          </div>
          <div className="p-3 rounded-2xl bg-blue-50 dark:bg-blue-950/50 text-blue-500 dark:text-blue-400 playful-stat-icon">
            <CalendarIcon className="w-6 h-6" />
          </div>
        </div>

        {/* Completed */}
        <div className="p-4 rounded-2xl bg-white dark:bg-slate-900 shadow-sm flex items-center justify-between comic-stat-card">
          <div>
            <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-600 dark:text-emerald-400">
              Completed
            </span>
            <div className="text-2xl font-bold text-emerald-600 dark:text-emerald-400 mt-0.5">
              {completedItems.length} 项
            </div>
            <p className="text-[10px] text-slate-400 mt-1">已达成学习目标</p>
          </div>
          <div className="p-3 rounded-2xl bg-emerald-50 dark:bg-emerald-950/50 text-emerald-500 dark:text-emerald-400 playful-stat-icon">
            <CheckCircle2 className="w-6 h-6" />
          </div>
        </div>
      </div>

      {/* Main Lists Column Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Overdue & Today */}
        <div className="space-y-4">
            {/* Overdue List */}
          {overdueItems.length > 0 && (
            <div className="p-4 rounded-2xl bg-white dark:bg-slate-900 border border-rose-200 dark:border-rose-900/50 shadow-sm">
              <h3 className="text-xs font-bold text-rose-600 dark:text-rose-400 mb-3 flex items-center gap-1.5">
                <AlertCircle className="w-4 h-4" />
                <span>逾期待办 ({overdueItems.length})</span>
              </h3>
              <div className="space-y-1.5 pl-2 border-l-2 border-rose-200 dark:border-rose-800/50 max-h-64 overflow-y-auto pr-1">
                {overdueItems.map((item) => (
                  <div
                    key={item.id}
                    className="relative p-3 rounded-xl bg-rose-50/50 dark:bg-rose-950/20 border border-rose-100 dark:border-rose-900/30 flex items-center justify-between gap-2"
                  >
                    <div className="absolute -left-[17px] top-1/2 -translate-y-1/2 w-2 h-2 rounded-full bg-rose-400 dark:bg-rose-500 shadow-sm" />
                    <div className="flex items-center gap-2.5 flex-1 min-w-0">
                      <button
                        onClick={() => handleTaskCheck(item)}
                        className="w-5 h-5 rounded-lg border-2 border-rose-400 flex items-center justify-center transition hover:bg-rose-100"
                      />
                      <div className="truncate">
                        <p className="text-xs font-semibold text-slate-900 dark:text-slate-100 truncate">
                          {item.taskText}
                        </p>
                        <span
                          onClick={() => onSelectNoteByTitle(item.noteTitle)}
                          className="text-[10px] text-blue-600 dark:text-blue-400 hover:underline cursor-pointer"
                        >
                          来源: [[{item.noteTitle}]]
                        </span>
                      </div>
                    </div>
                    <span className="text-[10px] font-mono text-rose-600 dark:text-rose-400 font-semibold px-2 py-0.5 rounded bg-rose-100 dark:bg-rose-900/40">
                      @due({item.dueDate})
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Today Tasks */}
          <div className="p-4 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800 shadow-sm">
            <h3 className="text-xs font-bold text-slate-900 dark:text-slate-100 mb-3 flex items-center gap-1.5">
              <Clock className="w-4 h-4 text-blue-600" />
              <span>今日到期任务 ({todayItems.length})</span>
            </h3>
            {todayItems.length === 0 ? (
              <p className="text-xs text-slate-400 text-center py-6">今日暂无到期任务，太棒了！</p>
            ) : (
              <div className="space-y-1.5 pl-2 border-l-2 border-blue-200 dark:border-blue-800/50 max-h-64 overflow-y-auto pr-1">
                {todayItems.map((item) => (
                  <div
                    key={item.id}
                    className="relative p-3 rounded-xl bg-slate-50 dark:bg-slate-800/50 border border-slate-200/60 dark:border-slate-700/60 flex items-center justify-between gap-2"
                  >
                    <div className="absolute -left-[17px] top-1/2 -translate-y-1/2 w-2 h-2 rounded-full bg-blue-400 dark:bg-blue-500 shadow-sm" />
                    <div className="flex items-center gap-2.5 flex-1 min-w-0">
                      <button
                        onClick={() => handleTaskCheck(item)}
                        className={`w-5 h-5 rounded-lg border-2 flex items-center justify-center transition ${
                          item.completed
                            ? "bg-emerald-500 border-emerald-500 text-white"
                            : "border-slate-300 dark:border-slate-600 hover:border-blue-500"
                        }`}
                      >
                        {item.completed && <Check className="w-3.5 h-3.5" />}
                      </button>
                      <div className="truncate">
                        <p
                          className={`text-xs font-medium truncate ${
                            item.completed ? "line-through text-slate-400" : "text-slate-800 dark:text-slate-200"
                          }`}
                        >
                          {item.taskText}
                        </p>
                        <span
                          onClick={() => onSelectNoteByTitle(item.noteTitle)}
                          className="text-[10px] text-blue-600 dark:text-blue-400 hover:underline cursor-pointer"
                        >
                          [[{item.noteTitle}]]
                        </span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Upcoming Tasks Column */}
        <div className="p-4 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800 shadow-sm flex flex-col h-150">
          <h3 className="text-xs font-bold text-slate-900 dark:text-slate-100 mb-3 flex items-center gap-1.5">
            <CalendarIcon className="w-4 h-4 text-indigo-600" />
            <span>未来学习计划 ({upcomingItems.length})</span>
          </h3>
          {upcomingItems.length === 0 ? (
            <p className="text-xs text-slate-400 text-center py-6">暂无未来设定的学习计划</p>
          ) : (
            <div className="space-y-1.5 pl-2 border-l-2 border-indigo-200 dark:border-indigo-800/50 flex-1 min-h-0 overflow-y-auto pr-1">
              {upcomingItems.map((item) => (
                <div
                  key={item.id}
                  className="relative p-3 rounded-xl bg-slate-50 dark:bg-slate-800/50 border border-slate-200/60 dark:border-slate-700/60 flex items-center justify-between gap-2"
                >
                  <div className="absolute -left-[17px] top-1/2 -translate-y-1/2 w-2 h-2 rounded-full bg-indigo-400 dark:bg-indigo-500 shadow-sm" />
                  <div className="flex items-center gap-2.5 flex-1 min-w-0">
                    <button
                      onClick={() => handleTaskCheck(item)}
                      className="w-5 h-5 rounded-lg border-2 border-slate-300 dark:border-slate-600 flex items-center justify-center transition hover:border-blue-500"
                    />
                    <div className="truncate">
                      <p className="text-xs font-medium text-slate-800 dark:text-slate-200 truncate">
                        {item.taskText}
                      </p>
                      <span
                        onClick={() => onSelectNoteByTitle(item.noteTitle)}
                        className="text-[10px] text-blue-600 dark:text-blue-400 hover:underline cursor-pointer"
                      >
                        [[{item.noteTitle}]]
                      </span>
                    </div>
                  </div>
                  <span className="text-[10px] font-mono text-indigo-600 dark:text-indigo-400 font-semibold px-2 py-0.5 rounded bg-indigo-50 dark:bg-indigo-950/60">
                    @due({item.dueDate})
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Completed Tasks Card (已达成学习目标) */}
      {completedItems.length > 0 && (
        <div className="p-4 rounded-2xl bg-white dark:bg-slate-900 border border-emerald-200/80 dark:border-emerald-900/40 shadow-sm">
          <h3 className="text-xs font-bold text-emerald-700 dark:text-emerald-400 mb-3 flex items-center gap-1.5">
            <CheckCircle2 className="w-4 h-4 text-emerald-600" />
            <span>已达成学习目标 ({completedItems.length})</span>
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2 max-h-64 overflow-y-auto pr-1">
            {completedItems.map((item) => (
              <div
                key={item.id}
                className="p-3 rounded-xl bg-emerald-50/40 dark:bg-emerald-950/20 border border-emerald-100 dark:border-emerald-900/30 flex items-center justify-between gap-2"
              >
                <div className="flex items-center gap-2.5 flex-1 min-w-0">
                  <button
                    onClick={() => handleTaskCheck(item)}
                    title="点击取消完成"
                    className="w-5 h-5 rounded-lg bg-emerald-500 border-2 border-emerald-500 text-white flex items-center justify-center transition hover:bg-emerald-600"
                  >
                    <Check className="w-3.5 h-3.5" />
                  </button>
                  <div className="truncate">
                    <p className="text-xs font-medium line-through text-slate-400 truncate">
                      {item.taskText}
                    </p>
                    <span
                      onClick={() => onSelectNoteByTitle(item.noteTitle)}
                      className="text-[10px] text-blue-600 dark:text-blue-400 hover:underline cursor-pointer"
                    >
                      来源: [[{item.noteTitle}]]
                    </span>
                  </div>
                </div>
                <span className="text-[10px] font-mono text-emerald-600 dark:text-emerald-400 font-medium px-2 py-0.5 rounded bg-emerald-100 dark:bg-emerald-900/40">
                  @due({item.dueDate})
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Add New Schedule Modal */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-4">
          <form
            onSubmit={handleCreateTask}
            className="bg-white dark:bg-slate-900 rounded-2xl p-5 shadow-2xl border border-slate-200 dark:border-slate-800 w-full max-w-md space-y-4"
          >
            <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100 flex items-center gap-1.5">
              <Clock className="w-4 h-4 text-blue-600" />
              添加学习计划提醒
            </h3>

            <div>
              <label className="text-[11px] font-semibold text-slate-600 dark:text-slate-400 block mb-1">
                目标笔记
              </label>
              <select
                value={selectedNoteIdForNewTask}
                onChange={(e) => setSelectedNoteIdForNewTask(e.target.value)}
                className="w-full px-3 py-2 text-xs rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-800 dark:text-slate-100"
              >
                {notes.map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.title}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="text-[11px] font-semibold text-slate-600 dark:text-slate-400 block mb-1">
                计划任务描述
              </label>
              <input
                type="text"
                value={newTaskText}
                onChange={(e) => setNewTaskText(e.target.value)}
                placeholder="例如: 完成算法动态规划章节练习"
                className="w-full px-3 py-2 text-xs rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-800 dark:text-slate-100"
                required
              />
            </div>

            <div>
              <label className="text-[11px] font-semibold text-slate-600 dark:text-slate-400 block mb-1">
                到期日期 (@due)
              </label>
              <input
                type="date"
                value={newTaskDate}
                onChange={(e) => setNewTaskDate(e.target.value)}
                className="w-full px-3 py-2 text-xs rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-800 dark:text-slate-100"
                required
              />
            </div>

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setShowAddModal(false)}
                className="px-3 py-1.5 text-xs text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-xl"
              >
                取消
              </button>
              <button
                type="submit"
                className="px-4 py-1.5 text-xs font-semibold rounded-xl bg-blue-600 text-white shadow-md hover:bg-blue-700"
              >
                插入到笔记
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
