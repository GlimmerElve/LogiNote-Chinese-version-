import type {DocumentChunk,StructuredDocument,UploadedDocumentFileType} from '../../types';
import type {TextbookReferenceChunk,TextbookReferenceChunkInput} from './textbookReferenceChunks.ts';

/** Installed by the desktop host only. Worker processes keep the original pure
 * implementations; failure never silently falls back to blocking the UI host. */
export interface BackgroundRagCompute {
  parse(filePath:string,fileType:UploadedDocumentFileType,docId:string):Promise<StructuredDocument>;
  vectorize(docId:string,fileName:string,text:string,structured?:StructuredDocument):Promise<DocumentChunk[]>;
  embed(texts:string[]):Promise<number[][]>;
  chunkTextbook(input:TextbookReferenceChunkInput):Promise<TextbookReferenceChunk[]>;
}
let executor:BackgroundRagCompute|undefined;
export function setBackgroundRagCompute(value:BackgroundRagCompute|undefined){executor=value;}
export function getBackgroundRagCompute(){return executor;}
