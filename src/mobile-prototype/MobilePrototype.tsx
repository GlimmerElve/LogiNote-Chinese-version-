import React, { useDeferredValue, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, ArrowUpRight, BellOff, BookOpen, Bookmark, Check, CheckCircle2, ChevronRight, Cloud, CloudOff, Compass, FileText, Flag, Leaf, ListChecks, LockKeyhole, MessageCircle, Mic, MoreHorizontal, NotebookPen, Plus, Search, Send, ShieldCheck, Smartphone, Sparkles, Wifi, X, Zap } from 'lucide-react';
import { conversations, initialTasks, questions, readings, tabInfo, type Capture, type DemoMessage, type MobileTab, type Reading, type Task } from './data';
import { RestatementBubble } from './RestatementBubble';
import { PracticePage, RecordsPage } from './LearningPages';
import { MessagesPage } from './MessagePages';
import { PlanPage } from './PlanPage';

const STORAGE_KEY = 'loginote.mobile-prototype.v1';
type DemoState = { records: Capture[]; tasks: Task[]; bookmarks: string[]; messages: DemoMessage[]; messageDrafts?: Record<string, string>; blocked: string[]; answers: Record<string, number>; draft: string; draftKind: Capture['kind']; draftSource: string; pending: { id: string; kind: string }[]; receipts: number };
const freshState = (): DemoState => ({ records: [], tasks: initialTasks.map(t => ({ ...t })), bookmarks: [], messages: [], messageDrafts: {}, blocked: [], answers: {}, draft: '', draftKind: '复述', draftSource: 'retrieval', pending: [], receipts: 0 });
function loadDemo(): { state: DemoState; warning: string; recover?: boolean } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { state: freshState(), warning: '' };
    const data = JSON.parse(raw) as DemoState;
    if (!data || !Array.isArray(data.records) || !Array.isArray(data.tasks) || !Array.isArray(data.bookmarks) || !Array.isArray(data.messages) || !Array.isArray(data.blocked) || !Array.isArray(data.pending) || typeof data.draft !== 'string' || !['复述', '认知', '想法'].includes(data.draftKind) || typeof data.draftSource !== 'string' || !data.answers || typeof data.answers !== 'object' || typeof data.receipts !== 'number' || data.tasks.some(t => typeof t.id !== 'string' || typeof t.title !== 'string' || !['阅读', '复述', '简测'].includes(t.kind) || typeof t.done !== 'boolean') || data.records.some(r => typeof r.text !== 'string' || typeof r.id !== 'string' || typeof r.at !== 'string') || data.messages.some(m => typeof m.text !== 'string' || typeof m.id !== 'string')) throw Error('invalid prototype state');
    if (data.messageDrafts !== undefined && (!data.messageDrafts || typeof data.messageDrafts !== 'object' || Array.isArray(data.messageDrafts) || Object.values(data.messageDrafts).some(value => typeof value !== 'string'))) throw Error('invalid message drafts');
    return { state: data, warning: '' };
  } catch { return { state: freshState(), warning: '原型存储不可用或格式异常，当前显示初始演示。写入前将先备份原始缓存；无法备份时不会覆盖。', recover: true }; }
}
const id = () => crypto.randomUUID();
const tabs: { key: MobileTab; Icon: typeof Compass }[] = [{ key: 'discover', Icon: Compass }, { key: 'practice', Icon: Zap }, { key: 'capture', Icon: NotebookPen }, { key: 'messages', Icon: MessageCircle }, { key: 'plan', Icon: ListChecks }];
const sheetTitles = { sync: '数据与同步', profile: '设置', privacy: '隐私与 AI', 'ai-consent': 'AI 授权', legal: '协议与许可', delete: '删除账号', report: '举报与屏蔽', generate: '新计划', adjust: '调整日期' };
const newsReadings: Reading[] = ['如何判断一项 AI 研究值得深入阅读？', '学习工具的价值，藏在反馈而非记录数量里'].map((title, index) => ({
  id: `news-${index}`, title, category: '资讯样例', minutes: 3,
  summary: '关注证据、方法与适用边界。', reason: '演示文章 · 非实时新闻',
  sections: [{ heading: '先问一个好问题', text: '这是为展示移动阅读编写的演示文章。正式资讯保留来源、发布日期与原文入口，遵循来源授权，并与私人资料分开。' }],
}));

function Sheet({ title, label, error, children, close, wide = false }: { title: string; label?: string; error?: string; children: React.ReactNode; close: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const dialog = ref.current!; dialog.showModal(); return () => dialog.close(); }, []);
  return <dialog ref={ref} className={`mp-sheet ${wide ? 'mp-sheet-reading' : ''}`} onCancel={e => { e.preventDefault(); close(); }} onClick={e => { if (e.target === e.currentTarget) close(); }} aria-label={label || title}>
    <div className="mp-sheet-head"><h2>{title}</h2><button className="mp-icon" aria-label="关闭弹层" onClick={close}><X size={20} /></button></div>
    <div className="mp-sheet-body">{error && <p className="mp-restatement-error" role="alert">{error}</p>}{children}</div>
  </dialog>;
}

export function MobilePrototype() {
  const [loaded] = useState(loadDemo);
  const needsBackup = useRef(!!loaded.recover);
  const [demo, setDemo] = useState(loaded.state);
  const [error, setError] = useState(loaded.warning);
  const [tab, setTab] = useState<MobileTab>('discover');
  const [view, setView] = useState<'prototype' | 'architecture' | 'roadmap'>('prototype');
  const [feed, setFeed] = useState<'推荐' | '我的资料' | '资讯'>('推荐');
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query.trim().toLowerCase());
  const [cardIndex, setCardIndex] = useState(0);
  const [cardDirection, setCardDirection] = useState<'next' | 'previous'>('next');
  const swipeStart = useRef<{ x: number; y: number } | null>(null);
  const deviceRef = useRef<HTMLElement>(null);
  const [restatementOpen, setRestatementOpen] = useState(false);
  const [reading, setReading] = useState<Reading | null>(null);
  const [sheet, setSheet] = useState<null | 'sync' | 'profile' | 'privacy' | 'ai-consent' | 'legal' | 'delete' | 'report' | 'generate' | 'adjust'>(null);
  const [demoConsent, setDemoConsent] = useState<'unknown' | 'allowed' | 'declined'>('unknown');
  const [notice, setNotice] = useState('');
  const [offline, setOffline] = useState(false);
  const [questionIndex, setQuestionIndex] = useState(0);
  const [selected, setSelected] = useState<number | null>(null);
  const [conversation, setConversation] = useState<string | null>(null);
  const [recordDetail, setRecordDetail] = useState<Capture | null>(null);
  const [reportReason, setReportReason] = useState('骚扰或不当内容');
  const [goal, setGoal] = useState('');
  const [minutes, setMinutes] = useState(15);
  const [generated, setGenerated] = useState<Task[] | null>(null);
  const [adjustTask, setAdjustTask] = useState<Task | null>(null);
  const [newDay, setNewDay] = useState('明天');
  const [simulateConflict, setSimulateConflict] = useState(false);
  const [conflict, setConflict] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => { scrollRef.current?.scrollTo(0, 0); }, [tab, conversation, feed]);
  useEffect(() => { setCardIndex(0); }, [deferredQuery, feed]);
  useEffect(() => { if (!notice) return; const timer = window.setTimeout(() => setNotice(''), 4200); return () => clearTimeout(timer); }, [notice]);
  function persist(next: DemoState) {
    if (needsBackup.current) {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw !== null) localStorage.setItem(`${STORAGE_KEY}.recovery.${id()}`, raw);
      needsBackup.current = false;
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  }
  function commit(next: DemoState): boolean {
    try { persist(next); setDemo(next); setError(''); return true; }
    catch { setError('本机保存失败。请保留输入，释放浏览器存储空间后重试。'); return false; }
  }
  function draft(patch: Partial<Pick<DemoState, 'draft' | 'draftKind' | 'draftSource'>>) {
    const next = { ...demo, ...patch }; setDemo(next);
    try { persist(next); setError(''); }
    catch { setError('草稿仅在当前页面，尚未持久保存。请勿关闭页面。'); }
  }
  function addEvent(next: DemoState, kind: string) { return { ...next, pending: [...next.pending, { id: id(), kind }] }; }
  function go(next: MobileTab) { setTab(next); setConversation(null); }
  function recordFrom(source: string, kind: Capture['kind'] = '复述') {
    // A suspended draft keeps its original source even when another card opens it.
    if (!demo.draft.trim()) draft({ draftSource: source, draftKind: kind });
    setReading(null);
    setRestatementOpen(true);
  }
  function saveRestatement() {
    if (!demo.draft.trim()) return false;
    const record: Capture = { id: id(), text: demo.draft.trim(), kind: demo.draftKind, sourceId: demo.draftSource, at: new Date().toISOString() };
    if (!commit(addEvent({ ...demo, records: [record, ...demo.records], draft: '' }, '个人记录'))) return false;
    setNotice('已保存到本机原型');
    return true;
  }
  function bookmark(source: string) { if (commit({ ...demo, bookmarks: demo.bookmarks.includes(source) ? demo.bookmarks.filter(x => x !== source) : [...demo.bookmarks, source] })) setNotice(demo.bookmarks.includes(source) ? '已取消原型收藏' : '已收藏到本机原型'); }
  const question = questions[questionIndex];
  const message = conversation ? demo.messageDrafts?.[conversation] || '' : '';
  const activeConversation = conversations.find(c => c.id === conversation);
  const visible = (feed === '资讯' ? newsReadings : readings).filter(r => !deferredQuery || `${r.title} ${r.summary} ${r.category} ${r.sections.map(s => s.text).join(' ')}`.toLowerCase().includes(deferredQuery));
  const activeCardIndex = Math.max(0, Math.min(cardIndex, visible.length - 1));
  const activeCard = visible[activeCardIndex];
  function changeCard(step: number) {
    const next = activeCardIndex + step;
    if (next < 0 || next >= visible.length) return;
    setCardDirection(step > 0 ? 'next' : 'previous');
    setCardIndex(next);
  }
  const info = tabInfo[tab];
  function updateMessageDraft(text: string) {
    if (!conversation) return;
    const next = { ...demo, messageDrafts: { ...demo.messageDrafts, [conversation]: text } };
    setDemo(next);
    try { persist(next); setError(''); }
    catch { setError('消息草稿未保存，请稍后重试。'); }
  }
  function openAdjustment(task: Task | null = null) {
    setAdjustTask(task);
    setNewDay(task?.day === '明天' ? '今天' : '明天');
    setConflict(false);
    setSheet('adjust');
  }

  function renderDiscover() {
    return <div className="mp-discovery">
      <label className="mp-search"><Search size={18} /><input aria-label="搜索自己的资料" placeholder={feed === '资讯' ? '搜索资讯样例' : '搜索自己的资料'} value={query} onChange={e => setQuery(e.target.value)} />{query && <button className="mp-icon" aria-label="清除搜索" onClick={() => setQuery('')}><X size={16} /></button>}</label>
      <div className="mp-segment mp-discovery-tabs" aria-label="内容来源">{(['推荐', '我的资料', '资讯'] as const).map(f => <button key={f} aria-pressed={feed === f} onClick={() => setFeed(f)}>{f}</button>)}</div>
      {activeCard ? <>
        <div className="mp-card-stack">
          <article key={activeCard.id} className="mp-discover-card" data-testid="discover-card" data-source-id={activeCard.id} data-direction={cardDirection}
            role="region" aria-roledescription="卡片" aria-label={activeCard.title} tabIndex={0}
            onKeyDown={e => { if (e.target !== e.currentTarget) return; if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); changeCard(e.key === 'ArrowRight' ? 1 : -1); } }}
            onTouchStart={e => { swipeStart.current = e.touches.length === 1 && !(e.target as HTMLElement).closest('button,a,input,textarea') ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null; }}
            onTouchCancel={() => { swipeStart.current = null; }}
            onTouchEnd={e => { const start = swipeStart.current; swipeStart.current = null; if (!start || e.touches.length || !e.changedTouches.length) return; const dx = e.changedTouches[0].clientX - start.x, dy = e.changedTouches[0].clientY - start.y; if (Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy) * 1.3) changeCard(dx < 0 ? 1 : -1); }}>
            <div className="mp-discover-card-top"><span>{activeCard.category} · {activeCard.minutes} 分钟</span><button className="mp-icon" aria-label={demo.bookmarks.includes(activeCard.id) ? '取消收藏' : '收藏'} aria-pressed={demo.bookmarks.includes(activeCard.id)} onClick={() => bookmark(activeCard.id)}><Bookmark size={18} fill={demo.bookmarks.includes(activeCard.id) ? 'currentColor' : 'none'} /></button></div>
            <div className="mp-discover-card-content"><h1>{activeCard.title}</h1><p className="mp-discover-summary">{activeCard.summary}</p><div className="mp-card-excerpt"><span /> <h2>{activeCard.sections[0].heading}</h2><p>{activeCard.sections[0].text}</p></div></div>
            <div className="mp-discover-card-bottom"><p><BookOpen size={13} />{feed === '资讯' ? '资讯样例 · 非实时' : '我的桌面资料 · 演示'}</p><div><button className="mp-text-button" onClick={() => setReading(activeCard)}>阅读全文<ArrowUpRight size={15} /></button><button className="mp-primary" onClick={() => recordFrom(activeCard.id, feed === '资讯' ? '想法' : '复述')}><Mic size={17} />复述</button></div></div>
          </article>
        </div>
        <div className="mp-card-switcher"><button className="mp-icon" aria-label="上一张" disabled={activeCardIndex === 0} onClick={() => changeCard(-1)}><ArrowLeft size={18} /></button><div aria-live="polite"><span>{String(activeCardIndex + 1).padStart(2, '0')} <i>/ {String(visible.length).padStart(2, '0')}</i></span><small>左右滑动，换一张</small></div><button className="mp-icon" aria-label="下一张" disabled={activeCardIndex === visible.length - 1} onClick={() => changeCard(1)}><ArrowRight size={18} /></button></div>
      </> : <div className="mp-empty"><Search size={28} /><h3>没有找到这项内容</h3><p>换个关键词试试。</p><button className="mp-text-button" onClick={() => setQuery('')}>查看全部演示资料</button></div>}
    </div>;
  }
  function renderPractice() {
    return <PracticePage questionIndex={questionIndex} selected={selected} answers={demo.answers}
      onSelect={setSelected} onQuestionChange={index => { setQuestionIndex(index); setSelected(null); }}
      onSubmit={() => { if (selected !== null) commit(addEvent({ ...demo, answers: { ...demo.answers, [question.id]: selected } }, '简测作答')); }}
      onOpenSource={source => setReading(readings.find(r => r.id === source) || null)} />;
  }
  function renderCapture() {
    return <RecordsPage records={demo.records} draftText={demo.draft}
      onCreate={() => recordFrom('', '想法')} onResume={() => setRestatementOpen(true)} onOpen={setRecordDetail} />;
  }
  function renderMessages() {
    return <MessagesPage conversationId={conversation} messages={demo.messages} blockedIds={demo.blocked}
      draft={message} onDraftChange={updateMessageDraft} onOpen={setConversation} onBack={() => setConversation(null)}
      onSend={() => { if (!conversation || !message.trim()) return; commit({ ...demo,
        messages: [...demo.messages, { id: id(), conversation, text: message.trim(), self: true }],
        messageDrafts: { ...demo.messageDrafts, [conversation]: '' } }); }}
      onReport={() => setSheet('report')} onUnblock={() => commit({ ...demo, blocked: demo.blocked.filter(value => value !== conversation) })} />;
  }
  function renderPlan() {
    return <PlanPage tasks={demo.tasks}
      onToggle={task => commit(addEvent({ ...demo, tasks: demo.tasks.map(t => t.id === task.id ? { ...t, done: !t.done } : t) }, '任务状态'))}
      onCreate={() => { setGenerated(null); setSheet('generate'); }}
      onAdjust={task => openAdjustment(task)} onAdjustAll={() => openAdjustment()}
      onOpen={task => { if (task.kind === '简测') { setQuestionIndex(0); setSelected(null); go('practice'); }
        else if (task.kind === '复述') recordFrom('retrieval');
        else setReading(readings[0]); }} />;
  }
  return <div className="mp-studio">
    <header className="mp-studio-header"><a href="#" className="mp-brand" onClick={e => { e.preventDefault(); setView('prototype'); }}><img src="/loginote-mark.svg" alt="" /><span>LogiNote<small>静默生长</small></span></a><nav aria-label="设计工作区">{([{ key: 'prototype', label: '移动端原型' }, { key: 'architecture', label: '协同架构' }, { key: 'roadmap', label: '实施路线' }] as const).map(v => <button key={v.key} aria-current={view === v.key ? 'page' : undefined} onClick={() => setView(v.key)}>{v.label}</button>)}</nav><span className="mp-studio-version">DESIGN EXPLORATION <b>01</b></span></header>
    {view === 'prototype' ? <main className="mp-stage">
      <aside className="mp-intro"><span className="mp-eyebrow">LOGINOTE · 随身学习伙伴</span><h2>一份知识，<br />随处继续。</h2><p>电脑上深度构建，<br />手机上轻盈回响。</p><div className="mp-intro-rule" /><p className="mp-intro-copy">让阅读、复述和短练习融入生活，把每一次零散的思考，带回同一份知识里。</p><div className="mp-platforms"><Smartphone size={17} /><span>Android & iOS · 独立体验</span></div><div className="mp-intro-note"><span>第一阶段 / 交互验证</span><p>点击手机中的内容进行体验。<br />演示数据仅存本机，不访问真实资料、账号或 AI 服务。</p></div></aside>
      <section ref={deviceRef} className="mp-device" aria-label="LogiNote 移动端原型"><div className="mp-device-status"><span>9:41</span><span className="mp-camera" /><span><Wifi size={15} /><span className="mp-battery" /></span></div><header className="mp-app-header"><span><Leaf size={21} strokeWidth={1.4} />LogiNote</span><div><button className="mp-sync-indicator" aria-label="查看同步状态" onClick={() => setSheet('sync')}>{offline ? <CloudOff size={17} /> : <Cloud size={17} />}<span>{demo.pending.length ? `${demo.pending.length} 条待同步` : '演示资料'}</span></button><button className="mp-profile" aria-label="账号与隐私" onClick={() => setSheet('profile')}>我</button></div></header>
        <div className="mp-demo-strip">原型 · 演示数据{offline ? ' · 模拟离线' : ''}</div>
        {error && <p role="alert" className="mp-error">{error}</p>}
        <div ref={scrollRef} className={`mp-app-scroll ${tab === 'discover' ? 'mp-discover-scroll' : ''} ${tab === 'messages' ? 'mp-messages-scroll' : ''}`}>{tab === 'discover' ? renderDiscover() : tab === 'practice' ? renderPractice() : tab === 'capture' ? renderCapture() : tab === 'messages' ? renderMessages() : renderPlan()}</div>
        <nav className="mp-bottom-nav" aria-label="移动端主导航">{tabs.map(({ key, Icon }) => <button key={key} aria-current={tab === key ? 'page' : undefined} onClick={() => go(key)}><span><Icon size={21} strokeWidth={tab === key ? 2 : 1.6} />{key === 'capture' && <i />}</span>{tabInfo[key].label}</button>)}</nav>
        {notice && <div className="mp-toast" role="status"><CheckCircle2 size={17} />{notice}</div>}
      </section>
      <aside className="mp-context"><span className="mp-eyebrow">{info.en} / {String(tabs.findIndex(t => t.key === tab) + 1).padStart(2, '0')}</span><h2>{info.label}，<br />从一个小动作开始。</h2><p>{info.scene}</p><ol>{info.actions.map((action, i) => <li key={action}><span>0{i + 1}</span>{action}</li>)}</ol><div className="mp-design-boundary"><LockKeyhole size={17} /><h3>功能边界</h3><p>{info.boundary}</p></div><button className="mp-text-button" onClick={() => setView('architecture')}>看看数据如何互通<ArrowUpRight size={16} /></button></aside>
    </main> : <DesignView view={view} goPrototype={() => setView('prototype')} />}
    <footer className="mp-studio-footer"><span>以深度思考为根，以日常行动为叶。</span><span>LOGiNOTE MOBILE / PRODUCT CONCEPT · 2026</span></footer>

    {restatementOpen && <RestatementBubble text={demo.draft} sourceTitle={[...readings, ...newsReadings].find(r => r.id === demo.draftSource)?.title || '独立记录'} error={error} anchor={deviceRef.current} onChange={text => draft({ draft: text })} onSave={saveRestatement} onClose={() => setRestatementOpen(false)} />}

    {recordDetail && <Sheet title="记录" label="记录详情" close={() => setRecordDetail(null)}><time className="sp-note">{new Date(recordDetail.at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time><p className="sp-record-body">{recordDetail.text}</p>{[...readings, ...newsReadings].some(r => r.id === recordDetail.sourceId) && <button className="mp-secondary mp-full" onClick={() => { setReading([...readings, ...newsReadings].find(r => r.id === recordDetail.sourceId)!); setRecordDetail(null); }}>查看资料<ArrowUpRight size={16} /></button>}</Sheet>}

    {reading && <Sheet title="阅读" close={() => setReading(null)} wide><div className="mp-reader-meta">{reading.category} · {reading.minutes} 分钟 · 演示资料</div><h1 className="mp-reader-title">{reading.title}</h1><p className="mp-reader-intro">{reading.summary}</p><div className="mp-reader-source"><FileText size={16} /><span>来源：{reading.id.startsWith('news-') ? '编辑演示文章' : '桌面知识库示例'} / {reading.category}<small>演示快照 v1 · 只读阅读</small></span></div><article className="mp-reader">{reading.sections.map(s => <section key={s.heading}><h2>{s.heading}</h2><p>{s.text}</p></section>)}</article><div className="mp-reader-actions"><button className="mp-primary" onClick={() => recordFrom(reading.id, reading.id.startsWith('news-') ? '想法' : '复述')}>{reading.id.startsWith('news-') ? '记录一个想法' : '用自己的话复述'}<NotebookPen size={17} /></button>{questions.some(q => q.source === reading.id) && <button className="mp-secondary" onClick={() => { setQuestionIndex(questions.findIndex(q => q.source === reading.id)); setSelected(null); setReading(null); go('practice'); }}>做个简测<Zap size={17} /></button>}</div></Sheet>}
    {sheet && <Sheet title={sheetTitles[sheet]} error={error} close={() => setSheet(null)}>
      {sheet === 'sync' && <><div className="sp-summary"><Cloud size={23} /><span>仅本机演示</span></div><div className="mp-stat-row"><span>待处理</span><strong>{demo.pending.length} 条</strong></div><div className="mp-stat-row"><span>模拟回执</span><strong>{demo.receipts} 条</strong></div><label className="mp-switch-label"><input type="checkbox" checked={offline} onChange={e => setOffline(e.target.checked)} />模拟离线</label><label className="mp-switch-label"><input type="checkbox" checked={simulateConflict} onChange={e => { setSimulateConflict(e.target.checked); setConflict(false); }} />模拟计划冲突</label><button className="mp-primary mp-full" aria-label="模拟服务器回执" disabled={offline || !demo.pending.length} onClick={() => { if (commit({ ...demo, pending: [], receipts: demo.receipts + demo.pending.length })) setNotice('模拟接收完成，未上传'); }}>演示接收</button></>}
      {sheet === 'profile' && <><div className="sp-account"><span className="mp-avatar">我</span><div><h3>本机原型</h3><span>未登录</span></div></div><div className="sp-settings">{[{ icon: Cloud, name: '数据与同步', label: '数据与同步', action: () => setSheet('sync') }, { icon: ShieldCheck, name: '隐私与 AI', label: '隐私与 AI 使用', action: () => setSheet('privacy') }, { icon: LockKeyhole, name: '删除账号', label: '查看账号删除流程', action: () => setSheet('delete') }, { icon: FileText, name: '协议与许可', label: '协议与开源许可说明', action: () => setSheet('legal') }].map(item => <button key={item.name} className="mp-settings-row" aria-label={item.label} onClick={item.action}><item.icon size={20} />{item.name}<ChevronRight size={17} /></button>)}</div></>}
      {sheet === 'privacy' && <><div className="mp-stat-row"><span>私人资料</span><strong>默认私有</strong></div><div className="mp-stat-row"><span>AI 授权</span><strong aria-live="polite">{demoConsent === 'allowed' ? '已允许（演示）' : '未授权'}</strong></div><button className="mp-settings-row" aria-label="体验 AI 授权流程（不发送）" onClick={() => setSheet('ai-consent')}><Sparkles size={19} />管理 AI 授权<ChevronRight size={17} /></button>{demoConsent === 'allowed' && <button className="sp-danger-action" aria-label="撤回演示授权" onClick={() => { setDemoConsent('declined'); setNotice('已撤回演示授权'); }}>撤回授权</button>}<p className="sp-note">原型不发送资料或采集声音。</p></>}
      {sheet === 'ai-consent' && <><div className="sp-definition"><div><span>接收方</span><strong>尚未接入</strong></div><div><span>用途</span><strong>生成学习计划</strong></div><div><span>内容</span><strong>目标与所选资料片段</strong></div><div><span>保留策略</span><strong>正式接入前披露</strong></div></div><p className="sp-note">仅演示，不发送资料。</p><button className="mp-primary mp-full" aria-label="模拟同意本次用途" onClick={() => { setDemoConsent('allowed'); setSheet('privacy'); }}>允许</button><button className="mp-secondary mp-full" onClick={() => { setDemoConsent('declined'); setSheet('privacy'); }}>暂不发送</button></>}
      {sheet === 'legal' && <><details className="sp-disclosure"><summary>隐私政策</summary><p>正式版列明数据用途、接收方、保留期限和删除方式。</p></details><details className="sp-disclosure"><summary>用户与社区协议</summary><p>正式版提供服务条款、社区规范和支持联系方式。</p></details><details className="sp-disclosure"><summary>开源许可</summary><p>按发行版本附 React、Lucide 与 Noto Serif SC 等实际依赖的许可。</p></details><p className="sp-note">原型说明，非已生效协议。</p><a className="mp-text-button" href="https://developer.apple.com/app-store/review/guidelines/" target="_blank" rel="noreferrer">Apple 审核指南<ArrowUpRight size={15} /></a><br /><a className="mp-text-button" href="https://play.google.com/about/developer-content-policy/" target="_blank" rel="noreferrer">Google Play 政策<ArrowUpRight size={15} /></a></>}
      {sheet === 'delete' && <><p className="sp-note">原型没有真实账号。</p><ol className="sp-delete-steps"><li>验证账号</li><li>选择导出资料</li><li>确认删除并撤销设备</li></ol><button className="mp-secondary mp-full" disabled>当前无可删除账号</button></>}
      {sheet === 'report' && <><p className="sp-object-name">{activeConversation?.name}</p><label className="mp-label" htmlFor="report-reason">原因</label><select id="report-reason" value={reportReason} onChange={e => setReportReason(e.target.value)}><option>骚扰或不当内容</option><option>侵犯隐私</option><option>版权问题</option><option>其他问题</option></select><button className="mp-primary mp-full" aria-label="演示提交举报" onClick={() => { setSheet(null); setNotice('演示举报，未提交'); }}>举报</button><button className="mp-secondary mp-full" aria-label="在原型中屏蔽此会话" onClick={() => { if (!conversation) return; if (commit({ ...demo, blocked: [...new Set([...demo.blocked, conversation])] })) setSheet(null); }}>屏蔽此会话</button></>}
      {sheet === 'generate' && <><form className="sp-plan-form" onSubmit={e => { e.preventDefault(); if (!goal.trim()) return; setGenerated([{ id: id(), title: `阅读：${goal.trim()}`, kind: '阅读', minutes: Math.max(1, Math.floor(minutes * 0.4)), day: '今天', done: false }, { id: id(), title: `复述：${goal.trim()}的一个关键点`, kind: '复述', minutes: Math.max(1, Math.floor(minutes * 0.3)), day: '明天', done: false }, { id: id(), title: `简测：检验${goal.trim()}的理解`, kind: '简测', minutes: Math.max(1, Math.ceil(minutes * 0.3)), day: '明天', done: false }]); }}><label className="mp-label" htmlFor="plan-goal">目标</label><textarea id="plan-goal" aria-label="你的目标" placeholder="想学什么？" maxLength={80} rows={3} required value={goal} onChange={e => { setGoal(e.target.value); setGenerated(null); }} /><label className="mp-label" htmlFor="plan-minutes">每日时长</label><select id="plan-minutes" value={minutes} onChange={e => { setMinutes(Number(e.target.value)); setGenerated(null); }}><option value={10}>10 分钟</option><option value={15}>15 分钟</option><option value={30}>30 分钟</option></select><button className="mp-secondary mp-full" aria-label="生成演示草案" disabled={!goal.trim()}>生成草案<Sparkles size={17} /></button></form>{generated && <div className="sp-plan-draft" aria-live="polite"><span className="sp-note">示例草案 · 未调用 AI</span>{generated.map(t => <div key={t.id}><strong>{t.title}</strong><span>{t.day} · {t.minutes} 分钟</span></div>)}<button className="mp-primary mp-full" aria-label="确认加入演示计划" onClick={() => { if (commit(addEvent({ ...demo, tasks: [...demo.tasks, ...generated] }, '计划草案确认'))) { setSheet(null); setGenerated(null); setNotice('已加入演示计划'); } }}>加入计划<Check size={17} /></button></div>}</>}
      {sheet === 'adjust' && <><label className="mp-label" htmlFor="adjust-day">日期</label><select id="adjust-day" aria-label="调整到" value={newDay} onChange={e => setNewDay(e.target.value)}><option>今天</option><option>明天</option><option>本周末</option></select><div className="sp-plan-draft">{demo.tasks.filter(t => adjustTask ? t.id === adjustTask.id : !t.done).map(t => <div key={t.id}><strong>{t.title}</strong><span>{t.day}<ArrowRight size={13} />{newDay}</span></div>)}</div>{conflict && <div className="mp-conflict" role="alert"><strong>计划已更新，草案已保留</strong><button className="mp-secondary mp-full" aria-label="按新版本重新预览" onClick={() => { setConflict(false); setSimulateConflict(false); }}>重新预览</button></div>}<button className="mp-primary mp-full" aria-label="确认这次调整" disabled={conflict || (!adjustTask && demo.tasks.every(t => t.done))} onClick={() => { if (simulateConflict) { setConflict(true); return; } if (commit(addEvent({ ...demo, tasks: demo.tasks.map(t => (adjustTask ? t.id === adjustTask.id : !t.done) ? { ...t, day: newDay } : t) }, '计划改期'))) { setSheet(null); setNotice('已调整'); } }}>确认调整<Check size={17} /></button></>}
    </Sheet>}
  </div>;
}

function DesignView({ view, goPrototype }: { view: 'architecture' | 'roadmap'; goPrototype: () => void }) {
  return <main className="mp-design-page"><span className="mp-eyebrow">{view === 'architecture' ? 'ONE KNOWLEDGE SPACE / 多端协同' : 'BUILD WITH INTENT / 分期交付'}</span><h1>{view === 'architecture' ? '共享数据，尊重每一端的使用方式。' : '先验证体验，再接通真实的数据。'}</h1><p className="mp-design-lead">{view === 'architecture' ? '桌面负责深度生产，手机负责随身学习。私人同步与公共社区分开，使用成熟方案的设计经验。' : '当前为第一阶段产品原型。安装包、云同步与上架需要独立的实现和验收。'}</p>
    {view === 'architecture' ? <><div className="mp-architecture"><section><span className="mp-eyebrow">DESKTOP</span><h2>深度构建</h2><p>长文与知识结构<br />文档整理、复杂场景<br />参考依据与 AI 深度任务</p><span className="mp-pill">本地 Markdown + user-state</span></section><div className="mp-architecture-arrow"><ArrowRight /><span>阅读投影<br />版本与来源</span><ArrowLeft /><span>短记录事件<br />计划变更意图</span></div><section className="mp-cloud"><Cloud size={25} /><h2>私人同步域</h2><p>账号 / 资料库隔离<br />增量游标、幂等回执<br />冲突保留、删除墓碑</p><span className="mp-pill">不承载模型密钥与全量索引</span></section><div className="mp-architecture-arrow"><ArrowRight /><span>按需同步<br />离线可读</span><ArrowLeft /><span>本地队列<br />重连续传</span></div><section><span className="mp-eyebrow">MOBILE</span><h2>日常回响</h2><p>查阅、推荐与资讯<br />复述、简测与社交<br />生成计划草案与轻量调整</p><span className="mp-pill">独立 React UI + 原生适配</span></section></div><div className="mp-design-columns"><section><h2>成熟实践，按需借鉴</h2><p><a href="https://joplinapp.org/help/dev/spec/sync/" target="_blank" rel="noreferrer">Joplin</a>：离线优先、同步分层和冲突保留。</p><p><a href="https://github.com/streetwriters/notesnook" target="_blank" rel="noreferrer">Notesnook</a>：独立终端界面，共享业务内核。</p><p><a href="https://capacitorjs.com/docs" target="_blank" rel="noreferrer">Capacitor</a>：复用现有 Web 技术，接入 iOS / Android 原生能力。</p><p className="mp-caption">参考设计不等于引入代码。许可证、商业插件与服务端部署单独评估。</p></section><section><h2>关键边界</h2><ul><li>云同步开关目前没有完整私人同步实现。</li><li>手机不上传整份旧笔记覆盖桌面。</li><li>复述和简测按独立事件保存，不混作参考真值。</li><li>计划变更先预览，版本冲突保留草案。</li><li>正式 AI 功能在发送私人资料前取得明确同意。</li></ul></section></div></> : <><div className="mp-roadmap">{[{ phase: '01', name: '定义与体验验证', state: '本次交付', lines: ['独立移动导航与关键任务闭环', '演示数据隔离、可操作原型', '同步设计、开源参考与上架规范'] }, { phase: '02', name: '私人数据协同', state: '后续实现', lines: ['选型验证、私有同步服务与设备授权', '桌面投影、离线队列与回执', '跨设备冲突、删除与撤销测试'] }, { phase: '03', name: '原生核心能力', state: '后续实现', lines: ['Android / iOS 原生包与真机适配', '录音转写、简测和 AI 计划', '社区消息、举报、账号删除'] }, { phase: '04', name: '正式提审与运营', state: '后续验收', lines: ['隐私、权限、内购及 SDK 合规核对', '审核账号、线上后端与演示资料', 'TestFlight / Play 测试和商店提审'] }].map(p => <section key={p.phase}><span className="mp-eyebrow">PHASE {p.phase} / {p.state}</span><h2>{p.name}</h2><ul>{p.lines.map(l => <li key={l}>{l}</li>)}</ul></section>)}</div><div className="mp-design-columns"><section><h2>设计从官方规则开始</h2><p>把独立移动价值、离线使用、隐私同意、账号删除和社交治理放进正式版验收范围；不以一个 WebView 链接列表作为安装包交付。</p><a className="mp-text-button" href="https://developer.apple.com/app-store/review/guidelines/" target="_blank" rel="noreferrer">Apple App Review Guidelines<ArrowUpRight size={15} /></a><br /><a className="mp-text-button" href="https://play.google.com/about/developer-content-policy/" target="_blank" rel="noreferrer">Google Play Developer Policies<ArrowUpRight size={15} /></a></section><section><h2>交付物与限制</h2><p>本原型不连接真实账号、桌面知识库、云端或 AI。录音说明、举报与账号删除目前展示流程设计，不能代替后端能力或提审证据。</p><p>官方政策会更新，正式提审时重新核对。符合设计原则不能保证审核通过。</p></section></div></>}
    <button className="mp-primary" onClick={goPrototype}>回到可操作原型<Smartphone size={17} /></button>
  </main>;
}
