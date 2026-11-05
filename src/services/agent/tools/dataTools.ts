import { searchDocuments } from '../../documentRagClient';
import { searchNotes } from '../../ragService';
import { registerTool } from '../toolRegistry';

function boundedK(value: unknown): number {
  return Math.max(1, Math.min(10, typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : 5));
}

export function registerDataTools(): void {
  registerTool({
    name: 'query_learner_profile', description: '查询经过证据门控的长期用户画像，不返回未采信指标。',
    parameters: { type: 'object', properties: { includeEvidence: { type: 'boolean', description: '用户询问画像详细依据时返回已采信指标的受限证据投影。' } }, additionalProperties: false },
    location: 'main', permission: 'readonly',
    execute: async (args) => {
      const api = (window as any).electronAPI?.agent;
      if (!api) throw new Error('Agent 数据接口未就绪');
      return api.queryProfile({ includeEvidence: args.includeEvidence === true });
    },
  });
  registerTool({
    name: 'query_mastery', description: '查询知识点掌握度、证据数、可提取率和复习次数；不传标题时返回薄弱项优先列表。',
    parameters: { type: 'object', properties: { noteTitles: { type: 'array', items: { type: 'string' } } }, additionalProperties: false },
    location: 'main', permission: 'readonly',
    execute: async (args) => {
      const api = (window as any).electronAPI?.agent;
      if (!api) throw new Error('Agent 数据接口未就绪');
      return api.queryMastery({ noteTitles: Array.isArray(args.noteTitles) ? args.noteTitles.map(String) : undefined });
    },
  });
  registerTool({
    name: 'get_review_queue', description: '查询当前基于遗忘风险生成的知识点复习队列。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    location: 'main', permission: 'readonly',
    execute: async () => {
      const api = (window as any).electronAPI?.agent;
      if (!api) throw new Error('Agent 数据接口未就绪');
      return api.reviewQueue();
    },
  });
  registerTool({
    name: 'search_notes', description: '按语义检索知识点笔记的参考正文，不返回项目复述或用户论证图；查找项目用计划查询工具，查询个人理解由专用认知通道处理。',
    parameters: { type: 'object', required: ['query'], properties: { query: { type: 'string' }, k: { type: 'number' } }, additionalProperties: false },
    location: 'main', permission: 'readonly',
    execute: (args) => searchNotes(String(args.query || ''), boundedK(args.k)),
  });
  registerTool({
    name: 'search_documents', description: '检索用户导入并完成向量化的本地学习资料。',
    parameters: { type: 'object', required: ['query'], properties: { query: { type: 'string' }, k: { type: 'number' } }, additionalProperties: false },
    location: 'main', permission: 'readonly',
    execute: (args) => searchDocuments(String(args.query || ''), boundedK(args.k)),
  });
}
