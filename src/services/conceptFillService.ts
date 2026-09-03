import { NoteItem, ConceptDraft } from '../types';
import { loadLlmSettings } from './llmStorage';
import { searchDocuments } from './documentRagClient';

/**
 * 知识点概念补全编排。
 *
 * 两条链路：
 * - web：调用后端 `/api/ai/concept-generation`（DeepSeek web_search 联网）
 * - rag：本地资料文档向量检索，命中片段纯拼接 + 来源（完全离线，不调 LLM）
 */

/** 定位可用的 DeepSeek 服务商（联网搜索专用，与 resource-search 同约定） */
function findDeepSeekProvider() {
  const settings = loadLlmSettings();
  return settings.providers.find((p) => p.enabled && (p.baseUrl || '').includes('deepseek')) || null;
}

/** 联网补全 */
export async function generateConceptByWeb(note: NoteItem): Promise<ConceptDraft> {
  const provider = findDeepSeekProvider();
  if (!provider || !provider.apiKey) {
    throw new Error('请先在设置中配置并启用 DeepSeek 服务商后才能联网补全');
  }

  const ai = (window as any).electronAPI?.ai;
  if (!ai) {
    throw new Error('当前环境不支持 IPC 调用（仅桌面版可用）');
  }

  const data = await ai.conceptGeneration({
    term: note.title,
    provider: {
      apiKey: provider.apiKey,
      baseUrl: provider.baseUrl,
      selectedModel: provider.selectedModel || provider.models?.[0] || 'deepseek-chat',
      models: provider.models || [],
    },
  });

  if (!data.content || !data.content.trim()) {
    throw new Error(data.error || '未能获取到概念内容');
  }

  return {
    noteId: note.id,
    title: note.title,
    content: data.content.trim(),
    source: 'web',
    createdAt: new Date().toISOString(),
  };
}

/** 本地 RAG 补全（纯拼接命中片段 + 来源，不调 LLM） */
export async function generateConceptByRag(note: NoteItem): Promise<ConceptDraft> {
  const results = await searchDocuments(note.title, 3);

  if (results.length === 0) {
    throw new Error('本地资料库中没有检索到相关内容，请先在「资料」板块上传文档');
  }

  const sections: string[] = [];
  const references: Array<{ title: string; url?: string }> = [];

  results.forEach((r, i) => {
    const label = r.sectionPath ? `〔${r.sectionPath}〕` : '';
    sections.push(
      `### 资料片段 ${i + 1}（来自 ${r.fileName}）${label ? ' ' + label : ''}\n${r.snippet}`,
    );
    references.push({ title: r.fileName });
  });

  const content = `# ${note.title}\n\n## 摘自本地资料\n\n${sections.join('\n\n')}\n\n## 来源\n${references
    .map((ref, i) => `${i + 1}. ${ref.title}`)
    .join('\n')}`;

  return {
    noteId: note.id,
    title: note.title,
    content,
    source: 'rag',
    references,
    createdAt: new Date().toISOString(),
  };
}

/**
 * 统一入口：默认联网，source='rag' 时走本地检索。
 * 返回 ConceptDraft（预览态，不直接落盘）。
 */
export async function generateConcept(
  note: NoteItem,
  source: 'web' | 'rag' = 'web',
): Promise<ConceptDraft> {
  if (source === 'rag') return generateConceptByRag(note);
  return generateConceptByWeb(note);
}