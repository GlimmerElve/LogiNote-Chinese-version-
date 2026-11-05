import {stopOwnedProcess,type OwnedProcess} from './ownedProcessShutdown';
export interface ComputeTransport {
  postMessage(message:unknown):void;
  on(event:string,listener:(...args:any[])=>void):unknown;
  kill():unknown;
  pid?:number;
  removeListener?(event:string,listener:(...args:any[])=>void):unknown;
}
type Task={id:number;operation:string;args:unknown;resolve:(value:any)=>void;reject:(reason:Error)=>void;progress?:(value:any)=>void};

/** One isolated process, one request at a time. A crash rejects its current work,
 * never retries it automatically. The next independently queued task may restart. */
export class RagComputeClient {
  private child:ComputeTransport|undefined;
  private active:Task|undefined;
  private queue:Task[]=[];
  private sequence=0;
  private stopping=false;
  constructor(private spawn:()=>ComputeTransport,private configuration:()=>{modelsDir:string;pdfExtractScript:string}){}
  run<T>(operation:string,args:unknown,progress?:(value:any)=>void):Promise<T>{
    if(this.stopping)return Promise.reject(new Error('应用正在退出，不再启动后台计算'));
    return new Promise((resolve,reject)=>{
      this.queue.push({id:++this.sequence,operation,args,resolve,reject,progress});
      this.drain();
    });
  }
  cancelAll(reason='后台计算已停止'){
    const child=this.child;this.child=undefined;
    const tasks=[...(this.active?[this.active]:[]),...this.queue];this.active=undefined;this.queue=[];
    tasks.forEach(t=>t.reject(new Error(reason)));
    try{child?.kill();}catch{/* The transport may already have exited. */}
  }
  async shutdown(stop:(child:OwnedProcess)=>Promise<void>=stopOwnedProcess){
    this.stopping=true;
    const child=this.child,tasks=[...(this.active?[this.active]:[]),...this.queue];
    this.active=undefined;this.queue=[];tasks.forEach(task=>task.reject(new Error('应用退出，后台计算已停止')));
    if(child)await stop(child);
    if(this.child===child)this.child=undefined;
  }
  private drain(){
    if(this.stopping||this.active||!this.queue.length)return;
    const task=this.queue.shift()!;this.active=task;
    try {
      if(!this.child){
        const child=this.spawn();this.child=child;
        child.on('message',(message:any)=>{
          if(this.child!==child||message?.id!==this.active?.id)return;
          if(message.type==='progress'){
            try{this.active?.progress?.(message.value);}catch{/* Progress display cannot stop computation. */}
            return;
          }
          const current=this.active!;this.active=undefined;
          if(message.ok===true)current.resolve(message.value);
          else current.reject(new Error(typeof message.error==='string'?message.error:'后台计算失败'));
          setImmediate(()=>this.drain());
        });
        const failed=()=>{
          if(this.child!==child)return;this.child=undefined;
          const current=this.active;this.active=undefined;
          current?.reject(new Error('资料后台计算进程退出；页面仍可使用，请显式重试该资料'));
          setImmediate(()=>this.drain());
        };
        child.on('exit',failed);child.on('error',failed);
      }
      this.child.postMessage({id:task.id,operation:task.operation,args:task.args,configuration:this.configuration()});
    }catch(error){
      const child=this.child;this.child=undefined;
      this.active=undefined;task.reject(error instanceof Error?error:new Error(String(error)));
      try{child?.kill();}catch{/* Already exited; the failed task is not retried. */}
      setImmediate(()=>this.drain());
    }
  }
}
