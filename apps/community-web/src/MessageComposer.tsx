import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ImagePlus, Smile, X } from 'lucide-react';
import { useApp } from './context';
import { MESSAGE_IMAGE_LIMIT, MESSAGE_STORAGE_BUDGET, readMessageImage } from './messageMedia';
import { validMessageTopic } from './model';
import { Primary } from './ui';

const emojis=['😊','👍','🤔','💪','🎉','🙏','😂','❤️','😅','👏','✅','🌱','📚','✨','🙌','👀'];
export function MessageComposer({conversation,topicId,placeholder='写点什么，也可以粘贴截图……',disabled=false,onSent}:{conversation:string;topicId?:string;placeholder?:string;disabled?:boolean;onSent:(id:string)=>void}){
  const {state,patch}=useApp();const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const textarea=useRef<HTMLTextAreaElement>(null),fileInput=useRef<HTMLInputElement>(null),emojiMenu=useRef<HTMLDetailsElement>(null);
  const generation=useRef(0),selection=useRef({start:0,end:0});
  const latest=useRef({state,patch,disabled});latest.current={state,patch,disabled};
  useEffect(()=>()=>{generation.current++;},[]);
  const draft=state.messageDrafts[conversation]||{body:'',imageIds:[]};
  const images=draft.imageIds.map(id=>state.messageImages.find(image=>image.id===id)).filter(image=>!!image);
  const update=(body:string,imageIds=draft.imageIds)=>patch({messageDrafts:{...state.messageDrafts,[conversation]:{body,imageIds}}});
  const remember=()=>{if(textarea.current)selection.current={start:textarea.current.selectionStart,end:textarea.current.selectionEnd};};
  const insertEmoji=(emoji:string)=>{
    const {start,end}=selection.current,body=draft.body;
    update(body.slice(0,start)+emoji+body.slice(end));emojiMenu.current!.open=false;
    requestAnimationFrame(()=>{textarea.current?.focus({preventScroll:true});textarea.current?.setSelectionRange(start+emoji.length,start+emoji.length);remember();});
  };
  const addImages=async(files:File[])=>{
    if(!files.length||busy||disabled)return;
    const request=++generation.current;setError('');setBusy(true);
    try{
      const currentDraft=latest.current.state.messageDrafts[conversation]||{body:'',imageIds:[]};
      if(currentDraft.imageIds.length+files.length>MESSAGE_IMAGE_LIMIT)throw Error(`每条消息最多 ${MESSAGE_IMAGE_LIMIT} 张图片。`);
      const added=await Promise.all(files.map(readMessageImage));if(request!==generation.current||latest.current.disabled)return;
      const current=latest.current.state,now=current.messageDrafts[conversation]||{body:'',imageIds:[]};
      const messageDrafts={...current.messageDrafts,[conversation]:{body:now.body,imageIds:[...now.imageIds,...added.map(image=>image.id)]}};
      const used=new Set([...current.structuredMessages.flatMap(message=>message.imageIds||[]),...Object.values(messageDrafts).flatMap(item=>item.imageIds)]);
      const messageImages=[...current.messageImages.filter(image=>used.has(image.id)),...added];
      if(JSON.stringify({...current,messageDrafts,messageImages}).length>MESSAGE_STORAGE_BUDGET)throw Error('本机演示存储空间不足，请选择更小的图片；文字和原有图片已保留。');
      latest.current.patch({messageDrafts,messageImages});
    }catch(cause){if(request===generation.current)setError(cause instanceof Error?cause.message:'图片读取失败，草稿已保留。');}
    finally{if(request===generation.current)setBusy(false);}
  };
  const removeImage=(id:string)=>{
    const messageDrafts={...state.messageDrafts,[conversation]:{body:draft.body,imageIds:draft.imageIds.filter(item=>item!==id)}};
    const used=new Set([...state.structuredMessages.flatMap(message=>message.imageIds||[]),...Object.values(messageDrafts).flatMap(item=>item.imageIds)]);
    patch({messageDrafts,messageImages:state.messageImages.filter(image=>used.has(image.id))});setError('');
  };
  const send=(event:FormEvent)=>{
    event.preventDefault();if(disabled||busy||(!draft.body.trim()&&!images.length))return;
    if(topicId!==undefined&&!validMessageTopic(state,conversation,topicId)){setError('这个话题当前不可用，或不属于当前共学群；草稿已保留。');return;}
    const id=`message-${crypto.randomUUID()}`;
    patch({structuredMessages:[...state.structuredMessages,{id,conversation,body:draft.body.trim(),imageIds:images.map(image=>image.id),...(topicId!==undefined?{topicId}:{})}],messageDrafts:{...state.messageDrafts,[conversation]:{body:'',imageIds:[]}}});
    setError('');selection.current={start:0,end:0};onSent(id);textarea.current?.focus({preventScroll:true});
  };
  return <form className="message-compose message-compose-media" onSubmit={send}>
    {images.length>0&&<div className="message-draft-images">{images.map(image=><div key={image.id}><img src={image.data} alt={`待发送：${image.name}`}/><button type="button" className="icon-button" aria-label={`移除聊天图片${image.name}`} onClick={()=>removeImage(image.id)}><X size={14}/></button></div>)}</div>}
    <textarea ref={textarea} aria-label="消息正文" placeholder={placeholder} value={draft.body} disabled={disabled} onChange={event=>update(event.target.value)} onSelect={remember} onKeyUp={remember} onClick={remember}
      onPaste={event=>{const files=Array.from(event.clipboardData.files);if(files.length){event.preventDefault();void addImages(files);}}}
      onDragOver={event=>{if(event.dataTransfer.types.includes('Files'))event.preventDefault();}}
      onDrop={event=>{if(event.dataTransfer.files.length){event.preventDefault();void addImages(Array.from(event.dataTransfer.files));}}}/>
    <div className="message-compose-tools"><button type="button" className="icon-button" aria-label="添加图片或表情包" title="图片／表情包，也可粘贴截图" disabled={disabled||busy} onClick={()=>fileInput.current?.click()}><ImagePlus size={19}/></button>
      <details data-popup ref={emojiMenu} className="message-emoji-menu" onBlur={event=>{if(!event.currentTarget.contains(event.relatedTarget))event.currentTarget.open=false;}} onKeyDown={event=>{if(event.key==='Escape'){event.stopPropagation();event.currentTarget.open=false;event.currentTarget.querySelector('summary')?.focus();}}}>
        <summary className="icon-button" aria-label="插入表情" title="表情" onClick={event=>{remember();if(disabled)event.preventDefault();}}><Smile size={19}/></summary><div className="message-emoji-options" aria-label="表情选择">{emojis.map(emoji=><button type="button" key={emoji} aria-label={`插入表情${emoji}`} disabled={disabled} onClick={()=>insertEmoji(emoji)}>{emoji}</button>)}</div>
      </details>{busy&&<span className="meta" role="status">正在读取图片…</span>}<Primary type="submit" disabled={disabled||busy||(!draft.body.trim()&&!images.length)}>发送</Primary>
    </div><input ref={fileInput} hidden type="file" multiple accept="image/png,image/jpeg,image/webp,image/gif" aria-label="选择聊天图片" onChange={event=>{void addImages(Array.from(event.target.files||[]));event.target.value='';}}/>
    {error&&<p className="inline-status" role="alert">{error}</p>}
  </form>;
}
