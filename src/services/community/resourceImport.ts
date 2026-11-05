import type {NoteItem,PlanMeta} from '../../types';
import type {ResourceManifest,PackagePlanNode} from '../../../apps/community-api/src/resourceFormat';
export type CommunityProvenance={accountId:string;entryId:string;versionId:string;sourceId:string;sourceUrl?:string};
export function communityReviewEligible(note:NoteItem):boolean{return !note.communityImport||!!(note.dsrState?.lastReviewedAt||note.dsrState?.lastPracticedAt||(note.dsrState?.conceptMasterySamples||0)>0||note.learningReviewRecords?.length);}
export function prepareCommunityNotes(existing:NoteItem[],manifest:ResourceManifest,files:Record<string,Uint8Array>,source:Omit<CommunityProvenance,'sourceId'>,idFor:(sourceId:string)=>string,now=new Date().toISOString()){
  const map=new Map(manifest.notes.map(note=>[note.id,idFor(note.id)])),wrapperId=idFor('@container');
  const previous=existing.filter(note=>note.communityImport?.accountId===source.accountId&&note.communityImport.versionId===source.versionId&&!note.communityImport.sourceId.startsWith('active:'));
  if(previous.length){const expected=new Set([wrapperId,...map.values()]);if(previous.length!==expected.size||previous.some(note=>!expected.has(note.id)))throw Error('部分已导入内容被修改或移除，请在桌面处理后重试。');return {notes:existing,localIds:[...expected],replayed:true};}
  const usedTitles=new Set(existing.map(note=>note.title.trim().toLocaleLowerCase())),titles=new Map<string,string>();
  const unique=(title:string)=>{let next=title,index=1;while(usedTitles.has(next.toLocaleLowerCase()))next=`${title}（社区副本 ${index++}）`;usedTitles.add(next.toLocaleLowerCase());return next;};
  for(const note of manifest.notes){if(existing.some(item=>item.id===map.get(note.id)))throw Error('本地标识冲突，未覆盖已有内容。');titles.set(note.id,unique(note.title));}
  if(existing.some(note=>note.id===wrapperId))throw Error('本地标识冲突，未覆盖已有内容。');
  const wrapper:NoteItem={id:wrapperId,title:unique(manifest.title),content:`来自社区资源的独立副本。\n\n${manifest.notes.length} 篇笔记。${source.sourceUrl?`\n\n[查看社区来源](${source.sourceUrl})`:''}`,noteType:'project',projectRole:'reference',tags:['社区资源'],links:[],backlinks:[],dueDates:[],createdAt:now,updatedAt:now,communityImport:{...source,sourceId:'@container'}};
  const created=manifest.notes.map(note=>{
    let content=new TextDecoder('utf-8',{fatal:true}).decode(files[note.file]);
    content=content.replace(/\[\[([^\]#|]+)(?:\|([^\]]+))?\]\]/g,(_match,key:string,alias:string|undefined)=>titles.has(key)?`[[${titles.get(key)}|${alias||titles.get(key)}]]`:`（待关联：${alias||key}）`);
    content=content.replace(/!\[([^\]]*)\]\((?:\.\.\/)?(assets\/[^)]+)\)/g,(_match,alt:string,file:string)=>{const asset=manifest.assets.find(item=>item.file===file);if(!asset||!files[file])throw Error('资源图片缺失。');let binary='';for(const byte of files[file])binary+=String.fromCharCode(byte);return `![${alt}](data:${asset.mime};base64,${btoa(binary)})`;});
    return {id:map.get(note.id)!,title:titles.get(note.id)!,content,noteType:note.noteType,...(note.noteType==='project'?{projectRole:'reference' as const}:{}),parentId:note.parentId?map.get(note.parentId)!:wrapperId,tags:[...note.tags],links:note.links.map(key=>titles.get(key)!),backlinks:[],dueDates:[],createdAt:now,updatedAt:now,communityImport:{...source,sourceId:note.id}} satisfies NoteItem;
  });
  return {notes:[...existing,wrapper,...created],localIds:[wrapperId,...map.values()],replayed:false};
}
export function communityPlanLeafDependencies(plan:PackagePlanNode[],nodeId:string):string[]{
  const byId=new Map(plan.map(node=>[node.id,node])),leaves=plan.filter(node=>!plan.some(child=>child.parentId===node.id));
  const below=(node:PackagePlanNode,parentId:string)=>{let cursor:PackagePlanNode|undefined=node;while(cursor){if(cursor.id===parentId)return true;cursor=cursor.parentId?byId.get(cursor.parentId):undefined;}return false;};
  const dependencies=new Set<string>();let current=byId.get(nodeId);while(current){for(const dependency of current.dependencyIds)for(const leaf of leaves)if(below(leaf,dependency)){if(leaf.id===nodeId)throw Error('计划前置关系与层级冲突。');dependencies.add(leaf.id);}current=current.parentId?byId.get(current.parentId):undefined;}return [...dependencies];
}
export function scheduleCommunityPlan(plan:PackagePlanNode[],startDate:string,dailyMinutes:number,weekdays:number[]=[1,2,3,4,5,6,0]){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(startDate)||!Number.isInteger(dailyMinutes)||dailyMinutes<5||dailyMinutes>1440||!weekdays.length||weekdays.some(day=>!Number.isInteger(day)||day<0||day>6))throw Error('计划起始日或学习投入不正确。');
  const date=new Date(startDate+'T12:00:00Z');if(Number.isNaN(date.getTime())||date.toISOString().slice(0,10)!==startDate)throw Error('计划起始日不正确。');
  const byId=new Map(plan.map(item=>[item.id,item])),leaves=plan.filter(item=>!plan.some(child=>child.parentId===item.id)),ordered:PackagePlanNode[]=[],seen=new Set<string>(),visiting=new Set<string>();
  const visit=(item:PackagePlanNode)=>{if(visiting.has(item.id))throw Error('计划前置关系存在循环。');if(seen.has(item.id))return;visiting.add(item.id);for(const dependency of communityPlanLeafDependencies(plan,item.id))visit(byId.get(dependency)!);visiting.delete(item.id);seen.add(item.id);ordered.push(item);};for(const leaf of leaves)visit(leaf);
  const allocations=new Map<string,{startDate:string;dueDate:string}>();let remaining=dailyMinutes;const step=()=>{do{date.setUTCDate(date.getUTCDate()+1);}while(!weekdays.includes(date.getUTCDay()));remaining=dailyMinutes;};while(!weekdays.includes(date.getUTCDay()))step();
  for(const item of ordered){if(remaining===0)step();const first=date.toISOString().slice(0,10);let minutes=item.minutes;while(minutes>remaining){minutes-=remaining;step();}remaining-=minutes;allocations.set(item.id,{startDate:first,dueDate:date.toISOString().slice(0,10)});}
  for(let pass=0;pass<plan.length;pass++)for(const item of plan)if(!allocations.has(item.id)){const children=plan.filter(child=>child.parentId===item.id).map(child=>allocations.get(child.id));if(children.length&&children.every(Boolean))allocations.set(item.id,{startDate:children.map(child=>child!.startDate).sort()[0],dueDate:children.map(child=>child!.dueDate).sort().at(-1)!});}
  return {allocations,meta:{schemaVersion:2,status:'active',startDate,dailyStudyMinutes:dailyMinutes,activeWeekdays:weekdays,autoAdjustPolicy:'ask',targetDate:date.toISOString().slice(0,10)} satisfies PlanMeta};
}
