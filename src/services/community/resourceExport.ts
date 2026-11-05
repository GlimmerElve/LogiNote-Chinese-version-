import {strToU8} from 'fflate';
import type {NoteItem} from '../../types';
import {createResourcePackage,type ResourceManifest,type PackageNote,type PackagePlanNode} from '../../../apps/community-api/src/resourceFormat';
import type { SharedProgressiveTeaching } from '../progressiveLearning/types';
import { sharedTeachingMarkdown, sharedTeachingBody } from '../progressiveLearning/share';
import { readTextbookBody } from '../textbook/noteContent';
import { preparationRoot } from '../progressiveLearning/preparation';

/** A community-specific whitelist; the wider vault persistence whitelist is not an export policy. */
export function exportCommunityNotes(all:NoteItem[],selectedIds:string[],options:{kind:'notes'|'plan';title?:string;license?:string;includeDescendants?:boolean;progressiveTeaching?:ReadonlyMap<string,SharedProgressiveTeaching>}){
  if(!selectedIds.length||new Set(selectedIds).size!==selectedIds.length)throw Error('请选择要分享的笔记。');
  const chosen=new Set(selectedIds);if(selectedIds.some(id=>!all.some(note=>note.id===id)))throw Error('所选笔记已不存在，请重新选择。');
  if(options.includeDescendants){let changed=true;while(changed){changed=false;for(const note of all)if(note.parentId&&chosen.has(note.parentId)&&!chosen.has(note.id)){chosen.add(note.id);changed=true;}}}
  const selected=all.filter(note=>chosen.has(note.id));if(selected.length>100)throw Error('每个资源包最多包含 100 篇笔记。');
  const ids=new Map(selected.map((note,index)=>[note.id,`note_${index+1}`])),byTitle=new Map<string,NoteItem>();
  for(const note of all){const key=note.title.toLocaleLowerCase();if(!byTitle.has(key))byTitle.set(key,note);}
  for(const note of all)for(const alias of note.aliases||[]){const key=alias.toLocaleLowerCase();if(!byTitle.has(key))byTitle.set(key,note);}
  const files:Record<string,Uint8Array>={},assets:ResourceManifest['assets']=[],notes:PackageNote[]=[];
  for(const note of selected){
    const links=new Set<string>(),external=new Set<string>();
    const teaching=options.progressiveTeaching?.get(note.id),textbook=note.textbook?readTextbookBody(note.content,note.textbook):undefined;
    const teachingOnly=Boolean(preparationRoot(note,all));
    if(teachingOnly&&!teaching&&!note.textbook&&options.kind==='notes')throw Error('项目尚无已生成教材，请从叶子项目生成后分享。');
    if(note.textbook&&textbook===null)throw Error('教材边界异常，未分享私人笔记。');
    let body=(teaching?sharedTeachingMarkdown(teaching):textbook!==undefined?sharedTeachingBody(textbook!):teachingOnly?`# ${note.title}`:note.content).replace(/@due\(\d{4}-\d{2}-\d{2}\)/g,'').replace(/<!--\s*plan-task:[\s\S]*?-->/g,'').replace(/^([\s>*-]*)\[[xX]\]/gm,'$1[ ]');
    if(/(?:sk-[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/.test(body))throw Error('所选正文含疑似密钥，请检查后再分享。');
    body=body.replace(/!\[([^\]]*)\]\((data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+))\)/g,(_match,alt:string,_url:string,extension:string,base64:string)=>{const bytes=Uint8Array.from(atob(base64),char=>char.charCodeAt(0));const file=`assets/image_${assets.length+1}.${extension==='jpeg'?'jpg':extension}`;assets.push({file,mime:`image/${extension}` as ResourceManifest['assets'][number]['mime'],bytes:bytes.length});files[file]=bytes;return `![${alt}](${file})`;});
    body=body.replace(/!\[([^\]]*)\]\((https?:\/\/[^)]+)\)/g,(_match,alt:string)=>`[外部图片待关联：${alt}]`);
    body=body.replace(/\[\[([^\]#|]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g,(_match,target:string,alias:string|undefined)=>{const reference=selected.find(item=>item.id===target.trim())||byTitle.get(target.trim().toLocaleLowerCase());if(reference&&ids.has(reference.id)){links.add(ids.get(reference.id)!);return `[[${ids.get(reference.id)}|${alias||reference.title}]]`;}external.add(target.trim());return `（待关联：${alias||target.trim()}）`;});
    const key=ids.get(note.id)!,file=`notes/${key}.md`;files[file]=strToU8(body);
    notes.push({id:key,title:note.title,noteType:note.noteType,file,...(note.parentId&&ids.has(note.parentId)?{parentId:ids.get(note.parentId)!}:{}),links:[...links],externalLinks:[...external],tags:(note.tags||[]).slice(0,12)});
  }
  const plan:PackagePlanNode[]=[];
  if(options.kind==='plan'){
    const projects=selected.filter(note=>note.noteType==='project');if(!projects.length)throw Error('请选择计划项目。');
    const taskKeys=new Map<string,string>();for(const project of projects)for(const task of project.dueDates||[])taskKeys.set(task.id,task.taskText===project.title?ids.get(project.id)!:`task_${taskKeys.size+1}`);
    for(const project of projects){const key=ids.get(project.id)!;plan.push({id:key,title:project.title,...(project.parentId&&ids.has(project.parentId)?{parentId:ids.get(project.parentId)!}:{}),minutes:project.planMeta?.dailyStudyMinutes||30,dependencyIds:[]});
      for(const task of project.dueDates||[]){const dependencies=(task.dependencyTaskIds||[]).map(dependency=>{const target=taskKeys.get(dependency);if(!target)throw Error('计划包含未选择的前置任务，请把依赖项目一并选入。');return target;});if(task.taskText===project.title){const node=plan.find(node=>node.id===key)!;node.minutes=Math.max(5,Math.min(10080,Math.round(task.estimatedMinutes||30)));node.dependencyIds=dependencies;continue;}plan.push({id:taskKeys.get(task.id)!,title:task.taskText,parentId:key,minutes:Math.max(5,Math.min(10080,Math.round(task.estimatedMinutes||30))),dependencyIds:dependencies});}
    }
  }
  const manifest:ResourceManifest={format:'loginote-resource',version:1,kind:options.kind,title:options.title?.trim()||selected[0].title,contentVersion:'1',license:options.license?.trim()||'作者保留权利；仅供个人学习',notes,assets,plan};
  const bytes=createResourcePackage(manifest,files);return {bytes,manifest,selectedIds:selected.map(note=>note.id),name:`${manifest.title.replace(/[<>:"/\\|?*\x00-\x1f]/g,'_')}.lnresource`};
}
