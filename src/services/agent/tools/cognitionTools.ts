import { registerTool } from '../toolRegistry';
import { loadPersonalCognition } from '../../cognition/store';
import { buildCognitionManagement, cognitionNodeKey } from '../../cognition/management';
import { cognitionQueryTerms } from '../../cognition/retrieval';
import { prepareCognitionChange, cognitionChangeApprovalSnapshot, cognitionChangePreview, commitCognitionChange, commitCognitionChanges } from '../../cognition/changeProposals';
import { cognitionEdgeKey } from '../../cognition/editing';
import type { CognitionGraphEdit, CognitionNodeReference } from '../../cognition/types';
import { COGNITION_RELATION_LABELS, COGNITION_RELATION_MEANINGS } from '../../cognition/types';
import { appendCognitionReadItem, projectCognitionConditions } from '../../cognition/readProjection';
import { flowStructureForNode } from '../../argumentDoc/flowStructure';

const string = { type: 'string' };
const nodeProperties = { recordId: string, revisionId: string, branchId: string, nodeId: string };
const nodeRef = { type: 'object', additionalProperties: false, required: Object.keys(nodeProperties), properties: nodeProperties };
const edgeRef = { anyOf: [{ type: 'object', additionalProperties: false, required: ['linkId'], properties: { linkId: string } },
  { type: 'object', additionalProperties: false, required: ['recordId', 'revisionId', 'branchId', 'edgeId'], properties: { recordId: string, revisionId: string, branchId: string, edgeId: string } }] };
const conditionChange = { anyOf: [
  { type: 'object', additionalProperties: false, required: ['kind', 'after'], properties: { kind: { const: 'add' }, after: string } },
  { type: 'object', additionalProperties: false, required: ['kind', 'before'], properties: { kind: { const: 'remove' }, before: string } },
  { type: 'object', additionalProperties: false, required: ['kind', 'before', 'after'], properties: { kind: { const: 'replace' }, before: string, after: string } },
] };
const meaningSchema = { type: 'object', additionalProperties: false, required: ['interpretation', 'preserved'], properties: {
  interpretation: { ...string, description: '用用户能核对的话解释本次意图：新增/删除/正文修订/条件变化/关系变化。不是语义正确性保证。' },
  preserved: { type: 'array', maxItems: 40, items: string, description: 'update_node 时声明逐字保留的原文片段，必须同时出现在原文和新文；其他操作填空数组。' },
  conditions: { type: 'object', additionalProperties: false, required: ['before', 'changes'], properties: {
    before: { type: 'array', maxItems: 40, items: string, description: '已有 conditions 时完整照读且顺序不变；旧数据没有该字段时，只能逐字摘录原文条件，确认卡需用户核对是否完整。' },
    changes: { type: 'array', minItems: 1, maxItems: 40, items: conditionChange },
  } },
} };
export function registerCognitionTools() {
  registerTool({ name: 'query_cognition', description: '只读浏览个人认知库，无需主题、当前笔记或修改授权。不传 query 浏览全库；filter 筛选孤立/待复核/失效引用/跨活动关系端点/认同/暂定节点，可组合主题。target 读当前节点全文和完整条件，edge 读指定关系完整理由。按 next* 和 expectedRevision 分页，不能把首批说成全部；此工具不改库。',
    location: 'renderer', permission: 'readonly',
    parameters: { type: 'object', additionalProperties: false, properties: { query: string,
      filter: { type: 'string', enum: ['all', 'isolated', 'review', 'broken', 'cross-activity', 'endorsed', 'tentative'] },
      target: nodeRef, edge: edgeRef, relationsOnly: { type: 'boolean' }, offset: { type: 'integer', minimum: 0 }, edgeOffset: { type: 'integer', minimum: 0 }, brokenEdgeOffset: { type: 'integer', minimum: 0 }, expectedRevision: { type: 'integer', minimum: 0 } } },
    execute: async (rawArgs, ctx) => {
      const args = ctx.prepareCognitionRead?.(rawArgs) || rawArgs;
      const finish = (result: unknown) => { ctx.observeCognitionRead?.(args, result); return result; };
      const file = await loadPersonalCognition(), model = buildCognitionManagement(file);
      if (args.expectedRevision !== undefined && args.expectedRevision !== file.revision) throw new Error('认知快照已变化，请从新快照重新查找');
      const offset = args.offset ?? 0; if (!Number.isSafeInteger(offset) || Number(offset) < 0) throw new Error('分页偏移无效');
      const edgeOffset = args.edgeOffset ?? 0; if (!Number.isSafeInteger(edgeOffset) || Number(edgeOffset) < 0) throw new Error('关系分页偏移无效');
      const brokenEdgeOffset = args.brokenEdgeOffset ?? 0; if (!Number.isSafeInteger(brokenEdgeOffset) || Number(brokenEdgeOffset) < 0) throw new Error('失效关系分页偏移无效');
      if ([offset, edgeOffset, brokenEdgeOffset].some(value => Number(value) > 0) && args.expectedRevision === undefined) throw new Error('续读必须携带 expectedRevision，不能混用不同认知快照');
      if (args.relationsOnly !== undefined && typeof args.relationsOnly !== 'boolean') throw new Error('关系读取模式无效');
      if (args.query !== undefined && (typeof args.query !== 'string' || args.query.length > 500)) throw new Error('查询过长');
      const filter = args.filter ?? 'all';
      if (!['all', 'isolated', 'review', 'broken', 'cross-activity', 'endorsed', 'tentative'].includes(String(filter)) || typeof filter !== 'string') throw new Error('认知筛选无效');
      if ((args.edge || args.target) && (args.filter !== undefined || args.query !== undefined)) throw new Error('精确读取不能混用主题或筛选条件');
      if (args.edge) {
        if (args.target || args.query || args.relationsOnly) throw new Error('精确关系读取不能混用节点或主题查询');
        const reference = args.edge as Parameters<typeof cognitionEdgeKey>[0];
        const edge = [...model.groups.flatMap(group => group.edges), ...model.brokenEdges].find(edge => edge.id === cognitionEdgeKey(reference));
        if (!edge || ('revisionId' in reference && (!edge.reference || !('revisionId' in edge.reference) || edge.reference.revisionId !== reference.revisionId))) throw new Error('目标关系已变化或不存在');
        const result = { fileRevision: file.revision, edges: [{ ...edge, reasonTruncated: false }], responseLimitChars: 48000, limits: '仅精确读取指定当前关系，理由完整；不修改认知库。' };
        if (JSON.stringify(result).length > result.responseLimitChars) throw new Error('关系标识过长，请在认知管理窗口核对完整关系');
        return finish(result);
      }
      const allNodes = model.groups.flatMap(group => group.nodes), byId = new Map(allNodes.map(node => [node.id, node]));
      const allEdges = model.groups.flatMap(group => group.edges);
      const crossEdges = allEdges.filter(edge => byId.get(edge.source)!.recordId !== byId.get(edge.target)!.recordId);
      const crossIds = new Set(crossEdges.flatMap(edge => [edge.source, edge.target]));
      const brokenIds = new Set(model.brokenEdges.flatMap(edge => [edge.source, edge.target]));
      let nodes = allNodes.filter(node => filter === 'all' || (filter === 'isolated' && node.degree === 0)
        || (filter === 'review' && node.needsReview) || (filter === 'broken' && brokenIds.has(node.id))
        || (filter === 'cross-activity' && crossIds.has(node.id)) || node.stance === filter), exact = false;
      if (args.target) {
        const target = args.target as CognitionNodeReference;
        nodes = nodes.filter(node => node.id === cognitionNodeKey(target) && node.revisionId === target.revisionId);
        if (nodes.length !== 1) throw new Error('目标节点已变化或不存在'); exact = true;
      } else if (args.query) {
        const terms = cognitionQueryTerms(String(args.query));
        nodes = nodes.map(node => ({ node, score: terms.filter(term => `${node.title} ${node.text}`.toLocaleLowerCase().includes(term)).length }))
          .filter(row => row.score > 0).sort((a, b) => b.score - a.score).map(row => row.node);
      }
      const page = nodes.slice(Number(offset), Number(offset) + 8);
      // Current exact text/conditions can be large by design; auxiliary/history fields
      // remain excerpts. Never clip the exact baseline to make it look complete.
      const responseLimitChars = exact && !args.relationsOnly ? 800000 : 48000;
      const result = { fileRevision: file.revision, filter, totalMatches: nodes.length, nodes: [] as unknown[], edges: [] as unknown[], edgeTotal: 0,
        edgeScope: '当前筛选的本页节点所触及的有效关系；cross-activity 仅返回跨活动关系', brokenEdgeScope: '全库已存关系的失效引用，独立分页；并非语义断链审核',
        history: [] as unknown[], historyLimit: 8, historyTruncated: exact, graphSummary: model.summary, brokenEdges: [] as unknown[], brokenEdgeTotal: model.brokenEdges.length,
        relationMeanings: COGNITION_RELATION_MEANINGS, responseLimitChars,
        roleMeaning: 'role 是当前复盘的主张/前提/背景/方法；mainType 仅为历史兼容字段，不可推断角色、客观真伪或掌握。无 role 表示尚未标注，不自动转成事实。',
        limits: '只读匹配节点；候选正文、条件、关系理由和历史均可能是摘要，截断不代表原文不存在。候选不可作为写入基线，必须用 target 精确读取当前正文及完整条件；关系理由用返回的 reference 作为 edge 参数精确读取。分页使用同一 expectedRevision。relationsOnly=true 可在节点占满预算时单独分页读关系，切换模式应从 edgeOffset=0 开始；历史完整版本在认知管理窗口查看。条件缺省是尚未结构化，不代表无条件；没有新的关系、掌握度或事实结论。',
      };
      let count = 0;
      for (const node of page) {
        if (!args.relationsOnly) {
          const conditions = exact ? (node.conditions === undefined ? {} : { conditionsTotal: node.conditions.length, conditionsTruncated: false }) : projectCognitionConditions(node.conditions);
          const branch = exact ? file.records.find(r => r.id === node.recordId)?.revisions.at(-1)?.branches.find(b => b.id === node.branchId) : undefined;
          const analysisStructure = branch && flowStructureForNode(branch.graph, node.nodeId);
          const analysisTooLarge = analysisStructure && JSON.stringify(analysisStructure).length > 400000;
          const projected = { ...node, ...conditions, ...(analysisStructure ? analysisTooLarge ? { analysisStructureOmitted: true, analysisStructureWarning: '原始论证组超出单次读取预算，请在认知管理窗口核对，不能声称已读完。' } : { analysisStructure } : {}), ...(!exact ? { number: Number(offset) + count + 1 } : {}), title: exact ? node.title : node.title.slice(0, 160), text: exact ? node.text : node.text.slice(0, 1600), truncated: !exact && (node.text.length > 1600 || node.title.length > 160 || conditions.conditionsTruncated === true) };
          if (!appendCognitionReadItem(result, result.nodes, projected, responseLimitChars)) break;
        }
        count++;
      }
      if (page.length && !count) throw new Error('当前节点超出安全读取预算，请在认知管理窗口核对');
      const ids = new Set(page.slice(0, count).map(node => node.id));
      const matchingEdges = (filter === 'cross-activity' ? crossEdges : allEdges).filter(edge => ids.has(edge.source) || ids.has(edge.target));
      result.edgeTotal = matchingEdges.length;
      const projectEdge = (edge: typeof matchingEdges[number]) => ({ ...edge, reason: edge.reason?.slice(0, 160), reasonChars: edge.reason?.length || 0, reasonTruncated: (edge.reason?.length || 0) > 160 });
      for (const edge of matchingEdges.slice(Number(edgeOffset), Number(edgeOffset) + 100)) if (!appendCognitionReadItem(result, result.edges, projectEdge(edge), responseLimitChars)) break;
      for (const edge of model.brokenEdges.slice(Number(brokenEdgeOffset), Number(brokenEdgeOffset) + 20)) if (!appendCognitionReadItem(result, result.brokenEdges, projectEdge(edge), responseLimitChars)) break;
      const history = exact && !args.relationsOnly ? file.records.find(record => record.id === page[0]?.recordId)?.revisions.slice(-8) || [] : [];
      for (const revision of history) {
        const excerpt = { id: revision.id, at: revision.at, operation: revision.operation, reason: revision.reason.slice(0, 160),
          interpretation: revision.meaning?.interpretation.slice(0, 160), truncated: true,
          nodes: revision.branches.find(branch => branch.id === page[0].branchId)?.graph.nodes.filter(node => node.id === page[0].nodeId).map(node => ({ ...node, ...projectCognitionConditions(node.conditions), text: node.text.slice(0, 1600), truncated: true })) };
        if (!appendCognitionReadItem(result, result.history, excerpt, responseLimitChars)) break;
      }
      return finish({ ...result, ...(Number(offset) + count < nodes.length ? { nextOffset: Number(offset) + count } : {}),
        ...(Number(edgeOffset) + result.edges.length < matchingEdges.length ? { nextEdgeOffset: Number(edgeOffset) + result.edges.length } : {}),
        ...(Number(brokenEdgeOffset) + result.brokenEdges.length < model.brokenEdges.length ? { nextBrokenEdgeOffset: Number(brokenEdgeOffset) + result.brokenEdges.length } : {}),
      });
    } });
  registerTool({ name: 'prepare_cognition_change', description: '为一个明确认知块或关系制作具体变更预览：新增、补充适用条件、修订、删除或建立/调整关联。先 query_cognition 查找并读全真实目标；不把普通聊天中观点变化直接写入。准备成功仍未修改，下一步 commit_cognition_change 才会弹出用户确认卡。',
    location: 'renderer', permission: 'readonly', requiresCognitionContext: true,
    parameters: { type: 'object', additionalProperties: false, required: ['edit'], properties: { edit: { type: 'object', additionalProperties: false, required: ['action', 'reason', 'meaning'], properties: {
      action: { type: 'string', enum: ['add_node', 'update_node', 'delete_node', 'add_relation', 'update_relation', 'delete_relation'] }, reason: string, title: string, text: string,
      role: { type: 'string', enum: ['background', 'premise', 'claim', 'method'], description: '使用当前心流复盘角色：claim 可讨论判断；premise 仅作支持/反驳材料；background 概念、来源或理解背景；method 设计、程序、工具或情景。新增必填；修改省略则保留原角色，不使用旧九类代替。' }, stance: { type: 'string', enum: ['endorsed', 'tentative'] },
      operation: { type: 'string', enum: ['revise', 'qualify', 'add_conditions', 'remove_conditions', 'replace_conditions', 'certainty'], description: '新增/移除/替换条件分别选择对应操作；qualify 仅用于混合条件变更，必须逐项列出 changes；普通正文修订用 revise。' }, target: nodeRef, source: nodeRef, edge: edgeRef,
      meaning: meaningSchema,
      relation: { type: 'string', enum: Object.keys(COGNITION_RELATION_LABELS), description: 'support 支持；oppose 同条件反对；limits 限定适用范围；exception 特定例外；context 仅背景。不要互相替代。' },
      parent: { type: 'object', additionalProperties: false, required: ['recordId', 'revisionId', 'branchId'], properties: { recordId: string, revisionId: string, branchId: string } },
    } } } }, execute: (args, ctx, execution) => prepareCognitionChange(args.edit as CognitionGraphEdit,
      { ownerId: ctx.getCognitionProposalOwner?.(), signal: execution?.signal }) });
  registerTool({ name: 'commit_cognition_change', description: '请求用户确认并保存已预览的这一项认知变更。必须使用 prepare 返回的 proposalId；用户明确确认卡片后才执行，自动模式/先前授权/聊天中的“我意识到”均不能代替确认。',
    location: 'renderer', permission: 'write', requiresConfirmation: true, requiresExplicitApproval: true, requiresCognitionContext: true,
    parameters: { type: 'object', additionalProperties: false, required: ['proposalId'], properties: { proposalId: string } },
    approvalSnapshot: args => cognitionChangeApprovalSnapshot(args.proposalId),
    confirmation: args => { const preview = cognitionChangePreview(args.proposalId); return { title: `确认${preview.title}`, description: '仅执行下面这份具体变更；取消不写入，旧版本保留。', impacts: preview.lines }; },
    execute: (args, _ctx, execution) => commitCognitionChange(args.proposalId, execution?.signal),
    executeApprovedBatch: (args, _ctx, execution) => commitCognitionChanges(args.map(item => item.proposalId), execution.signal) });
}
