import { createNoteMetadataSession, type NoteMetadataRequest } from './noteMetadataProtocol';

const calculate = createNoteMetadataSession();
self.onmessage = (event: MessageEvent<NoteMetadataRequest>) => {
  const { id } = event.data;
  try { self.postMessage({ id, metadata: event.data.isolated ? createNoteMetadataSession()(event.data) : calculate(event.data) }); }
  catch (error) { self.postMessage({ id, error: error instanceof Error ? error.message : '笔记元数据处理失败' }); }
};
