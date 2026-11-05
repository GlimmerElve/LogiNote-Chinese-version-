import { lazy, Suspense } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import {SafeLink,linkDestination} from './LinkSafety';
import { useApp } from './context';

const ResourceMath=lazy(()=>import('./ResourceMath'));
/** Explicit local images only: remote images and raw HTML never execute on preview. */
export function ResourceBody({body,imageIds=[],resolvedImages={}}:{body:string;imageIds?:string[];resolvedImages?:Record<string,string>}) {
  const context=useApp();
  const images=context?.state.resourceImages.filter(image=>imageIds.includes(image.id))||[];
  return <div className="resource-markdown"><ReactMarkdown skipHtml remarkPlugins={[remarkGfm,remarkMath]} urlTransform={(url,key)=>{
    if(key==='src')return resolvedImages[url]?url:url.startsWith('attachment:')&&images.some(image=>image.id===url.slice(11))?url:'';
    return /^(https?:|mailto:|#\/|\/)/i.test(url)&&linkDestination(url)?url:'';
  }} components={{
    h1:({children})=><h2>{children}</h2>,
    h2:({children})=><h3>{children}</h3>,
    h3:({children})=><h4>{children}</h4>,
    img:({src,alt})=>{const resolved=src?resolvedImages[src]:undefined;if(resolved)return <img src={resolved} alt={alt||'资源图片'} loading="lazy"/>;const image=images.find(image=>`attachment:${image.id}`===src);return image?<img src={image.data} alt={alt||image.name} loading="lazy"/>:<span className="resource-image-unavailable">{alt||'图片'}（图片未附带，请作者添加正文图片）</span>;},
    a:({href,children})=>href?<SafeLink href={href}>{children}</SafeLink>:<span>{children}</span>,
    code:({className,children})=>className?.includes('language-math')?<Suspense fallback={<code>{children}</code>}><ResourceMath value={String(children).trim()} display={className.includes('math-display')}/></Suspense>:<code className={className}>{children}</code>,
    input:({checked})=><input type="checkbox" checked={checked||false} disabled readOnly/>,
  }}>{body}</ReactMarkdown></div>;
}
