import {LearningStatistics,LearningStatisticsEditor,defaultStatisticsPolicy} from './LearningStatistics';
import {ServiceMyGroups} from './ServiceGroups';
import {useEffect,useRef,useState} from 'react';
import {useApp} from './context';
import {Empty,LinkButton,Overlay,Primary,Tabs} from './ui';
import {ServiceApiError,serviceClient,type ServiceProfile} from './serviceClient';
import './service-profile.css';
import {ServiceAvatar} from './ServiceAvatar';
import {ServiceDeliveryPanel} from './ServiceResources';
import {ServiceEntryList} from './ServiceEntries';
import {prepareProfileAvatar} from './profileAvatarImage';
export {ServiceAvatar} from './ServiceAvatar';

export function ServiceProfilePage(){
  const {go,open}=useApp();
  const [profile,setProfile]=useState<ServiceProfile|null>(null),[error,setError]=useState(''),[guest,setGuest]=useState(false),[version,setVersion]=useState(0);
  const [tab,setTab]=useState('我的分享'),[editing,setEditing]=useState(false),[saved,setSaved]=useState(false),[delivery,setDelivery]=useState(false);
  useEffect(()=>{
    const controller=new AbortController();setError('');setGuest(false);
    serviceClient.getProfile(controller.signal).then(setProfile).catch(cause=>{if(controller.signal.aborted)return;setProfile(null);if(cause instanceof ServiceApiError&&cause.status===401)setGuest(true);else setError(cause instanceof Error?cause.message:'暂时无法读取个人资料。');});
    return()=>controller.abort();
  },[version]);
  useEffect(()=>{const controller=new AbortController();const refresh=()=>{void serviceClient.getLearningStatistics(controller.signal).then(value=>setProfile(prior=>prior?{...prior,learningStatistics:value}:prior)).catch(()=>{});};window.addEventListener('focus',refresh);return()=>{controller.abort();window.removeEventListener('focus',refresh);};},[]);
  if(guest)return <section className="reading-column service-profile"><h1>我的主页</h1><Empty action={<Primary onClick={()=>go('account')}>登录或注册</Primary>}>登录后查看自己的资料。</Empty></section>;
  if(error)return <section className="reading-column service-profile"><h1>我的主页</h1><Empty action={<LinkButton onClick={()=>setVersion(value=>value+1)}>重新加载</LinkButton>}>{error}</Empty></section>;
  if(!profile)return <section className="reading-column service-profile"><p className="meta" role="status">正在读取个人主页…</p></section>;
  return <section className="reading-column profile-page service-profile">
    <div className="profile-heading"><ServiceAvatar name={profile.displayName} size={148} src={profile.avatarUrl}/><div className="profile-info"><h1>{profile.displayName}</h1>{profile.bio?<p className="lead">{profile.bio}</p>:<p className="lead muted">还没有填写个人介绍。</p>}{profile.interests.length>0&&<div className="profile-topics">{profile.interests.map(interest=><span className="chip" key={interest}>{interest}</span>)}</div>}<LearningStatistics value={profile.learningStatistics?.snapshot}/></div><div className="profile-actions"><Primary onClick={()=>{setSaved(false);setEditing(true);}}>编辑资料</Primary></div></div>
    {saved&&<p className="inline-status" role="status">资料已保存。</p>}
    <Tabs items={['我的分享','收藏','已保存','共学']} value={tab} onChange={setTab}/>
    {tab==='我的分享'&&<div className="news-owner-actions"><LinkButton onClick={()=>go('news','mine')}>我的投稿</LinkButton></div>}
    {tab==='共学'?<ServiceMyGroups/>:<ServiceEntryList query={{view:tab==='我的分享'?'mine':tab==='收藏'?'bookmarks':'learning'}} empty={tab==='我的分享'?'还没有分享内容。':tab==='收藏'?'还没有收藏内容。':'还没有保存到 LogiNote 的资源。'}/>}
    <div className="profile-footer"><LinkButton onClick={()=>setDelivery(true)}>桌面接收</LinkButton><span>|</span><LinkButton onClick={()=>open({kind:'privacy'})}>隐私与提醒</LinkButton><span>|</span><LinkButton onClick={()=>go('account','settings')}>账号设置</LinkButton><span>|</span><LinkButton onClick={()=>go('feedback')}>帮助与反馈</LinkButton></div>
    {delivery&&<Overlay title="桌面接收" onClose={()=>setDelivery(false)}><ServiceDeliveryPanel/></Overlay>}
    {editing&&<Overlay title="编辑资料" onClose={()=>setEditing(false)}><ProfileForm profile={profile} onConnect={()=>{setEditing(false);setDelivery(true);}} onSaved={value=>{setProfile(value);setEditing(false);setSaved(true);}}/></Overlay>}
  </section>;
}
function ProfileForm({profile,onSaved,onConnect}:{profile:ServiceProfile;onSaved:(profile:ServiceProfile)=>void;onConnect:()=>void}){
  const [name,setName]=useState(profile.displayName),[bio,setBio]=useState(profile.bio),[interests,setInterests]=useState(profile.interests.join('、')),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const [statistics,setStatistics]=useState(profile.learningStatistics?.policy||defaultStatisticsPolicy),[statisticsOpen,setStatisticsOpen]=useState(false);
  const statisticsBase=useRef(profile.learningStatistics);
  const [avatarData,setAvatarData]=useState<string|null|undefined>(),[reading,setReading]=useState(false);
  const input=useRef<HTMLInputElement>(null),selection=useRef(0);
  useEffect(()=>()=>{selection.current++;},[]);
  const avatar=avatarData===undefined?profile.avatarUrl:avatarData;
  const chooseAvatar=async(file?:File)=>{
    if(!file)return;
    const request=++selection.current;setReading(true);setError('');
    try{const data=await prepareProfileAvatar(file);if(request===selection.current)setAvatarData(data);}
    catch(cause){if(request===selection.current)setError(cause instanceof Error?cause.message:'图片无法读取，请换一张图片。');}
    finally{if(request===selection.current)setReading(false);}
  };
  return <form className="service-profile-editor" onSubmit={event=>{event.preventDefault();if(busy||reading)return;setBusy(true);setError('');const tags=[...new Set(interests.split(/[、,，\n]/).map(item=>item.trim()).filter(Boolean))];void (async()=>{let savedStatistics=statisticsBase.current;if(JSON.stringify(statistics)!==JSON.stringify(savedStatistics?.policy||defaultStatisticsPolicy)){savedStatistics=await serviceClient.updateLearningStatistics(statistics,profile.accountId);statisticsBase.current=savedStatistics;setStatistics(savedStatistics.policy);}const profileChanged=name.trim()!==profile.displayName||bio.trim()!==profile.bio||JSON.stringify(tags)!==JSON.stringify(profile.interests)||avatarData!==undefined;const updated=profileChanged?await serviceClient.updateProfile({displayName:name.trim(),bio:bio.trim(),interests:tags,...(avatarData!==undefined?{avatarData}:{})},profile.accountId):profile;return {...updated,learningStatistics:savedStatistics};})().then(onSaved).catch(cause=>setError(cause instanceof Error?cause.message:'资料暂时未能保存。')).finally(()=>setBusy(false));}}>
    <div className="profile-avatar-editor">
      <ServiceAvatar name={name} size={88} src={avatar}/>
      <div><LinkButton disabled={busy} onClick={()=>input.current?.click()}>更换头像</LinkButton>{avatar&&<LinkButton disabled={busy} onClick={()=>{selection.current++;setReading(false);setError('');setAvatarData(null);}}>恢复默认头像</LinkButton>}<p className="meta">PNG、JPG、WebP，原图 10 MB 以内，自动压缩</p></div>
      <input ref={input} hidden type="file" accept="image/png,image/jpeg,image/webp" aria-label="选择头像图片" disabled={busy} onChange={event=>{void chooseAvatar(event.target.files?.[0]);event.target.value='';}}/>
    </div>
    {reading&&<p className="meta" role="status">正在读取图片…</p>}
    <label className="field-label">昵称<input required maxLength={80} autoComplete="nickname" value={name} onChange={event=>setName(event.target.value)} disabled={busy}/></label>
    <label className="field-label">一句介绍<input maxLength={160} placeholder="简单介绍自己，留空也可以" value={bio} onChange={event=>setBio(event.target.value)} disabled={busy}/></label>
    <details className="fold"><summary>兴趣（可选）</summary><label className="field-label">兴趣标签<input maxLength={167} placeholder="例如：线性代数、阅读，用逗号分隔" value={interests} onChange={event=>setInterests(event.target.value)} disabled={busy}/></label><p className="meta">最多 8 个，每个不超过 20 个字。</p></details>
    <details className="fold" onToggle={event=>setStatisticsOpen(event.currentTarget.open)}><summary>学习统计（{statistics.enabled?'已开启':'默认关闭'}）</summary>{statisticsOpen&&<LearningStatisticsEditor value={statistics} onChange={setStatistics} disabled={busy} onConnect={onConnect}/>}</details>
    {error&&<p className="inline-status" role="alert">{error}</p>}
    <Primary type="submit" disabled={busy||reading||!name.trim()}>{busy?'正在保存…':'保存资料'}</Primary>
  </form>;
}
