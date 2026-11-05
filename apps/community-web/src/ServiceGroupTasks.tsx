import {startVisiblePoll} from './visiblePoll';
import {useEffect,useRef,useState} from 'react';
import {CheckCircle2,Circle,MoreHorizontal} from 'lucide-react';
import {Empty,LinkButton,Overlay,Primary} from './ui';
import {ResourceBody} from './ResourceBody';
import {ServiceGovernancePage} from './ServiceGovernance';
import {groupTasks as api,type GroupInfo,type GroupTask,type GroupTaskDraft,type TaskActivity} from './serviceGroupClient';

export function ServiceGroupTasks({group,accountId,preview=false,active=true,onOpen,onGroupChanged}:{group:GroupInfo;accountId:string;preview?:boolean;active?:boolean;onOpen?:()=>void;onGroupChanged:()=>void}){
  const [items,setItems]=useState<GroupTask[]>([]),[view,setView]=useState('open'),[limit,setLimit]=useState(3),[next,setNext]=useState<number|null>(null),[ready,setReady]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[selected,setSelected]=useState<GroupTask|null>(null),[editing,setEditing]=useState(false),[report,setReport]=useState(false),[removed,setRemoved]=useState<GroupTask|null>(null);
  const loadedPages=useRef(1),currentView=useRef(view),editingPanel=useRef(false);currentView.current=view;editingPanel.current=editing||report;
  const refresh=async(signal?:AbortSignal)=>{
    const pages:GroupTask[]=[];let offset=0,nextOffset:number|null=null;
    for(let page=0;page<loadedPages.current;page++){const result=await api.list(group.id,{view,offset},signal);pages.push(...result.items);if(signal?.aborted)return;nextOffset=result.nextOffset;if(result.nextOffset===null)break;offset=result.nextOffset;}
    if(signal?.aborted||currentView.current!==view)return;setNext(nextOffset);setItems(pages);setReady(true);
    if(!editingPanel.current)setSelected(old=>old?pages.find(item=>item.id===old.id)||null:null);
  };
  useEffect(()=>{loadedPages.current=1;setLimit(3);setReady(false);setItems([]);setError('');const controller=new AbortController();void refresh(controller.signal).catch(error=>{if(!controller.signal.aborted)setError(error.message);});return()=>controller.abort();},[group.id,view]);
  useEffect(()=>{if(!active)return;const poll=startVisiblePoll(signal=>refresh(signal),{intervalMs:10000,immediate:false,onError:error=>{if([403,410].includes((error as {status:number}).status))onGroupChanged();}});return()=>poll.stop();},[active,group.id,view]);
  const run=async(work:()=>Promise<unknown>)=>{if(busy)return false;let saved=false;setBusy(true);setError('');try{await work();saved=true;await refresh();return true;}catch(error){setError(error instanceof Error?error.message:'暂时无法保存。');await refresh().catch(()=>{});return saved;}finally{setBusy(false);}};
  const progress=(task:GroupTask,state:GroupTask['myState'])=>run(()=>api.progress(accountId,group.id,task,state));
  const change=(task:GroupTask,action:string,fields?:GroupTaskDraft)=>run(async()=>{const result=await api.update(accountId,group.id,task,action,fields);if(action==='remove'){setRemoved(result);setSelected(null);}if(action==='restore')setRemoved(null);setEditing(false);});
  const more=async()=>{if(limit<items.length){setLimit(n=>n+3);return;}if(next===null)return;await run(async()=>{loadedPages.current++;setLimit(n=>n+3);});};
  if(preview&&!items.length)return null;
  const editable=group.canManage&&group.canSend,canProgress=group.canSend&&!group.learningPaused;
  const row=(task:GroupTask)=><article className="service-task-row" key={task.id} data-task-id={task.id}>
    <button type="button" className="icon-button service-task-check" aria-label={(task.myState==='done'?'撤销完成任务：':'完成任务：')+task.title} aria-pressed={task.myState==='done'} disabled={busy||!canProgress||task.state!=='open'} onClick={()=>void progress(task,task.myState==='done'?'doing':'done')}>{task.myState==='done'?<CheckCircle2 size={21}/>:<Circle size={21}/>}</button>
    <div className="service-task-title"><button type="button" className="text-button" onClick={()=>{setSelected(task);setEditing(false);}}>{task.title}</button><p className="meta">{task.myState==='done'?'我已完成':task.myState==='doing'?'我在参与':'自愿参与'}{task.dueOn?' · '+task.dueOn+' 截止':''}{task.participantCount?' · '+task.completedCount+' / '+task.participantCount+' 人完成':''}{task.state==='closed'?' · 已结束':''}</p></div>
    {!preview&&<details data-popup className="service-member-menu"><summary className="icon-button" aria-label={task.title+'的任务操作'}><MoreHorizontal size={18}/></summary><div onClick={event=>{if((event.target as Element).closest('button'))event.currentTarget.closest('details')?.removeAttribute('open');}}>
      {task.state==='open'&&canProgress&&task.myState==='none'&&<LinkButton disabled={busy} onClick={()=>void progress(task,'doing')}>参与任务</LinkButton>}
      {task.state==='open'&&canProgress&&task.myState!=='none'&&<LinkButton disabled={busy} onClick={()=>void progress(task,'none')}>取消参与</LinkButton>}
      {editable&&(task.state==='removed'?<LinkButton disabled={busy} onClick={()=>void change(task,'restore')}>恢复任务</LinkButton>:<><LinkButton onClick={()=>{setSelected(task);setEditing(true);}}>编辑任务</LinkButton><LinkButton disabled={busy} onClick={()=>void change(task,task.state==='closed'?'reopen':'close')}>{task.state==='closed'?'重新开放任务':'结束任务'}</LinkButton><LinkButton disabled={busy} onClick={()=>void change(task,'remove')}>移除任务</LinkButton></>)}
      {task.state!=='removed'&&<LinkButton onClick={()=>{setSelected(task);setReport(true);}}>反馈与举报</LinkButton>}
    </div></details>}
  </article>;
  return <section className={'service-group-tasks '+(preview?'preview':'')} aria-label={preview?'共学任务简览':'共学任务'}>
    <div className="service-task-heading"><h2>{preview?'一起完成':'共学任务'}</h2>{preview?<LinkButton onClick={onOpen}>全部任务 ›</LinkButton>:<details data-popup className="service-filter"><summary>筛选</summary><div><select aria-label="任务状态筛选" disabled={busy} value={view} onChange={event=>{setView(event.target.value);event.currentTarget.closest('details')?.removeAttribute('open');}}><option value="open">进行中</option><option value="closed">已结束</option>{group.canManage&&<option value="removed">已移除</option>}</select></div></details>}</div>
    {!preview&&group.learningPaused&&<p className="meta">你已暂停共学。<LinkButton disabled={busy} onClick={()=>void run(async()=>{const {communityGroups}=await import('./serviceGroupClient');await communityGroups.participation(accountId,group.id,false);onGroupChanged();})}>恢复参与</LinkButton></p>}
    {!preview&&editable&&view==='open'&&<TaskEditor key="create" busy={busy} onSave={draft=>run(()=>api.create(accountId,group.id,draft))}/>}
    {!selected&&error&&<p role="alert" className="inline-status">{error}</p>}{items.slice(0,preview?3:limit).map(row)}
    {!preview&&ready&&!items.length&&<Empty>{view==='open'?'还没有共学任务。群主或管理员可以用一句话发起。':view==='closed'?'还没有已结束的任务。':'没有已移除的任务。'}</Empty>}
    {!preview&&!ready&&!error&&<p className="meta">正在读取任务…</p>}
    {!preview&&(items.length>limit||next!==null)&&<LinkButton disabled={busy} onClick={()=>void more()}>更多任务</LinkButton>}
    {removed&&<p className="meta">任务已移除。<LinkButton disabled={busy} onClick={()=>void change(removed,'restore')}>撤销移除</LinkButton></p>}
    {selected&&<Overlay title={report?'反馈与举报':editing?'编辑共学任务':'共学任务'} onClose={()=>{setSelected(null);setReport(false);setEditing(false);}}>{error&&<p role="alert" className="inline-status">{error}</p>}{report?<ServiceGovernancePage target={{targetType:'object',targetId:selected.id,label:selected.title}}/>:editing?<TaskEditor key={selected.id} value={selected} busy={busy} onSave={draft=>change(selected,'edit',draft)}/>:<><h3>{selected.title}</h3><p className="meta">{selected.creatorName} 发起{selected.dueOn?' · '+selected.dueOn+' 截止':''}</p>{selected.body&&<ResourceBody body={selected.body}/>}<p className="meta">{selected.completedCount} / {selected.participantCount} 位参与者已完成</p>{selected.state==='open'&&<Primary disabled={busy||!canProgress} onClick={()=>void progress(selected,selected.myState==='done'?'doing':'done')}>{selected.myState==='done'?'撤销完成':'标记完成'}</Primary>}<TaskHistory key={selected.id} groupId={group.id} taskId={selected.id}/></>}</Overlay>}
  </section>;
}
function TaskEditor({value,busy,onSave}:{value?:GroupTask;busy:boolean;onSave:(input:GroupTaskDraft)=>Promise<boolean>}){
  const [title,setTitle]=useState(value?.title||''),[body,setBody]=useState(value?.body||''),[dueOn,setDueOn]=useState(value?.dueOn||'');const input=useRef<HTMLInputElement>(null);
  return <form className="service-task-editor" onSubmit={event=>{event.preventDefault();void onSave({title,body,dueOn:dueOn||null}).then(saved=>{if(saved&&!value){setTitle('');setBody('');setDueOn('');input.current?.focus({preventScroll:true});}});}}><div className="service-task-input"><input ref={input} aria-label="共学任务标题" readOnly={busy} placeholder="一起完成什么？写一句话…" maxLength={160} value={title} onChange={event=>setTitle(event.target.value)}/><Primary type="submit" disabled={busy||!title.trim()}>{value?'保存修改':'发起任务'}</Primary></div><details data-popup className="service-editor-more"><summary>更多</summary><div><label>补充说明（可选）<textarea aria-label="任务补充说明" readOnly={busy} placeholder="说明做法，也可以粘贴资料链接。支持 Markdown。" maxLength={8000} value={body} onChange={event=>setBody(event.target.value)}/></label><label>截止日期（可选）<input aria-label="任务截止日期" readOnly={busy} type="date" min="2000-01-01" max="2100-12-31" value={dueOn} onChange={event=>setDueOn(event.target.value)}/></label></div></details></form>;
}
function TaskHistory({groupId,taskId}:{groupId:string;taskId:string}){
  const [items,setItems]=useState<TaskActivity[]>([]),[next,setNext]=useState<string|null>(null),[error,setError]=useState('');const labels:Record<string,string>={create:'发起任务',edit:'编辑任务',close:'结束任务',reopen:'重新开放',remove:'移除任务',restore:'恢复任务',complete:'标记完成',participate:'参与任务',withdraw:'取消参与'};
  const load=async(before?:string)=>{try{const result=await api.activity(groupId,taskId,before);setItems(old=>before?[...old,...result.items]:result.items);setNext(result.nextBefore);}catch(error){setError(error instanceof Error?error.message:'暂时无法读取。');}};
  return <details className="fold" onToggle={event=>{if(event.currentTarget.open)void load();}}><summary>任务记录</summary>{items.map(item=><p className="meta" key={item.id}>{item.actorName} · {labels[item.action]||item.action} · {new Date(item.createdAt).toLocaleString('zh-CN')}</p>)}{next&&<LinkButton onClick={()=>void load(next)}>更早记录</LinkButton>}{error&&<p className="meta">{error}</p>}</details>;
}
