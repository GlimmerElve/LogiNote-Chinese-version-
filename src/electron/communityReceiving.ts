import fs from 'node:fs/promises';
import path from 'node:path';

/** Remove only generated receipt staging files, never the authoritative library. */
export async function clearCommunityReceivingFiles(userStateDir:string,documentId:string){
  if(!/^community-[a-f\d]{32}$/.test(documentId))return;
  const directory=path.resolve(userStateDir,'community-receive');
  if(path.dirname(directory)!==path.resolve(userStateDir))throw Error('社区临时目录越界。');
  let stat;try{stat=await fs.lstat(directory);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
  if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('社区临时目录不能使用符号链接。');
  for(const name of await fs.readdir(directory)){
    if(!name.startsWith(documentId+'.')||!/^community-[a-f\d]{32}\.[a-zA-Z0-9]{1,12}$/.test(name))continue;
    const file=path.join(directory,name);const entry=await fs.lstat(file).catch(error=>{if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;});
    if(!entry)continue;
    if(!entry.isFile()||entry.isSymbolicLink())throw Error('社区临时文件无效。');
    await fs.unlink(file).catch(error=>{if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;});
  }
}
