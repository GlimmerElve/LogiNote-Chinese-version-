import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Bold, CircleHelp, Code2, FileText, Globe2, Hash, ImagePlus, Link, List, MoreHorizontal, X } from 'lucide-react';
import { useApp } from './context';
import { allGroups, allResources } from './model';
import { Avatar, LinkButton, Primary } from './ui';
import { TopicEditor } from './TopicEditor';
import { cleanTopicIds, topicIdsFor } from './contentTopics';

export function Composer({group=false,groupId='linear'}:{group?:boolean;groupId?:string}){
  const {state,patch,resourceId,go,notice,setNotice}=useApp();
  const [expanded,setExpanded]=useState(['question','discovery'].includes(resourceId));
  const [type,setType]=useState<'discovery'|'question'>(resourceId==='question'?'question':'discovery');
  const [scope,setScope]=useState<'公开'|'仅共学群可见'>(group?'仅共学群可见':'公开');
  const [selectedGroup,setSelectedGroup]=useState(groupId);
  const [refId,setRefId]=useState('');const [file,setFile]=useState('');
  const [titleOpenFor,setTitleOpenFor]=useState('');const [linkInputs,setLinkInputs]=useState<Record<string,string>>({}),[linkErrors,setLinkErrors]=useState<Record<string,string>>({});
  const ownInput=useRef<HTMLTextAreaElement>(null);const groupInput=ownInput;
  const titleInput=useRef<HTMLInputElement>(null),moreMenu=useRef<HTMLDetailsElement>(null),linkMenu=useRef<HTMLDetailsElement>(null),topicMenu=useRef<HTMLDetailsElement>(null),linkInput=useRef<HTMLInputElement>(null);
  useEffect(()=>{if(['question','discovery'].includes(resourceId)){setExpanded(true);setType(resourceId==='question'?'question':'discovery');}},[resourceId]);
  const draft=group?(state.groupDrafts[groupId]||''):state.questionDraft;
  const groupDetails=state.groupDraftDetails[groupId]||{title:'',resourceId:'',topicIds:topicIdsFor(state,{groupId})};
  const referenceId=group?groupDetails.resourceId:refId;
  const selected=allResources(state).find(r=>r.id===referenceId);
  const groupTarget=group?groupId:selectedGroup;
  const topicIds=group?cleanTopicIds(state,groupDetails.topicIds):cleanTopicIds(state,state.questionTopicIds);
  const postScope=group?'仅共学群可见':scope;
  const validScope=(!referenceId||!!selected)&&(!group||state.joinedGroupIds.includes(groupId))&&(postScope==='公开'||state.joinedGroupIds.includes(groupTarget))&&(!selected||selected.scope!=='仅共学群可见'||(postScope==='仅共学群可见'&&selected.groupId===groupTarget));
  const canSubmit=validScope&&(!!draft.trim()||!!selected);
  const updateDetails=(details:Partial<typeof groupDetails>)=>patch({groupDraftDetails:{...state.groupDraftDetails,[groupId]:{...groupDetails,...details}}});
  const updateGroupBody=(body:string)=>patch({groupDrafts:{...state.groupDrafts,[groupId]:body}});
  const closeOtherMenus=(current:HTMLDetailsElement)=>{if(current.open)for(const menu of [moreMenu,linkMenu,topicMenu])if(menu.current&&menu.current!==current)menu.current.open=false;};
  const menuKeys=(event:React.KeyboardEvent<HTMLDetailsElement>)=>{if(event.key==='Escape'){event.stopPropagation();event.currentTarget.open=false;event.currentTarget.querySelector('summary')?.focus();}};
  const menuBlur=(event:React.FocusEvent<HTMLDetailsElement>)=>{if(event.relatedTarget&&!event.currentTarget.contains(event.relatedTarget))event.currentTarget.open=false;};
  const linkDraftKey=group?`group:${groupId}`:'public',linkValue=linkInputs[linkDraftKey]||'',linkError=linkErrors[linkDraftKey]||'';
  const setLinkValue=(value:string)=>{setLinkInputs(values=>({...values,[linkDraftKey]:value}));setLinkErrors(errors=>({...errors,[linkDraftKey]:''}));};
  const insertLink=()=>{
    const raw=linkValue.trim(),fail=(message:string)=>setLinkErrors(errors=>({...errors,[linkDraftKey]:message}));
    let url:URL;
    try{url=raw.startsWith('#/resource/')?new URL(raw,location.href):new URL(raw);}catch{fail('请输入 http/https 链接，或本站的资源链接。');return;}
    if(!['http:','https:'].includes(url.protocol)){fail('仅支持 http/https 链接。');return;}
    const platform=url.origin===location.origin&&url.pathname===location.pathname&&url.hash.startsWith('#/resource');
    if(platform){
      const match=/^#\/resource\/([^/?#]+)\/?$/.exec(url.hash);
      let id='';try{id=match?decodeURIComponent(match[1]):'';}catch{fail('资源链接格式不正确，正文草稿已保留。');return;}
      const resource=allResources(state).find(item=>item.id===id);
      if(!resource){fail('没有找到这份资源，链接未插入，正文草稿已保留。');return;}
      if((group&&!state.joinedGroupIds.includes(groupId))||(resource.scope==='仅共学群可见'&&(postScope!=='仅共学群可见'||resource.groupId!==groupTarget||!state.joinedGroupIds.includes(groupTarget)))){fail('这份资源仅原共学群可见，请在原群分享。正文草稿已保留。');return;}
      if(group)updateDetails({resourceId:resource.id,topicIds:cleanTopicIds(state,[...groupDetails.topicIds,...topicIdsFor(state,{resourceId:resource.id})])});
      else{setRefId(resource.id);patch({questionTopicIds:cleanTopicIds(state,[...state.questionTopicIds,...topicIdsFor(state,{resourceId:resource.id})])});}
    }else{
      const input=group?groupInput.current:ownInput.current,start=input?.selectionStart??draft.length,end=input?.selectionEnd??start;
      const text=(draft.slice(start,end)||url.href).replace(/[\\[\]]/g,'\\$&'),href=url.href.replace(/\(/g,'%28').replace(/\)/g,'%29');
      const body=draft.slice(0,start)+`[${text}](${href})`+draft.slice(end);
      if(group)updateGroupBody(body);else patch({questionDraft:body});
    }
    setLinkValue('');if(linkMenu.current)linkMenu.current.open=false;
    requestAnimationFrame(()=>(group?groupInput.current:ownInput.current)?.focus({preventScroll:true}));
  };
  const insertMarkdown=(before:string,after:string,placeholder:string)=>{
    const input=groupInput.current,start=input?.selectionStart??draft.length,end=input?.selectionEnd??start;
    const selection=draft.slice(start,end)||placeholder;
    updateGroupBody(draft.slice(0,start)+before+selection+after+draft.slice(end));
    if(moreMenu.current)moreMenu.current.open=false;
    requestAnimationFrame(()=>{input?.focus({preventScroll:true});input?.setSelectionRange(start+before.length,start+before.length+selection.length);});
  };
  const submit=(e:FormEvent)=>{
    e.preventDefault();if(!canSubmit)return;
    patch({posts:[{id:`post-${crypto.randomUUID()}`,body:draft.trim(),bodyFormat:'markdown',type,scope:postScope,topicIds,groupId:postScope==='仅共学群可见'?groupTarget:undefined,resourceId:referenceId||undefined,...(group?{title:groupDetails.title.trim()||undefined}:{})},...state.posts],...(group?{groupDrafts:{...state.groupDrafts,[groupId]:''},groupDraftDetails:{...state.groupDraftDetails,[groupId]:{title:'',resourceId:'',topicIds:topicIdsFor(state,{groupId})}},groupDraft:groupId==='linear'?'':state.groupDraft}:{questionDraft:'',questionTopicIds:[]})});
    setRefId('');setFile('');setExpanded(false);setTitleOpenFor('');setNotice('演示：内容已加入本机预览，未对外发布。');
  };
  const linkPicker=<details data-popup ref={linkMenu} className={`composer-link-menu link-insert-menu ${group?'group-composer-menu group-resource-menu group-link-menu':'public-link-menu'}`} onToggle={event=>{closeOtherMenus(event.currentTarget);if(event.currentTarget.open)requestAnimationFrame(()=>linkInput.current?.focus({preventScroll:true}));}} onKeyDown={menuKeys} onBlur={menuBlur}><summary className="text-button" title="插入链接"><Link size={16}/>插入链接</summary><div className="composer-link-popover link-insert-popover group-composer-popover"><div className="composer-link-input"><input ref={linkInput} type="text" inputMode="url" aria-label="插入链接地址" placeholder="粘贴资源链接或网址……" value={linkValue} onChange={event=>setLinkValue(event.target.value)} onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();insertLink();}}}/><button type="button" className="text-button" disabled={!linkValue.trim()} onClick={insertLink}>插入</button></div>{linkError&&<p className="inline-status" role="alert">{linkError}</p>}</div></details>;
  if(group)return <form className="composer group-composer" onSubmit={submit}>
    <Avatar size={42}/><div className="group-composer-fields">
      {(titleOpenFor===groupId||groupDetails.title)&&<div className="group-composer-title"><input ref={titleInput} aria-label="群内分享标题（可选）" maxLength={160} placeholder="标题（可选）" value={groupDetails.title} onChange={e=>updateDetails({title:e.target.value})}/><button type="button" className="icon-button" aria-label="移除分享标题" onClick={()=>{updateDetails({title:''});setTitleOpenFor('');groupInput.current?.focus({preventScroll:true});}}><X size={15}/></button></div>}
      <div className="group-composer-main"><textarea ref={groupInput} aria-label="群内分享正文" placeholder="写下今天的收获，或说说卡住的地方……" value={draft} onChange={e=>updateGroupBody(e.target.value)}/></div>
      {groupDetails.resourceId&&<div className="composer-reference group-composer-reference"><FileText size={15}/><span>{selected?.title||'资源暂不可用'}</span>{selected&&<small>{selected.scope==='仅共学群可见'?'本群':'市场'}</small>}<button type="button" className="icon-button" aria-label="移除引用资源" onClick={()=>updateDetails({resourceId:''})}><X size={14}/></button></div>}
      <div className="group-composer-toolbar">
          <details data-popup ref={moreMenu} className="group-composer-menu group-more-menu" onToggle={event=>closeOtherMenus(event.currentTarget)} onKeyDown={menuKeys} onBlur={menuBlur}><summary className="text-button" title="更多编辑"><MoreHorizontal size={17}/>更多编辑</summary><div className="group-composer-popover group-format-menu"><button type="button" onClick={()=>{setTitleOpenFor(groupId);if(moreMenu.current)moreMenu.current.open=false;requestAnimationFrame(()=>titleInput.current?.focus({preventScroll:true}));}}><span>{groupDetails.title?'编辑标题':'添加标题'}</span></button><button type="button" onClick={()=>insertMarkdown('**','**','重点')}><Bold size={15}/>粗体</button><button type="button" onClick={()=>insertMarkdown('- ','','列表项')}><List size={15}/>列表</button><button type="button" onClick={()=>insertMarkdown('```\n','\n```','代码')}><Code2 size={15}/>代码</button></div></details>
          {linkPicker}
          <details data-popup ref={topicMenu} className="group-composer-menu group-topic-menu" onToggle={event=>{if(event.target!==event.currentTarget)return;closeOtherMenus(event.currentTarget);if(event.currentTarget.open){const picker=event.currentTarget.querySelector<HTMLDetailsElement>('.topic-add');if(picker)picker.open=true;}}} onKeyDown={menuKeys} onBlur={menuBlur}><summary className="text-button" title="话题"><Hash size={16}/>话题</summary><div className="group-composer-popover"><TopicEditor label="学习记录话题（可选）" value={groupDetails.topicIds} text={groupDetails.title+' '+draft} onChange={topicIds=>updateDetails({topicIds})}/></div></details>
        <Primary type="submit" disabled={!canSubmit}>分享</Primary>
      </div>
      {!validScope&&<p className="inline-status">仅当前共学群成员可以分享；群内资源只能在原群引用。</p>}{notice&&<p className="inline-status" role="status">{notice}</p>}
    </div>
  </form>;
  return <form className={`composer ${expanded?'expanded':''}`} onSubmit={submit}><Avatar size={40}/>{!expanded?<><button className="composer-prompt" type="button" onClick={()=>setExpanded(true)}>{draft||'分享一个发现，或说说你遇到的问题……'}</button><LinkButton onClick={()=>{setExpanded(true);setType('question');}}><CircleHelp size={20}/>求助</LinkButton><LinkButton onClick={()=>go('publish')}><FileText size={20}/>分享资源</LinkButton></>:<div className="composer-fields">
    <div className="composer-tabs"><button type="button" className={type==='discovery'?'selected':''} onClick={()=>setType('discovery')}>分享发现</button><button type="button" className={type==='question'?'selected':''} onClick={()=>setType('question')}>求助</button><button className="icon-button" type="button" aria-label="收起编辑，保留草稿" onClick={()=>setExpanded(false)}><X size={18}/></button></div>
    <textarea ref={ownInput} autoFocus aria-label="分享或求助正文" placeholder="直接说说你的发现，或具体卡在哪一步……" value={draft} onChange={e=>patch({questionDraft:e.target.value})}/>
    {refId&&<div className="composer-reference"><FileText size={15}/><span>{selected?.title||'资源暂不可用'}</span>{selected&&<small>{selected.scope==='仅共学群可见'?'本群':'市场'}</small>}<button type="button" className="icon-button" aria-label="移除引用资源" onClick={()=>setRefId('')}><X size={14}/></button></div>}
    <TopicEditor label="动态话题" value={state.questionTopicIds} text={draft} onChange={questionTopicIds=>patch({questionTopicIds})}/>
    <div className="composer-tools"><label className="text-button file-button"><ImagePlus size={18}/>图片<input type="file" accept="image/*" onChange={e=>setFile(e.target.files?.[0]?.name||'')}/></label>{linkPicker}<label className="scope-select"><Globe2 size={18}/><select aria-label="发布可见范围" value={scope} onChange={e=>setScope(e.target.value as typeof scope)}><option>公开</option><option>仅共学群可见</option></select></label>{scope==='仅共学群可见'&&<select aria-label="发布到哪个共学群" value={selectedGroup} onChange={e=>setSelectedGroup(e.target.value)}>{allGroups(state).filter(g=>state.joinedGroupIds.includes(g.id)).map(g=><option key={g.id} value={g.id}>{g.name}</option>)}</select>}<span className="draft-label">草稿仅存本机</span><Primary type="submit" disabled={!canSubmit}>发布{type==='question'?'求助':'分享'}</Primary></div>
    {file&&<p className="meta">{file}（仅显示名称，未上传）</p>}{!validScope&&<p className="inline-status">群内资源只能在原群引用；请调整可见范围。</p>}
  </div>}{notice&&<p className="inline-status" role="status">{notice}</p>}</form>;
}
