import { useEffect, useState, type FormEvent } from 'react';
import { ChevronRight, Lightbulb, Search, UsersRound } from 'lucide-react';
import { useApp } from './context';
import { ProfileAvatar } from './ProfileAvatar';
import { allGroups, allResources, names, type StudyGroup } from './model';
import { Art, ArrowLink, Empty, Fold, LinkButton, Primary, Tabs } from './ui';
import { DemoPosts, Hero, ResourceStrip, ScenarioContent, ThreadPost } from './shared';
import { Composer } from './Composer';
import { SharePanel } from './Sharing';
import { GroupChat } from './GroupChat';
import { TopicEditor } from './TopicEditor';
import { TopicLinks } from './TopicLinks';
import { topicSearchText } from './contentTopics';
import { pinnedGroupDiscussion } from './discussions';

export function JoinGroupButton({group}:{group:StudyGroup}){
  const {state,patch,go,setNotice}=useApp();const joined=state.joinedGroupIds.includes(group.id);const pending=state.pendingGroupIds.includes(group.id);
  const join=()=>{if(joined){go('group',group.id);return;}if(group.policy==='request'){patch({pendingGroupIds:[...state.pendingGroupIds,group.id]});setNotice('演示：加入申请已记入本机，尚未发送给群主。');}else{patch({joinedGroupIds:[...state.joinedGroupIds,group.id],joined:group.id==='linear'?true:state.joined});go('group',group.id);}};
  return pending?<div className="join-actions"><span className="meta">已申请（演示）</span><LinkButton onClick={()=>patch({pendingGroupIds:state.pendingGroupIds.filter(id=>id!==group.id)})}>撤销申请</LinkButton></div>:<Primary onClick={join}>{joined?'进入共学':group.policy==='request'?'申请加入':'加入共学'}</Primary>;
}
export function GroupDirectory(){
  const {state,open,notice}=useApp();const [tab,setTab]=useState('我的共学');const [query,setQuery]=useState('');
  const groups=allGroups(state).filter(g=>(tab==='找共学'||state.joinedGroupIds.includes(g.id))&&`${g.name} ${g.description} ${topicSearchText(state,g)}`.includes(query));
  return <><Hero title="找一群人，把一个问题学深" subtitle="在自己的节奏里交流、分享和互相鼓励。"/><section className="reading-column"><div className="section-toolbar"><Tabs items={['我的共学','找共学']} value={tab} onChange={setTab}/><LinkButton onClick={()=>open({kind:'createGroup'})}>创建共学群</LinkButton></div><div className="market-search"><Search size={19}/><input type="search" aria-label="搜索共学群" placeholder="搜索群名称、主题或学习目标……" value={query} onChange={e=>setQuery(e.target.value)}/></div>{notice&&<p className="inline-status" role="status">{notice}</p>}<ScenarioContent>{groups.length?groups.slice(0,3).map(g=><GroupRow group={g} key={g.id}/>):<Empty action={<LinkButton onClick={()=>setTab('找共学')}>去找共学</LinkButton>}>{query?'没有找到相关共学群。':'还没有参与的共学群，可以搜索加入，也可以自己创建。'}</Empty>}{groups.length>3&&<Fold title="查看其他共学群">{groups.slice(3).map(g=><GroupRow key={g.id} group={g}/>)}</Fold>}</ScenarioContent></section></>;
}
export function GroupRow({group}:{group:StudyGroup}){const {go}=useApp();return <article className="group-row"><span className="group-symbol"><UsersRound size={28}/></span><div><h2><button className="heading-button" onClick={()=>go('group',group.id)}>{group.name}</button></h2><p>{group.description||'一起交流学习中的发现与问题。'}</p><TopicLinks content={group}/><span className="meta">{group.policy==='request'?'申请加入':'开放加入'}</span></div><JoinGroupButton group={group}/></article>;}
export function MyGroupList(){const {state}=useApp();const groups=allGroups(state).filter(g=>state.joinedGroupIds.includes(g.id));return <>{groups.length?groups.map(g=><GroupRow group={g} key={g.id}/>):<Empty>还没有参与共学。</Empty>}</>;}
export function CreateGroupPanel(){
  const {state,patch,go}=useApp();const [name,setName]=useState('');const [description,setDescription]=useState('');const [topicIds,setTopicIds]=useState<string[]>([]);const [policy,setPolicy]=useState<'open'|'request'>('open');
  const submit=(e:FormEvent)=>{e.preventDefault();if(!name.trim())return;const g:StudyGroup={id:`group-${Date.now()}`,name:name.trim(),description:description.trim(),topicIds,policy,creator:'me'};patch({createdGroups:[g,...state.createdGroups],joinedGroupIds:[...state.joinedGroupIds,g.id]});go('group',g.id);};
  return <form onSubmit={submit}><p className="muted">先给共学起个名字，其他内容可以慢慢补充。</p><label className="field-label">群名称<input autoFocus aria-label="共学群名称" placeholder="例如：一起读懂线性代数" value={name} onChange={e=>setName(e.target.value)}/></label><textarea aria-label="共学目标（可选）" placeholder="想一起学什么？怎样交流？简单说一句就好（可选）。" value={description} onChange={e=>setDescription(e.target.value)}/><TopicEditor label="共学话题" value={topicIds} text={name+' '+description} onChange={setTopicIds}/><Fold title="更多设置"><label className="field-label">加入方式<select aria-label="加入方式" value={policy} onChange={e=>setPolicy(e.target.value as typeof policy)}><option value="open">开放加入</option><option value="request">申请加入</option></select></label></Fold><p className="meta">默认开放加入，成员按自己的节奏参与。当前仅创建本机演示群。</p><Primary className="primary full-width" type="submit" disabled={!name.trim()}>创建共学群</Primary></form>;
}
export function GroupPage(){
  const {state,patch,resourceId,open,go,notice}=useApp();const routeGroupId=resourceId.split('~')[0];const group=allGroups(state).find(g=>g.id===routeGroupId)||((routeGroupId==='linear')?allGroups(state).find(g=>g.id==='linear'):undefined);
  const [tab,setTab]=useState(resourceId.split('~')[1]==='chat'?'交流':'今天'),[showTopic,setShowTopic]=useState(false);
  useEffect(()=>{setTab(resourceId.split('~')[1]==='chat'?'交流':'今天');setShowTopic(false);},[resourceId]);
  if(!group)return <section className="reading-column"><Hero title="共学" subtitle="这个共学群暂时不可用。"/><ArrowLink onClick={()=>go('groups')}>返回共学列表</ArrowLink></section>;
  const joined=state.joinedGroupIds.includes(group.id), sample=group.id==='linear', topic=pinnedGroupDiscussion(group);
  const groupResources=allResources(state).filter(r=>(r.scope==='仅共学群可见'&&r.groupId===group.id)||(sample&&['linear','matrix'].includes(r.id)));
  return <section className="reading-column group-page"><div className="breadcrumb"><a href="#/groups">共学</a><span>/</span><span>{group.name}</span></div><div className="group-heading">{sample?<Art/>:<span className="group-symbol large"><UsersRound size={48}/></span>}<div><h1>{group.name}</h1><p className="lead">{group.description||'一起交流学习中的发现与问题。'}</p><div className="group-meta">{joined&&sample&&<div className="avatar-stack"><ProfileAvatar person="he" size={36}/><ProfileAvatar person="lin" size={36}/><ProfileAvatar person="boat" size={36}/></div>}<LinkButton onClick={()=>open({kind:'groupInfo',groupId:group.id})}>群介绍<ChevronRight size={15}/></LinkButton>{joined&&<LinkButton onClick={()=>open({kind:'invite',groupId:group.id})}>邀请一起共学<ChevronRight size={15}/></LinkButton>}</div></div>{!joined&&<JoinGroupButton group={group}/>}</div>
  {!joined?<><p className="inline-status">这里展示公开的群介绍。加入后才能查看群内交流、资源和学习记录。</p>{notice&&<p role="status" className="inline-status">{notice}</p>}</>:<><Tabs items={['今天','交流','资源','成员']} value={tab} onChange={value=>{setTab(value);setShowTopic(false);}}/><ScenarioContent>
  {tab==='今天'&&<>{topic&&!state.deletedPostIds.includes(topic.id)&&<div className="today-card group-topic-card"><div className="today-top"><span className="bulb"><Lightbulb size={28}/></span><div><b className="eyebrow">群讨论话题</b><h2>{topic.title}</h2><p>{topic.body}</p></div><div className="today-actions"><Primary onClick={()=>{setTab('交流');setShowTopic(true);}}>进入讨论</Primary></div></div></div>}<h2 className="section-heading">大家的学习记录</h2></>}
  {tab==='交流'&&<GroupChat groupId={group.id} targetMessageId={resourceId.split('~')[2]} showTopic={showTopic}/>}
  {tab==='今天'&&<><DemoPosts scope="仅共学群可见" groupId={group.id}/>{sample?<><ThreadPost id="group-matrix"/><ThreadPost id="group-order"/></>:!state.posts.some(p=>p.groupId===group.id)&&<Empty>共学刚刚开始，写下第一个发现或问题吧。</Empty>}<Composer group groupId={group.id}/></>}
  {tab==='资源'&&<>{groupResources.length?groupResources.map(r=><ResourceStrip id={r.id} key={r.id}/>):<Empty>还没有群内资源。</Empty>}<ArrowLink onClick={()=>{patch({publishScope:'仅共学群可见',publishGroupId:group.id});go('publish');}}>分享到这个共学群</ArrowLink></>}
  {tab==='成员'&&<div className="member-list">{(sample?['he','lin','boat','me'] as const:['me'] as const).map(p=><div key={p}><ProfileAvatar person={p}/><span>{p==='me'?state.profile.name:names[p]}</span></div>)}<Fold title="我的参与设置"><p>可以随时退出，不公开缺席，也不设置排名。</p><LinkButton onClick={()=>{patch({joinedGroupIds:state.joinedGroupIds.filter(id=>id!==group.id),joined:sample?false:state.joined});go('groups');}}>退出共学（演示）</LinkButton></Fold></div>}</ScenarioContent></>}
  </section>;
}
export function GroupPanel({kind,groupId='linear'}:{kind:'groupInfo'|'schedule'|'invite';groupId?:string}){
  const {state}=useApp();const group=allGroups(state).find(g=>g.id===groupId);if(!group)return <Empty>没有找到共学群。</Empty>;
  if(kind==='invite')return <SharePanel id={`group:${group.id}`}/>;
  return <><h3>{group.name}</h3><p>{group.description||'共同学习、交流与答疑。'}</p><p className="meta">{group.policy==='request'?'申请加入，由群主审核。':'开放加入，自主参与。'}</p><Fold title="共学约定"><p>尊重不同的学习节奏。分享有权公开的资料，不传播成员私人信息。不做强制打卡和监督排名。</p></Fold><JoinGroupButton group={group}/></>;
}
