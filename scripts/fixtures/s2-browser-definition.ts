import type { SceneInitialRequest } from '../../src/types';
import type { S2CanvasDefinition, S2Document } from '../../src/types/sceneS2';
import { S2ProjectNoteSource } from '../../src/services/scene/sceneS2ProjectNotes';

/** Browser protocol fixture, never an actual model-generated or semantically accepted design. */
export const browserRequest: SceneInitialRequest = {
  source: 'build', sceneSkill: 'S2', subject: '合成浏览器验收：JSON 到表格', knowledgePoints: [],
  extraHints: '仅使用本地 parse-json、to-table、table 三项能力，原样展示两条合成记录，包括空姓名和120分。初始保留一条通往表格展示的必要连线让我补齐。保留我的笔记原文；先解释，不擅自改图或运行，修改与运行分别确认。不使用网络、真实笔记、画像或真实模型。',
};
export const browserInputText = '[{"name":"示例甲","score":80},{"name":"","score":120}]';
export const browserNotesText = '我的原文：JSON解析成功说明所有业务条件都满足。请保留我的原文，不要覆盖。';
const cap = (capabilityId: string, pluginId = 'structured-data') => ({ pluginId, pluginVersion: '1.0.0', capabilityId });
const plugins = [cap('parse-json'), cap('to-table'), cap('table', 'structured-view')];

/** In-memory fixture only. Never imports the App note adapter, a vault or the real file system. */
export const browserResourceText = '[{"name":"合成资料甲","enabled":false,"count":0,"empty":null},{"name":"缺失字段"}]';
export const browserResourceState = { version: 'v1', present: true, reads: 0, body: 'valid' as 'valid' | 'empty' | 'long' | 'non-text' };
export const browserResourceSource = new S2ProjectNoteSource({ projectId: 'synthetic-project',
  list: () => browserResourceState.present ? [{ noteId: 'synthetic-note', label: '合成项目知识', updatedAt: browserResourceState.version }] : [],
  read: async noteId => { browserResourceState.reads++; if (typeof window !== 'undefined') window.dispatchEvent?.(new Event('s2-resource-read'));
    return { noteId, updatedAt: browserResourceState.version, text: browserResourceState.body === 'empty' ? '  \n\t'
      : browserResourceState.body === 'long' ? '合'.repeat(6001) : browserResourceState.body === 'non-text' ? '合成\0正文' : browserResourceText }; },
});
export const browserResourceRequest: SceneInitialRequest = {
  source: 'build', sceneSkill: 'S2', subject: '合成浏览器验收：只读资料与失效恢复', knowledgePoints: [], taskBinding: { noteId: 'synthetic-project' },
  extraHints: '两条独立链路分别读取本局允许的文本文件、项目知识笔记，再解析、转表格、展示。用户逐项允许、按名称选用、手动运行。资料失效或撤回后不得继续读取，历史结果保留且不代表当前成功。不读取真实资料，不使用模型或网络。',
};
const resourcePlugins = [cap('read-text', 'local-material'), cap('read-text', 'project-notes'), ...plugins];
function resourceDocument(reference: boolean): S2Document {
  const nodes: NonNullable<S2Document['execution']>['nodes'] = [], links: NonNullable<S2Document['execution']>['links'] = [];
  for (const [branch, pluginId, label, y] of [['file', 'local-material', '文件', 40], ['note', 'project-notes', '笔记', 280]] as const) {
    nodes.push({ id: `${branch}Read`, ...cap('read-text', pluginId), position: { x: 30, y },
      bindings: reference ? { resource: { kind: 'literal', value: branch === 'file' ? 'user-approved-file' : 'user-approved-note' } } : {},
      presentation: { label: `读取${label}`, description: `读取你在本局允许并选用的${label}；确认运行前不读取。` } },
    { id: `${branch}Parse`, ...cap('parse-json'), position: { x: 360, y }, bindings: {}, presentation: { label: `解析${label}内容` } },
    { id: `${branch}Rows`, ...cap('to-table'), position: { x: 690, y }, bindings: {}, presentation: { label: `整理${label}表格` } },
    { id: `${branch}View`, ...cap('table', 'structured-view'), position: { x: 1020, y }, bindings: {}, presentation: { label: `展示${label}结果` } });
    links.push({ source: { nodeId: `${branch}Read`, portId: 'text' }, target: { nodeId: `${branch}Parse`, portId: 'text' } },
      { source: { nodeId: `${branch}Parse`, portId: 'value' }, target: { nodeId: `${branch}Rows`, portId: 'value' } },
      { source: { nodeId: `${branch}Rows`, portId: 'table' }, target: { nodeId: `${branch}View`, portId: 'table' } });
  }
  return { nodes: [], edges: [], execution: { version: 1, nodes, links } };
}
export const browserResourceDefinition: S2CanvasDefinition = {
  version: 1, goal: '分别允许、选用和读取两类合成资料；失效、撤回与恢复不混淆授权或历史输出。',
  instructions: { understanding: '区分允许、选用、运行、撤回和解释。', planning: '用户明确要求才申请运行；两路资源权限独立。', response: '依据真实宿主结果解释，不把历史展示当作新读取成功。' },
  blockTypes: [{ id: 'note', label: '练习笔记', fields: [{ id: 'content', label: '内容', kind: 'multiline' }] }],
  plugins: resourcePlugins, initial: resourceDocument(false),
  business: { version: 1, purpose: '在已有工具内完成只读资料到表格的自由操作；批准和选用均不读取正文。',
    knowledge: [{ id: 'Types', title: '允许、选用与运行', content: '允许只是授予本局读取某份资料的权限；选用只是配置输入；运行才读取。失效后应撤回并重新允许，不能假定旧输出是最新正文。' }],
    workflow: [{ id: 'ResourcePath', goal: '读取允许的资料并展示原始记录', actor: 'tool', capabilities: resourcePlugins, input: '用户允许的两类合成资料', output: '分别保留 false、0、null 与缺失值的表格' }],
    completion: { mode: 'execution', reference: resourceDocument(true), targetNodeIds: ['fileView', 'noteView'], coverage: [{ requirementId: 'r1', stepIds: ['ResourcePath'], nodeIds: ['fileRead', 'fileParse', 'fileRows', 'fileView', 'noteRead', 'noteParse', 'noteRows', 'noteView'] }] },
    criteria: [{ id: 'Explain', label: '理解读取时机', expectation: '允许与选用不读取，运行才读取；只作建议。', method: 'advisory', required: false }],
  },
};
function document(prefix: string, complete: boolean): S2Document {
  return { nodes: [
    { id: `${prefix}input`, type: 'note', position: { x: 30, y: 40 }, values: { content: browserInputText } },
    { id: `${prefix}notes`, type: 'note', position: { x: 30, y: 280 }, values: { content: browserNotesText } },
  ], edges: [], execution: { version: 1, nodes: [
    { id: `${prefix}parse`, ...cap('parse-json'), position: { x: 370, y: 40 }, bindings: { text: { kind: 'field', nodeId: `${prefix}input`, fieldId: 'content' } } },
    { id: `${prefix}rows`, ...cap('to-table'), position: { x: 710, y: 40 }, bindings: {} },
    { id: `${prefix}view`, ...cap('table', 'structured-view'), position: { x: 1050, y: 40 }, bindings: {} },
  ], links: [
    { source: { nodeId: `${prefix}parse`, portId: 'value' }, target: { nodeId: `${prefix}rows`, portId: 'value' } },
    ...(complete ? [{ source: { nodeId: `${prefix}rows`, portId: 'table' }, target: { nodeId: `${prefix}view`, portId: 'table' } }] : []),
  ] } };
}
export const browserDefinition: S2CanvasDefinition = {
  version: 1, goal: '在授权的三项本地能力内，原样解析、转换并展示两条合成记录；浏览器验收不证明真实模型理解能力。',
  instructions: {
    understanding: '先理解本轮表达，区分解释、改图建议和申请执行；保留用户原文。',
    planning: '按需读取业务知识。先给提示或例子；用户明确要求协作时可提出最小补线建议，应用修改与运行分别确认。',
    response: '清楚区分待确认方案与真实宿主执行结果，技术执行成功不等于业务合格；不要把合成响应称为真实模型验收。',
  },
  blockTypes: [{ id: 'note', label: '内容与笔记', fields: [{ id: 'content', label: '内容', kind: 'multiline' }] }],
  plugins, initial: document('', false),
  business: { version: 1, purpose: '完整保留原始输入，执行本地解析→转表格→展示；不作姓名、分数筛选。',
    knowledge: [
      { id: 'Types', title: '文本、JSON 与表格', content: '文本像封好的信；解析得到可读取的JSON值，再把记录数组转为表格，展示器只接收表格类型。不同端口不是自动转换器。' },
      { id: 'Meaning', title: '技术成功与业务合格', content: '成功打开信封不代表信里信息满足业务规则。解析和展示成功只证明技术过程；空姓名或120分是否允许，需要单独明确标准。' },
    ],
    workflow: [{ id: 'LocalPath', goal: '本地原样解析、转换、展示', actor: 'tool', capabilities: plugins, input: '两条记录的完整JSON文本', output: '包含两条原记录的表格；不是业务合格证明' }],
    completion: { mode: 'execution', reference: document('Private', true), targetNodeIds: ['Privateview'],
      coverage: [{ requirementId: 'r1', stepIds: ['LocalPath'], nodeIds: ['Privateparse', 'Privaterows', 'Privateview'] }] },
    criteria: [
      { id: 'SourceName', label: '第一条姓名', expectation: '仅核对输入JSON的/0/name等于示例甲，不外推整个记录', method: 'local', required: true,
        target: { nodeId: 'input', fieldId: 'content' }, rule: { kind: 'json-pointer-equals', pointer: '/0/name', value: '示例甲' } },
      { id: 'Meaning', label: '理解技术与业务的区别', expectation: '理解说明区分技术执行成功和业务合格', method: 'semantic', required: true, target: { nodeId: 'notes', fieldId: 'content' } },
      { id: 'Example', label: '可选例子', expectation: '可用形象例子帮助理解，不作为必过指标', method: 'advisory', required: false },
    ],
  },
};

/** Native record material: no JSON syntax, model or new execution capability is required. */
export const browserRecordFormRequest: SceneInitialRequest = {
  source: 'build', sceneSkill: 'S2', subject: '合成浏览器验收：逐条填写记录', knowledgePoints: [],
  extraHints: '直接填写、增删和排序记录，明确应用后单独运行转表格与展示。保留每条记录的独立字段、0、否、空文字和空值；不自动补齐、运行或评价。不读取真实资料或使用模型。',
};
export const browserRecordFormValue = [{ 姓名: '示例甲', 分数: 0, 已完成: false, 备注: null }, { 姓名: '示例乙', 备注: '' }];
export const browserRecordFormDefinition: S2CanvasDefinition = {
  version: 1, goal: '不用编写JSON也能逐条填写、增删和排序记录；应用材料与运行展示分别操作。',
  instructions: { understanding: '区分填写、应用、运行与解释。', planning: '保留各条记录的原始字段和类型；不擅自修改或运行。', response: '按实际材料和结果解释，不声称业务合格。' },
  blockTypes: [{ id: 'note', label: '练习笔记', fields: [{ id: 'content', label: '内容', kind: 'multiline' }] }],
  plugins: [cap('to-table'), cap('table', 'structured-view')],
  initial: { nodes: [{ id: 'notes', type: 'note', position: { x: 20, y: 220 }, values: { content: '我的记录由我填写；应用不等于运行。' } }], edges: [],
    execution: { version: 1, nodes: [
      { id: 'recordRows', ...cap('to-table'), position: { x: 20, y: 30 }, bindings: { value: { kind: 'literal', value: browserRecordFormValue } },
        presentation: { label: '整理我的记录', description: '选中后在材料表单逐条填写、增删或排序；先应用，再单独运行。' } },
      { id: 'recordView', ...cap('table', 'structured-view'), position: { x: 420, y: 30 }, bindings: {}, presentation: { label: '展示我的记录' } },
    ], links: [{ source: { nodeId: 'recordRows', portId: 'table' }, target: { nodeId: 'recordView', portId: 'table' } }] } },
};
browserRecordFormDefinition.business = {
  version: 1, purpose: '使用已有记录表单和两项本地能力完成编辑与展示；不要求手写JSON，不自动改写或评价。',
  knowledge: [{ id: 'Types', title: '填写、应用与运行', content: '填写先保留草稿，应用才更新材料，运行才处理。每条记录独立保留字段；缺失不等于空值、否、0或空文字。' }],
  workflow: [{ id: 'RecordPath', goal: '手动编辑完整记录后查看表格', actor: 'tool', capabilities: browserRecordFormDefinition.plugins,
    input: '用户逐条填写的完整记录', output: '原字段、类型与顺序不变的本地表格' }],
  completion: { mode: 'execution', reference: structuredClone(browserRecordFormDefinition.initial), targetNodeIds: ['recordView'],
    coverage: [{ requirementId: 'r1', stepIds: ['RecordPath'], nodeIds: ['recordRows', 'recordView'] }] },
  criteria: [{ id: 'Explain', label: '理解应用和运行的区别', expectation: '操作过程中保留原始数据；理解建议不代替用户决定。', method: 'advisory', required: false }],
};

/** Empty public graph: the learner adds every step using the ordinary production library. */
export const browserManualReuseRequest: SceneInitialRequest = {
  source: 'build', sceneSkill: 'S2', subject: '合成浏览器验收：手动组合与模板复用', knowledgePoints: [], taskBinding: { noteId: 'synthetic-project' },
  extraHints: '给我空画布与已有记录转表格、展示、本人确认、笔记读取能力。我自己从普通库添加步骤，填写记录并选材料；保存已应用设计后重新打开是新试验，不恢复等待、结果或资料许可。不读取真实资料或使用模型。',
};
export const browserManualReuseDefinition: S2CanvasDefinition = {
  ...structuredClone(browserRecordFormDefinition), goal: '从普通节点库手动组合本地记录展示和本人确认，再保存设计并重新使用；不自动改图或运行。',
  plugins: [...browserRecordFormDefinition.plugins!, cap('confirm', 'human-input'), cap('read-text', 'project-notes')],
  initial: { nodes: [], edges: [], execution: { version: 1, nodes: [], links: [] } },
};
const manualReference = structuredClone(browserRecordFormDefinition.initial);
manualReference.execution!.nodes.push({ id: 'manualConfirm', ...cap('confirm', 'human-input'), position: { x: 800, y: 30 },
  bindings: { prompt: { kind: 'literal', value: '请确认是否保留本次设计；这不是模型或资料授权，也不代表业务评价。' } } });
browserManualReuseDefinition.business = {
  version: 1, purpose: '用普通库和原生表单完成独立搭建；展示和本人确认可分别运行，不要求固定教学顺序。',
  knowledge: [{ id: 'Types', title: '保存设计，不保存会话', content: '材料需要明确应用，处理需要单独运行。保存只留已应用设计，重新使用不会恢复等待、结果或许可。本人确认不是模型或资料授权。' }],
  workflow: [{ id: 'ManualRecords', goal: '手动组合完整记录的本地转换与展示', actor: 'tool', capabilities: browserRecordFormDefinition.plugins,
    input: '用户自己填写并应用的多条记录', output: '保留原字段和值的表格' },
  { id: 'ManualChoice', goal: '用户自行决定是否确认本次设计', actor: 'user', capabilities: [cap('confirm', 'human-input')], input: '核对说明', output: '用户真实选择，不是授权或正确性结论' }],
  completion: { mode: 'execution', reference: manualReference, targetNodeIds: ['recordView', 'manualConfirm'],
    coverage: [{ requirementId: 'r1', stepIds: ['ManualRecords', 'ManualChoice'], nodeIds: ['recordRows', 'recordView', 'manualConfirm'] }] },
  criteria: [{ id: 'ManualUnderstanding', label: '独立组合与复用', expectation: '能区分填写、应用、运行、保存与新会话；这里只作建议。', method: 'advisory', required: false }],
};

export const browserGroupFormRequest: SceneInitialRequest = {
  source: 'build', sceneSkill: 'S2', subject: '合成浏览器验收：分组填写学习资料', knowledgePoints: [],
  extraHints: '按中文分组填写学习者信息和练习设置；先明确应用，之后单独提取并展示练习设置。不得将分组压平、补默认值或自动运行；只使用本地提取和展开查看，不读取真实资料或调用模型。',
};
export const browserGroupFormValue = { 学习者信息: { 昵称: '合成学员', 备注: '' }, 练习设置: { 题量: 0, 需要提示: false, 补充: null }, 说明: '这些是合成资料' };
export const browserGroupFormDefinition: S2CanvasDefinition = {
  version: 1, goal: '分组填写完整学习资料，再独立提取并查看练习设置；不手写JSON，不压平字段。',
  instructions: { understanding: '先区分用户是在填写、解释、修改还是申请运行。', planning: '仅在用户要求时协助，保留分组和未填写的草稿。', response: '依据真实材料和结果解释，不替用户决定题量或需要提示与否。' },
  blockTypes: [{ id: 'note', label: '练习笔记', fields: [{ id: 'content', label: '内容', kind: 'multiline' }] }],
  plugins: [cap('select'), cap('json-tree', 'structured-view')],
  initial: { nodes: [], edges: [], execution: { version: 1, nodes: [
    { id: 'groupSelect', ...cap('select'), position: { x: 30, y: 40 }, bindings: { value: { kind: 'literal', value: browserGroupFormValue }, pointer: { kind: 'literal', value: '/练习设置' } },
      presentation: { label: '选取练习设置', description: '在材料表单按分组填写学习资料，明确应用后再运行；选取位置可按真实字段名称调整。' } },
    { id: 'groupView', ...cap('json-tree', 'structured-view'), position: { x: 450, y: 40 }, bindings: {}, presentation: { label: '查看练习设置' } },
  ], links: [{ source: { nodeId: 'groupSelect', portId: 'value' }, target: { nodeId: 'groupView', portId: 'value' } }] } },
};
browserGroupFormDefinition.business = {
  version: 1, purpose: '使用信息分组直接填写，再用真实类型兼容的本地能力提取和查看；不自动补写资料或评价。',
  knowledge: [{ id: 'Types', title: '分组不等于合并', content: '学习者信息和练习设置各自保留独立名称。应用才更新材料；选取练习设置只取这一组，不改变原始资料或其他组。运行需要单独操作。' }],
  workflow: [{ id: 'GroupPath', goal: '保留完整分组并查看指定组', actor: 'tool', capabilities: browserGroupFormDefinition.plugins, input: '分组填写的完整材料', output: '指定练习设置的原生对象' }],
  completion: { mode: 'execution', reference: structuredClone(browserGroupFormDefinition.initial), targetNodeIds: ['groupView'],
    coverage: [{ requirementId: 'r1', stepIds: ['GroupPath'], nodeIds: ['groupSelect', 'groupView'] }] },
  criteria: [{ id: 'Explain', label: '理解分组和提取', expectation: '区分原始材料、已应用内容和单独运行后的提取结果；只作建议。', method: 'advisory', required: false }],
};

/** Ordinary scalar list: the native array is neither a table nor a record list. */
export const browserListFormRequest: SceneInitialRequest = {
  source: 'build', sceneSkill: 'S2', subject: '合成浏览器验收：逐项填写普通列表', knowledgePoints: [],
  extraHints: '逐项填写、增删和排序文字、数字、是／否和空值；明确应用后单独运行并查看完整列表。不压平、不转表格、不补默认值，不读取真实资料或调用模型。',
};
export const browserListFormValue = ['合成要点', 0, false, null, ''];
export const browserListFormDefinition: S2CanvasDefinition = {
  version: 1, goal: '不用编写JSON即可逐项填写普通列表，保留各项类型与顺序；应用后再单独运行查看。',
  instructions: { understanding: '区分编辑、应用、运行与解释。', planning: '保留各项类型和未完成草稿，不擅自改图或运行。', response: '依据真实结果解释，不把列表展示当成业务合格。' },
  blockTypes: [{ id: 'note', label: '练习笔记', fields: [{ id: 'content', label: '内容', kind: 'multiline' }] }],
  plugins: [cap('select'), cap('json-tree', 'structured-view')],
  initial: { nodes: [], edges: [], execution: { version: 1, nodes: [
    { id: 'listSelect', ...cap('select'), position: { x: 30, y: 40 }, bindings: { value: { kind: 'literal', value: browserListFormValue }, pointer: { kind: 'literal', value: '' } },
      presentation: { label: '整理我的列表', description: '逐项填写、增删或排序，明确应用后再运行；这里保留完整列表，不转表格。' } },
    { id: 'listView', ...cap('json-tree', 'structured-view'), position: { x: 450, y: 40 }, bindings: {}, presentation: { label: '查看我的列表' } },
  ], links: [{ source: { nodeId: 'listSelect', portId: 'value' }, target: { nodeId: 'listView', portId: 'value' } }] } },
};
browserListFormDefinition.business = {
  version: 1, purpose: '用原生表单编辑普通列表，再独立运行已有提取与查看能力；不要求手写JSON或自动转换为表格。',
  knowledge: [{ id: 'Types', title: '普通列表与记录列表', content: '普通列表每项是一个值，不需要字段名。空文字、0、否和空值分别保存；尚未填写必须补齐或明确删除。应用更新材料，运行才处理，不会自动转表格。' }],
  workflow: [{ id: 'ListPath', goal: '查看逐项填写的完整列表', actor: 'tool', capabilities: browserListFormDefinition.plugins, input: '用户填写并应用的普通列表', output: '保留类型和顺序的原生列表' }],
  completion: { mode: 'execution', reference: structuredClone(browserListFormDefinition.initial), targetNodeIds: ['listView'],
    coverage: [{ requirementId: 'r1', stepIds: ['ListPath'], nodeIds: ['listSelect', 'listView'] }] },
  criteria: [{ id: 'Explain', label: '理解列表与运行', expectation: '分清草稿、已应用材料与运行结果；只作建议。', method: 'advisory', required: false }],
};

/** Named lists reuse the same native ports and real controls; no new executor or permission. */
export const browserNamedListFormRequest: SceneInitialRequest = {
  ...browserListFormRequest, subject: '合成浏览器验收：具名列表与学习资料',
  extraHints: '直接填写练习名称、知识点列表和练习设置中的例子列表。列表只放文字、数字、是／否和空值；增删排序不改其他字段，明确应用后单独查看完整资料。不读取真实资料或调用模型。',
};
export const browserNamedListFormValue = { 练习名称: '合成练习', 知识点: ['合成知识点', 0, false, null, ''], 练习设置: { 参考例子: [], 需要提示: false } };
export const browserNamedListFormDefinition: S2CanvasDefinition = structuredClone(browserListFormDefinition);
browserNamedListFormDefinition.goal = '按字段填写知识点和参考例子列表，独立保留练习名称与其他设置；明确应用后再查看完整资料。';
browserNamedListFormDefinition.initial.execution!.nodes[0].bindings.value = { kind: 'literal', value: browserNamedListFormValue };
browserNamedListFormDefinition.initial.execution!.nodes[0].presentation = { label: '整理练习资料', description: '按名称展开知识点或参考例子列表，逐项填写；应用不自动运行，也不覆盖其他设置。' };
browserNamedListFormDefinition.initial.execution!.nodes[1].presentation = { label: '查看完整练习资料' };
browserNamedListFormDefinition.business!.purpose = '按具名字段编辑一层信息分组与普通列表，不压平、不混入其他列表，不自动改写或运行。';
browserNamedListFormDefinition.business!.knowledge = [{ id: 'Types', title: '具名列表与独立字段', content: '知识点、参考例子各自保留完整列表，每项只放一个值。展开不应用，应用不运行；空列表不等于未填写，删除外层字段会删除整个列表，先核对再应用。' }];
browserNamedListFormDefinition.business!.workflow![0] = { id: 'ListPath', goal: '按名称编辑并查看完整练习资料', actor: 'tool', capabilities: browserNamedListFormDefinition.plugins,
  input: '名称、知识点列表和分组设置的完整原生对象', output: '字段、类型和各列表顺序保持完整的资料' };
browserNamedListFormDefinition.business!.completion.reference = structuredClone(browserNamedListFormDefinition.initial);

/** A mixed list remains an array, not an inferred table or a new execution capability. */
export const browserMixedListFormValue = ['合成要点', { 名称: '合成例子', 次数: 0, 完成: false, 备注: null, 空文字: '' }, {}, 0, false, null, ''];

/** Declarative parameter forms use native values and the same select/view executors. */
export const browserDeclaredFormRequest: SceneInitialRequest = {
  ...browserListFormRequest, subject: '合成浏览器验收：专属表单填写与问题定位',
  extraHints: '按练习要求表单填写数量、举例、检查清单和对照表。填写错误定位到具体输入，应用和运行分别确认；仅合成资料，不调用模型。',
};
export const browserDeclaredFormValue = { count: 0, examples: false, cases: [0], rows: [{ score: 0, note: null }] };
export const browserDeclaredFormDefinition: S2CanvasDefinition = structuredClone(browserListFormDefinition);
browserDeclaredFormDefinition.goal = '按专属练习表单填写，发现问题时定位到输入；应用后另行运行查看完整原生材料。';
browserDeclaredFormDefinition.initial.execution!.nodes[0].bindings.value = { kind: 'literal', value: browserDeclaredFormValue };
browserDeclaredFormDefinition.initial.execution!.nodes[0].presentation = {
  label: '填写练习要求', description: '按名称填写，有误时定位修改。应用只更新材料，不运行或评分。',
  inputForms: { value: { id: 'value', label: '练习要求', kind: 'form', fields: [
    { id: 'count', label: '题目数量', kind: 'number', required: true, min: 0, max: 20, integer: true },
    { id: 'examples', label: '需要举例', kind: 'boolean', required: true },
    { id: 'description', label: '练习备注', kind: 'multiline', maxLength: 80 },
    { id: 'cases', label: '检查清单', kind: 'list', minItems: 1, maxItems: 3, item: { id: 'count', label: '数量', kind: 'number', required: true, min: 0 } },
    { id: 'rows', label: '对照表', kind: 'table', minItems: 1, columns: [
      { id: 'score', label: '分数', type: 'number', required: true }, { id: 'note', label: '备注', type: 'string', nullable: true },
    ] },
  ] } },
};
browserDeclaredFormDefinition.initial.execution!.nodes[1].presentation = { label: '查看练习要求' };
// Separate paths exercise content-field editing and an actual native human wait.
// Neither path is an ancestor of the original fixed-parameter display target.
const declaredField = structuredClone(browserDeclaredFormDefinition.initial.execution!.nodes[0].presentation!.inputForms!.value);
browserDeclaredFormDefinition.blockTypes.push({ id: 'settings', label: '练习设置块', fields: [{ ...structuredClone(declaredField), id: 'content', label: '填写练习设置' }] });
browserDeclaredFormDefinition.initial.nodes.push({ id: 'fieldSettings', type: 'settings', position: { x: 30, y: 320 }, values: { content: JSON.stringify(browserDeclaredFormValue) } });
browserDeclaredFormDefinition.plugins!.push(cap('json', 'human-input'));
browserDeclaredFormDefinition.initial.execution!.nodes.push({ id: 'askSettings', ...cap('json', 'human-input'), position: { x: 30, y: 650 },
  bindings: { prompt: { kind: 'literal', value: '请补充这次练习要求。先填写再明确提交；仍可自由讨论，聊天不代替提交。' } },
  presentation: { label: '由你补充练习要求', responseForm: { ...structuredClone(declaredField), label: '本次回答' } } },
{ id: 'answerView', ...cap('json-tree', 'structured-view'), position: { x: 450, y: 650 }, bindings: {}, presentation: { label: '查看本次回答' } });
browserDeclaredFormDefinition.initial.execution!.links.push({ source: { nodeId: 'askSettings', portId: 'value' }, target: { nodeId: 'answerView', portId: 'value' } });
browserDeclaredFormDefinition.business!.purpose = '通过有界声明表单编辑完整原生材料；错误反馈不改变原有约束，不自动运行。';
browserDeclaredFormDefinition.business!.knowledge = [{ id: 'Types', title: '表单与原生材料', content: '名称是填写入口，声明约束仍由本地校验；题目数量0、否、空值与未填写不同。应用后再单独运行查看，不代表业务质量通过。' }];
browserDeclaredFormDefinition.business!.workflow![0] = { id: 'ListPath', goal: '填写并查看完整练习要求', actor: 'tool', capabilities: browserDeclaredFormDefinition.plugins,
  input: '合法专属表单的完整原生材料', output: '原样保留数字、布尔值、列表与表格的对象' };
browserDeclaredFormDefinition.business!.completion.reference = structuredClone(browserDeclaredFormDefinition.initial);
browserDeclaredFormDefinition.business!.completion.targetNodeIds = ['listView', 'answerView'];
browserDeclaredFormDefinition.business!.completion.coverage![0].nodeIds = ['listSelect', 'listView', 'askSettings', 'answerView'];

/** A separate, fully synthetic local-text scenario; it never submits the assembled prompt to an LLM. */
export const browserTemplateRequest: SceneInitialRequest = {
  source: 'build', sceneSkill: 'S2', subject: '合成浏览器验收：文本与提示词装配', knowledgePoints: [],
  extraHints: '只授权本地 text-template 的 bind 与 render。保留角色、任务、约束、模板四段原文，将前三段按变量逐项绑定后做单遍字面装配。初图只留最后一条变量连线让我补齐；解释、提出修改和申请运行由显式测试模式选择，修改与执行分别确认。不调用真实模型、网络、笔记或画像，也不声称测试提示词效果。',
};
const templateFields = {
  role: '你是一位耐心的提示词工程教练。',
  task: '解释检索增强生成，并给出一个学习场景。',
  constraints: '用中文回答，最多三点；原样保留符号 $& 与 {{literal}}，不要把它们当成代码。',
  template: '角色：{{role}}\n任务：{{task}}\n约束：{{constraints}}',
};
const templatePlugins = [cap('bind', 'text-template'), cap('render', 'text-template')];
const templateLabels: Record<string, string> = { role: '角色设定块', task: '任务要求块', constraints: '输出要求块', template: '提示词排版块' };
function templateDocument(prefix: string, complete: boolean): S2Document {
  return { nodes: Object.entries(templateFields).map(([id, content], index) => ({
    id: `${prefix}${id}`, type: id, position: { x: 30, y: 30 + index * 220 }, values: { content },
  })), edges: [], execution: { version: 1, nodes: [
    ...['role', 'task', 'constraints'].map((key, index) => ({
      id: `${prefix}bind${key[0].toUpperCase()}${key.slice(1)}`, ...cap('bind', 'text-template'), position: { x: 400 + index * 340, y: 30 },
      bindings: { key: { kind: 'literal' as const, value: key }, value: { kind: 'field' as const, nodeId: `${prefix}${key}`, fieldId: 'content' } },
      presentation: { label: `汇集${templateLabels[key].replace('块', '')}`, description: `读取${templateLabels[key]}的内容，供后面组合提示词；不改写原文。`, inputs: { value: templateLabels[key].replace('块', ''), variables: '前面汇集的材料' }, outputs: { variables: '汇集后的材料' } },
    })),
    { id: `${prefix}render`, ...cap('render', 'text-template'), position: { x: 1420, y: 30 }, bindings: { template: { kind: 'field', nodeId: `${prefix}template`, fieldId: 'content' } },
      presentation: { label: '生成完整提示词', description: '把角色、任务和输出要求按排版组合起来。这里只生成文本，不发送模型请求。', inputs: { template: '提示词排版', variables: '汇集好的材料' }, outputs: { text: '完整提示词' } } },
  ], links: [
    { source: { nodeId: `${prefix}bindRole`, portId: 'variables' }, target: { nodeId: `${prefix}bindTask`, portId: 'variables' } },
    { source: { nodeId: `${prefix}bindTask`, portId: 'variables' }, target: { nodeId: `${prefix}bindConstraints`, portId: 'variables' } },
    ...(complete ? [{ source: { nodeId: `${prefix}bindConstraints`, portId: 'variables' }, target: { nodeId: `${prefix}render`, portId: 'variables' } }] : []),
  ] } };
}
export const browserTemplateDefinition: S2CanvasDefinition = {
  version: 1, goal: '仅用两项已授权的本地文本装配能力，保留四段原文并产出完整文本；不执行提示词或验证模型效果。',
  instructions: {
    understanding: '区分单遍字面装配、真实LLM调用和效果评审；本合成示例只提供前者。先解释用户要求的类型与意义，不自动改图。',
    planning: '按需读取Types或Meaning知识。用户可补线或要求协作建议；只修改必要连线，应用与执行分别确认，不扩展插件或执行目标。',
    response: '原样保留文本、换行和字面符号。模板装配成功不代表LLM已接受提示词、生成回复或满足输出目标；只描述精确宿主状态。',
  },
  blockTypes: Object.entries(templateLabels).map(([id, label]) => ({ id, label, ...(id === 'template' ? { advanced: true } : {}), fields: [{ id: 'content', label: `填写${label.replace('块', '')}`, kind: 'multiline' }] })),
  plugins: templatePlugins, initial: templateDocument('', false),
  business: { version: 1, purpose: '将角色、任务、约束三个原文字符串装入变量字典，再将模板占位符替换为完整原文；纯本地、不发模型请求。',
    knowledge: [
      { id: 'Types', title: '文本、变量字典与模板', content: '文本像标签内容，bind把标签名和原文放进字符串字典；render读取字典并把模板中的同名占位符替换一次。core.text与structured-data.value不是同一种端口类型，不会自动解析JSON或执行表达式。' },
      { id: 'Meaning', title: '装配成功不是模型测试', content: '装好一封信不代表已寄出或收到答复。本地只做单遍字面替换，变量值里的$&或{{literal}}仍是原文，不递归展开、不调用模型，不评判提示词质量或业务效果。' },
    ],
    workflow: [{ id: 'LocalTemplate', goal: '绑定三个原文变量并单遍装配', actor: 'tool', capabilities: templatePlugins,
      input: '角色、任务、约束、模板四段合成原文', output: '一份完整的原始文本，不是LLM回复或提示词效果评分' }],
    completion: { mode: 'execution', reference: templateDocument('Private', true), targetNodeIds: ['Privaterender'],
      coverage: [{ requirementId: 'r1', stepIds: ['LocalTemplate'], nodeIds: ['PrivatebindRole', 'PrivatebindTask', 'PrivatebindConstraints', 'Privaterender'] }] },
    criteria: [{ id: 'Meaning', label: '可选装配边界说明', expectation: '说明本地装配与真实模型测试的区别，仅作解释建议，不作效果评分', method: 'advisory', required: false }],
  },
};

export const browserFreeTemplateText = '# 提示词草稿\n角色说明：{{ role }}\n请完成以下任务：{{task}}\n\n输出要求：{{constraints}}\n再次核对角色：{{role}}\n例子：{"说明":"普通单花括号，不执行代码"}\n$& 原样保留';
export const browserFreeTemplateRequest: SceneInitialRequest = {
  source: 'build', sceneSkill: 'S2', subject: '合成浏览器验收：按名称自由排版提示词', knowledgePoints: [],
  extraHints: '保留现有自定义排版、内联材料、重复引用和原始文本，按名称增删和调整片段；排版继续引用原内容块。明确应用后单独运行本地装配，不调用模型或自动评价。',
};
const freeTemplateDocument = (prefix: string): S2Document => {
  const document = templateDocument(prefix, true); document.nodes.find(node => node.id === `${prefix}template`)!.values.content = browserFreeTemplateText; return document;
};
export const browserFreeTemplateDefinition: S2CanvasDefinition = {
  ...structuredClone(browserTemplateDefinition), goal: '按材料名称自由排版，保留原内容块及引用；明确应用后单独生成完整提示词，不发送模型请求。',
  initial: freeTemplateDocument(''),
  business: { ...structuredClone(browserTemplateDefinition.business!), purpose: '通过文字片段和材料引用修改复杂模板，保留原块与其他材料；应用和本地装配分别确认。',
    completion: { mode: 'execution', reference: freeTemplateDocument('Private'), targetNodeIds: ['Privaterender'],
      coverage: [{ requirementId: 'r1', stepIds: ['LocalTemplate'], nodeIds: ['PrivatebindRole', 'PrivatebindTask', 'PrivatebindConstraints', 'Privaterender'] }] } },
};

/** Real host/model-session protocol with an explicitly synthetic transport; never a live-model acceptance. */
export const browserModelRequest: SceneInitialRequest = {
  source: 'build', sceneSkill: 'S2', subject: '合成浏览器验收：装配后逐次确认模型测试', knowledgePoints: [],
  extraHints: '只使用text-template的bind/render和model-test的generate。保留四段提示词原文与试验输入。初图留最后一条装配连线。模型测试默认关闭，预算授权与每次实际提示词确认分开。使用隔离合成传输，不读取模型配置、笔记或画像；不自动评审、重试或声称真实模型语义通过。',
};
function modelDocument(prefix: string, complete: boolean): S2Document {
  const doc = templateDocument(prefix, complete);
  doc.nodes.push({ id: `${prefix}testInput`, type: 'testInput', position: { x: 30, y: 910 }, values: { content: '合成试验输入：请为初学者举一个笔记检索的例子。' } });
  doc.execution!.nodes.push({ id: `${prefix}testModel`, ...cap('generate', 'model-test'), position: { x: 1790, y: 30 },
    bindings: { input: { kind: 'field', nodeId: `${prefix}testInput`, fieldId: 'content' } },
    presentation: { label: '测试提示词', description: '确认预算和本次实际请求后测试。本验收页只返回合成结果。', inputs: { prompt: '待测试的完整提示词', input: '试验输入' }, outputs: { text: '模型返回内容' } } });
  doc.execution!.links.push({ source: { nodeId: `${prefix}render`, portId: 'text' }, target: { nodeId: `${prefix}testModel`, portId: 'prompt' } });
  return doc;
}
const modelPlugins = [...templatePlugins, cap('generate', 'model-test')];
export const browserModelDefinition: S2CanvasDefinition = {
  ...structuredClone(browserTemplateDefinition),
  blockTypes: [...structuredClone(browserTemplateDefinition.blockTypes), { id: 'testInput', label: '试验输入块', fields: [{ id: 'content', label: '填写试验输入', kind: 'multiline' }] }],
  goal: '保留原文，单遍装配提示词，并在独立预算及逐次实际请求确认后测试模型节点；本示例回包为合成内容，不证明真实模型效果。',
  instructions: {
    understanding: '先理解解释、协作和执行要求。区分本地装配、模型测试授权、逐次实际请求确认和业务评价；不能从用户要求运行推导出付费授权。',
    planning: '仅在选中能力内提出最小改图或目标执行申请。需要模型时检查pluginContext.modelTest；没有授权则说明缺少本局批准，不自行扩大权限或使用pluginRequests绕过确认。',
    response: '只引用宿主实际状态。模型输出完整不等于符合教学目标；未经明确指标和用户要求，不自动评分、重试或修订提示词。合成传输不代表真实模型回包。',
  },
  plugins: modelPlugins, initial: modelDocument('', false),
  business: { version: 1, purpose: '本地组装后逐次确认测试，保留完整原文和调用记录；生产路径可使用配置的模型，本浏览器仅使用合成传输。',
    knowledge: [
      { id: 'Types', title: '装配、输入与测试节点', content: 'bind把原文加入变量字典，render输出完整core.text；model-test接收prompt和可选input。端口类型匹配不等于允许付费调用，还须独立预算和逐次确认。' },
      { id: 'Meaning', title: '完整输出与效果评价', content: '装配完成只是信写好了，用户确认后才能寄出。已获得完整模型回包也不代表满足指标；截断或不确定结束的预览不能当作完整产物交给下游。本示例信件回执是合成传输，不是真实模型效果证据。' },
    ],
    workflow: [{ id: 'ControlledTest', goal: '装配原文并经用户确认执行模型测试', actor: 'tool', capabilities: modelPlugins,
      input: '四段提示词原文和一段合成试验输入', output: '完整文本回包或明确未完成记录；不自动判断效果' }],
    completion: { mode: 'execution', reference: modelDocument('Private', true), targetNodeIds: ['PrivatetestModel'],
      coverage: [{ requirementId: 'r1', stepIds: ['ControlledTest'], nodeIds: ['PrivatebindRole', 'PrivatebindTask', 'PrivatebindConstraints', 'Privaterender', 'PrivatetestModel'] }] },
    criteria: [{ id: 'Meaning', label: '可选测试边界说明', expectation: '区分装配、完整回包、合成协议验收和业务指标；不冒充真实模型评审', method: 'advisory', required: false }],
  },
};
