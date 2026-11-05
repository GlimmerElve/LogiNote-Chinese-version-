import {useEffect,useMemo,useRef} from 'react';
import {MDXEditor,headingsPlugin,listsPlugin,quotePlugin,linkPlugin,linkDialogPlugin,imagePlugin,insertImage$,activeEditor$,tablePlugin,thematicBreakPlugin,markdownShortcutPlugin,toolbarPlugin,realmPlugin,UndoRedo,BoldItalicUnderlineToggles,BlockTypeSelect,ListsToggle,CreateLink,InsertTable,InsertThematicBreak,type MDXEditorMethods} from '@mdxeditor/editor';
import {$getSelection,$isNodeSelection,$getRoot} from 'lexical';
import {ImagePlus} from 'lucide-react';
import {communityResources} from './serviceResourceClient';
import {linkDestination,useLinkSafety} from './LinkSafety';
import {useApp} from './context';
import '@mdxeditor/editor/style.css';
type Props={body:string;accountId:string;disabled:boolean;onChange:(body:string)=>void;onImage:(file:File)=>Promise<{src:string;name:string}>;onError:(message:string)=>void};
type InlineImage={src:string;name:string};
const blank='data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';
const clipboardImages=(data:DataTransfer|null|undefined)=>{
  const files=Array.from(data?.files||[]).filter(file=>file.type.startsWith('image/'));
  return files.length?files:Array.from(data?.items||[]).filter(item=>item.kind==='file'&&item.type.startsWith('image/')).map(item=>item.getAsFile()).filter((file):file is File=>file!==null);
};
// Use the editor's public image insertion signal, so an uploaded picture stays an
// image node and shares the normal Markdown export and undo history.
const localImagesPlugin=realmPlugin<{ready:(insert:(image:InlineImage)=>void)=>void}>({init(realm,params){
  params!.ready(image=>{
    const editor=realm.getValue(activeEditor$);
    if(!editor)throw Error('编辑器尚未准备好，请稍后重新插入图片。');
    editor.update(()=>{
      const selection=$getSelection();
      // Clicking an illustration selects its decorator node. Pasting another
      // picture uses it as an insertion anchor, rather than deleting that image.
      if($isNodeSelection(selection))selection.getNodes().at(-1)?.selectNext();
      else if(!selection)$getRoot().selectEnd();
      realm.pub(insertImage$,{src:image.src,altText:image.name});
    });
  });
}});
const labels:Record<string,string>={'editable markdown':'投稿正文','Undo':'撤销','Redo':'重做','Bold':'粗体','Remove bold':'取消粗体','Italic':'斜体','Remove italic':'取消斜体','Paragraph':'正文','Heading {{level}}':'{{level}} 级标题','Quote':'引用','Bulleted list':'无序列表','Numbered list':'有序列表','Insert link':'插入链接','Create link':'插入链接','Insert table':'插入表格','Insert Table':'插入表格','Select block type':'段落样式','Block type':'段落样式','Insert thematic break':'分隔线','Anchor text':'链接文字','Select or paste an URL':'粘贴完整链接','Set URL':'保存链接','Cancel change':'取消修改','Save':'保存','Cancel':'取消','Edit link URL':'编辑链接','Remove link':'移除链接','Open {{url}} in new window':'访问 {{url}}'};
export default function NewsRichEditor(props:Props){
  const {state}=useApp();
  const editor=useRef<MDXEditorMethods>(null),shell=useRef<HTMLDivElement>(null),input=useRef<HTMLInputElement>(null),insertImage=useRef<((image:InlineImage)=>void)|null>(null),latest=useRef(props),initial=useRef(props.body),urls=useRef(new Map<string,Promise<string>>()),made=useRef<string[]>([]),alive=useRef(true),openLink=useLinkSafety(),opener=useRef(openLink);
  latest.current=props;opener.current=openLink;
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;made.current.forEach(url=>URL.revokeObjectURL(url));};},[]);
  const insert=async(files:File[])=>{if(latest.current.disabled)return;try{for(const file of files){const image=await latest.current.onImage(file);if(!alive.current)return;if(!insertImage.current)throw Error('编辑器尚未准备好，请稍后重新插入图片。');insertImage.current(image);}editor.current?.focus();}catch(error){latest.current.onError(error instanceof Error?error.message:'图片未能插入，请重试。');}};
  useEffect(()=>{
    const root=shell.current;if(!root)return;
    // Capture on the stable editor container before Lexical handles the event.
    // Tables have nested editors; subscribing only to the current active editor
    // leaves root-targeted paste unhandled while that subscription is switching.
    const handle=(event:ClipboardEvent|DragEvent)=>{
      const target=event.target instanceof Element?event.target:null;
      if(!target?.closest('[contenteditable="true"]'))return;
      const files=clipboardImages('clipboardData' in event?event.clipboardData:event.dataTransfer);
      if(!files.length)return;
      event.preventDefault();event.stopImmediatePropagation();void insert(files);
    };
    root.addEventListener('paste',handle,true);root.addEventListener('drop',handle,true);
    return()=>{root.removeEventListener('paste',handle,true);root.removeEventListener('drop',handle,true);};
  },[]);
  const plugins=useMemo(()=>[
    headingsPlugin({allowedHeadingLevels:[1,2,3]}),listsPlugin(),quotePlugin(),linkPlugin({validateUrl:url=>!!linkDestination(url)}),linkDialogPlugin({onClickLinkCallback:url=>opener.current?.(url)}),tablePlugin(),thematicBreakPlugin(),
    localImagesPlugin({ready:value=>{insertImage.current=value;}}),imagePlugin({disableImageResize:true,disableImageSettingsButton:true,imagePreviewHandler:async source=>{
      if(!/^attachment:[\da-f-]{36}$/i.test(source))return blank;
      let pending=urls.current.get(source);if(!pending){pending=communityResources.download(latest.current.accountId,{id:source.slice(11),name:'插图',mime:'image/webp',bytes:0,role:'image'}).then(blob=>{if(!alive.current)return blank;const url=URL.createObjectURL(new Blob([blob],{type:blob.type==='application/octet-stream'?'image/webp':blob.type}));made.current.push(url);return url;}).catch(()=>blank);urls.current.set(source,pending);}return pending;
    }}),markdownShortcutPlugin(),toolbarPlugin({toolbarContents:()=><><UndoRedo/><BlockTypeSelect/><BoldItalicUnderlineToggles options={['Bold','Italic']}/><ListsToggle/><CreateLink/><InsertTable/><button type="button" title="插入图片" aria-label="插入图片" onMouseDown={event=>event.preventDefault()} onClick={()=>input.current?.click()}><ImagePlus size={18}/></button><InsertThematicBreak/></>}),
  ],[]);
  return <div ref={shell} className="news-rich-editor" onDragOver={event=>{if(event.dataTransfer.types.includes('Files'))event.preventDefault();}}>
    <MDXEditor ref={editor} markdown={initial.current} plugins={plugins} readOnly={props.disabled} className={state.theme==='dark'?'dark-theme':''} contentEditableClassName="news-rich-body resource-markdown" placeholder="写下你想分享的内容，也可以粘贴原文链接……" suppressHtmlProcessing onChange={(body,initialNormalize)=>{if(!initialNormalize)latest.current.onChange(body);}} onError={()=>latest.current.onError('这段内容的格式无法编辑，请检查粘贴的内容。')} translation={(_key,value,variables)=>{let result=labels[value]||value;for(const [key,v] of Object.entries(variables||{}))result=result.replaceAll('{{'+key+'}}',String(v));return result;}}/>
    <input ref={input} type="file" hidden multiple accept="image/png,image/jpeg,image/webp" aria-label="选择资讯插图" disabled={props.disabled} onChange={event=>{void insert(Array.from(event.target.files||[]));event.target.value='';}}/>
  </div>;
}
