import { parseTextbookMarkdown } from './markdown';
import { isLocalRasterDataUrl } from './localImages';
import { parseScienceDiagram } from './scienceDiagram';

type PlanItem = { language: string; code: string; start: number; end: number; topLevel: boolean; error?: string };
self.onmessage = (event: MessageEvent<{ op: 'plan'; body: string; sourceIds?: string[] } | { op: 'image'; dataUrl: string } | { op: 'svg'; svg: string }>) => {
  try {
    if (event.data.op === 'svg') {
      if (event.data.svg.length > 1_000_000 || !/^\s*<svg[\s>]/u.test(event.data.svg)) throw Error('图示无效或过大');
      const bytes = new TextEncoder().encode(event.data.svg);
      let binary = '';
      for (let i = 0; i < bytes.length; i += 16_384) binary += String.fromCharCode(...bytes.subarray(i, i + 16_384));
      self.postMessage({ dataUrl: `data:image/svg+xml;base64,${btoa(binary)}` }); return;
    }
    if (event.data.op === 'image') {
      const data = event.data.dataUrl;
      if (!isLocalRasterDataUrl(data)) throw Error('原图不是可安全导出的本地图片');
      const match = /^data:image\/(png|jpeg|gif|webp);base64,(.+)$/u.exec(data)!;
      const binary = atob(match[2]);
      const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
      self.postMessage({ extension: match[1] === 'jpeg' ? 'jpg' : match[1], bytes });
      return;
    }
    if (event.data.body.length > 5_000_000) throw Error('教材过大，无法分析图示');
    const tree = parseTextbookMarkdown(event.data.body), items: PlanItem[] = [];
    const visit = (node: any, topLevel = false) => {
      if (node.type === 'code' && ['mermaid', 'function-plot', 'chart', 'molecule', 'science-diagram', 'textbook-image'].includes(node.lang || '')
        && Number.isInteger(node.position?.start.offset) && Number.isInteger(node.position?.end.offset)) {
        let error: string | undefined;
        if (node.lang === 'science-diagram') { try { parseScienceDiagram(node.value, event.data.op === 'plan' ? event.data.sourceIds || [] : []); } catch { error = '科学图参数无效'; } }
        items.push({ language: node.lang, code: node.value, start: node.position.start.offset, end: node.position.end.offset, topLevel, ...(error ? { error } : {}) });
      }
      if (Array.isArray(node.children)) for (const child of node.children) visit(child, node.type === 'root');
    };
    visit(tree); self.postMessage({ items });
  } catch (error) { self.postMessage({ error: error instanceof Error ? error.message : '素材分析失败' }); }
};
