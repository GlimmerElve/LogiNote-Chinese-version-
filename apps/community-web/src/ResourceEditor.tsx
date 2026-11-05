import { useEffect, useRef, useState } from 'react';
import { Bold, Code2, Heading2, ImagePlus, Italic, Link as LinkIcon, List, MoreHorizontal, Quote, Sigma, Table2, X } from 'lucide-react';
import { useApp } from './context';
import { imageReferences, validCover, type DemoState, type ResourceImage } from './model';
import { ResourceBody } from './ResourceBody';
import { LinkButton } from './ui';

export function ResourceEditor({onChange,onBusyChange}:{onChange:(values:Partial<DemoState>)=>void;onBusyChange:(busy:boolean)=>void}) {
  const {state}=useApp();
  const [preview,setPreview]=useState(false);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const textarea=useRef<HTMLTextAreaElement>(null),fileInput=useRef<HTMLInputElement>(null);
  const selection=useRef({start:0,end:0}),generation=useRef(0);
  const latest=useRef({state,onChange,onBusyChange});latest.current={state,onChange,onBusyChange};
  useEffect(()=>()=>{generation.current++;},[]);
  const imageIds=imageReferences(state.publishDraft);
  const images=state.resourceImages.filter(image=>imageIds.includes(image.id));
  const remember=()=>{if(textarea.current)selection.current={start:textarea.current.selectionStart,end:textarea.current.selectionEnd};};
  const apply=(body:string,start:number,end=start,extra:Partial<DemoState>={})=>{
    latest.current.onChange({...extra,publishDraft:body});selection.current={start,end};
    requestAnimationFrame(()=>{textarea.current?.focus({preventScroll:true});textarea.current?.setSelectionRange(start,end);});
  };
  const wrap=(before:string,after:string,label:string)=>{
    const body=latest.current.state.publishDraft,{start,end}=selection.current;
    const chosen=body.slice(start,end)||label;
    apply(body.slice(0,start)+before+chosen+after+body.slice(end),start+before.length,start+before.length+chosen.length);
  };
  const line=(prefix:string)=>{
    const body=latest.current.state.publishDraft,{start,end}=selection.current;
    const from=body.lastIndexOf('\n',Math.max(0,start-1))+1;
    const original=body.slice(from,end)||'内容';
    const replacement=original.split('\n').map(text=>prefix+text).join('\n');
    apply(body.slice(0,from)+replacement+body.slice(end),from+prefix.length,from+replacement.length);
  };
  const snippet=(value:string)=>{const body=latest.current.state.publishDraft,{start,end}=selection.current;apply(body.slice(0,start)+value+body.slice(end),start+value.length);};
  const readImage=async(file:File):Promise<ResourceImage>=>{
    if(!['image/png','image/jpeg','image/webp'].includes(file.type)||file.size>1024*1024)throw Error('请选择 1 MB 以内的 PNG、JPG 或 WebP 图片。');
    const data=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(Error('图片读取失败，正文已保留。'));reader.readAsDataURL(file);});
    if(!validCover(data))throw Error('图片无法读取，请换一张图片。');
    const image=new Image();image.src=data;await image.decode();
    return {id:`image-${crypto.randomUUID()}`,name:file.name,data};
  };
  const insertImages=async(files:File[])=>{
    if(!files.length||busy)return;
    setError('');const request=++generation.current;setBusy(true);latest.current.onBusyChange(true);
    try {
      if(files.length+imageReferences(latest.current.state.publishDraft).length>4)throw Error('本机原型每份资源最多插入 4 张正文图片。');
      const added=await Promise.all(files.map(readImage));if(request!==generation.current)return;
      const current=latest.current.state,body=current.publishDraft;
      const start=Math.min(selection.current.start,body.length),end=Math.min(selection.current.end,body.length);
      const insertion=added.map(image=>`![${image.name.replace(/[\[\]\r\n]/g,' ').slice(0,80)}](attachment:${image.id})`).join('\n\n');
      const separator=start&&body[start-1]!=='\n'?'\n\n':'';
      const nextBody=body.slice(0,start)+separator+insertion+'\n\n'+body.slice(end);
      const referenced=new Set([body,...current.userResources.map(resource=>resource.body||'')].flatMap(imageReferences));
      const pool=[...current.resourceImages.filter(image=>referenced.has(image.id)),...added];
      if(JSON.stringify({...current,publishDraft:nextBody,resourceImages:pool}).length>2_200_000)throw Error('本机演示存储空间不足，请选择更小的图片；正文已保留。');
      apply(nextBody,start+separator.length+insertion.length+2,undefined,{resourceImages:pool});
    } catch(cause) {if(request===generation.current)setError(cause instanceof Error&&cause.name!=='EncodingError'?cause.message:'图片内容无法解码，请换一张。');}
    finally {if(request===generation.current){setBusy(false);latest.current.onBusyChange(false);}}
  };
  const removeImage=(image:ResourceImage)=>{
    const current=latest.current.state;
    const body=current.publishDraft.replace(new RegExp(`!\\[[^\\]\\n]*\\]\\(attachment:${image.id}\\)`,'g'),'');
    const usedElsewhere=current.userResources.some(resource=>resource.imageIds?.includes(image.id));
    onChange({publishDraft:body,resourceImages:usedElsewhere?current.resourceImages:current.resourceImages.filter(item=>item.id!==image.id)});
  };
  const tool=(label:string,icon:React.ReactNode,action:()=>void)=><button type="button" className="icon-button" aria-label={label} title={label} onMouseDown={e=>e.preventDefault()} onClick={action}>{icon}</button>;
  return <div className="resource-editor">
    <div className="resource-editor-toolbar" aria-label="正文编辑工具">{!preview&&<>
      {tool('标题',<Heading2 size={18}/>,()=>line('## '))}{tool('加粗',<Bold size={18}/>,()=>wrap('**','**','加粗文字'))}{tool('斜体',<Italic size={18}/>,()=>wrap('*','*','斜体文字'))}{tool('列表',<List size={18}/>,()=>line('- '))}
      {tool('插入正文图片',<ImagePlus size={18}/>,()=>{remember();fileInput.current?.click();})}
      <details data-popup className="resource-editor-more" onBlur={e=>{if(!e.currentTarget.contains(e.relatedTarget))e.currentTarget.open=false;}} onKeyDown={e=>{if(e.key==='Escape'){e.currentTarget.open=false;e.currentTarget.querySelector('summary')?.focus();}}}><summary className="icon-button" aria-label="更多排版工具" title="更多排版工具"><MoreHorizontal size={18}/></summary><div onClick={e=>{if((e.target as Element).closest('button'))e.currentTarget.closest('details')?.removeAttribute('open');}}>
        <button type="button" onClick={()=>wrap('[','](https://example.com)','链接文字')}><LinkIcon size={16}/>链接</button>
        <button type="button" onClick={()=>line('> ')}><Quote size={16}/>引用</button>
        <button type="button" onClick={()=>wrap('\n```\n','\n```\n','代码')}><Code2 size={16}/>代码块</button>
        <button type="button" onClick={()=>wrap('$','$','x^2')}><Sigma size={16}/>公式</button>
        <button type="button" onClick={()=>snippet('\n\n| 项目 | 说明 |\n| --- | --- |\n| 内容 | 内容 |\n\n')}><Table2 size={16}/>表格</button>
      </div></details>
    </>}<LinkButton className="text-button resource-editor-preview-toggle" aria-pressed={preview} disabled={!state.publishDraft.trim()} onClick={()=>{remember();setPreview(!preview);}}>{preview?'继续编辑':'预览'}</LinkButton></div>
    <textarea ref={textarea} hidden={preview} className="publish-body" aria-label="资源正文" placeholder="直接写下资料、笔记、学习路线……也可以粘贴或拖入图片。" value={state.publishDraft} onChange={e=>onChange({publishDraft:e.target.value})} onSelect={remember} onKeyUp={remember} onClick={remember}
      onKeyDown={e=>{if((e.ctrlKey||e.metaKey)&&['b','i'].includes(e.key.toLowerCase())){e.preventDefault();remember();e.key.toLowerCase()==='b'?wrap('**','**','加粗文字'):wrap('*','*','斜体文字');}}}
      onPaste={e=>{const files=Array.from(e.clipboardData.files);if(files.length){e.preventDefault();remember();void insertImages(files);}}}
      onDragOver={e=>{if(e.dataTransfer.types.includes('Files'))e.preventDefault();}}
      onDrop={e=>{if(e.dataTransfer.files.length){e.preventDefault();remember();void insertImages(Array.from(e.dataTransfer.files));}}}/>
    {preview&&<div className="resource-editor-preview"><ResourceBody body={state.publishDraft} imageIds={imageIds}/></div>}
    <input ref={fileInput} hidden type="file" multiple accept="image/png,image/jpeg,image/webp" aria-label="选择正文图片" onChange={e=>{void insertImages(Array.from(e.target.files||[]));e.target.value='';}}/>
    {!preview&&images.length>0&&<div className="resource-editor-images">{images.map(image=><div key={image.id}><img src={image.data} alt={image.name}/><span>{image.name}</span><button type="button" className="icon-button" aria-label={`移除正文图片${image.name}`} onClick={()=>removeImage(image)}><X size={15}/></button></div>)}</div>}
    <div className="resource-editor-hint">{busy?<span role="status">正在读取图片…</span>:<span>支持 Markdown，图片可插入、粘贴或拖入。</span>}</div>{error&&<p className="inline-status" role="alert">{error}</p>}
  </div>;
}
