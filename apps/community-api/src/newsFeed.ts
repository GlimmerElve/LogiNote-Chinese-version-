import {XMLParser,XMLValidator} from 'fast-xml-parser';
import {createHash} from 'node:crypto';
import {ApiError} from './errors.js';

export const NEWS_FEED_LIMITS={minimumIntervalMinutes:60,maxItemsPerRun:10,maxRequestsPerDay:60,maxBytesPerDay:32*1024*1024,maxFeedBytes:2*1024*1024} as const;
export const NEWS_SOURCE_PRESETS=[
  {id:'ruanyifeng',name:'阮一峰科技爱好者周刊',url:'https://www.ruanyifeng.com/blog/atom.xml',description:'科技、编程与开源工具，每周精选。',hosts:['www.ruanyifeng.com'],topics:['科技'],recommended:true},
  {id:'sspai',name:'少数派',url:'https://sspai.com/feed',description:'学习方法、知识管理与效率工具。',hosts:['sspai.com'],topics:['学习方法'],recommended:true},
  {id:'solidot',name:'Solidot',url:'https://www.solidot.org/index.rss',description:'科学、技术、开源与人工智能资讯。',hosts:['www.solidot.org'],topics:['科技'],recommended:true},
  {id:'sciencenet-news',name:'科学网新闻',url:'https://www.sciencenet.cn/xml/news-0.aspx?news=0',description:'科研进展与科学新闻，日期按原站提供。',hosts:['www.sciencenet.cn'],topics:['科学'],recommended:true},
  {id:'sciencenet-math',name:'科学网数理科学论文',url:'https://www.sciencenet.cn/xml/paper.aspx?di=7',description:'数理科学论文与研究进展，包含物理。',hosts:['www.sciencenet.cn'],topics:['数学'],recommended:true},
  {id:'infoq',name:'InfoQ 中文',url:'https://www.infoq.cn/feed.xml',description:'软件开发、架构与人工智能工程。',hosts:['www.infoq.cn'],topics:['软件开发'],recommended:true},
  {id:'oschina',name:'开源中国',url:'https://www.oschina.net/news/rss',description:'备选：开源软件与编程资讯，快讯较多。',hosts:['www.oschina.net'],topics:['开源'],recommended:false},
  {id:'ithome',name:'IT之家',url:'https://www.ithome.com/rss/',description:'备选：科技与产品资讯，需人工筛选。',hosts:['www.ithome.com'],topics:['科技'],recommended:false},
] as const;
export type NewsSourcePreset=typeof NEWS_SOURCE_PRESETS[number];
export type ParsedFeedItem={title:string;summary:string;url:string;guidHash:string;urlHash:string;publishedAt:string|null;dateLabel:string|null};
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const values=(value:unknown):unknown[]=>value===undefined||value===null?[]:Array.isArray(value)?value:[value];
const valueText=(value:unknown):string=>typeof value==='string'||typeof value==='number'?String(value):value&&typeof value==='object'?valueText((value as Record<string,unknown>)['#text']):'';
const decodeEntities=(value:string)=>value.replace(/&(?:nbsp|#160);/gi,' ').replace(/&(?:amp|lt|gt|quot|apos);/gi,m=>({'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'"}[m.toLowerCase()]||' ')).replace(/&#(x[\da-f]+|\d+);/gi,(_,n:string)=>{const code=Number.parseInt(n.startsWith('x')?n.slice(1):n,n.startsWith('x')?16:10);return code>31&&code<=0x10ffff?String.fromCodePoint(code):' ';});

/** Plain text only. Feed HTML, external images and embedded active content are
 * never stored as article body or fetched. This is intentionally an excerpt. */
export function feedPlainText(value:unknown,max=280):string {
  // XML itself is byte-bounded, but a valid CDATA field can fill that entire
  // allowance with unclosed HTML tags. Bound the raw field before running any
  // stripping expression, so pathological publisher markup cannot stall Node.
  const raw=valueText(value).slice(0,4096);
  return decodeEntities(raw.replace(/<(script|style|iframe|object|svg)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,' ').replace(/<[^>]*>/g,' ')).replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim().slice(0,max);
}
export function canonicalFeedUrl(value:string,base?:string):string|null {
  try{const url=new URL(value,base);if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.href.length>2000)return null;url.hash='';for(const key of [...url.searchParams.keys()])if(/^(utm_|spm$)/i.test(key))url.searchParams.delete(key);url.searchParams.sort();return url.href;}catch{return null;}
}
export function feedUrlHash(value:string):string {const url=new URL(value);url.protocol='https:';return hash(url.href);}
export function parseNewsFeed(body:Buffer,base:string):{items:ParsedFeedItem[];ignored:number} {
  if(body.length>NEWS_FEED_LIMITS.maxFeedBytes)throw new ApiError(502,'feed_size','订阅响应超过 2 MB，已停止解析。');
  let xml:string;try{xml=new TextDecoder('utf-8',{fatal:true}).decode(body);}catch{throw new ApiError(502,'feed_encoding','订阅内容不是有效的 UTF-8 文本。');}
  // Entity expansion is never needed for RSS. Reject before XML validation so
  // neither validation nor the parser can process a DTD or external entity.
  if(/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml))throw new ApiError(502,'feed_xml','订阅包含不支持的 XML 声明。');
  if(XMLValidator.validate(xml)!==true)throw new ApiError(502,'feed_xml','订阅 XML 无法解析。');
  let parsed:Record<string,any>;try{parsed=new XMLParser({ignoreAttributes:false,attributeNamePrefix:'@_',processEntities:false,parseTagValue:false,trimValues:true,removeNSPrefix:true,maxNestedTags:50}).parse(xml) as Record<string,any>;}catch{throw new ApiError(502,'feed_xml','订阅 XML 无法解析。');}
  const raw=parsed.rss?.channel?.item??parsed.feed?.entry??parsed.RDF?.item;
  if(!parsed.rss&&!parsed.feed&&!parsed.RDF)throw new ApiError(502,'feed_format','响应不是 RSS 或 Atom 订阅。');
  const rawItems=values(raw),items:ParsedFeedItem[]=[];let ignored=Math.max(0,rawItems.length-200);
  // Both the document and item scan are bounded. Imported candidates use only
  // publisher summaries, never content:encoded or an Atom full-content field.
  for(const candidate of rawItems.slice(0,200)){
    if(!candidate||typeof candidate!=='object'){ignored++;continue;}const item=candidate as Record<string,any>;
    const title=feedPlainText(item.title,160),links=values(item.link),link=links.find(v=>v&&typeof v==='object'&&(!(v as any)['@_rel']||(v as any)['@_rel']==='alternate'));
    const rawLink=decodeEntities(link?valueText((link as any)['@_href']??link):valueText(item.link)).trim(),url=rawLink?canonicalFeedUrl(rawLink,base):null;if(!title||!url){ignored++;continue;}
    const dateLabel=feedPlainText(item.pubDate??item.published??item.updated??item.date,100)||null;
    // Publishers sometimes omit a timezone (notably ScienceNet). Preserve that
    // label instead of silently assigning the server's local timezone.
    const date=dateLabel&&/(?:Z|[+-]\d{2}:?\d{2}|GMT|UTC)$/i.test(dateLabel)?new Date(dateLabel):null;
    const publishedAt=date&&Number.isFinite(date.getTime())?date.toISOString():null;
    const guid=decodeEntities(valueText(item.guid??item.id)).trim().slice(0,4000)||url;
    items.push({title,url,summary:feedPlainText(item.description??item.summary,280),guidHash:hash(guid),urlHash:feedUrlHash(url),publishedAt,dateLabel});
  }
  return {items,ignored};
}
