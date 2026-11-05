import {extractStructuredDocument} from './documentParsers';
import {vectorizeDocument} from './ragIndex';
import {setModelsDir,generateEmbeddings} from './rag/embedding';
import {setPdfExtractScript} from './pdf';
import {buildTextbookReferenceChunks} from './rag/textbookReferenceChunks.ts';
import { constants as osConstants, setPriority } from 'node:os';

// Native ONNX work may use CPU while the page is reading/rendering. Keep the
// owning utility process below the main/renderer priority, including its threads.
try { setPriority(0, osConstants.priority.PRIORITY_BELOW_NORMAL); }
catch (error) { console.warn('[rag-compute] 后台进程优先级未能降低:', error instanceof Error ? error.message : error); }

// Electron utility process in production; Node IPC adapter exercises the same
// worker entry in local tests without opening a window or touching a real vault.
const port=(process as NodeJS.Process&{parentPort?:{on(event:'message',listener:(event:{data:any})=>void):void;postMessage(value:unknown):void}}).parentPort;
const send=(value:unknown)=>port?port.postMessage(value):process.send?.(value);
let tail=Promise.resolve();
async function execute(message:any){
  const {id,operation,args,configuration}=message||{};
  try {
    if(!Number.isSafeInteger(id)||!configuration||typeof configuration.modelsDir!=='string'||typeof configuration.pdfExtractScript!=='string')throw new Error('后台计算消息无效');
    setModelsDir(configuration.modelsDir);setPdfExtractScript(configuration.pdfExtractScript);
    let value:unknown;
    if(operation==='parse')value=await extractStructuredDocument(args.filePath,args.fileType,args.docId);
    else if(operation==='vectorize')value=await vectorizeDocument(args.docId,args.fileName,args.text,args.structured,
      (completed,total)=>send({id,type:'progress',value:{completed,total}}));
    else if(operation==='embed')value=await generateEmbeddings(args.texts);
    else if(operation==='chunk-textbook')value=buildTextbookReferenceChunks(args.input);
    else throw new Error('不支持的后台计算任务');
    send({id,ok:true,value});
  }catch(error){send({id,ok:false,error:error instanceof Error?error.message:'后台计算失败'});}
}
const receive=(message:any)=>{tail=tail.then(()=>execute(message)).catch(()=>undefined);};
if(port)port.on('message',event=>receive(event.data));else process.on('message',receive);
