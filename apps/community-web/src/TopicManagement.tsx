import { useState } from 'react';
import { useApp } from './context';
import { allContentTopics, findTopic } from './contentTopics';
import { topics } from './model';
import { Fold, LinkButton, Primary } from './ui';

export function TopicManagement(){
  const {state,patch}=useApp();const [id,setId]=useState('linear-algebra');
  const [mergeUndo,setMergeUndo]=useState<{id:string;redirects:typeof state.topicRedirects}|null>(null);
  return <Fold title="话题维护"><p className="meta">本机治理演示：修改名称和合并话题不会删除关联内容，不代表已接入服务端管理。</p><label className="field-label">选择话题<select aria-label="维护话题" value={id} onChange={event=>setId(event.target.value)}>{allContentTopics(state).map(topic=><option key={topic.id} value={topic.id}>{topic.name}</option>)}</select></label><TopicSettings key={id} id={id} onMerged={target=>{setMergeUndo({id,redirects:state.topicRedirects});setId(target);}}/>{mergeUndo&&<p role="status" className="inline-status">已合并到所选话题。<LinkButton onClick={()=>{patch({topicRedirects:mergeUndo.redirects});setId(mergeUndo.id);setMergeUndo(null);}}>撤销合并</LinkButton></p>}</Fold>;
}
function TopicSettings({id,onMerged}:{id:string;onMerged:(id:string)=>void}){
  const {state,patch}=useApp();const topic=state.topicCatalog.find(item=>item.id===id);
  const [name,setName]=useState(topic?.name||''),[aliases,setAliases]=useState(topic?.aliases.join('，')||''),[description,setDescription]=useState(topic?.description||''),[directions,setDirections]=useState(topic?.directions||[]);
  const [target,setTarget]=useState(''),[status,setStatus]=useState('');
  const [undo,setUndo]=useState<{catalog:typeof state.topicCatalog;redirects:typeof state.topicRedirects}|null>(null);
  if(!topic)return null;
  const save=()=>{
    const nextName=name.replace(/^#+|#+$/g,'').trim(),nextAliases=[...new Set([topic.name,...topic.aliases,...aliases.split(/[,，\n]/)].map(value=>value.trim()).filter(value=>value&&value!==nextName))];
    if(!nextName||nextName.length>20){setStatus('名称需要在 1–20 个字之间。');return;}
    if([nextName,...nextAliases].some(value=>{const other=findTopic(state,value);return other&&other.id!==id;})){setStatus('这个名称或别名已被其他话题使用，可以选择合并。');return;}
    setUndo({catalog:state.topicCatalog,redirects:state.topicRedirects});patch({topicCatalog:state.topicCatalog.map(item=>item.id===id?{...item,name:nextName,aliases:nextAliases.slice(0,30),description:description.slice(0,300),directions}:item)});setStatus('已保存到本机。');
  };
  return <div className="topic-settings"><label className="field-label">名称<input aria-label="话题名称" value={name} maxLength={20} onChange={event=>setName(event.target.value)}/></label><label className="field-label">别名<input aria-label="话题别名" placeholder="用逗号分隔，如 AI、人工智慧" value={aliases} onChange={event=>setAliases(event.target.value)}/></label><label className="field-label">简介<textarea aria-label="话题简介" value={description} maxLength={300} onChange={event=>setDescription(event.target.value)}/></label><fieldset><legend>相关方向</legend>{topics.map(direction=><label className="topic-direction" key={direction}><input type="checkbox" checked={directions.includes(direction)} onChange={()=>setDirections(directions.includes(direction)?directions.filter(value=>value!==direction):[...directions,direction])}/>{direction}</label>)}</fieldset><Primary onClick={save}>保存话题</Primary>
    <Fold title="合并重复话题"><p className="meta">旧话题链接、关联内容与搜索词会指向保留的话题。</p><select aria-label="合并到话题" value={target} onChange={event=>setTarget(event.target.value)}><option value="">选择保留的话题</option>{allContentTopics(state).filter(item=>item.id!==id).map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select><LinkButton disabled={!target} onClick={()=>{
      if(!allContentTopics(state).some(item=>item.id===target))return;
      // Keep the source entry and stable links as aliases, rather than rewriting posts.
      patch({topicRedirects:{...state.topicRedirects,[id]:target}});onMerged(target);
    }}>合并到所选话题</LinkButton></Fold>
    {status&&<p role="status" className="inline-status">{status}{undo&&<LinkButton onClick={()=>{patch({topicCatalog:undo.catalog,topicRedirects:undo.redirects});setName(undo.catalog.find(item=>item.id===id)!.name);setStatus('已撤销修改。');setUndo(null);}}>撤销修改</LinkButton>}</p>}
  </div>;
}
