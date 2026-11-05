import { useEffect, useRef, useState, type FormEvent } from 'react';
import { FileText, ImagePlus, Info, Paperclip, X } from 'lucide-react';
import { useApp } from './context';
import { allGroups, allResources, imageReferences, validCover, type Resource } from './model';
import { previewText } from './content';
import { ArrowLink, Fold, LinkButton, Primary } from './ui';
import { ResourceEditor } from './ResourceEditor';
import { resourcePlainText, resourceTitle } from './resourceText';
import { TopicEditor } from './TopicEditor';
import { cleanTopicIds, topicIdsFor } from './contentTopics';

export function PublishPage(){
  const {state,patch,go,setMarketView}=useApp();const [error,setError]=useState('');const [publishedId,setPublishedId]=useState('');const [kind,setKind]=useState('知识笔记');
  const [editingImages,setEditingImages]=useState(false);
  const reader=useRef<FileReader|null>(null);useEffect(()=>()=>reader.current?.abort(),[]);
  const publicScope=state.publishScope.startsWith('资源市场');const groups=allGroups(state).filter(g=>state.joinedGroupIds.includes(g.id));
  const topicIds=cleanTopicIds(state,state.publishTopicIds);
  const validScope=publicScope||groups.some(g=>g.id===state.publishGroupId);
  const update=(values:Partial<typeof state>)=>{patch(values);setPublishedId('');};
  const chooseCover=(file?:File)=>{
    if(!file)return;setError('');reader.current?.abort();
    if(!['image/png','image/jpeg','image/webp'].includes(file.type)){setError('请选择 PNG、JPEG 或 WebP 图片。');return;}
    if(file.size>1024*1024){setError('本机原型支持 1 MB 以内的封面，请选择更小的图片。');return;}
    const next=new FileReader();reader.current=next;
    next.onload=()=>{if(validCover(next.result))update({publishCover:next.result,publishCoverName:file.name});else setError('这张图片暂时无法预览，请换一张。');};
    next.onerror=()=>setError('图片读取失败，已保留正文草稿。');next.readAsDataURL(file);
  };
  const inherit=(id:string)=>{
    const r=allResources(state).find(r=>r.id===id&&r.author==='me');if(!r)return;
    update({publishTitle:r.title,publishTopicIds:topicIdsFor(state,r),publishDraft:r.body||previewText(r).paragraphs.join('\n\n'),publishCover:r.cover||'',publishCoverName:r.coverName||'',publishAttachment:r.attachmentName||'',publishScope:r.scope==='仅共学群可见'?'仅共学群可见':'资源市场 · 公开',publishGroupId:r.groupId||state.publishGroupId});setKind(r.kind);
  };
  const submit=(e:FormEvent)=>{
    e.preventDefault();if(!state.publishDraft.trim()||!validScope||publishedId||editingImages)return;
    const body=state.publishDraft.trim();const title=state.publishTitle.trim()||resourceTitle(body);const id=`resource-${Date.now()}`;
    const imageIds=imageReferences(body).filter(id=>state.resourceImages.some(image=>image.id===id));
    const resource:Resource={id,title,body,bodyFormat:'markdown',imageIds,summary:resourcePlainText(body).replace(/\s+/g,' ').slice(0,120)||(imageIds.length?`含 ${imageIds.length} 张正文插图`:title),author:'me',kind,level:'入门',topicIds,art:'gradient',cover:state.publishCover||undefined,coverName:state.publishCoverName||undefined,scope:publicScope?'公开':'仅共学群可见',groupId:publicScope?undefined:state.publishGroupId,attachmentName:state.publishAttachment||undefined,license:state.publishLicense,source:state.publishSource};
    patch({userResources:[resource,...state.userResources],posts:[{id:`post-${Date.now()}`,body:'',type:'discovery',topicIds,scope:resource.scope!,groupId:resource.groupId,resourceId:id},...state.posts]});setPublishedId(id);
  };
  return <section className="publish-column"><div className="breadcrumb"><a href="#/market">资源市场</a><span>/</span><span>分享资源</span></div><form className="publish-panel" onSubmit={submit}><h1>分享资源</h1><p className="lead">支持图文正文和 Markdown 排版，已有内容可以直接带入。</p>
  <Fold title="使用已有资源（可选）"><label className="field-label">选择自己已有的内容<select aria-label="选择已有资源" defaultValue="" onChange={e=>inherit(e.target.value)}><option value="">选择资源，自动带入标题与正文</option>{allResources(state).filter(r=>r.author==='me').map(r=><option value={r.id} key={r.id}>{r.title}</option>)}</select></label><p className="meta">当前可选内容为演示笔记及你在此原型中新建的资源。</p></Fold>
  <div className="publish-source"><span className="document-icon"><FileText size={28}/></span><input className="title-input" aria-label="资源标题" placeholder="资源名称，也可使用正文第一行" value={state.publishTitle} onChange={e=>update({publishTitle:e.target.value})}/></div><ResourceEditor onChange={update} onBusyChange={setEditingImages}/><div className="publish-topic"><TopicEditor label="资源话题" value={state.publishTopicIds} text={state.publishTitle+'\n'+state.publishDraft} onChange={publishTopicIds=>update({publishTopicIds})}/></div>
  <Fold title={state.publishCover?'封面 · 已选择':'添加封面（可选）'}><p className="muted">由你选择图片；不会自动生成或替换。没有封面时只显示文字摘要与资源类型图标。</p>{state.publishCover?<div className="cover-preview"><img src={state.publishCover} alt="所选资源封面"/><span className="meta">来自本机选择：{state.publishCoverName}</span><LinkButton onClick={()=>{reader.current?.abort();update({publishCover:'',publishCoverName:''});}}>移除封面</LinkButton></div>:null}<label className="text-button file-button"><ImagePlus size={18}/>选择封面<input type="file" aria-label="选择封面图片" accept="image/png,image/jpeg,image/webp" onChange={e=>chooseCover(e.target.files?.[0])}/></label><p className="meta">本机预览支持 PNG、JPEG、WebP，1 MB 以内；不会上传。</p></Fold>{error&&<p className="inline-status" role="status">{error}</p>}
  {state.publishAttachment&&<div className="attachment"><Paperclip/><span>{state.publishAttachment}<small>仅保存附件名称，尚未接入文件上传</small></span><button type="button" className="icon-button" aria-label="移除附件" onClick={()=>update({publishAttachment:''})}><X size={18}/></button></div>}<label className="text-button file-button"><Paperclip size={18}/>添加附件（可选）<input type="file" aria-label="选择资源附件" onChange={e=>update({publishAttachment:e.target.files?.[0]?.name||''})}/></label>
  <div className="publish-setting"><span>发布到</span><div><select aria-label="资源发布范围" value={publicScope?'资源市场 · 公开':'仅共学群可见'} onChange={e=>update({publishScope:e.target.value})}><option>资源市场 · 公开</option><option>仅共学群可见</option></select>{!publicScope&&<select aria-label="资源发布共学群" value={state.publishGroupId} onChange={e=>update({publishGroupId:e.target.value})}><option value="">选择已加入的共学群</option>{groups.map(g=><option value={g.id} key={g.id}>{g.name}</option>)}</select>}<p className="meta">{publicScope?'在公共交流和资源市场可见。':'只在选中的共学群可见，不进入公开市场。'}</p>{!validScope&&<ArrowLink onClick={()=>go('groups')}>先加入一个共学群</ArrowLink>}</div></div>
  <Fold title="更多设置"><label className="field-label">资源类型<select aria-label="资源类型" value={kind} onChange={e=>setKind(e.target.value)}>{['知识笔记','学习路线','练习','学习经验','链接资料'].map(k=><option key={k}>{k}</option>)}</select></label><label className="field-label">内容来源<select aria-label="内容来源" value={state.publishSource} onChange={e=>update({publishSource:e.target.value})}>{['原创内容','已获授权','链接与引用'].map(v=><option key={v}>{v}</option>)}</select></label><label className="field-label">许可与使用说明（可选）<textarea aria-label="许可与使用说明" placeholder="补充授权范围或使用说明……" value={state.publishLicense} onChange={e=>update({publishLicense:e.target.value})}/></label></Fold>
  <p className="meta"><Info size={16}/>只保存你主动选中的内容，不读取本地笔记。</p>{publishedId&&<p className="inline-status" role="status">演示：资源已加入本机{publicScope?'公开市场':'共学群'}，未上传到服务器。<ArrowLink onClick={()=>go('resource',publishedId)}>查看资源</ArrowLink></p>}<div className="publish-actions"><span className="meta">草稿仅存本机</span><LinkButton onClick={()=>go('market')}>返回</LinkButton><Primary type="submit" disabled={!state.publishDraft.trim()||!validScope||!!publishedId||editingImages}>{publishedId?'已保存（演示）':publicScope?'发布到市场':'发布到共学'}</Primary>{publishedId&&publicScope&&<ArrowLink onClick={()=>{setMarketView({query:state.userResources.find(r=>r.id===publishedId)?.title||'',topic:'全部',kind:'全部',limit:3});go('market');}}>在市场查看</ArrowLink>}</div></form></section>;
}
