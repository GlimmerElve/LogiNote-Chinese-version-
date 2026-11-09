import type { AgentRuntimeContext } from '../types';
import { registerTool } from '../toolRegistry';
import { canonicalAgentValue } from '../approvalBinding';
import { documentBindingApproval, queryLocalDocumentBindings, readDocumentBindingCommand } from '../documentBindings';
import { projectDisplayPath } from '../../projectResourceScope';

function port(ctx: AgentRuntimeContext) {
  if (!ctx.documentBindings) throw new Error('当前环境未接通已有资料的项目绑定入口，请重启更新后的桌面应用');
  return ctx.documentBindings;
}
export function registerDocumentTools(): void {
  // Preview cache is for labels only; approval validation and writes always reread live state.
  const previews = new Map<string, { documents: string[]; projects: string[] }>();
  registerTool({ name: 'query_local_documents',
    description: '分页查询已上传的本地资料元数据、稳定 documentId、上传时间和直接绑定项目；按文件名片段或 ID 查找刚上传的资料，不依赖全文索引是否完成。projectNoteId 可查看该项目直接及逐级父项目继承的资料和来源。只读，不取正文、不联网、不生成。查找项目 ID 用 list_notes。',
    parameters: { type: 'object', additionalProperties: false, properties: {
      fileNameContains: { type: 'string', maxLength: 200 }, documentIds: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string' } },
      projectNoteId: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 50 },
    } }, location: 'renderer', permission: 'readonly',
    execute: async (args, ctx) => queryLocalDocumentBindings(await port(ctx).read(), args),
  });
  registerTool({ name: 'update_document_project_bindings',
    description: '把同一份已有资料同时绑定多个项目（包括不同根计划），或解除指定项目的直接绑定。documentIds与projectNoteIds表示每份资料关联每个目标项目；可传一个documentId和多个projectNoteIds。共用原文件/索引，不复制。已绑定其它项目不构成限制，bind只追加并保留旧关联；unbind不影响其它项目、不删除文件或祖先继承。根/中间/叶子项目、无学习任务均可绑定。一次最多50对，确认后保存并返回全部直接关联。不读取正文、不搜索、不生成。先查询真实稳定ID，草稿项目保存后再绑定。',
    parameters: { type: 'object', additionalProperties: false, required: ['action', 'documentIds', 'projectNoteIds'], properties: {
      action: { type: 'string', enum: ['bind', 'unbind'] },
      documentIds: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string' } },
      projectNoteIds: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string' }, description: '所有要新增绑定或单独解绑的已有项目稳定ID；允许不同根计划。bind无需重复列出原有绑定，它们会保留。' },
    } }, location: 'renderer', permission: 'write', requiresConfirmation: true,
    approvalSnapshot: async (args, ctx) => {
      const command = readDocumentBindingCommand(args), catalog = await port(ctx).read();
      const snapshot = documentBindingApproval(catalog, command);
      if (previews.size >= 50) previews.clear();
      previews.set(canonicalAgentValue(args), {
        documents: snapshot.documents.map(doc => `《${doc.fileName}》 · ${doc.id}`),
        projects: command.projectNoteIds.map(id => {
          const note = catalog.notes.find(item => item.id === id)!;
          return `${projectDisplayPath(note, catalog.notes)} · ${id}`;
        }),
      });
      return snapshot;
    },
    confirmation: args => {
      const command = readDocumentBindingCommand(args), preview = previews.get(canonicalAgentValue(args));
      if (!preview) throw new Error('资料绑定预览尚未准备，请重新查询');
      return { title: command.action === 'bind' ? '确认绑定已有资料到项目' : '确认解除资料的直接项目绑定',
        description: `${command.documentIds.length} 份资料 × ${command.projectNoteIds.length} 个目标项目。仅调整关联，共用原文件与索引，不修改正文和学习任务。`,
        impacts: [...preview.documents.map(label => `资料：${label}`), ...preview.projects.map(label => `项目：${label}`),
          command.action === 'bind' ? '同一份资料可供多个项目或不同根计划共用，已有绑定保留；绑定父项目后其后代可继承，不复制文件。'
            : '只解除所列项目的直接绑定；如果父项目仍有绑定，后代仍可继承，需要移除继承来源时请明确选择该父项目。',
          '保留其它资料和其它项目的关联；确认后保存可恢复操作记录。' ] };
    },
    execute: async (args, ctx) => {
      const command = readDocumentBindingCommand(args), service = port(ctx), catalog = await service.read();
      return service.apply(command, documentBindingApproval(catalog, command));
    },
  });
}
