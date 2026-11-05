import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowUpRight, FileText, Info, LockKeyhole, Mail, MoreHorizontal, Paperclip, PencilLine, Search, ShieldCheck, UserRound } from 'lucide-react';
import { ArrowLink, Avatar, Empty, Fold, LinkButton, Overlay, Primary, Tabs } from './ui';
import { initialState, names, pages, readDemo, resources, STORAGE_KEY, allResources, type DemoState, type DemoPost, type Page } from './model';
import { createUnavailableCommunityIdentityPort } from '../../../src/services/community/unavailableIdentity';
import { EditProfile } from './ProfileEditor';
import { learningGoalPort, type ClientLearningGoal } from './learningGoal';
import { canReadDiscussion, findDiscussion } from './discussions';
import { ResourceContent } from './ResourceDetail';
import { AppContext, useApp, type Panel, type Context, type Scenario, type MarketView } from './context';
import { HomePage, PeopleProfile, ManageFollowing } from './Discovery';
import { GroupDirectory, GroupPage, GroupPanel, CreateGroupPanel, MyGroupList } from './Groups';
import { MessagesPage, SharePanel } from './Sharing';
import { PublishPage } from './Publishing';
import { Hero, ScenarioContent, BookmarkButton, ResourceStrip, DemoPosts, ThreadPost } from './shared';
import { MarketPage } from './Market';
import { MessageImagePreview } from './MessageImages';
import { TopicManagement } from './TopicManagement';
import { TopicPage, SearchPage } from './TopicPages';
import { ServiceAccountPage } from './ServiceAccount';
import { ServiceGovernancePage } from './ServiceGovernance';
import { ServiceAttention } from './ServiceAttention';
import { serviceEnabled } from './serviceClient';
import { ServiceAvatar, ServiceProfilePage } from './ServiceProfile';
import {ServiceIdentityProvider,useServiceIdentity} from './ServiceIdentity';
import {ServicePages} from './ServicePages';
import {LinkSafetyProvider} from './LinkSafety';
import {usePopupDismissal} from './usePopupDismissal';
const identity = createUnavailableCommunityIdentityPort();
function parseRoute() { const [route, id] = location.hash.replace(/^#\/?/, '').split('/'); return { page: pages.includes(route as Page) ? route as Page : 'home' as Page, id: decodeRouteId(id || (route==='search'||route==='messages'?'':route==='discussion'?'question-gradient':'linear')) }; }
function decodeRouteId(id:string){try{return decodeURIComponent(id);}catch{return id;}}
export function CommunityApp() {
    usePopupDismissal();
    const [state, setState] = useState(()=>serviceEnabled()?structuredClone(initialState):readDemo());
    const [deleted, setDeleted] = useState<{id:string; post?:DemoPost; index:number}|null>(null);
    useEffect(()=>{if(!deleted)return;const timer=window.setTimeout(()=>setDeleted(null),8000);return()=>window.clearTimeout(timer);},[deleted]);
    const deletePost = (id:string) => {
        const post=state.posts.find(p=>p.id===id);
        if(!post&&!['seed-gradient','seed-summary'].includes(id))return;
        setDeleted({id,post,index:state.posts.findIndex(p=>p.id===id)});
        setState(v=>({...v,posts:v.posts.filter(p=>p.id!==id),deletedPostIds:[...new Set([...v.deletedPostIds,id])]}));
    };
    const undoDelete = () => {
        if(!deleted)return;
        setState(v=>{const posts=[...v.posts];if(deleted.post&&!posts.some(p=>p.id===deleted.id))posts.splice(Math.min(Math.max(0,deleted.index),posts.length),0,deleted.post);return {...v,posts,deletedPostIds:v.deletedPostIds.filter(id=>id!==deleted.id)};});
        setDeleted(null);
    };
    const [marketView, setMarketView] = useState<MarketView>({ query: '', topic: '全部', kind:'全部', limit: 3 });
    const scrollPositions = useRef<Record<string, number>>({});
    const previousPage = useRef(parseRoute().page);
    const [route, setRoute] = useState(parseRoute);
    const [panel, setPanel] = useState<Panel | null>(null);
    const [notice, setNotice] = useState('');
    const [scenario, setScenario] = useState<Scenario>('正常');
    const [storageProblem, setStorageProblem] = useState(false);
    useEffect(() => { const onRoute = () => { scrollPositions.current[previousPage.current] = window.scrollY; const next = parseRoute(); previousPage.current = next.page; setRoute(next); setPanel(null); setNotice(''); setScenario('正常'); }; window.addEventListener('hashchange', onRoute); return () => window.removeEventListener('hashchange', onRoute); }, []);
    useEffect(() => { window.scrollTo({ top: scrollPositions.current[route.page] || 0, behavior: 'instant' }); }, [route.page, route.id]);
    useEffect(() => { if(serviceEnabled())return;try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        setStorageProblem(false);
    }
    catch {
        setStorageProblem(true);
    } }, [state]);
    useEffect(() => { document.documentElement.dataset.theme = state.theme; }, [state.theme]);
    useEffect(() => { document.title = `${({ home: '首页', following: '关注', groups: '共学', market: '资源市场', discussion: '交流', group: '共学', friends: '学友', me: '我的主页', messages: '消息', publish: '分享资源', news: '资讯与公告', admin: serviceEnabled()?'社区治理':'治理演示', resource: '资源详情', topic:'话题', search:'搜索',account:'社区账号',feedback:'帮助与反馈' })[route.page]} · LogiNote`; }, [route.page]);
    const patch = (s: Partial<DemoState>) => setState(v => ({ ...v, ...s }));
    const go = (p: Page, id?: string) => { setPanel(null); setNotice(''); setScenario('正常'); location.hash = `/${p}${id ? `/${id}` : ''}`; };
    const bookmark = (id: string) => setState(v => ({ ...v, bookmarks: v.bookmarks.includes(id) ? v.bookmarks.filter(x => x !== id) : [...v.bookmarks, id] }));
    const value: Context = { deletePost, marketView, setMarketView, state, patch, page: route.page, go, open: p => { setNotice(''); setPanel(p); }, close: () => setPanel(null), bookmark, notice, setNotice,  scenario, setScenario, resourceId: route.id };
    const app=<AppContext value={value}><LinkSafetyProvider>
    <a className="skip-link" href="#main-content" onClick={e => { e.preventDefault(); document.getElementById('main-content')?.focus(); }}>跳到主要内容</a>
    <SiteHeader />
    <main id="main-content" tabIndex={-1} className={`main-content page-${route.page}`}>
      {storageProblem && <p className="inline-status">浏览器存储不可用，本次演示仍可操作，刷新后不会保留修改。</p>}
      {serviceEnabled()?<ServicePages page={route.page} id={route.id}/>:<>
      {route.page === 'home' && <HomePage key={route.id}/>}{route.page==='topic'&&<TopicPage key={route.id}/>} {route.page==='search'&&<SearchPage key={route.id}/>} {route.page === 'following' && <HomePage following key="following"/>}{route.page === 'groups' && <GroupDirectory/>}{route.page === 'market' && <MarketPage />}{route.page === 'discussion' && <DiscussionPage key={route.id}/>}{route.page === 'group' && <GroupPage />}
      {route.page === 'friends' && <PeopleProfile key={route.id}/>} {route.page === 'me' && (serviceEnabled()?<ServiceProfilePage/>:<ProfilePage/>)}{route.page === 'messages' && <MessagesPage />}
      {route.page === 'publish' && <PublishPage />}{route.page === 'news' && <NewsPage />}{route.page === 'admin' && (serviceEnabled()?<ServiceGovernancePage mode="administrator"/>:<AdminPage />)}{route.page === 'resource' && <ResourceContent key={route.id} id={route.id} standalone/>}
      {route.page==='account'&&<ServiceAccountPage key={route.id} onAuthenticated={()=>go('me')} redirectAuthenticated={route.id!=='settings'}/>}{route.page==='feedback'&&<ServiceGovernancePage/>}
      </>}
    </main>
    <footer className="site-footer"><span>LogiNote · 静默生长</span>{serviceEnabled()?<span>社区服务</span>:<LinkButton onClick={() => setPanel({ kind: 'prototype' })}>交互原型 · 合成数据</LinkButton>}<LinkButton onClick={() => serviceEnabled()?go('feedback'):setPanel({ kind: 'feedback', target: '社区体验' })}>帮助与反馈</LinkButton></footer>
    {deleted && <div className="delete-undo" role="status"><span>动态已删除 · 本机演示</span><LinkButton onClick={undoDelete}>撤销删除</LinkButton></div>}
    {panel && <PanelContent panel={panel}/>}
  </LinkSafetyProvider></AppContext>;
    return serviceEnabled()?<ServiceIdentityProvider>{app}</ServiceIdentityProvider>:app;
}
function SiteHeader() {
    const { go, page, resourceId, open } = useApp();
    const [q, setQ] = useState('');
    const {session}=useServiceIdentity();
    const nav: [
        Page,
        string
    ][] = [['home', '首页'], ['following', '关注'], ['market', '资源市场'], ['groups', '共学']];
    return <header className="site-header"><div className="header-inner">
    <a className="brand" href="#/home">LogiNote<span> · 静默生长</span></a>
    <nav className="main-nav" aria-label="社区导航">{nav.map(([p, label]) => <a key={p} href={`#/${p}`} aria-current={(page === p || (p === 'home' && (page === 'discussion'||page === 'friends'))||(p==='groups'&&page==='group')) ? 'page' : undefined}>{label}</a>)}</nav>
    <div className="header-actions"><form className="header-search" role="search" onSubmit={e => { e.preventDefault(); go('search',encodeURIComponent(q.trim())); }}><Search size={17}/><input aria-label="搜索感兴趣的内容" placeholder="搜索感兴趣的内容…" value={q} onChange={e => setQ(e.target.value)}/></form><button type="button" className="icon-button" aria-label="消息" onClick={() => go('messages',page==='messages'?resourceId:undefined)}><Mail /></button><Primary onClick={e => open({ kind: 'composeMenu', anchor: e.currentTarget.getBoundingClientRect() })}>发布</Primary><button type="button" className={serviceEnabled()&&session?.kind!=='authenticated'?'icon-button':'avatar-button'} aria-label={serviceEnabled()&&session?.kind!=='authenticated'?'社区账号':'我的主页'} onClick={() => go(serviceEnabled()&&session?.kind!=='authenticated'?'account':'me')}>{serviceEnabled()?session?.kind==='authenticated'?<ServiceAvatar name={session.account.displayName} src={session.account.avatarUrl}/>:<UserRound size={22}/>:<Avatar size={36}/>}</button></div>
  </div></header>;
}
function DiscussionPage() {
    const {state,resourceId,go}=useApp();const post=findDiscussion(state,resourceId);
    if(state.deletedPostIds.includes(resourceId))return <section className="reading-column"><h1>这条动态已删除</h1><ArrowLink onClick={()=>go('me')}>返回我的主页</ArrowLink></section>;
    if(!post)return <section className="reading-column"><h1>没有找到这条讨论</h1><ArrowLink onClick={()=>go('home')}>返回首页</ArrowLink></section>;
    if(!canReadDiscussion(state,post))return <section className="reading-column"><h1>这条讨论仅共学群成员可见</h1><ArrowLink onClick={()=>go('group',post.groupId)}>查看群介绍</ArrowLink></section>;
    return <section className="reading-column discussion-page"><div className="breadcrumb"><a href={post.groupId?'#/group/'+post.groupId:'#/home'}><ArrowLeft size={15}/>{post.groupId?'返回共学':'返回社区'}</a><span>/</span><span>讨论详情</span></div><ScenarioContent><ThreadPost id={post.id} detail/></ScenarioContent></section>;
}
function ProfilePage() {
    const { state, patch, go, open } = useApp();
    const [tab, setTab] = useState('我的分享');
    const profile = state.profile;
    const [clientGoal,setClientGoal]=useState<ClientLearningGoal|null>(null);
    useEffect(()=>{let active=true;void learningGoalPort.readCurrentGoal().then(result=>{if(active&&result.status==='ready')setClientGoal(result.goal);});return()=>{active=false;};},[]);
    return <section className="reading-column profile-page">
      <div className="profile-heading"><Avatar person="me" size={148}/><div className="profile-info"><h1>{profile.name}</h1><p className="lead">{profile.bio}</p>
        <div className="profile-topics">{profile.interests.map(topic=><span className="chip" key={topic}>{topic}</span>)}<LinkButton onClick={()=>open({kind:'edit'})}>编辑兴趣</LinkButton></div>
        {clientGoal&&<p className="goal">当前目标：{clientGoal.title}<span><LockKeyhole size={15}/>{state.privacy.goal==='仅自己'?'仅自己可见':state.privacy.goal}</span></p>}
      </div><div className="profile-actions"><Primary onClick={()=>open({kind:'edit'})}>编辑资料</Primary><button className="icon-button" aria-label="个人主页设置" onClick={()=>open({kind:'privacy'})}><MoreHorizontal/></button></div></div>
      <Tabs items={['我的分享','收藏','共学']} value={tab} onChange={setTab} trailing={<LinkButton onClick={()=>open({kind:'drafts'})}>草稿</LinkButton>}/>
      <ScenarioContent>{tab==='收藏'?(state.bookmarks.length?<>{state.bookmarks.map(id=>{
        const resource=allResources(state).find(item=>item.id===id);if(resource)return <ResourceStrip key={id} id={id}/>;
        const post=findDiscussion(state,id);return <div className="saved-question" key={id}>{post&&canReadDiscussion(state,post)?<ArrowLink onClick={()=>go('discussion',id)}>{post.title||post.body.slice(0,80)||'查看原帖'}</ArrowLink>:<span className="meta">原帖已删除或暂时无权查看。</span>}<BookmarkButton id={id}/></div>;
      })}</>:<Empty action={<ArrowLink onClick={()=>go('market')}>去资源市场</ArrowLink>}>把想慢慢读的内容收藏在这里。</Empty>):tab==='共学'?<MyGroupList/>:<>
        <DemoPosts/><ThreadPost id="seed-gradient" extraActions={<LinkButton onClick={()=>{patch({publishTitle:'梯度下降的直觉笔记',publishDraft:resources.find(resource=>resource.id==='gradient')!.summary});go('publish');}}><PencilLine size={19}/>编辑</LinkButton>}/><ThreadPost id="seed-summary"/>
      </>}</ScenarioContent>
      <div className="profile-footer"><LinkButton onClick={()=>open({kind:'privacy'})}>隐私与提醒</LinkButton><span>|</span><LinkButton onClick={()=>open({kind:'account'})}>账号设置</LinkButton><span>|</span><LinkButton onClick={()=>open({kind:'feedback',target:'个人主页'})}>帮助与反馈</LinkButton></div>
    </section>;
}
function NewsPage() { const { open } = useApp(); return <section className="reading-column"><Hero title="关注资讯" subtitle="只读与你关注方向相关的几条。"/><p className="muted">以下为资讯版式示例，不是实时前沿新闻。</p><ScenarioContent>{['从原始论文开始，了解一个新方法', '开放学习工具：先看适用边界，再动手试试'].map((t, i) => <article className="news-item" key={t}><span className="meta">{i ? '工具与实践' : '人工智能'} · 示例摘要</span><h2>{t}</h2><p>先读研究问题、方法与限制，再决定是否值得深入。来源与日期在详情中核对。</p><Fold title="展开摘要与来源"><p>此条为合成演示。阶段 5 接入经审核的原始来源、发布日期与更新机制。</p><LinkButton onClick={() => open({ kind: 'feedback', target: t })}>纠错与反馈</LinkButton></Fold></article>)}</ScenarioContent></section>; }
function AdminPage() { const { state, open } = useApp(); const [tab, setTab] = useState('待处理'); const tickets = state.tickets.filter(t => tab === '处理记录' ? t.status === '已反馈' : t.status === '待处理'); return <section className="reading-column admin-page"><Hero title="社区治理" subtitle="先处理具体的问题，再看完整的记录。"/><p className="inline-status"><ShieldCheck size={18}/>独立治理演示 · 没有真实管理员身份或服务权限</p><Tabs items={['待处理', '处理记录', '规则与建议']} value={tab} onChange={setTab}/>{tab === '规则与建议' ? <><TopicManagement/><Fold title="内容违规如何处理"><p>侵权、骚扰、垃圾广告、隐私泄露等需保留依据，按严重程度限制展示、要求修改或移除。存在争议时提供复核与申诉。</p></Fold><Fold title="用户违规如何处理"><p>按证据与重复情况提醒、限制相关能力、限期禁言或封禁；处置需要理由、期限、申诉入口和审计记录。</p></Fold><Fold title="投诉建议如何反馈"><p>受理、核查、反馈处理结论；建议说明采纳、排期或不采纳的理由。用户在我的反馈主动查看。</p></Fold></> : tickets.length ? tickets.map(t => <article className="ticket-row" key={t.id}><span className="tag">{t.status} · 演示</span><h2>{t.target}</h2><p>{t.body}</p>{t.response && <p>处理反馈：{t.response}</p>}<ArrowLink onClick={() => open({ kind: 'moderate', id: t.id })}>查看与处理</ArrowLink></article>) : <Empty>目前没有{tab === '待处理' ? '待处理的演示反馈，先从页面提交一条反馈试试。' : '处理记录。'}</Empty>}</section>; }
function PanelContent({ panel }: {
    panel: Panel;
}) {
    const { close, state, patch, go, open, notice, setNotice, setScenario } = useApp();
    const title = panel.kind === 'createGroup'?'创建共学群':panel.kind === 'manageFollowing'?'管理关注的人':panel.kind === 'composeMenu' ? '发布' : panel.kind === 'resource' ? '资源预览' : panel.kind==='messageImage'?'图片预览': panel.kind === 'privacy' ? '隐私与提醒' : panel.kind === 'edit' ? '编辑资料' : panel.kind === 'account' ? '账号设置' : panel.kind === 'reports' ? '我的反馈' : panel.kind === 'feedback' ? '反馈与举报' : panel.kind === 'friend' ? '向晓禾发送学友申请' : panel.kind === 'share' ? '分享资源' : panel.kind === 'prototype' ? '原型说明与验收' : panel.kind === 'groupInfo' ? '线性代数共学' : panel.kind === 'schedule' ? '本周安排' : panel.kind === 'invite' ? '邀请学友' : panel.kind === 'drafts' ? '本机草稿' : '核查与处理';
    return <Overlay key={panel.kind} title={title} kind={panel.kind === 'friend' || panel.kind === 'composeMenu' || (panel.kind==='share'&&panel.anchor) ? 'popover' : panel.kind === 'prototype'||panel.kind==='messageImage' ? 'modal' : 'drawer'} anchor={'anchor' in panel ? panel.anchor : undefined} onClose={close} headerActions={panel.kind==='resource'&&<button type="button" className="icon-button" aria-label="在独立页面打开" title="在独立页面打开" onClick={()=>go('resource',panel.id)}><ArrowUpRight size={18}/></button>}>
    {panel.kind === 'composeMenu' && <div className="action-list"><ArrowLink onClick={() => go('home', 'discovery')}>分享发现</ArrowLink><ArrowLink onClick={() => go('home', 'question')}>求助</ArrowLink><ArrowLink onClick={() => go('publish')}>分享资源</ArrowLink></div>}
    {panel.kind==='messageImage'&&<MessageImagePreview id={panel.id}/>}
    {panel.kind === 'resource' && <ResourceContent key={panel.id} id={panel.id}/>}
    {panel.kind === 'privacy' && (serviceEnabled()?<ServiceAttention/>:<PrivacyPanel />)}
    {panel.kind === 'edit' && <EditProfile />}
    {panel.kind === 'feedback' && <FeedbackPanel target={panel.target}/>}
    {panel.kind === 'reports' && <><p className="muted">以下记录仅保存在本机，没有发送给运营人员。</p>{state.tickets.length ? state.tickets.map(t => <article className="ticket-row" key={t.id}><span className="tag">{t.status} · 演示</span><h3>{t.target}</h3><p className="user-body">{t.body}</p>{t.extra && <p>补充说明：{t.extra}</p>}{t.attachmentName && <p className="meta">附件名称：{t.attachmentName}（未上传）</p>}{t.response && <p>处理反馈：{t.response}</p>}</article>) : <Empty>还没有提交过反馈。</Empty>}</>}
    {panel.kind === 'friend' && <form onSubmit={e => { e.preventDefault(); patch({ friendRequested: true, greetingDraft: '' }); setNotice('演示：申请已记入本机预览，未发送给任何人。'); }}><textarea aria-label="学友申请招呼（可选）" placeholder="打个招呼（可选）" value={state.greetingDraft} onChange={e => patch({ greetingDraft: e.target.value })}/><p className="meta">例如：我也在学习线性代数，想一起交流。</p>{notice && <p className="inline-status" role="status">{notice}</p>}<div className="panel-actions"><Primary type="submit" disabled={state.friendRequested}>{state.friendRequested ? '已申请（演示）' : '发送申请'}</Primary><LinkButton onClick={close}>关闭</LinkButton></div></form>}
    {panel.kind === 'share' && <SharePanel id={panel.id}/>}{panel.kind === 'createGroup'&&<CreateGroupPanel/>}{panel.kind === 'manageFollowing'&&<ManageFollowing/>}
    {panel.kind === 'account' && <AccountPanel />}



    {(panel.kind==='groupInfo'||panel.kind==='schedule'||panel.kind==='invite')&&<GroupPanel kind={panel.kind} groupId={panel.groupId}/>}
    {panel.kind === 'drafts' && <><p className="muted">草稿仅保存在此浏览器，不会同步到账号。</p>{state.questionDraft ? <><h3>发现或求助</h3><p className="user-body">{state.questionDraft}</p><ArrowLink onClick={() => go('home')}>继续编辑</ArrowLink></> : <p>还没有求助草稿。</p>}<h3>资源分享</h3><p className="user-body">{state.publishDraft}</p><ArrowLink onClick={() => go('publish')}>继续编辑</ArrowLink></>}
    {panel.kind === 'moderate' && <ModeratePanel id={panel.id}/>}
    {panel.kind === 'prototype' && <><p>阶段 1 本地交互原型。人物、帖子、资源与会话都是合成数据。操作仅写入本浏览器专用演示空间。</p><p>账号、真实发布、私信、文件上传、云端治理尚未接入；不会自动读取本地笔记、学习画像或账号数据。</p><label className="field-label">演示页面状态<select aria-label="演示页面状态" defaultValue="正常" onChange={e => setScenario(e.target.value as Scenario)}>{['正常', '加载中', '空内容', '加载失败', '无权限'].map(v => <option key={v}>{v}</option>)}</select></label><div className="panel-actions"><Primary onClick={close}>查看当前状态</Primary><LinkButton onClick={() => patch({ theme: state.theme === 'light' ? 'dark' : 'light' })}>切换{state.theme === 'light' ? '深色' : '浅色'}主题</LinkButton></div><Fold title="更多验收入口"><div className="action-list"><ArrowLink onClick={() => go('news')}>关注资讯</ArrowLink><ArrowLink onClick={() => go('admin')}>治理后台演示</ArrowLink><ArrowLink onClick={() => open({ kind: 'account' })}>账号接口状态</ArrowLink></div></Fold></>}
  </Overlay>;
}
function PrivacyPanel() {
    const { state, patch, notice, setNotice } = useApp();
    const [privacy, setPrivacy] = useState(state.privacy);
    const [enabled, setEnabled] = useState(state.attention.ordinaryAlertsEnabled);
    return <form className="privacy-panel" onSubmit={e => { e.preventDefault(); patch({ privacy, attention: { ...initialState.attention, ordinaryAlertsEnabled: enabled } }); setNotice('演示：设置仅保存在本机。'); }}><h3>谁可以看到</h3><div className="setting-group">{([['intro', '个人介绍与兴趣'], ['goal', '学习目标']] as const).map(([key, label]) => <label key={key} className="setting-row"><span>{label}</span><select aria-label={label} value={privacy[key]} onChange={e => setPrivacy({ ...privacy, [key]: e.target.value })}>{(['仅自己', '仅学友', '公开']).map(v => <option key={v}>{v}</option>)}</select></label>)}</div><h3>提醒方式</h3><div className="setting-group"><div className="alert-setting"><div><b>普通社区提醒</b><p className="meta">专注时暂停普通提醒，结束后不补发。</p></div><button type="button" role="switch" aria-checked={enabled} aria-label="普通社区提醒" className={`switch ${enabled ? 'on' : ''}`} onClick={() => setEnabled(!enabled)}><span /></button><span className="meta">{enabled ? '已开启' : '默认关闭'}</span></div><Fold title="更多提醒选项"><p>声音、振动、系统推送均关闭；不显示红点和未读数字。</p><p className="meta">开启普通提醒在原型中只保存偏好，不触发浏览器通知权限。</p></Fold></div><Fold title="已拉黑的用户">{state.blockedPeople.length?state.blockedPeople.map(person=><div className="blocked-person-row" key={person}><span>{names[person]}</span><LinkButton onClick={()=>patch({blockedPeople:state.blockedPeople.filter(id=>id!==person)})}>解除拉黑{names[person]}</LinkButton></div>):<p className="meta">暂时没有拉黑的用户。</p>}</Fold><p className="privacy-note"><Info size={19}/>不会自动上传本地笔记与学习画像。</p>{notice && <p className="inline-status" role="status">{notice}</p>}<Primary type="submit" className="primary full-width">保存设置</Primary></form>;
}

function AccountPanel() { const {go}=useApp();const [message, setMessage] = useState('');if(serviceEnabled())return <><p>管理社区账号、邮箱验证与登录安全。</p><Primary onClick={()=>go('account','settings')}>打开账号设置</Primary></>;return <><p>账号服务尚未接入。当前小川是合成演示人物，没有真实账号权限。</p><p className="meta">预留统一账号接口，后续接入注册、登录和找回。</p><Primary onClick={async () => { const r = await identity.requestAccountAction({ action: 'sign_in', returnPath: '/me' }); setMessage(r.ok === true ? '账号接口已连接。' : r.error.message); }}>检查账号接入状态</Primary>{message && <p className="inline-status" role="status">{message}</p>}</>; }
function FeedbackPanel({ target }: {
    target: string;
}) { const { state, patch, notice, setNotice, open } = useApp(); const [file, setFile] = useState(''); return <form onSubmit={e => { e.preventDefault(); if (!state.feedbackDraft.trim())
    return; patch({ tickets: [{ id: `ticket-${Date.now()}`, target, body: state.feedbackDraft.trim(), extra: state.feedbackExtraDraft.trim(), attachmentName: file, status: '待处理' }, ...state.tickets], feedbackDraft: '', feedbackExtraDraft: '' }); setNotice('演示：反馈已保存在本机，尚未发送给运营人员。'); }}><label className="field-title">相关内容</label><div className="feedback-target"><FileText /><b>{target}</b></div><label className="field-label">反馈内容<textarea aria-label="反馈内容" placeholder="描述你遇到的问题，或希望改进的地方……" value={state.feedbackDraft} onChange={e => patch({ feedbackDraft: e.target.value })}/></label><label className="field-title">补充图片（可选）</label><label className="text-button file-button"><Paperclip size={18}/>添加图片<input type="file" accept="image/*" onChange={e => setFile(e.target.files?.[0]?.name || '')}/></label>{file && <p className="meta">{file}（仅预览文件名，未上传）</p>}<Fold title="补充其他信息（可选）"><textarea aria-label="补充信息" placeholder="例如发生位置、复现方式……" value={state.feedbackExtraDraft} onChange={e => patch({ feedbackExtraDraft: e.target.value })}/></Fold><p className="meta">提交内容仅用于核实和处理反馈。</p>{notice && <p className="inline-status" role="status">{notice}</p>}<Primary className="primary full-width" type="submit" disabled={!state.feedbackDraft.trim()}>提交反馈</Primary><div className="center-link"><LinkButton onClick={() => open({ kind: 'reports' })}>我的反馈</LinkButton><p className="meta">处理进度可在我的反馈中主动查看。</p></div></form>; }
function ModeratePanel({ id }: {
    id: string;
}) { const { state, patch, notice, setNotice } = useApp(); const t = state.tickets.find(t => t.id === id); const [response, setResponse] = useState(t?.response || ''); const [action, setAction] = useState(t?.action || '建议与体验反馈'); if (!t)
    return <Empty>没有找到该反馈。</Empty>; return <form onSubmit={e => { e.preventDefault(); if (!response.trim())
    return; patch({ tickets: state.tickets.map(v => v.id === id ? { ...v, status: '已反馈', response, action } : v) }); setNotice('演示：处理结果已写入本机“我的反馈”，没有执行真实处罚。'); }}><p className="meta">演示案件 · {t.id}</p><h3>{t.target}</h3><p className="user-body">{t.body}</p>{t.extra && <p>补充说明：{t.extra}</p>}{t.attachmentName && <p className="meta">附件名称：{t.attachmentName}（未上传）</p>}<label className="field-label">处理类型<select value={action} onChange={e => setAction(e.target.value)}>{['建议与体验反馈', '内容需要修改', '内容限制展示', '用户行为核查', '不违规并说明理由'].map(a => <option key={a}>{a}</option>)}</select></label><label className="field-label">处理依据与反馈<textarea aria-label="处理依据与反馈" placeholder="说明核查结果、处理理由及复核途径……" value={response} onChange={e => setResponse(e.target.value)}/></label><p className="meta">真实处置、角色权限和审计留痕在服务阶段实现。</p>{notice && <p className="inline-status" role="status">{notice}</p>}<Primary type="submit" disabled={!response.trim()}>记录处理并反馈（演示）</Primary></form>; }
