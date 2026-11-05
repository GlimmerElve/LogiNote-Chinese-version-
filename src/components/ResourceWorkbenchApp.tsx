import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  BookOpenText,
  Check,
  Download,
  ExternalLink,
  FileSearch,
  Files,
  FlaskConical,
  Home,
  LogIn,
  RefreshCw,
  Search,
  ShieldCheck,
  Video,
  ThumbsDown,
  X,
} from 'lucide-react';
import type { ResourceItem } from '../types';
import { createResourceWorkbenchController, type ResourceWorkbenchApi } from '../services/ui/resourceWorkbenchController';
import { resourceWorkbenchLayout } from '../services/ui/resourceWorkbenchLayout';

type FilterId = 'all' | 'selected' | 'downloadable' | 'preferences';

function typeLabel(resource: ResourceItem): string {
  const labels: Record<string, string> = {
    webpage: '网页', article: '文章', video: '视频', audio: '音频', pdf: 'PDF',
    presentation: '演示文稿', document: '文档', image: '图片', archive: '压缩包', other: '其他',
  };
  return labels[resource.resourceType || 'webpage'] || '网页';
}

function sizeLabel(bytes?: number): string {
  if (!bytes) return '';
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function categoryLabel(resource: ResourceItem): string {
  return {
    encyclopedia: '百科概念',
    video: '视频介绍',
    materials: '资料教材',
    practice: '实践案例',
    paper: '论文研究',
  }[resource.searchCategory || ''] || '';
}

const TAB_ICONS = {
  encyclopedia: BookOpenText,
  video: Video,
  materials: Files,
  practice: FlaskConical,
  paper: BookOpenText,
};

export const ResourceWorkbenchApp: React.FC<{ api?: ResourceWorkbenchApi }> = ({ api: suppliedApi }) => {
  const api = suppliedApi || (window as any).electronAPI?.resourceWorkbench;
  const controller = useMemo(() => createResourceWorkbenchController(api), [api]);
  const [snapshot, setSnapshot] = useState(controller.getSnapshot);
  const { state, address, working, pending, error } = snapshot;
  const [filter, setFilter] = useState<FilterId>('all');
  const resourceListRef = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (resourceListRef.current) resourceListRef.current.scrollTop = 0;
  }, [filter, state?.sessionId]);
  const pendingFocusRef = useRef<{ element: HTMLElement; sessionId: string } | null>(null);
  const rememberActionFocus = (element: HTMLElement) => {
    if (state) pendingFocusRef.current = { element, sessionId: state.sessionId };
  };
  useEffect(() => controller.connect(setSnapshot), [controller]);
  useEffect(() => setFilter('all'), [state?.sessionId]);
  useEffect(() => {
    if (working || !pendingFocusRef.current) return;
    const target = pendingFocusRef.current;
    pendingFocusRef.current = null;
    if (target.sessionId !== state?.sessionId || !target.element.isConnected || target.element.matches(':disabled')) return;
    if (document.activeElement === document.body || document.activeElement === document.documentElement
      || document.activeElement === target.element) target.element.focus({ preventScroll: true });
  }, [working, state?.sessionId]);
  const { navigate, decide, toggleDownload, scan, saveSiteLogin, commit } = controller;
  const handleTabKey = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey
      || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]:not(:disabled)'));
    const index = tabs.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;
    const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length
      : event.key === 'ArrowLeft' ? (index - 1 + tabs.length) % tabs.length
        : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1;
    if (next < 0) return;
    event.preventDefault(); tabs[next]?.focus();
  };

  const resources = state?.resources || [];
  const selected = resources.filter((item) => state?.decisions[item.candidateId || ''] === 'selected');
  const rejected = resources.filter((item) => state?.decisions[item.candidateId || ''] === 'rejected');
  const downloadable = resources.filter((item) => item.downloadable);
  const activeSearchTab = state?.searchTabs?.find((tab) => tab.id === state.activeSearchTabId);
  const visible = useMemo(() => {
    if (!state) return [];
    if (filter === 'selected') return selected;
    if (filter === 'downloadable') return downloadable;
    if (filter === 'preferences') return resources.filter((item) => Boolean(state.decisions[item.candidateId || '']));
    return resources;
  }, [downloadable, filter, resources, selected, state]);

  if (!state) {
    return <main className="rw-loading" role="status"><RefreshCw aria-hidden="true" />{api ? '正在初始化资源工作台…' : '资源工作台需要桌面版支持，请从项目资源入口重新打开。'}</main>;
  }
  const toolbarHeight = resourceWorkbenchLayout(1380, 860, Boolean(state.searchTabs?.length)).toolbarHeight;
  const pendingText = pending === 'commit' ? '正在确认并写回…'
    : pending === 'scan' ? '正在识别当前页面的资源…'
      : pending === 'authorize' ? '正在等待本站登录确认…'
        : pending === 'decision' || pending === 'download' ? '正在更新本批选择…'
          : '正在加载资源页面…';

  return (
    <main className="rw-shell" style={{ '--rw-toolbar-height': `${toolbarHeight}px` } as React.CSSProperties}>
      <header className="rw-browser-toolbar" aria-label="浏览器导航">
        <div className="rw-browser-controls">
          <button type="button" onClick={event => { rememberActionFocus(event.currentTarget); void navigate('back'); }} disabled={working || !state.canGoBack} aria-label="后退"><ArrowLeft /></button>
          <button type="button" onClick={event => { rememberActionFocus(event.currentTarget); void navigate('forward'); }} disabled={working || !state.canGoForward} aria-label="前进"><ArrowRight /></button>
          <button type="button" onClick={event => { rememberActionFocus(event.currentTarget); void navigate('reload'); }} disabled={working} aria-label="刷新"><RefreshCw /></button>
          <button type="button" onClick={event => { rememberActionFocus(event.currentTarget); void navigate('home'); }} disabled={working} aria-label="返回本次搜索"><Home /></button>
          <form onSubmit={(event) => { event.preventDefault(); void navigate('go', address); }}>
            <Search aria-hidden="true" />
            <input value={address} readOnly={pending === 'navigate'} onChange={(event) => controller.setAddress(event.target.value)} aria-label="网址或搜索词" placeholder="输入网址或搜索词" />
          </form>
          <button type="button" className="rw-scan-button" aria-label={pending === 'scan' ? '正在扫描当前页' : '扫描当前页'} onClick={event => { rememberActionFocus(event.currentTarget); void scan(); }} disabled={working} title="识别当前页面及其中的 PDF、文档、视频等资源">
            <FileSearch aria-hidden="true" />{pending === 'scan' ? '正在扫描…' : '扫描当前页'}
          </button>
        </div>
        {state.searchTabs && state.searchTabs.length > 0 && (
          <nav className="rw-search-tabs" role="tablist" aria-label="资源检索类型" onKeyDown={handleTabKey}>
            {state.searchTabs.map((tab) => {
              const Icon = TAB_ICONS[tab.id];
              const active = state.activeSearchTabId === tab.id;
              return (
                <button
                  type="button"
                  role="tab"
                  aria-selected={active}
                  tabIndex={active ? 0 : -1}
                  id={`rw-tab-${tab.id}`}
                  aria-controls="rw-search-page"
                  className={active ? 'is-active' : ''}
                  key={tab.id}
                  title={`${tab.description}；${tab.loaded ? '已加载' : '首次点击时加载'}；Agent 自动发布基线 ${tab.automaticTarget} 个，不限制人工选择`}
                  onClick={event => { rememberActionFocus(event.currentTarget); void navigate('switch-tab', tab.id); }}
                  disabled={working}
                >
                  <Icon aria-hidden="true" />
                  <span>{tab.label}</span>
                  <small>{tab.candidateCount}</small>
                </button>
              );
            })}
          </nav>
        )}
        {activeSearchTab?.variants && activeSearchTab.variants.length > 0 && (
          <nav className="rw-query-variants" aria-label={`${activeSearchTab.label}备用搜索词`}>
            <span>搜索词</span>
            {activeSearchTab.variants.map((variant) => (
              <button
                type="button"
                key={variant.id}
                aria-pressed={activeSearchTab.activeVariantId === variant.id}
                title={`搜索：${variant.query}`}
                disabled={working}
                onClick={event => { rememberActionFocus(event.currentTarget); void navigate('search-variant', `${activeSearchTab.id}::${variant.id}`); }}
              >
                {variant.label}
              </button>
            ))}
            <small title={activeSearchTab.query}>{activeSearchTab.query}</small>
          </nav>
        )}
      </header>

      <section id="rw-search-page" className="rw-search-page" role="tabpanel" aria-label="资源浏览页面" aria-labelledby={activeSearchTab ? `rw-tab-${activeSearchTab.id}` : undefined} tabIndex={0}>
        <BookOpenText aria-hidden="true" /><span>网页在桌面版隔离浏览器中显示</span>
      </section>

      <aside className="rw-sidebar" aria-label="资源操作栏">
        <header className="rw-sidebar-head">
          <div>
            <span className="rw-eyebrow">资源统筹工作台</span>
            <h1>{state.projectTitle}</h1>
            <p>{state.taskText}</p>
          </div>
          <button type="button" className="rw-close" disabled={working} onClick={() => controller.close()} aria-label="关闭资源工作台"><X /></button>
          <div className="rw-knowledge" aria-label="关联知识点">
            {state.knowledgeTitles.map((title) => <span key={title}>{title}</span>)}
          </div>
        </header>

        <section className="rw-summary" aria-label="本批选择摘要">
          <div><strong>{selected.length}</strong><span>加入备选</span></div>
          <div><strong>{rejected.length}</strong><span>不感兴趣</span></div>
          <div><strong>{state.downloadCandidateIds.length}</strong><span>确认后下载</span></div>
        </section>

        {working && <div className="rw-notice rw-progress" role="status"><RefreshCw className="is-spinning" aria-hidden="true" />{pendingText}</div>}
        {error ? <div className="rw-notice is-error" role="alert">{error}</div>
          : state.notice && !working ? <div className="rw-notice" role="status">{state.notice}</div> : null}

        <nav className="rw-filters" aria-label="筛选资源">
          {([
            ['all', `全部 ${resources.length}`],
            ['selected', `已选 ${selected.length}`],
            ['downloadable', `可下载 ${downloadable.length}`],
            ['preferences', `偏好事实 ${selected.length + rejected.length}`],
          ] as Array<[FilterId, string]>).map(([id, label]) => (
            <button type="button" key={id} aria-pressed={filter === id} onClick={() => setFilter(id)}>{label}</button>
          ))}
        </nav>

        <section ref={resourceListRef} className="rw-resource-list" aria-label="资源候选">
          {visible.length === 0 ? (
            <div className="rw-empty">
              <FileSearch aria-hidden="true" />
              <strong>当前列表为空</strong>
              <span>{filter === 'all' ? '在左侧打开目标页面后点击“扫描当前页”，也可以在网页链接上右键加入待确认清单。' : '当前筛选暂无匹配，切换“全部”查看其他候选。'}</span>
            </div>
          ) : visible.map((resource) => {
            const id = resource.candidateId || '';
            const decision = state.decisions[id];
            const wantsDownload = state.downloadCandidateIds.includes(id);
            return (
              <article className={`rw-resource-card${decision ? ` is-${decision}` : ''}`} key={id || resource.url}>
                <div className="rw-resource-title">
                  <button type="button" disabled={working || !id} onClick={event => { rememberActionFocus(event.currentTarget); void navigate('open-candidate', id); }} title="在左侧打开">
                    <strong>{resource.title}</strong><ExternalLink aria-hidden="true" />
                  </button>
                  <span>{resource.platform || resource.url}</span>
                </div>
                <div className="rw-badges">
                  <span>{typeLabel(resource)}</span>
                  {categoryLabel(resource) && <span>{categoryLabel(resource)}</span>}
                  {resource.isFree && <span>开放访问</span>}
                  {sizeLabel(resource.contentLength) && <span>{sizeLabel(resource.contentLength)}</span>}
                  {resource.downloadable && <span className="is-download">可下载{resource.indexable ? '并索引' : ''}</span>}
                  {resource.authContainerId && <span><ShieldCheck aria-hidden="true" />登录状态已保存</span>}
                </div>
                {resource.taskText && <div className="rw-task-binding">服务任务：{resource.taskText}</div>}
                {resource.description && <p>{resource.description}</p>}
                <div className="rw-card-actions">
                  <button
                    type="button"
                    className="is-select"
                    aria-pressed={decision === 'selected'}
                    disabled={working || !id}
                    onClick={event => { rememberActionFocus(event.currentTarget); void decide(resource, decision === 'selected' ? null : 'selected'); }}
                  ><Check />{decision === 'selected' ? '已加入' : '加入备选'}</button>
                  <button
                    type="button"
                    className="is-reject"
                    aria-pressed={decision === 'rejected'}
                    disabled={working || !id}
                    onClick={event => { rememberActionFocus(event.currentTarget); void decide(resource, decision === 'rejected' ? null : 'rejected'); }}
                  ><ThumbsDown />{decision === 'rejected' ? '已标记' : '不感兴趣'}</button>
                  {!resource.authContainerId && resource.kind !== 'local' && (
                    <button
                      type="button"
                      onClick={event => { rememberActionFocus(event.currentTarget); void saveSiteLogin(resource); }}
                      disabled={working}
                      title="经确认后，把本站当前 Cookie 保存到本机独立容器；以后在心流模式打开同源链接会自动复用"
                    ><LogIn />保存本站登录</button>
                  )}
                  {resource.downloadable && (
                    <label className="rw-download-toggle">
                      <input type="checkbox" disabled={working || !id} checked={wantsDownload} onChange={(event) => { rememberActionFocus(event.currentTarget); void toggleDownload(resource, event.target.checked); }} />
                      <Download aria-hidden="true" />确认后下载
                    </label>
                  )}
                </div>
              </article>
            );
          })}
        </section>

        <footer className="rw-footer">
          <p>普通浏览不会形成偏好。需要登录时请点“保存本站登录”；Cookie 仅保存在本机隔离容器。确认后，已选资源会写入对应项目并自动关闭。</p>
          <button type="button" onClick={event => { rememberActionFocus(event.currentTarget); void commit(); }} disabled={working || selected.length + rejected.length === 0}>
            {pending === 'commit' ? <RefreshCw className="is-spinning" aria-hidden="true" /> : <Check aria-hidden="true" />}
            {pending === 'commit' ? '正在写回…' : '确认并写回'}
          </button>
        </footer>
      </aside>
    </main>
  );
};
