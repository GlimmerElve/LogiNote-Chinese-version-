let flush:(()=>Promise<void>)|undefined;
export function registerCommunitySourceFlush(callback:()=>Promise<void>){flush=callback;return()=>{if(flush===callback)flush=undefined;};}
export async function flushCommunitySource(){if(!flush)throw Error('笔记仍在载入，请稍后分享。');await flush();}
