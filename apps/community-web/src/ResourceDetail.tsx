import { useState } from 'react';
import { ArrowLeft, Check, FileText, UsersRound } from 'lucide-react';
import { useApp } from './context';
import { allResources, names, resources } from './model';
import { demoResourceUsage, previewText } from './content';
import { ArrowLink, Fold, LinkButton, Primary } from './ui';
import { ProfileAvatar } from './ProfileAvatar';
import { BookmarkButton, ResourceCover } from './shared';
import { ShareResourceAction } from './Sharing';
import { ResourceBody } from './ResourceBody';
import { resourcePlainText } from './resourceText';
import { TopicLinks } from './TopicLinks';

export function ResourceContent({id,standalone=false}:{id:string;standalone?:boolean}) {
  const {state,patch,open,go}=useApp();
  const [expanded,setExpanded]=useState(false);
  const resource=allResources(state).find(r=>r.id===id);
  if(!resource)return <section className="reading-column"><h1>资源暂不可用</h1><ArrowLink onClick={()=>go('market')}>返回资源市场</ArrowLink></section>;
  if(resource.scope==='仅共学群可见'&&resource.author!=='me'&&!state.joinedGroupIds.includes(resource.groupId||''))return <section className="reading-column"><h1>这份资源仅共学群成员可见</h1><ArrowLink onClick={()=>go('groups')}>返回共学</ArrowLink></section>;
  const authored=resource.body!==undefined;
  const content=previewText(resource);
  const usage=demoResourceUsage(resource);
  const learning=state.learning.includes(id);
  const author=resource.author==='me'?state.profile.name:names[resource.author];
  const body=authored?resource.body||'':content.paragraphs.join('\n\n');
  const trimmedBody=Array.from(body);
  const truncated=trimmedBody.length>1000;
  const displayedBody=truncated&&!expanded?trimmedBody.slice(0,800).join('')+'…':body;
  const hasCover=!!resource.cover||resources.some(r=>r.id===id);
  const plainBody=resourcePlainText(body).replace(/\s/g,'');
  const contentLabel=content.outline.length?`${content.outline.length} 项内容`:plainBody?`正文约 ${Array.from(plainBody).length} 字`:resource.imageIds?.length?'图文资源':'暂无正文';
  return <article className={`${standalone?'resource-page reading-column':'resource-detail'} resource-overview`}>
    {standalone&&<div className="resource-topline"><LinkButton onClick={()=>go('market')}><ArrowLeft size={17}/>资源市场</LinkButton></div>}
    <header className="resource-overview-header"><div className="resource-overview-heading"><h1>{resource.title}</h1><div className="resource-author"><ProfileAvatar person={resource.author} size={40}/><div><button type="button" className="author-name" onClick={()=>go(resource.author==='me'?'me':'friends',resource.author)}>{author}</button><span className="meta">{resource.kind} · {resource.level} · {resource.scope||'公开'}</span></div></div></div>{hasCover&&<ResourceCover resource={resource}/>}</header>
    <TopicLinks content={resource}/>
    {!authored&&<p className="lead">{resource.summary}</p>}
    <div className="resource-facts"><span>{contentLabel}{resource.imageIds?.length?` · ${resource.imageIds.length} 张插图`:''}{resource.attachmentName?' · 1 条附件记录':''}</span><span className="resource-usage"><UsersRound size={16}/>{usage===null?'使用人数待接入':`${usage} 人加入学习`}{usage!==null&&<small>演示统计</small>}</span></div>
    <div className="resource-primary-actions" aria-label="资源操作"><Primary aria-pressed={learning} onClick={()=>patch({learning:learning?state.learning.filter(key=>key!==id):[...state.learning,id]})}>{learning&&<Check size={18}/>} {learning?'已加入 · 撤销':'加入我的学习'}</Primary><BookmarkButton id={id}/><ShareResourceAction id={id}/></div>
    {learning&&<p className="meta resource-learning-note" role="status">已加入本机学习清单，尚未同步到 LogiNote 客户端。</p>}
    <section className="resource-content" aria-label="资源内容"><h2>资源内容</h2>{content.outline.length>0&&<ol className="resource-outline">{content.outline.map(([title,summary],index)=><li key={title}><span>{index+1}</span><div><b>{title}</b><p>{summary}</p></div></li>)}</ol>}
      {!authored&&<h3 className="resource-preview-heading">正文预览</h3>}<div className="resource-text-body">{resource.bodyFormat==='markdown'?<ResourceBody body={displayedBody} imageIds={resource.imageIds}/>:<div className="user-body">{displayedBody||'作者还没有添加正文。'}</div>}</div>
      {truncated&&<LinkButton className="text-button resource-expand" aria-expanded={expanded} onClick={()=>setExpanded(!expanded)}>{expanded?'收起正文':'展开剩余正文'}</LinkButton>}
      {resource.attachmentName&&<div className="resource-attachment"><FileText size={22}/><div><b>{resource.attachmentName}</b><span className="meta">仅记录附件名称，文件尚未上传。</span></div></div>}
    </section>
    <div className="resource-secondary"><Fold title="来源与使用说明"><p>{authored?(resource.source||'作者主动分享'):'演示作者原创示例，内容及使用人数仅供界面预览。'}</p>{resource.license&&<p>{resource.license}</p>}<p className="meta">{authored?'当前内容仅保存在本机，使用人数将在真实服务接入后统计。':'使用人数按加入学习的用户统计；当前为演示值，本机加入或撤销不会改变人数。'}</p>{resource.cover&&<p className="meta">封面由作者主动选择：{resource.coverName||'本机图片'}</p>}</Fold><Fold title="版本记录"><p>{authored?'首次发布 · 本机演示版本':'v1 · 4月12日 · 演示初版'}</p></Fold><LinkButton className="text-button resource-report-link" onClick={()=>open({kind:'feedback',target:resource.title})}>反馈与举报</LinkButton></div>
  </article>;
}
