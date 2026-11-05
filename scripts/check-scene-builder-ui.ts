import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { collectKnowledgePoints } from '../src/services/scene/sceneKnowledgePoints';
import { listSceneCapabilities, UNIFIED_SCENE_RECIPE_DEFINITIONS } from '../src/services/scene/sceneCapabilityRegistry';

// Execute the actual UI handlers and storage boundaries with synthetic memory only.
globalThis.fetch = async () => assert.fail('Scene builder checks cannot contact a model or network');
function compile(path: string, environment: Record<string, unknown>, names: string[]) {
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  const code = source.statements.filter(node => !ts.isImportDeclaration(node) && !ts.isExportDeclaration(node))
    .map(node => node.getText(source)).join('\n').replace(/^export\s+/gm, '');
  const js = ts.transpileModule(`${code}\nreturn { ${names.join(', ')} };`, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None, jsx: ts.JsxEmit.React,
  } }).outputText;
  return new Function(...Object.keys(environment), js)(...Object.values(environment));
}
type Tree = { type: unknown; props: Record<string, any> };
const React = { createElement: (type: unknown, props: any, ...children: any[]): Tree => ({type, props: {...props, children}}), Fragment: 'fragment' };
const all = (value: any): Tree[] => !value || typeof value !== 'object' ? [] : Array.isArray(value) ? value.flatMap(all) : [value, ...all(value.props?.children)];
const text = (node: any): string => typeof node === 'string' || typeof node === 'number' ? String(node)
  : Array.isArray(node) ? node.map(text).join('') : node?.props ? text(node.props.children) : '';
const scene = (skill: string) => ({sceneId:`scene-${skill}`, sceneSkill:skill,name:`合成${skill}`,subject:'合成训练',knowledgePoints:[],reuseCount:0,createdAt:'2026-10-07'});
const deferred = () => { let resolve!: (value: any) => void, reject!: (error: Error) => void;
  const promise = new Promise<any>((yes,no) => {resolve=yes;reject=no;}); return {promise,resolve,reject}; };

function harness() {
  const slots: any[] = []; let cursor = 0; let effects: (() => void)[] = [];
  let live=true, writesAfterUnmount=0;
  const cleanups: (() => void)[] = []; const dialogs: any[] = []; const reads: any[] = [], deletes: any[] = [], enters: any[] = [];
  const hooks = {
    useState(initial: any) {const index=cursor++; if (!(index in slots)) slots[index]={value:typeof initial==='function'?initial():initial};
      return [slots[index].value,(value:any)=>{if(!live)writesAfterUnmount++;slots[index].value=typeof value==='function'?value(slots[index].value):value;}];},
    useRef(initial: any) {const index=cursor++; return slots[index] ||= {current:initial};},
    useEffect(effect: () => void, deps: any[]) {const index=cursor++; if (!slots[index] || deps.some((dep,i)=>dep!==slots[index][i])) {slots[index]=deps;effects.push(effect);}},
    useMemo(callback:()=>any, deps:any[]) {const index=cursor++;if(!slots[index]||deps.some((dep,i)=>dep!==slots[index].deps[i]))slots[index]={deps,value:callback()};return slots[index].value;},
    useCallback(callback:any,deps:any[]) {const index=cursor++;if(!slots[index]||deps.some((dep,i)=>dep!==slots[index].deps[i]))slots[index]={deps,value:callback};return slots[index].value;},
    useId:()=> 'scene-fields',
  };
  const icons=Object.fromEntries(['Layers','Sparkles','Wand2','PenLine','Trash2','RefreshCw','ArrowRight','ArrowLeft','ChevronRight','Check','FolderTree','SlidersHorizontal','ClipboardCheck'].map(name=>[name,name]));
  const module=compile('src/components/scene/SceneBuilderPanel.tsx', {React,...hooks,...icons,
    useLayoutEffect: hooks.useEffect,
    H5pLibraryPanel: 'h5p-library',
    SCENE_SKILL_S1:'S1',SCENE_SKILL_S4:'S4',collectKnowledgePoints,listSceneCapabilities,UNIFIED_SCENE_RECIPE_DEFINITIONS,
    ProjectTreePanel:'tree',buildProjectTreeStructure:(notes:any[])=>notes.filter(note=>!note.parentId).map(note=>({note,children:[]})),
    useDialog:(open:boolean,_ref:any,close:any)=>dialogs.push({open,close}),
    listScenes:(options:any)=>{assert.equal(options.strict,true);const job=deferred();reads.push(job);return job.promise;},
    deleteScene:(id:string,options:any)=>{assert.equal(options.strict,true);const job=deferred();deletes.push({...job,id});return job.promise;},
  }, ['SceneBuilderPanel']);
  let props:any={allNotes:[{id:'root',title:'合成项目',noteType:'project',content:'',tags:[],links:[],backlinks:[]}],onEnterScene:(request:any)=>enters.push(request)};
  let nodes:Tree[]=[];
  const render=()=>{cursor=0;dialogs.length=0;nodes=all(module.SceneBuilderPanel(props));for (const effect of effects.splice(0)) {const cleanup:any=effect(); if(typeof cleanup==='function')cleanups.push(cleanup);}return nodes;};
  const button=(label:string)=>{const found=nodes.find(node=>node.type==='button' && (node.props['aria-label']===label || text(node)===label || text(node).startsWith(label)));assert.ok(found,`button ${label}`);return found;};
  const click=(label:string)=>{const node=button(label);assert.equal(Boolean(node.props.disabled),false,`${label} enabled`);node.props.onClick();render();};
  const pick=()=>{nodes.find(node=>node.type==='tree')!.props.onSelect('root');render();};
  render();render();
  return {render,button,click,pick,reads,deletes,enters,dialogs,get nodes(){return nodes;},get writesAfterUnmount(){return writesAfterUnmount;},setNotes(notes:any[]){props={...props,allNotes:notes};render();},unmount(){live=false;cleanups.forEach(fn=>fn());}};
}
const flush=async()=>{await Promise.resolve();await Promise.resolve();};
const modes=harness();modes.click('H5P 互动场景');
assert.ok(modes.nodes.some(node=>node.type==='h5p-library'));
assert.equal(modes.enters.length,0,'H5P library does not enter the AI scene runtime');
modes.click('原生场景搭建');assert.ok(!modes.nodes.some(node=>node.type==='h5p-library'));modes.unmount();
const h=harness();h.pick();h.click('下一步');h.click('复用已有场景');
assert.equal(h.reads.length,1);assert.equal(h.button('下一步').props.disabled,true,'cannot proceed while library is loading');
h.reads[0].reject(new Error('合成读取失败'));await flush();h.render();
assert.ok(h.nodes.some(node=>node.props.role==='alert' && text(node).includes('合成读取失败')));
assert.ok(!h.nodes.some(node=>text(node).includes('场景库还是空的')),'failure is never presented as an empty library');
h.click('重试读取场景库');h.reads[1].resolve([scene('S1'),scene('S4')]);await flush();h.render();
h.click('合成S1');h.click('数理场景');
assert.ok(h.nodes.filter(node=>node.type==='button').every(node=>!all(node.props.children).some(child=>child.type==='button')),'selection and deletion cannot be nested controls');
assert.equal(h.button('下一步').props.disabled,true,'switching skill invalidates the old S1 choice');
h.click('合成S4');h.click('下一步');
assert.ok(h.nodes.some(node=>node.props['aria-current']==='step' && text(node).includes('确认进入')));
assert.equal(h.button('补充条件').props.disabled,true,'skipped step cannot be opened');
const enter=h.button('进入场景');enter.props.onClick();enter.props.onClick();
assert.equal(h.enters.length,1,'same confirmation cannot launch twice');
assert.equal(h.enters[0].sceneSkill,'S4');assert.equal(h.enters[0].sceneId,'scene-S4');
h.unmount();

const deletion=harness();deletion.pick();deletion.click('下一步');deletion.click('复用已有场景');
deletion.reads[0].resolve([scene('S1')]);await flush();deletion.render();
deletion.click('合成S1');deletion.click('删除场景 合成S1');
assert.equal(deletion.deletes.length,0,'opening confirmation never deletes');
assert.ok(deletion.nodes.some(node=>node.props.role==='alertdialog'));
assert.equal(deletion.button('H5P 互动场景').props.disabled,true,'mode switching cannot hide an active deletion dialog');
deletion.dialogs.at(-1).close();deletion.render();assert.equal(deletion.deletes.length,0,'Escape cancellation never deletes');
deletion.click('删除场景 合成S1');const confirm=deletion.button('确认删除');const firstDelete=confirm.props.onClick();confirm.props.onClick();
assert.equal(deletion.deletes.length,1,'synchronous mutation lock blocks duplicate clicks');deletion.render();
assert.equal(deletion.dialogs.at(-1).close,undefined,'waiting dialog cannot be dismissed');
deletion.deletes[0].reject(new Error('合成删除失败'));await flush();await firstDelete;deletion.render();
assert.ok(deletion.nodes.some(node=>node.props.role==='alert' && text(node).includes('合成删除失败')));
deletion.click('重试删除');deletion.deletes[1].resolve(undefined);await flush();deletion.render();
assert.ok(!deletion.nodes.some(node=>node.props.role==='alertdialog'));assert.equal(deletion.button('下一步').props.disabled,true,'deleted selection cannot be reused');
deletion.unmount();

const stale=harness();stale.pick();stale.click('下一步');stale.click('下一步');stale.click('下一步');
stale.setNotes([]);assert.equal(stale.button('进入场景').props.disabled,true,'removed project is not a valid binding');
stale.unmount();
const race=harness();race.pick();race.click('下一步');race.click('复用已有场景');race.unmount();
race.reads[0].resolve([scene('S1')]);await flush();assert.equal(race.enters.length,0,'late responses cannot launch a scene');assert.equal(race.writesAfterUnmount,0,'late library responses never update an unmounted picker');

const custom=harness();custom.setNotes([]);
custom.nodes.find(node=>node.type==='input' && node.props.id==='scene-fields-title')!.props.onChange({target:{value:'合成自定义练习'}});custom.render();
custom.click('下一步');custom.click('自定义场景');custom.click('下一步');custom.click('进入场景');
assert.equal(custom.enters[0].source,'custom');assert.equal(custom.enters[0].subject,'合成自定义练习');assert.equal(custom.enters[0].taskBinding,undefined);custom.unmount();
const build=harness();build.pick();build.click('下一步');build.click('下一步');
assert.ok(build.nodes.some(node=>node.props['aria-current']==='step' && text(node).includes('补充条件')));
assert.ok(build.nodes.filter(node=>node.type==='input').every(node=>node.props.id),'conditions have explicit label targets');
build.click('下一步');build.click('进入场景');assert.equal(build.enters[0].source,'build');assert.equal(build.enters[0].taskBinding.noteId,'root');build.unmount();

// Real IPC handler: missing index is empty; malformed JSON and permissions propagate.
const electronSource=ts.createSourceFile('main.ts',readFileSync('src/electron/main.ts','utf8'),ts.ScriptTarget.ES2022,true);
let readHandler:ts.Node|undefined;
const find=(node:ts.Node)=>{if(ts.isCallExpression(node) && node.expression.getText(electronSource)==='ipcMain.handle'
  && node.arguments[0]?.getText(electronSource)==="'scene-skills:load-manifest'")readHandler=node.arguments[1];ts.forEachChild(node,find);};find(electronSource);
assert.ok(readHandler);
const handlerJs=ts.transpileModule(`return (${readHandler!.getText(electronSource)});`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
let raw='{"scenes":[]}';let failure:any;
const handler=new Function('fs','path','ensureSceneSkillsDir',handlerJs)({readFile:async()=>{if(failure)throw failure;return raw;}},{join:()=> 'synthetic'},async()=> 'synthetic');
assert.equal((await handler()).scenes.length,0);failure=Object.assign(new Error('missing'),{code:'ENOENT'});assert.equal((await handler()).scenes.length,0);
failure=Object.assign(new Error('denied'),{code:'EACCES'});await assert.rejects(handler(),/denied/);failure=null;raw='{bad';await assert.rejects(handler());

let api:any;let storageWrites=0;
const store=compile('src/services/scene/sceneSkillStore.ts',{window:{get electronAPI(){return api ? {sceneSkills:api}:undefined;}},SCENE_SKILLS_DIR_NAME:'synthetic'},['loadManifest','listScenes','deleteScene','upsertManifestEntry','saveScene','bumpReuseCount']);
await assert.rejects(store.listScenes({strict:true}),/桌面/);assert.equal((await store.listScenes()).length,0);
api={loadManifest:async()=>{throw new Error('storage-read');},deleteScene:async()=>{storageWrites++;},saveManifest:async()=>{storageWrites++;},saveScene:async()=>{storageWrites++;}};
await assert.rejects(store.deleteScene('synthetic',{strict:true}),/storage-read/);assert.equal(storageWrites,0,'failed index read precedes any deletion');
await assert.rejects(store.upsertManifestEntry({sceneId:'synthetic-new'}),/storage-read/);
await assert.rejects(store.saveScene({sceneId:'synthetic-new'}),/storage-read/);
await assert.rejects(store.bumpReuseCount('scene-S1'),/storage-read/);
assert.equal(storageWrites,0,'all scene write paths stop before any write when the existing index is unreadable');
api.loadManifest=async()=>({scenes:[scene('S1')]});await store.deleteScene('scene-S1',{strict:true});assert.equal(storageWrites,2);
console.log('Scene builder UI checks passed: strict library read, retry, skill isolation, explicit deletion, duplicate lock, keyboard buttons, stale project, late replies, IPC error distinction and no index overwrite on failed read.');
