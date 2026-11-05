import { renderStyledTextbookHtml } from './styledTextbookHtml';
import type { StyledExportAssets } from './exportAssetTypes';

self.onmessage = (event: MessageEvent<{ title: string; body: string; assets?: StyledExportAssets }>) => {
  try { self.postMessage({ html: renderStyledTextbookHtml(event.data.title, event.data.body, event.data.assets) }); }
  catch (error) { self.postMessage({ error: error instanceof Error ? error.message : 'HTML 导出失败' }); }
};
