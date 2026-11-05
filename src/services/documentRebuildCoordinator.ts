import type {UploadedDocument} from '../types';
import { canProcessDocumentArgument } from './documentProcessingActions';

export interface DocumentRebuildDependencies {
  guard():Promise<void>;
  retry(docId:string):Promise<void>;
  resetGraph?(docId:string):Promise<void>;
  list():Promise<UploadedDocument[]>;
  subscribe(changed:()=>void):()=>void;
  process(doc:UploadedDocument):Promise<{done:number;total:number;requests:number;bridgePending:boolean;bridgeProgress?:boolean;bridgeReviewRequired?:boolean;warning:string;fileName:string}>;
}
/** A user-approved re-index action runs all NEW batches; any failed request stops the run. */
export async function rebuildDocumentAndArguments(docId:string,deps:DocumentRebuildDependencies,progress:(text:string)=>void,signal?:AbortSignal,
  options:{rebuildBody?:boolean;resetGraph?:boolean}={}){
  const check=async()=>{if(signal?.aborted)throw new DOMException('已停止重建，已校验批次可继续处理','AbortError');await deps.guard();};
  await check();
  if(options.rebuildBody!==false){await deps.retry(docId);progress('正在本地解析资料并重建正文索引…');}
  const doc=await new Promise<UploadedDocument>((resolve,reject)=>{
    let stopped=false,busy=false;
    const finish=(error?:unknown,value?:UploadedDocument)=>{if(stopped)return;stopped=true;unsubscribe();clearInterval(timer);clearTimeout(timeout);signal?.removeEventListener('abort',abort);if(error)reject(error);else resolve(value!);};
    const abort=()=>finish(new DOMException('已停止重建','AbortError'));
    const inspect=async()=>{if(stopped||busy)return;busy=true;try{
      const d=(await deps.list()).find(d=>d.id===docId);
      if(!d)finish(new Error('资料已被删除，已停止重建'));
      else if(options.rebuildBody===false && canProcessDocumentArgument(d))finish(undefined,d);
      else if(d.status==='failed')finish(new Error(d.error||'资料解析失败'));
      else if(d.status==='ready'&&!d.needsReindex)finish(undefined,d);
    }catch(error){finish(error);}finally{busy=false;}};
    const unsubscribe=deps.subscribe(()=>void inspect());
    const timer=setInterval(()=>void inspect(),2000);
    const timeout=setTimeout(()=>finish(new Error('本地索引处理尚未完成，请稍后继续')),30*60*1000);
    signal?.addEventListener('abort',abort,{once:true});
    if(signal?.aborted)abort();else void inspect();
  });
  await check();
  if(options.resetGraph!==false&&deps.resetGraph)await deps.resetGraph(docId);
  let requests=0,batches=0;
  for(;;){
    await check();
    const result=await deps.process(doc);requests+=result.requests;batches++;
    if(result.warning)progress(result.warning);
    if(!result.fileName||result.done>=result.total&&(!result.bridgePending||result.bridgeReviewRequired===true
      ||result.bridgeReviewRequired===undefined&&!!result.warning)){
      progress(`论证图处理完成：${batches}批、${requests}次请求；新图已发布${result.warning?'，保留待核对告警':''}。`);return {batches,requests};}
    if(result.done>=result.total&&result.bridgePending&&result.bridgeProgress!==true)
      {progress('论证图已发布；补链未取得进展，已记录待核对问题，不再自动请求。');return {batches,requests};}
    progress(result.done>=result.total?'新图已发布，继续核对下一组补链候选…':`已保存${result.done}/${result.total}段，自动处理下一批…`);
  }
}
