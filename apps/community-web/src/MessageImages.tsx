import { useApp } from './context';

export function MessageImages({ids=[]}:{ids?:string[]}){
  const {state,open}=useApp();const images=ids.map(id=>state.messageImages.find(image=>image.id===id)).filter(image=>!!image);
  if(!images.length)return null;
  return <div className="message-images">{images.map(image=><button type="button" key={image.id} aria-label={`查看图片${image.name}`} onClick={()=>open({kind:'messageImage',id:image.id})}><img src={image.data} alt={image.name} loading="lazy"/></button>)}</div>;
}
export function MessageImagePreview({id}:{id:string}){
  const {state}=useApp();const image=state.messageImages.find(item=>item.id===id);
  return image?<div className="message-image-preview"><img src={image.data} alt={image.name}/></div>:<p>图片暂不可用。</p>;
}
