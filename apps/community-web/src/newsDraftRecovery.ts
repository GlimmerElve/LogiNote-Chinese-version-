import type {NewsInput,NewsKind} from './serviceNewsClient';
import type {InlineImageFile} from './ContentImages';

export type NewsFields=Pick<NewsInput,'title'|'body'|'topics'|'sourceUrl'>;
export type PendingNewsSave={id?:string;input:NewsInput;signature:string;key:string};
export type NewsRecovery={accountId:string;id?:string;kind:NewsKind;fields:NewsFields;version?:number;stageId?:string;images:InlineImageFile[];uninsertedImages:InlineImageFile[];pending:PendingNewsSave|null;updatedAt:number};
const prefix='loginote:news-draft-recovery:';
const key=(accountId:string,id:string|undefined,kind:NewsKind)=>prefix+accountId+':'+(id||'new:'+kind);
const flushing=new Map<string,Promise<unknown>>();
export function trackNewsDraftFlush(accountId:string,id:string|undefined,kind:NewsKind,work:Promise<unknown>){const name=key(accountId,id,kind);flushing.set(name,work);const done=()=>{if(flushing.get(name)===work)flushing.delete(name);};void work.then(done,done);}
export async function waitNewsDraftFlush(accountId:string,id:string|undefined,kind:NewsKind){await flushing.get(key(accountId,id,kind))?.catch(()=>{});}
export function readNewsRecovery(accountId:string,id:string|undefined,kind:NewsKind):NewsRecovery|null{
  try{
    const value=JSON.parse(sessionStorage.getItem(key(accountId,id,kind))||'null') as NewsRecovery|null;
    if(!value||value.accountId!==accountId||value.id!==id||!['news','article','announcement'].includes(value.kind)||!id&&value.kind!==kind||!value.fields||typeof value.fields.title!=='string'||typeof value.fields.body!=='string'||typeof value.fields.sourceUrl!=='string'||!Array.isArray(value.fields.topics)||!value.fields.topics.every(topic=>typeof topic==='string')||!Array.isArray(value.images)||!Array.isArray(value.uninsertedImages)||!Number.isFinite(value.updatedAt)||Date.now()-value.updatedAt>7*24*3600000)return null;
    return value;
  }catch{return null;}
}
export function writeNewsRecovery(value:NewsRecovery){try{sessionStorage.setItem(key(value.accountId,value.id,value.kind),JSON.stringify(value));}catch{/* Saving to the service remains available when browser storage is disabled. */}}
export function clearNewsRecovery(accountId:string,id:string|undefined,kind:NewsKind){try{sessionStorage.removeItem(key(accountId,id,kind));}catch{/* Storage may be disabled by the browser. */}}
