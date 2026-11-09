/** Browser/host shared protocol checks. No credentials or platform APIs belong here. */
export const MAX_TRANSFER_CHUNK_BYTES=4*1024*1024;
export const DEFAULT_TRANSFER_THRESHOLD_BYTES=8*1024*1024;
export interface FileTransferCapabilities {chunkedUpload:boolean;rangeDownload:boolean;chunkBytes:number;thresholdBytes:number}
export const LEGACY_FILE_TRANSFER:FileTransferCapabilities={chunkedUpload:false,rangeDownload:false,chunkBytes:MAX_TRANSFER_CHUNK_BYTES,thresholdBytes:DEFAULT_TRANSFER_THRESHOLD_BYTES};
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const positive=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>0;
export function parseFileTransferCapabilities(value:unknown):FileTransferCapabilities {
  const transfer=record(value)&&value.fileTransfer;
  if(!record(transfer)||typeof transfer.chunkedUpload!=='boolean'||typeof transfer.rangeDownload!=='boolean'||!positive(transfer.chunkBytes)||transfer.chunkBytes>MAX_TRANSFER_CHUNK_BYTES||!positive(transfer.thresholdBytes)||transfer.thresholdBytes<transfer.chunkBytes||transfer.thresholdBytes>100*1024*1024)throw Error('社区文件传输配置响应不正确。');
  return {chunkedUpload:transfer.chunkedUpload,rangeDownload:transfer.rangeDownload,chunkBytes:transfer.chunkBytes,thresholdBytes:transfer.thresholdBytes};
}
export interface TransferRange {start:number;end:number;total:number}
export function* transferRanges(total:number,chunkBytes:number):Generator<TransferRange> {
  if(!positive(total)||!positive(chunkBytes)||chunkBytes>MAX_TRANSFER_CHUNK_BYTES)throw Error('文件分块大小不正确。');
  for(let start=0;start<total;start+=chunkBytes)yield {start,end:Math.min(total,start+chunkBytes)-1,total};
}
export function verifyTransferRange(header:string|null,range:TransferRange,received:number):void {
  const match=header?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
  if(!match||Number(match[1])!==range.start||Number(match[2])!==range.end||Number(match[3])!==range.total||received!==range.end-range.start+1)throw Error('文件分块响应不完整，请重新下载。');
}
export function verifyUploadChunk(value:unknown,id:string,range:TransferRange):void {
  if(!record(value)||value.attachmentId!==id||value.offset!==range.start||value.received!==range.end-range.start+1||value.nextOffset!==range.end+1||!['pending','ready'].includes(String(value.state))||range.end===range.total-1&&value.state!=='ready')throw Error('文件分块上传结果无法确认，请重试。');
}
