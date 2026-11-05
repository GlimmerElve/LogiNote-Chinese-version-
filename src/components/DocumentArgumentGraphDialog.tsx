import React,{useEffect,useMemo,useRef,useState} from 'react';
import {ReactFlow,Background,Controls,Handle,MarkerType,Position,type Node,type NodeProps,type Edge,type ReactFlowInstance} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type {UploadedDocument} from '../types';
import type {DocumentArgumentGraphView} from '../services/documentArgumentV5Types';
import {readDocumentArgumentGraphView,subscribeDocumentChanges} from '../services/documentRagClient';
import {layoutDocumentArgumentGraph,ARGUMENT_NODE_SIZE} from '../services/documentArgumentGraphLayout';
import {routeDocumentArgumentGraph,type ArgumentPort} from '../services/documentArgumentGraphRouting';
import {useDialog} from './useDialog';

const roles={claim:'主张',premise:'依据',background:'背景',method:'方法'};
const kinds={support:'支持',oppose:'反对',context:'上下文',method_for:'方法来源',relates:'关联'};
const colors={support:'var(--ln-accent)',oppose:'var(--ln-danger)',context:'#7895c9',method_for:'#c99b50',relates:'#a88dc9'};
type CardNode=Node<{label:string;ports:ArgumentPort[]},'argumentCard'>;
function ArgumentCard({data}:NodeProps<CardNode>){return <>
  <div style={{padding:12,height:'100%',overflow:'hidden'}}>{data.label}</div>
  {data.ports.map(p=><Handle key={p.id} id={p.id} type={p.type} position={p.side==='left'?Position.Left:Position.Right} isConnectable={false} style={{top:`${p.top}%`,width:4,height:4,opacity:.5,border:0,background:'var(--ln-text-secondary)'}}/>)}</>;}
const nodeTypes={argumentCard:ArgumentCard};
const initialFitOptions={padding:.15,maxZoom:1};
export function DocumentArgumentGraphDialog({document:doc,onClose}:{document:UploadedDocument;onClose:()=>void}){
  const ref=useRef<HTMLDivElement>(null),[graph,setGraph]=useState<DocumentArgumentGraphView|null>(null),[error,setError]=useState(''),[selected,setSelected]=useState('');
  const flow=useRef<ReactFlowInstance|null>(null);
  const [selectedRelation,setSelectedRelation]=useState(''),[localOnly,setLocalOnly]=useState(false);
  const selectNode=(id:string)=>{setSelected(id);setSelectedRelation('');};
  useEffect(()=>{setSelectedRelation('');setLocalOnly(false);},[doc.id,graph?.revision]);
  useDialog(true,ref,onClose,95);
  useEffect(()=>{let current=true,sequence=0;setGraph(null);setError('');setSelected('');
    const refresh=()=>{const request=++sequence;
      readDocumentArgumentGraphView(doc.id).then(g=>{if(current&&request===sequence){setError('');setGraph(g);setSelected(id=>g.nodes.some(n=>n.id===id)?id:g.nodes[0]?.id||'');}})
        .catch(e=>{if(current&&request===sequence)setError(e.message||'无法读取论证图');});};
    refresh();const unsubscribe=subscribeDocumentChanges(refresh);
    return()=>{current=false;unsubscribe();};},[doc.id]);
  const layout=useMemo(()=>layoutDocumentArgumentGraph(graph||{nodes:[],edges:[]}),[graph]);
  const routing=useMemo(()=>routeDocumentArgumentGraph(graph||{nodes:[],edges:[]},layout.positions),[graph,layout]);
  const {nodes,edges}=useMemo(()=>{
    const visibleRelations=(graph?.edges||[]).filter(e=>selectedRelation?e.id===selectedRelation:e.to===selected||e.from.includes(selected));
    const focusIds=new Set(visibleRelations.flatMap(e=>[...e.from,e.to]));focusIds.add(selected);
    const nodes:Node[]=(graph?.nodes||[]).map(n=>{
      const text=n.text.replace(/\s+/gu,' ');
      return {id:n.id,type:'argumentCard',position:layout.positions.get(n.id)!,
        data:{label:`${n.id} · ${roles[n.role]}\n${text.slice(0,36)}${text.length>36?'…':''}`,ports:routing.ports.get(n.id)||[]},
        style:{...ARGUMENT_NODE_SIZE,opacity:(localOnly||selectedRelation)&&!focusIds.has(n.id)?.2:1,whiteSpace:'pre-wrap',fontSize:12,lineHeight:1.5,textAlign:'left',background:'var(--ln-bg-surface)',color:'var(--ln-text-primary)',border:`1px solid var(${n.id===selected?'--ln-accent':'--ln-border'})`,borderRadius:10}};});
    const edgeById=new Map((graph?.edges||[]).map(e=>[e.id,e]));
    const edges:Edge[]=routing.branches.map(b=>{
      const e=edgeById.get(b.relationId)!;
      const focus=visibleRelations.some(r=>r.id===e.id),active=e.id===selectedRelation;
      return {...b,type:'default',data:{relationId:e.id},hidden:localOnly&&!focus,zIndex:focus?2:0,
        ariaLabel:`${b.source} → ${b.target} · ${kinds[e.kind]}`,interactionWidth:18,
        label:active&&b.source===e.from[0]?`${e.id} · ${kinds[e.kind]}`:undefined,
        markerEnd:{type:MarkerType.ArrowClosed,color:colors[e.kind]},
        style:{stroke:colors[e.kind],strokeWidth:active?3:focus?2:1.2,opacity:focus?1:selectedRelation ? .08 : .3,strokeDasharray:['context','relates'].includes(e.kind)?'5 4':undefined},
        labelStyle:{fill:'var(--ln-text-primary)',fontSize:12},labelBgStyle:{fill:'var(--ln-bg-surface)'}};
    });return {nodes,edges};
  },[graph,selected,selectedRelation,localOnly,layout,routing]);
  const node=graph?.nodes.find(n=>n.id===selected),links=graph?.edges.filter(e=>e.to===selected||e.from.includes(selected))||[];
  return <div className="fixed inset-0 z-[95] flex items-center justify-center bg-black/50 p-3 sm:p-6" onMouseDown={e=>{if(e.target===e.currentTarget)onClose();}}>
    <div ref={ref} role="dialog" aria-modal="true" aria-label={`${doc.fileName}的论证图`} tabIndex={-1} className="flex h-[88dvh] w-full max-w-7xl flex-col overflow-hidden rounded-2xl border border-[var(--ln-border)] bg-[var(--ln-bg-surface)] text-[var(--ln-text-primary)]">
      <header className="flex items-start justify-between gap-3 border-b border-[var(--ln-border)] p-4"><div><h3 className="text-base font-bold">{doc.fileName} · 论证图</h3>
        <p className="mt-1 text-xs text-[var(--ln-text-secondary)]">{graph?`${graph.published?'有效版本':'已保存的局部图，全文尚未完成'}${graph.progress?` · 已保存${graph.progress.batchCount}批（${graph.progress.completedWindows}/${graph.progress.totalWindows}原文段落）`:''} · ${graph.nodes.length}节点 · ${edges.length}条连线`:'正在本地读取…'}。点击节点查看全文和直接关系；缩放查看结构。</p></div>
        <button type="button" onClick={onClose} className="min-h-11 rounded-lg border border-[var(--ln-border)] px-3 focus-visible:ring-2 focus-visible:ring-[var(--ln-focus-ring)]">关闭</button></header>
      {error?<p role="alert" className="p-4 text-sm text-[var(--ln-danger)]">{error}</p>:!graph?<p role="status" className="p-4 text-sm">正在读取论证图…</p>:<div className="grid min-h-0 flex-1 grid-rows-[1fr_190px] md:grid-cols-[1fr_320px] md:grid-rows-1">
        <div className="min-h-0 min-w-0"><ReactFlow key={graph.revision||graph.nodes.length} nodeTypes={nodeTypes} nodes={nodes} edges={edges} onInit={instance=>{flow.current=instance;}} fitView fitViewOptions={initialFitOptions} minZoom={.04} maxZoom={2} nodesDraggable={false} nodesConnectable={false} onNodeClick={(_,n)=>selectNode(n.id)} onEdgeClick={(_,e)=>{setSelectedRelation(String(e.data?.relationId||''));setSelected(e.target);}} onPaneClick={()=>setSelectedRelation('')} proOptions={{hideAttribution:true}}>
          <Background/><Controls showInteractive={false}/></ReactFlow></div>
        <aside className="overflow-y-auto border-t border-[var(--ln-border)] p-4 md:border-l md:border-t-0">
          <label className="text-xs font-semibold">节点<select value={selected} onChange={e=>{selectNode(e.target.value);void flow.current?.fitView({nodes:[{id:e.target.value}],maxZoom:1,padding:.8,duration:250});}} className="mt-1 w-full rounded border border-[var(--ln-border)] bg-[var(--ln-bg-surface)] p-2">{graph.nodes.map(n=><option key={n.id} value={n.id}>{n.id} · {roles[n.role]}</option>)}</select></label>
          <button type="button" onClick={()=>{setSelectedRelation('');setLocalOnly(false);void flow.current?.fitView({padding:.15,maxZoom:1,duration:250});}} className="mt-2 min-h-9 rounded border border-[var(--ln-border)] px-3 text-xs focus-visible:ring-2 focus-visible:ring-[var(--ln-focus-ring)]">适应全图</button>
          <label className="mt-3 flex min-h-9 items-center gap-2 text-xs"><input type="checkbox" checked={localOnly} onChange={e=>{setLocalOnly(e.target.checked);setSelectedRelation('');}}/>只看当前节点关系</label>
          <p className="mt-1 text-xs text-[var(--ln-text-secondary)]">点击连线或下方关系，单独高亮其全部前提与目标。点击空白取消聚焦。</p>
          <div className="mt-2 flex flex-wrap gap-2 text-xs">{Object.entries(kinds).map(([kind,label])=><span key={kind} style={{borderBottom:`2px ${['context','relates'].includes(kind)?'dashed':'solid'} ${colors[kind as keyof typeof colors]}`}}>{label}</span>)}</div>
          {node&&<><h4 className="mt-4 text-sm font-bold">{node.id} · {roles[node.role]}</h4>{node.originalRole&&<p className="mt-1 text-xs text-[var(--ln-text-secondary)]">角色已修订：{roles[node.originalRole]} → {roles[node.role]}</p>}<p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6">{node.text}</p>
            <h4 className="mt-4 text-sm font-bold">直接关系</h4>{links.map(e=><button type="button" key={e.id} aria-pressed={selectedRelation===e.id} onClick={()=>{setSelectedRelation(id=>id===e.id?'':e.id);void flow.current?.fitView({nodes:[...e.from,e.to].map(id=>({id})),maxZoom:1,padding:.3,duration:250});}} className="mt-2 w-full rounded border border-[var(--ln-border)] p-2 text-left text-xs focus-visible:ring-2 focus-visible:ring-[var(--ln-focus-ring)]" style={{borderColor:selectedRelation===e.id?colors[e.kind]:undefined}}><span className="block">{e.id} · {e.from.join(' + ')} → {e.to} · {kinds[e.kind]}</span><span className="mt-1 block text-[var(--ln-text-secondary)]">{e.reason}</span></button>)}</>}
          {!!graph.unresolved.length&&<details className="mt-4 text-xs"><summary>待核对问题 · {graph.unresolved.length}</summary>{graph.unresolved.map((u,i)=><p key={i} className="mt-2">{u.nodeId} {u.reason}</p>)}</details>}
        </aside></div>}
    </div>
  </div>;
}
