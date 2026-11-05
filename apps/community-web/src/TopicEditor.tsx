import { useRef, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { useApp } from './context';
import { cleanTopicIds, findTopic, searchTopics, suggestedTopicIds } from './contentTopics';

export function TopicEditor({value,onChange,label,text=''}:{value:string[];onChange:(ids:string[])=>void;label:string;text?:string}){
  const {state,patch}=useApp();const [query,setQuery]=useState('');const box=useRef<HTMLDetailsElement>(null);
  const ids=cleanTopicIds(state,value),suggestions=suggestedTopicIds(text);
  const found=searchTopics(state,query).sort((a,b)=>Number(suggestions.includes(b.id))-Number(suggestions.includes(a.id))).slice(0,6);
  const name=query.replace(/^#+|#+$/g,'').trim();
  const canCreate=!!name&&name.length<=20&&!findTopic(state,name);
  const toggle=(id:string)=>{if(ids.includes(id))onChange(ids.filter(item=>item!==id));else if(ids.length<3)onChange([...ids,id]);};
  return <div className="topic-editor" role="group" aria-label={label}>
    {ids.length>0&&<div className="selected-content-topics">{ids.map(id=><button type="button" key={id} className="topic-token" aria-label={`移除话题${state.topicCatalog.find(t=>t.id===id)!.name}`} onClick={()=>toggle(id)}>#{state.topicCatalog.find(t=>t.id===id)!.name}<X size={13}/></button>)}</div>}
    <details data-popup ref={box} className="topic-add" onKeyDown={event=>{if(event.key==='Escape'){event.stopPropagation();box.current!.open=false;box.current?.querySelector('summary')?.focus();}}}>
      <summary><Plus size={15}/>添加话题</summary><div className="topic-options">
        <input type="search" aria-label={`${label}搜索`} placeholder="搜索或新建话题……" value={query} onChange={event=>setQuery(event.target.value)} onKeyDown={event=>{if(event.key==='Enter')event.preventDefault();}}/>
        <div className="topic-option-list">{found.map(topic=><button type="button" key={topic.id} aria-pressed={ids.includes(topic.id)} disabled={ids.length>=3&&!ids.includes(topic.id)} onClick={()=>toggle(topic.id)}>#{topic.name}</button>)}</div>
        {canCreate&&<button type="button" className="text-button" disabled={ids.length>=3} onClick={()=>{
          const existing=findTopic(state,name);if(existing){toggle(existing.id);return;}
          const topic={id:`topic-${crypto.randomUUID()}`,name,aliases:[],description:'',directions:[]};
          patch({topicCatalog:[...state.topicCatalog,topic]});onChange([...ids,topic.id]);setQuery('');
        }}>新建话题「{name}」</button>}
        {name.length>20&&<p className="meta">话题名称不超过 20 个字。</p>}<p className="meta">最多 3 个，不选也能发布。</p>
      </div>
    </details>
  </div>;
}
