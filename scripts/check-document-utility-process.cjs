// Actual Electron utilityProcess transport smoke test. No BrowserWindow or vault.
const {app,utilityProcess}=require('electron');
const assert=require('node:assert/strict');
const path=require('node:path');
const fs=require('node:fs/promises');
const os=require('node:os');
let child,temporary,timer;
app.whenReady().then(async()=>{
  try{
    temporary=await fs.mkdtemp(path.join(os.tmpdir(),'loginote-utility-check-'));
    const filePath=path.join(temporary,'fixture.txt');
    await fs.writeFile(filePath,'合成正文。\n\n实验观察到两种不同结果。');
    child=utilityProcess.fork(path.resolve('dist-electron/rag-compute.cjs'),[],{
      serviceName:'资料后台验证',stdio:'ignore',execArgv:['--max-old-space-size=768'],
    });
    let beats=0;const pulse=setInterval(()=>{beats++;},5);
    const value=await new Promise((resolve,reject)=>{
      timer=setTimeout(()=>reject(Error('utility worker timeout')),60000);
      child.on('exit',code=>reject(Error('utility worker exited '+code)));
      child.on('message',message=>{
        if(message.id!==1)return;
        if(message.ok)resolve(message.value);else reject(Error(message.error));
      });
      child.postMessage({id:1,operation:'parse',args:{filePath,fileType:'txt',docId:'doc-utility'},
        configuration:{modelsDir:path.resolve('models'),pdfExtractScript:path.resolve('python/pdf_extract.py')}});
    });
    clearInterval(pulse);
    assert.equal(value.docId,'doc-utility');assert(value.normalizedText.includes('两种不同结果'));assert(beats>1);
    console.log('Electron utilityProcess: actual transport, bundled worker and responsive main heartbeat passed.');
    app.exitCode=0;
  }catch(error){console.error(error);app.exitCode=1;}
  finally{
    clearTimeout(timer);child?.kill();
    if(temporary){assert(path.resolve(temporary).startsWith(path.resolve(os.tmpdir())+path.sep));await fs.rm(temporary,{recursive:true,force:true});}
    app.exit(app.exitCode||0);
  }
});
