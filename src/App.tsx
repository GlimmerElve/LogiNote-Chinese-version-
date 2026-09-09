import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  NoteItem, NoteType, ViewMode, VaultSettings, SyncStatus, DueDateItem, PlanNode, StudyQuestionCard,
  KnowledgePointCandidate, KnowledgePointMasteryResult, KnowledgePointDsr,
} from "./types";
import {
  loadNotesFromStorage, saveAllNotesToStorage, loadSettingsFromStorage, saveSettingsToStorage,
  parseNoteMetadata, recalculateBacklinks, toggleTaskInNoteContent
} from "./services/storage";
import { Header } from "./components/Header";
import { Sidebar } from "./components/Sidebar";
import { NoteEditor } from "./components/NoteEditor";
import { GraphView } from "./components/GraphView";
import { TimelineCalendarView } from "./components/TimelineCalendarView";
import { PlanBuilder } from "./components/PlanBuilder";
import { SettingsModal } from "./components/SettingsModal";
import { AiSegmentModal } from "./components/AiSegmentModal";
import { CommandPalette } from "./components/CommandPalette";
import { PrivacyPolicyModal } from "./components/PrivacyPolicyModal";
import { LearnHub } from "./components/LearnHub";
import { FlowMode } from "./components/FlowMode";
import { FlowAnalysisPanel } from "./components/FlowAnalysisPanel";
import { ReviewChat } from "./components/ReviewChat";
import { ReviewBubbleMode } from "./components/ReviewBubbleMode";
import { DocumentsView } from "./components/DocumentsView";
import { HomeView } from "./components/HomeView";
import { ConceptFillModal } from "./components/ConceptFillModal";
import { KnowledgePointSelectionModal } from "./components/KnowledgePointSelectionModal";
import { indexNote, deleteNoteIndex, indexAllNotes } from "./services/ragService";
import { updateStability, updateDifficulty, ratingToNumber, calculateRetrievability } from "./services/reviewScheduler";
import { ReviewAnalysis } from "./types";
import { FlowSession } from "./types";
import { computeLayeredMastery, scoreConceptEvidence, scoreJudgmentEvidence, scoreReasoningEvidence, MASTERY_LINE } from "./services/profile/scoring/threeLayer";
import { recordNewMastered, recordStudyDuration } from "./services/learningAbility/timelineStore";
import { hydrateFromUserState } from "./services/electronUserState";
import { hydrateProfileFromUserState } from "./services/profile/profileStore";
import { discoverKnowledgePoints, scoreKnowledgePointsInParallel } from "./services/knowledgeScoringService";
import { resolveNoteByTitleOrAlias } from "./services/noteResolver";
import { AnalysisProgressModal, AnalysisPhase } from "./components/AnalysisProgressModal";
import { probeLlmConnection } from "./services/llmService";

export default function App() {
  const [notes, setNotes] = useState<NoteItem[]>([]);
  const [activeNoteId, setActiveNoteId] = useState<string | null>(null);
  const [currentView, setCurrentView] = useState<ViewMode>("home");
  const [settings, setSettings] = useState<VaultSettings>(loadSettingsFromStorage());
  const [isAiSegmentOpen, setIsAiSegmentOpen] = useState(false);
  const [aiNoteTarget, setAiNoteTarget] = useState<NoteItem | null>(null);
  const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState(false);
  const [isPrivacyOpen, setIsPrivacyOpen] = useState(false);
  const [conceptFillNote, setConceptFillNote] = useState<NoteItem | null>(null);
  const [flowTargetNote, setFlowTargetNote] = useState<NoteItem | null>(null);
  const [flowReviewInterval, setFlowReviewInterval] = useState(20);
  const [flowSpeakingContent, setFlowSpeakingContent] = useState("");
  const [flowSummaryText, setFlowSummaryText] = useState("");
  const [flowQuestions, setFlowQuestions] = useState<StudyQuestionCard[]>([]);
  const [isFlowAnalysisOpen, setIsFlowAnalysisOpen] = useState(false);
  const [reviewNoteId, setReviewNoteId] = useState("");
  const [reviewNoteTitle, setReviewNoteTitle] = useState("");
  const [reviewQuestion, setReviewQuestion] = useState("");
  const [reviewContext, setReviewContext] = useState("");
  const [reviewReturnView, setReviewReturnView] = useState<ViewMode>("learn");
  const [syncStatus, setSyncStatus] = useState<SyncStatus>({
    lastSyncedAt: null, isSyncing: false, syncedNotesCount: 0, cloudStorageUsed: "1.2 MB", statusText: "本地状态正常"
  });
  const [knowledgeCandidates, setKnowledgeCandidates] = useState<KnowledgePointCandidate[]>([]);
  const [isSelectionOpen, setIsSelectionOpen] = useState(false);
  const [isSelectionLoading, setIsSelectionLoading] = useState(false);
  const [knowledgeResults, setKnowledgeResults] = useState<KnowledgePointMasteryResult[]>([]);
  const [analysisProgressOpen, setAnalysisProgressOpen] = useState(false);
  const [analysisPhase, setAnalysisPhase] = useState<AnalysisPhase>('mastery');
  const [analysisOffline, setAnalysisOffline] = useState(false);
  const [editorRefreshVersion, setEditorRefreshVersion] = useState(0);

  useEffect(() => { loadNotesFromStorage().then(loaded => { setNotes(loaded); if (loaded.length > 0) setActiveNoteId(loaded[0].id); indexAllNotes(loaded).catch(() => {}); }); }, []);
  // 启动时把 user-state 文件（画像/设置/LLM/心流会话）灌入 localStorage 缓存，供同步读取
  useEffect(() => { hydrateFromUserState().catch(() => {}); }, []);
  // 启动时把画像灌入新 profileStore 内存缓存（A1，唯一权威读入口）
  useEffect(() => { hydrateProfileFromUserState().catch(() => {}); }, []);
  useEffect(() => { settings.theme === "dark" ? document.documentElement.classList.add("dark") : document.documentElement.classList.remove("dark"); document.documentElement.setAttribute("data-accent", settings.accentColor); document.documentElement.style.setProperty("--editor-font-size", `${settings.fontSize}px`); saveSettingsToStorage(settings); }, [settings]);
  useEffect(() => { const h = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setIsCommandPaletteOpen(p => !p); } }; window.addEventListener("keydown", h); return () => window.removeEventListener("keydown", h); }, []);

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingNotesRef = useRef<NoteItem[] | null>(null);
  const flushSave = useCallback((ns: NoteItem[]) => { saveAllNotesToStorage(ns).catch(console.error); }, []);
  // 未联网判定后 3 秒自动退出等待弹窗（回到编辑器视图，不弹结果面板）
  useEffect(() => {
    if (!analysisOffline) return;
    const t = setTimeout(() => {
      setAnalysisOffline(false);
      setAnalysisProgressOpen(false);
    }, 3000);
    return () => clearTimeout(t);
  }, [analysisOffline]);

  const handleUpdateNote = (u: NoteItem) => {
    // 增量更新 RAG 索引（后台异步，不阻塞 UI）
    indexNote(u).catch(() => {});
    setNotes(prev => { const i = prev.findIndex(n => n.id === u.id); let nn = [...prev]; if (i !== -1) nn[i] = u; else nn.unshift(u); const r = recalculateBacklinks(nn); if (saveTimerRef.current) clearTimeout(saveTimerRef.current); pendingNotesRef.current = r; saveTimerRef.current = setTimeout(() => { if (pendingNotesRef.current) { flushSave(pendingNotesRef.current); pendingNotesRef.current = null; } }, 800); return r; }); };
  useEffect(() => { return () => { if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); if (pendingNotesRef.current) flushSave(pendingNotesRef.current); } }; }, []);

  const handleQuickNewNote = () => handleNewNote("knowledge");
  const handleNewNote = (t: NoteType = "knowledge", pid?: string, title?: string) => { const ct = title?.trim(); if (ct && t === "knowledge") { const ex = resolveNoteByTitleOrAlias(ct, notes); if (ex) { setActiveNoteId(ex.id); setCurrentView("editor"); return; } } const nn: NoteItem = { id: `note-${Date.now()}`, title: title || `未命名学习笔记 ${notes.length + 1}`, content: t === "project" ? "" : "请对该知识点进行定义描述", noteType: t, parentId: pid, tags: ["学习计划"], links: [], backlinks: [], dueDates: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }; handleUpdateNote(nn); setActiveNoteId(nn.id); setCurrentView("editor"); };
  const handleDeleteNote = (id: string, e: React.MouseEvent) => { e.stopPropagation(); const f = notes.filter(n => n.id !== id); setNotes(f); saveAllNotesToStorage(f).catch(console.error); deleteNoteIndex(id).catch(() => {}); if (activeNoteId === id) setActiveNoteId(f[0]?.id || null); };
  const collectDescendantIds = (pid: string, an: NoteItem[]): string[] => { const c = an.filter(n => n.parentId === pid); let ids = c.map(n => n.id); c.forEach(n => { ids = ids.concat(collectDescendantIds(n.id, an)); }); return ids; };
  const handleDeleteProject = (id: string) => { const cn = [...notes]; const di = collectDescendantIds(id, cn); const all = [id, ...di]; const f = cn.filter(n => !all.includes(n.id)); setNotes(f); saveAllNotesToStorage(f).catch(console.error); all.forEach(nid => deleteNoteIndex(nid).catch(() => {})); if (all.includes(activeNoteId || "")) setActiveNoteId(f[0]?.id || null); };
  const handleToggleFavorite = (id: string, e: React.MouseEvent) => { e.stopPropagation(); const n = notes.find(n => n.id === id); if (n) handleUpdateNote({ ...n, isFavorite: !n.isFavorite, updatedAt: new Date().toISOString() }); };
  const handleTogglePin = (id: string, e: React.MouseEvent) => { e.stopPropagation(); const n = notes.find(n => n.id === id); if (n) handleUpdateNote({ ...n, pinned: !n.pinned, updatedAt: new Date().toISOString() }); };
  const handleSelectNote = (id: string) => { setActiveNoteId(id); setCurrentView("editor"); };
  const handleSelectNoteByTitle = (tt: string) => { const t = resolveNoteByTitleOrAlias(tt, notes); if (t) { setActiveNoteId(t.id); setCurrentView("editor"); } else { const nn: NoteItem = { id: `note-${Date.now()}`, title: tt, content: "请对该知识点进行定义描述", noteType: "knowledge", tags: ["新建图谱节点"], links: [], backlinks: [], dueDates: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }; handleUpdateNote(nn); setActiveNoteId(nn.id); setCurrentView("editor"); } };
  const handleToggleTaskCompleted = (nid: string, tid: string) => { const n = notes.find(n => n.id === nid); if (!n) return; const ud = (n.dueDates || []).map(d => d.id === tid ? { ...d, completed: !d.completed } : d); let uc = n.content; const td = (n.dueDates || []).find(d => d.id === tid); if (td) uc = toggleTaskInNoteContent(n.content, tid, td.taskText, td.dueDate); handleUpdateNote({ ...n, dueDates: ud, content: uc, updatedAt: new Date().toISOString() }); };
  const handleBatchCreateProjectTree = (tree: PlanNode[], pid?: string) => { if (!tree || tree.length === 0) return; const ids: string[] = []; [...tree].reverse().forEach(node => { const ct = node.title.trim(); if (!ct && node.children.length === 0) return; const nid = `note-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`; const dd: DueDateItem[] = []; if (node.dueDate) dd.push({ id: `due-${nid}-0`, noteId: nid, noteTitle: ct || "未命名阶段", taskText: ct || "未命名阶段", dueDate: node.dueDate, completed: false, priority: node.priority || "medium" }); const nn: NoteItem = { id: nid, title: ct || "未命名阶段", content: "", noteType: "project", parentId: pid, tags: ["学习计划"], links: [], backlinks: [], dueDates: dd, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }; handleUpdateNote(nn); ids.push(nid); if (node.children.length > 0) handleBatchCreateProjectTree(node.children, nid); }); if (ids.length > 0 && !pid) { setActiveNoteId(ids[0]); setCurrentView("editor"); } };
  const handleAddNewScheduleTask = (nid: string, txt: string, ds: string) => { const n = notes.find(n => n.id === nid); if (!n) return; handleUpdateNote({ ...n, content: n.content + `\n- [ ] ${txt} @due(${ds})`, updatedAt: new Date().toISOString() }); };
  const handleTriggerSync = async () => {
    // 方向 X：移除云端同步，改为「打开数据目录」作为导出/备份入口
    const openData = (window as any).electronAPI?.openDataFolder;
    if (openData) {
      try {
        await openData();
        setSyncStatus(p => ({ ...p, isSyncing: false, statusText: "已打开数据目录：vault/ 可分享、user-state/ 可备份" }));
      } catch {
        setSyncStatus(p => ({ ...p, isSyncing: false, statusText: "打开数据目录失败" }));
      }
    } else {
      setSyncStatus(p => ({ ...p, isSyncing: false, statusText: "仅桌面版支持本地数据目录" }));
    }
  };
  const handleOpenAiSegment = (tn?: NoteItem) => { const s = tn || notes.find(n => n.id === activeNoteId); if (s) { setAiNoteTarget(s); setIsAiSegmentOpen(true); } };
  const handleOpenLearn = () => { setCurrentView("learn"); };
  const handleEnterBubbleMode = () => { setCurrentView("bubble"); };
  const handleEnterFlowMode = (nid: string, rim: number) => { const n = notes.find(n => n.id === nid); if (!n) return; setFlowTargetNote(n); setFlowReviewInterval(rim); setFlowSpeakingContent(""); setIsFlowAnalysisOpen(false); setCurrentView("flow"); };
  const handleExitFlowMode = (session: FlowSession) => {
    // 记录学习时长（心流模式）：把 durationSeconds 转分钟写入周报（内部按 ≥20 分钟判定活跃天数）
    const flowMinutes = Math.round((session.durationSeconds || 0) / 60);
    if (flowMinutes > 0) recordStudyDuration(flowMinutes).catch(() => {});
    const exited = notes.find(n => n.id === session.noteId);
    setFlowSummaryText(session.summary || exited?.flowSummary || "");
    setFlowQuestions(exited?.questions || []);
    // 口语复盘分析：仅分析本次学习新增的复述文本（已剥离进入心流前的原文）；无新增则不触发分析
    const analysisText = (session.incrementalText || "").trim();
    setActiveNoteId(session.noteId);
    setCurrentView("editor");
    // 分析开关关闭：只保存文本，不进入知识点识别与 AI 分析
    if (session.analyze === false) {
      return;
    }
    if (analysisText) {
      setFlowSpeakingContent(analysisText);
      setKnowledgeCandidates([]);
      setIsSelectionLoading(true);
      setIsSelectionOpen(true);
      // 阶段一：识别知识点，完成后由用户在选择窗口确认
      discoverKnowledgePoints(analysisText, notes)
        .then((candidates) => setKnowledgeCandidates(candidates))
        .catch((e) => { console.warn('[KP] 知识点识别失败:', e); setKnowledgeCandidates([]); })
        .finally(() => setIsSelectionLoading(false));
    }
  };
  const handleConfirmKnowledgePoints = async (selected: KnowledgePointCandidate[]) => {
    setIsSelectionOpen(false);
    if (selected.length === 0) { setIsFlowAnalysisOpen(false); return; }
    // 打开全屏等待弹窗：阶段② 掌握度评分进行中
    setAnalysisOffline(false);
    setAnalysisPhase('mastery');
    setAnalysisProgressOpen(true);
    try {
      // 前置探活：同一家服务商，解析评分 workflow 的 provider 并探测连通性
      const online = await probeLlmConnection('knowledge-mastery-scoring');
      if (!online) {
        setAnalysisOffline(true);
        setIsFlowAnalysisOpen(false);
        return;
      }
      const results = await scoreKnowledgePointsInParallel(selected, flowSpeakingContent);
      // 全部评分失败（无 provider / 网络失败）：判定为未联网
      if (selected.length > 0 && results.length === 0) {
        setAnalysisOffline(true);
        setIsFlowAnalysisOpen(false);
        return;
      }
      setKnowledgeResults(results);
      // 回写掌握度：已有笔记用分层评分增量更新；new 类自动建笔记（初始掌握度 0）
      const baseDsr: KnowledgePointDsr = { difficulty: 5, stability: 2, lastReviewedAt: null, reviewCount: 0, consecutiveCorrect: 0, consecutiveWrong: 0 };
      for (const cand of selected) {
        const r = results.find((x) => x.name === cand.name);
        if (!r) continue;
        if (cand.existingNoteTitle) {
          // known / potential：匹配已有笔记，增量更新 conceptMastery
          const target = resolveNoteByTitleOrAlias(cand.existingNoteTitle || '', notes.filter((n) => n.noteType === 'knowledge'));
          if (target) {
            const dsr = target.dsrState || baseDsr;
            const oldMastery = dsr.conceptMastery ?? 0;
            const layered = computeLayeredMastery(r.conceptDelta, r.judgmentDelta, r.reasoningDelta, oldMastery);
            // 新增掌握检测：从 <55 跨到 ≥55 记一次新增掌握
            if (oldMastery < MASTERY_LINE && layered.mastery >= MASTERY_LINE) {
              recordNewMastered(1).catch(() => {});
            }
            handleUpdateNote({
              ...target,
              dsrState: {
                ...dsr,
                conceptMastery: layered.mastery,
                conceptMasterySamples: (dsr.conceptMasterySamples || 0) + 1,
                conceptMasteryUpdatedAt: new Date().toISOString(),
              },
              updatedAt: new Date().toISOString(),
            });
          }
        } else {
          // new：未学知识点，自动新建笔记 + 初始掌握度 0
          const ct = cand.name.trim();
          if (!ct) continue;
          if (resolveNoteByTitleOrAlias(ct, notes)) continue;
          const nn: NoteItem = {
            id: `note-${Date.now()}`,
            title: ct,
            content: "请对该知识点进行定义描述",
            noteType: "knowledge",
            tags: ["学习计划"],
            links: [], backlinks: [], dueDates: [],
            dsrState: { ...baseDsr, conceptMastery: 0, conceptMasterySamples: 1, conceptMasteryUpdatedAt: new Date().toISOString() },
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };
          handleUpdateNote(nn);
        }
      }
      // 掌握度评分完成，进入五路画像证据分析阶段（弹窗持续展示）
      setAnalysisPhase('evidence');
      setIsFlowAnalysisOpen(true);
    } catch (e) {
      console.warn('[KP] 并行评分失败:', e);
      setIsFlowAnalysisOpen(false);
      setAnalysisProgressOpen(false);
    }
  };
  const handleEnterReview = (nid: string, nt: string, q: string, ctx: string) => { setReviewReturnView("learn"); setReviewNoteId(nid); setReviewNoteTitle(nt); setReviewQuestion(q); setReviewContext(ctx); setCurrentView("review"); };
  const handleEnterReviewFromBubble = (nid: string, nt: string, q: string, ctx: string) => { setReviewReturnView("bubble"); setReviewNoteId(nid); setReviewNoteTitle(nt); setReviewQuestion(q); setReviewContext(ctx); setCurrentView("review"); };
  const handleExitReview = (analysis: ReviewAnalysis | null, segmentMastery?: KnowledgePointMasteryResult[]) => {
    // 项目复习：项目笔记本身无 DSR/掌握度，仅按名称反查知识点笔记批量更新 conceptMastery
    if (Array.isArray(segmentMastery)) {
      if (segmentMastery.length > 0) {
        for (const r of segmentMastery) {
          const target = resolveNoteByTitleOrAlias(r.name, notes.filter((n) => n.noteType === 'knowledge'));
          if (!target) continue;
          const dsr = target.dsrState || { difficulty: 5, stability: 2, lastReviewedAt: null, reviewCount: 0, consecutiveCorrect: 0, consecutiveWrong: 0 };
          const oldMastery = dsr.conceptMastery ?? 0;
          const layered = computeLayeredMastery(r.conceptDelta, r.judgmentDelta, r.reasoningDelta, oldMastery);
          if (oldMastery < MASTERY_LINE && layered.mastery >= MASTERY_LINE) {
            recordNewMastered(1).catch(() => {});
          }
          const updatedDsr = {
            ...dsr,
            conceptMastery: layered.mastery,
            conceptMasterySamples: (dsr.conceptMasterySamples || 0) + 1,
            conceptMasteryUpdatedAt: new Date().toISOString(),
          };
          handleUpdateNote({ ...target, dsrState: updatedDsr, lastReferencedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
        }
      }
      setCurrentView(reviewReturnView);
      return;
    }

    // 气泡复习（单知识点）：更新单个知识点的 DSR 记忆巩固 + 分层掌握度
    if (analysis && reviewNoteId) {
      const tn = notes.find(n => n.id === reviewNoteId);
      if (tn) {
        const dsr = tn.dsrState || { difficulty: 5, stability: 2, lastReviewedAt: null, reviewCount: 0, consecutiveCorrect: 0, consecutiveWrong: 0 };
        const G = ratingToNumber(analysis.overallRating);
        const R = calculateRetrievability(dsr.stability, dsr.lastReviewedAt);
        const avgScore = (analysis.accuracyScore + analysis.completenessScore + analysis.logicScore + analysis.relevanceScore) / 4;
        const ns = updateStability(dsr.stability, G, R, avgScore);
        const nd = updateDifficulty(dsr.difficulty, G, dsr.reviewCount);
        const ic = G >= 3;
        // 来源二：由复习评分的三层证据锚点折算为概念掌握度（与心流模式统一）
        const me = analysis.masteryEvidence;
        const conceptDelta = scoreConceptEvidence(me?.conceptEvidence);
        const judgmentDelta = scoreJudgmentEvidence(me?.judgmentEvidence);
        const reasoningDelta = scoreReasoningEvidence(me?.reasoningEvidence);
        const oldMastery = dsr.conceptMastery ?? 0;
        const layered = computeLayeredMastery(conceptDelta, judgmentDelta, reasoningDelta, oldMastery);
        if (oldMastery < MASTERY_LINE && layered.mastery >= MASTERY_LINE) {
          recordNewMastered(1).catch(() => {});
        }
        const masteryUpdate = {
          conceptMastery: layered.mastery,
          conceptMasterySamples: (dsr.conceptMasterySamples || 0) + 1,
          conceptMasteryUpdatedAt: new Date().toISOString(),
        };
        const updatedDsr = { ...dsr, difficulty: nd, stability: ns, lastReviewedAt: new Date().toISOString(), reviewCount: dsr.reviewCount + 1, consecutiveCorrect: ic ? dsr.consecutiveCorrect + 1 : 0, consecutiveWrong: ic ? 0 : dsr.consecutiveWrong + 1, ...masteryUpdate };
        handleUpdateNote({ ...tn, dsrState: updatedDsr, lastReferencedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      }
    }
    setCurrentView(reviewReturnView);
  };
  const activeNote = notes.find(n => n.id === activeNoteId) || null;

  return React.createElement('div', { className: 'app-frame min-h-screen flex flex-col bg-[#FEF9F3] dark:bg-slate-950 text-slate-900 dark:text-slate-100 font-sans transition-colors selection:bg-indigo-100 selection:text-indigo-900 bg-playful-pattern' },
    React.createElement(Header, { currentView, onSelectView: setCurrentView, onOpenCommandPalette: () => setIsCommandPaletteOpen(true), onOpenLearn: handleOpenLearn, onNewNote: handleQuickNewNote, settings, onUpdateSettings: s => setSettings(p => ({ ...p, ...s })), syncStatus, onTriggerSync: handleTriggerSync, onOpenPrivacy: () => setIsPrivacyOpen(true) }),
    React.createElement('div', { className: 'flex-1 flex overflow-hidden' },
      currentView !== 'home' && currentView !== 'learn' && currentView !== 'review' && currentView !== 'bubble' && currentView !== 'documents' && React.createElement(Sidebar, { notes, activeNoteId, onSelectNote: handleSelectNote, onNewNote: handleNewNote, onDeleteNote: handleDeleteNote, onToggleFavorite: handleToggleFavorite, onTogglePin: handleTogglePin, onDeleteProject: handleDeleteProject, settings }),
      React.createElement('main', { className: 'flex-1 flex overflow-hidden relative' },
        currentView === "home" && React.createElement(HomeView, {
          notes,
          onOpenTodo: handleSelectNote,
          onToggleTodo: handleToggleTaskCompleted,
        }),
        currentView === "editor" && React.createElement('div', { className: 'flex-1 flex overflow-hidden' }, React.createElement(NoteEditor, { note: activeNote, allNotes: notes, onUpdateNote: handleUpdateNote, onOpenAiSegment: handleOpenAiSegment, onSelectNoteByTitle: handleSelectNoteByTitle, onOpenConceptFill: (n) => setConceptFillNote(n), settings, contentVersion: editorRefreshVersion }), isFlowAnalysisOpen && flowSpeakingContent && React.createElement(FlowAnalysisPanel, { speakingContent: flowSpeakingContent, noteTitle: activeNote?.title || "", allNotes: notes, summaryText: flowSummaryText, questions: flowQuestions, onClose: () => setIsFlowAnalysisOpen(false), onSelectNoteByTitle: handleSelectNoteByTitle, onUpdateNote: handleUpdateNote, masteryResults: knowledgeResults, onProgress: (stage) => setAnalysisPhase(stage), onDone: () => setAnalysisProgressOpen(false) })),
        currentView === "graph" && React.createElement(GraphView, { notes, onSelectNoteByTitle: handleSelectNoteByTitle, onDeleteNote: (nid) => { const ff = notes.filter(n => n.id !== nid); setNotes(ff); saveAllNotesToStorage(ff).catch(console.error); if (activeNoteId === nid) setActiveNoteId(ff[0]?.id || null); }, settings }),
        currentView === "learn" && React.createElement(LearnHub, { notes, flowSettings: settings.flowSettings, onEnterFlow: handleEnterFlowMode, onEnterReview: handleEnterReview, onEnterBubbleMode: handleEnterBubbleMode, onUpdateNote: handleUpdateNote }),
        currentView === "review" && reviewNoteId && React.createElement('div', { className: 'flex-1 h-[calc(100vh-3.5rem)] overflow-hidden' }, React.createElement(ReviewChat, { noteId: reviewNoteId, noteTitle: reviewNoteTitle, questionText: reviewQuestion, knowledgeContext: reviewContext, allNotes: notes, onReviewComplete: handleExitReview })),
        currentView === "documents" && React.createElement(DocumentsView),
        currentView === "flow" && flowTargetNote && React.createElement(FlowMode, { note: flowTargetNote, allNotes: notes, reviewIntervalMinutes: flowReviewInterval, flowSettings: settings.flowSettings, onExit: handleExitFlowMode, onUpdateNote: handleUpdateNote }),
        currentView === "bubble" && React.createElement(ReviewBubbleMode, { allNotes: notes, onBubbleClick: handleEnterReviewFromBubble, onExit: handleOpenLearn }),
        currentView === "timeline" && React.createElement(TimelineCalendarView, { notes, onToggleTaskCompleted: handleToggleTaskCompleted, onSelectNoteByTitle: handleSelectNoteByTitle, onAddNewScheduleTask: handleAddNewScheduleTask, onOpenPlanBuilder: () => setCurrentView("plan"), settings }),
        currentView === "plan" && React.createElement(PlanBuilder, { onBatchCreate: handleBatchCreateProjectTree, allNotes: notes }),
        currentView === "settings" && React.createElement(SettingsModal, { settings, onUpdateSettings: s => setSettings(p => ({ ...p, ...s })), syncStatus, onTriggerSync: handleTriggerSync, notes })
      )
    ),
    React.createElement(AiSegmentModal, { isOpen: isAiSegmentOpen, onClose: () => setIsAiSegmentOpen(false), note: aiNoteTarget, allNotes: notes, onApplySegmentation: (updated, tasks) => { handleUpdateNote(updated); setEditorRefreshVersion(v => v + 1); }, onUpdateNote: handleUpdateNote }),
    React.createElement(CommandPalette, { isOpen: isCommandPaletteOpen, onClose: () => setIsCommandPaletteOpen(false), notes, onSelectNote: handleSelectNote, onNewNote: handleNewNote, onSelectView: setCurrentView }),
    React.createElement(PrivacyPolicyModal, { isOpen: isPrivacyOpen, onClose: () => setIsPrivacyOpen(false) }),
    isSelectionOpen && React.createElement(KnowledgePointSelectionModal, { candidates: knowledgeCandidates, knowledgeNotes: notes.filter(n => n.noteType === "knowledge"), loading: isSelectionLoading, onClose: () => setIsSelectionOpen(false), onConfirm: handleConfirmKnowledgePoints }),
    analysisProgressOpen && React.createElement(AnalysisProgressModal, { phase: analysisPhase, offline: analysisOffline }),
    conceptFillNote && React.createElement(ConceptFillModal, { note: conceptFillNote, onClose: () => setConceptFillNote(null), onConfirm: (content) => { if (conceptFillNote) { handleUpdateNote({ ...conceptFillNote, content, updatedAt: new Date().toISOString() }); } setConceptFillNote(null); } })
  );
}
