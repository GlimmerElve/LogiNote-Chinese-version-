import {forwardRef,useEffect,useImperativeHandle,useRef,useState} from 'react';
import {ImagePlus,X} from 'lucide-react';
import {useServiceIdentity} from './ServiceIdentity';
import {communityResources,type ResourceFile} from './serviceResourceClient';
import {ResourceBody} from './ResourceBody';
import {LinkButton} from './ui';

export type InlineImageFile=Pick<ResourceFile,'id'|'name'|'mime'|'bytes'>;
export type ContentImageHandle={addFiles:(files:File[])=>void;choose:()=>void};
const pattern=/!\[[^\]]*\]\(attachment:[\da-f-]{36}\)/gi;
export const contentText=(body:string)=>body.replace(/(?:\n\n)?!\[[^\]]*\]\(attachment:[\da-f-]{36}\)/gi,'');
export const withContentText=(body:string,text:string)=>[text,...body.match(pattern)||[]].filter(Boolean).join('\n\n');

export async function prepareContentImage(file:File){
  if(!['image/png','image/jpeg','image/webp'].includes(file.type)||file.size>10*1024*1024||!file.size)throw Error('请选择 10 MB 以内的 PNG、JPG 或 WebP 图片。');
  const url=URL.createObjectURL(file),image=new Image();
  try{
    image.src=url;await image.decode();if(!image.naturalWidth||!image.naturalHeight)throw Error();
    const scale=Math.min(1,2400/Math.max(image.naturalWidth,image.naturalHeight)),canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(image.naturalWidth*scale));canvas.height=Math.max(1,Math.round(image.naturalHeight*scale));
    const context=canvas.getContext('2d');if(!context)throw Error();context.drawImage(image,0,0,canvas.width,canvas.height);
    for(const quality of [.9,.8,.65,.5]){const blob=await new Promise<Blob|null>(resolve=>canvas.toBlob(resolve,'image/webp',quality));if(blob&&blob.size<=2*1024*1024)return new File([blob],file.name.replace(/\.[^.]*$/,'').replace(/[\\/\[\]\r\n\x00-\x1f]/g,'_').slice(0,150)+'.webp',{type:'image/webp'});}
    throw Error('图片压缩后仍过大，请裁剪后重试。');
  }catch(error){throw Error(error instanceof Error&&error.message.startsWith('图片压缩')?error.message:'图片无法读取，请换一张图片。');}
  finally{URL.revokeObjectURL(url);}
}

function useImageUrls(files:InlineImageFile[]){
  const {session}=useServiceIdentity(),accountId=session?.kind==='authenticated'?session.account.accountId:'';
  const [urls,setUrls]=useState<Record<string,string>>({});const key=JSON.stringify(files);
  useEffect(()=>{setUrls({});if(!accountId||!files.length)return;let active=true;const made:string[]=[];
    void Promise.allSettled(files.map(async file=>{const blob=await communityResources.download(accountId,{...file,role:'image'});if(!active)return;const url=URL.createObjectURL(new Blob([blob],{type:file.mime}));made.push(url);setUrls(current=>({...current,['attachment:'+file.id]:url}));}));
    return()=>{active=false;made.forEach(url=>URL.revokeObjectURL(url));};
  },[accountId,key]);return urls;
}

export function ContentBody({body,images=[],compact=false}:{body:string;images?:InlineImageFile[];compact?:boolean}){
  const urls=useImageUrls(images);let value=body;
  if(compact){const text=contentText(body);value=[text.length>320?text.slice(0,320)+'…':text,...body.match(pattern)||[]].filter(Boolean).join('\n\n');}
  return <ResourceBody body={value} resolvedImages={urls}/>;
}

/** One small image control shared by posts, questions, comments and resource text. */
export const ContentImagePicker=forwardRef<ContentImageHandle,{stageId?:string|null;body:string;images?:InlineImageFile[];onChange:(body:string,stageId?:string)=>void;onBusy:(busy:boolean)=>void;disabled?:boolean;showButton?:boolean;maxImages?:number}>(function ContentImagePicker(props,ref){
  const {session}=useServiceIdentity(),accountId=session?.kind==='authenticated'?session.account.accountId:'';
  const [files,setFiles]=useState<InlineImageFile[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const current=useRef(props),stage=useRef(props.stageId),locked=useRef(false),alive=useRef(true),input=useRef<HTMLInputElement>(null),retry=useRef<{source:File;file?:File;key:string}[]>([]);
  current.current=props;stage.current=props.stageId||stage.current;
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  useEffect(()=>{stage.current=props.stageId;if(!props.stageId){setFiles([]);return;}let active=true;void communityResources.stage(props.stageId).then(result=>{if(active)setFiles(result.files.filter(file=>file.role==='image'));}).catch(error=>{if(active)setError(error.message);});return()=>{active=false;};},[props.stageId]);
  const visible=[...props.images||[],...files].filter((file,index,all)=>all.findIndex(item=>item.id===file.id)===index&&props.body.includes('attachment:'+file.id)),urls=useImageUrls(visible);
  const add=async(sources:File[])=>{
    if(!sources.length||locked.current||current.current.disabled||!accountId)return;
    if(visible.length+sources.length>(props.maxImages??8)){setError('每条内容最多包含 '+(props.maxImages??8)+' 张图片。');return;}
    locked.current=true;setBusy(true);setError('');current.current.onBusy(true);retry.current=sources.map(source=>retry.current.find(item=>item.source===source)||{source,key:crypto.randomUUID()});
    try{
      for(let index=0;index<sources.length;index++){
        const source=sources[index],pending=retry.current.find(item=>item.source===source)!;pending.file??=await prepareContentImage(source);
        if(!stage.current){stage.current=(await communityResources.createStage(accountId)).stageId;current.current.onChange(current.current.body,stage.current);}
        const id=await communityResources.upload(accountId,stage.current,pending.file,'image',pending.key);
        if(!alive.current)return;const file={id,name:pending.file.name,mime:pending.file.type,bytes:pending.file.size};setFiles(value=>[...value.filter(item=>item.id!==id),file]);
        current.current.onChange(current.current.body+'\n\n!['+file.name+'](attachment:'+id+')',stage.current);retry.current=retry.current.filter(item=>item!==pending);
      }
    }catch(error){if(alive.current)setError(error instanceof Error?error.message:'图片上传未完成，请重试。');}
    finally{locked.current=false;if(alive.current){setBusy(false);current.current.onBusy(false);}}
  };
  useImperativeHandle(ref,()=>({addFiles:files=>void add(files),choose:()=>input.current?.click()}));
  return <div className="service-content-images" style={props.showButton===false&&!visible.length&&!busy&&!error?{display:'contents'}:undefined}>{visible.length>0&&<div className="service-content-image-list">{visible.map(file=><div key={file.id}>{urls['attachment:'+file.id]?<img src={urls['attachment:'+file.id]} alt={file.name}/>:<span className="meta">正在读取图片…</span>}<button type="button" className="icon-button" aria-label={'移除图片'+file.name} disabled={busy||props.disabled} onClick={()=>{
    const remove=async()=>{if(locked.current)return;locked.current=true;setBusy(true);current.current.onBusy(true);try{if(files.some(item=>item.id===file.id)&&stage.current)await communityResources.remove(accountId,stage.current,file.id);const body=current.current.body.replace(/(?:\n\n)?!\[[^\]]*\]\(attachment:([\da-f-]{36})\)/gi,(match,id)=>id===file.id?'':match);setFiles(value=>value.filter(item=>item.id!==file.id));current.current.onChange(body,stage.current||undefined);}catch(error){setError(error instanceof Error?error.message:'图片暂未移除。');}finally{locked.current=false;if(alive.current){setBusy(false);current.current.onBusy(false);}}};void remove();
  }}><X size={14}/></button></div>)}</div>}{props.showButton!==false&&<LinkButton aria-label="添加正文图片" disabled={busy||props.disabled} onClick={()=>input.current?.click()}><ImagePlus size={17}/></LinkButton>}<input ref={input} hidden multiple type="file" aria-label="选择内容图片" accept="image/png,image/jpeg,image/webp" onChange={event=>{void add(Array.from(event.target.files||[]));event.target.value='';}}/>{busy&&<p className="meta" role="status">正在处理图片…</p>}{error&&<p className="inline-status" role="alert">{error} {retry.current.length>0&&<LinkButton onClick={()=>{const pending=[...retry.current];void add(pending.map(item=>item.source));}}>重试</LinkButton>}</p>}</div>;
});
