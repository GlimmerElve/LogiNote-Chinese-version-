import {useState} from 'react';
import {serviceClient} from './serviceClient';
export function ServiceAvatar({name,size=36,src}:{name:string;size?:number;src?:string|null}){
  const [failed,setFailed]=useState<string|null>(null);
  const url=src?.startsWith('data:image/webp;base64,')?src:src&&/^\/profiles\/[\da-f-]+\/avatar\/\d{1,18}$/i.test(src)&&serviceClient.configuration.kind==='configured'?serviceClient.configuration.baseUrl+src:undefined;
  return <span className="service-avatar" aria-hidden="true" style={{width:size,height:size,fontSize:Math.round(size*.38)}}>{url&&url!==failed?<img src={url} alt="" decoding="async" onError={()=>setFailed(url)}/>:Array.from(name.trim())[0]?.toLocaleUpperCase()||'同'}</span>;
}
