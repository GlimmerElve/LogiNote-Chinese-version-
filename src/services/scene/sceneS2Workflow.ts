import type { S2CanvasDefinition, S2Document, S2InputBinding, S2Workflow, S2WorkflowNode, S2WorkflowCondition } from '../../types/sceneS2';
import type { S2ExecutionLink, S2Json } from '../../types/sceneS2Plugin';
import { canonicalS2Json, preflightS2ExecutionGraph, readS2Artifact } from './sceneS2PluginProtocol';
import { s2BuiltinPluginRegistry, s2CapabilityKey, readS2PluginBindings } from './sceneS2PluginRegistry';
import { readS2NodePresentation } from './sceneS2Presentation';

const registry = s2BuiltinPluginRegistry();
/** Canvas-owned content policy, shared by every interaction pack and Agent stage. */
export const S2_CONTENT_EDITABILITY_RULES = `S2内容编辑约束：initial/current.nodes实例readOnly?:布尔值；省略/false可编辑，true固定全部values，贯穿预览/运行的学习者与互动Agent全部修改入口。没有运行时解锁命令。
场景原只读块的id/type/values/readOnly:true须保留，不可删除、清空、替换、改型或解锁，批量/先删后加/整图替换同样受限；label/position、读取、连线和执行不受限。新独立场景可按目标设置/修复，当前场景编辑保留原锁。
同一种通用text/content块可有固定实例(readOnly:true)和可编辑实例；其他内容块类型同样适用。只读是实例配置，不修改包或新增专用类型，不授予权限，不预枚举玩法，非明确要求不锁定。`;
/** Compiled only for assembly, editing intent or an existing composite canvas. */
export const S2_COMPOSITE_AGENT_RULES = '组合：initial/current可选composites:[{id,label,nodeIds:[子树全部真实步骤id],parentId?:父组合id}]。最多4层、无环，父级包含全部子成员；仅祖孙可重叠，不与groups重叠。内部when来源一起封装，内容块留外部。接口重算，不是插件/授权。按需建议{op:"set-composite",composite}、{op:"remove-composite",id}或{op:"move-composite",id,parentId:父级id或null总画布}，确认后整批校验；搬移自动更新祖先成员。拆开保留步骤、子组合升一级；封装/搬移不执行。executionRequest只用真实步骤及上游，资源/模型授权仍独立。内部批量复制可用action.compositeId指定当前组合，避免复制整个祖先。';
const WORKFLOW_RULES = `S2自由组合规则：plugins为目录内精确{pluginId,pluginVersion,capabilityId}装配列表，不是授权。根据场景目标自主选择，也可不用插件，不固定教学流程。各能力用途/类型见目录；参数绑定输入端口，不执行表达式。renderer只读，不通过pluginRequests调用。
节点可选presentation:{label,description?,inputs?:{端口id:显示名},outputs?:{端口id:显示名},inputForms?:{端口id:控件声明},responseForm?:控件声明}。inputForms仅用于structured-data.value@1输入、控件id=端口id；responseForm仅用于human-input@1.0.0/json回答、id=value，不是工具输入或授权。子字段id映射实际JSON键、label用场景语言；用户填表提交原生值，真实端口仍校验，不改权限，commands用ID。
使用宿主模型服务的能力须遵守已安装model-session@1契约，不以业务ID推断权限。用户通过当前终端执行入口启动本次请求；模型、完整输入、参数和运行限制由本地程序绑定与检查。Agent只能提出executionRequest，不代用户启动，不用pluginRequests绕过，不缓存或自动重试。能力声明、编辑和模板不是授权；完整输入与返回不注入画像、笔记或主持历史。截断/未知结束不发布成功产物，执行成功不等于业务目标达成。
initial/current中的execution可选，格式{version:1,nodes:[{id,pluginId,pluginVersion,capabilityId,position:{x,y},bindings:{端口id:{kind:"field",nodeId:"内容块id",fieldId:"字段id"}或{kind:"literal",value:完整类型化JSON}}}],links:[{source:{nodeId,portId},target:{nodeId,portId}}]}。bindings及执行线不能同时占用单值输入；文本字段只能连core.text，解析必须显式用parse-json；select的pointer须完整提供，空字符串表示根。允许未接线草稿但不能运行缺输入图。普通edges是语义关联，可有环且不自动执行；execution.links是类型化数据依赖，只能DAG，不决定对话或教学阶段。
互动Agent可以在本局批准范围内返回画布修改commands：{op:"add-execution-node",node}、{op:"update-execution-node",id,bindings}、{op:"remove-execution-node",id}、{op:"unbind-input",id,portId}、{op:"connect-ports",link}、{op:"disconnect-ports",link}。仅提出建议，用户确认后本地校验整批应用，不能扩权。需要先改图时，本轮只建议改图，确认后再申请执行，不能请求尚未存在的新节点。
已有完整图需要运行时可返回executionRequest:{targetNodeIds:[目标节点id],reason:"与本次需求对应的目的",force?:布尔值}，本地只运行这些目标和真实上游；不强制运行整图、复查、讲解或下一阶段。默认复用已验证的本局纯计算缓存，只有用户明确要求重算时才建议force:true；cached和cacheReuses表示复用旧执行的完整产物，不是新的工具执行，不得声称重新运行过。失败/取消/来源不完整的产物不复用。每轮在普通回应、commands、pluginRequests或executionRequest中按语义选择；不得同时发出单次调用和执行图请求，不自动重试。收到本地结果后再决定解释、追问、修改建议或下一步；没有本地结果不能声称执行成功。
current.groups可选，格式[{id,label,nodeIds:[内容或执行节点id],collapsed:布尔值}]。分组/折叠仅组织展示，不能嵌套或重叠，不改变数据依赖、权限或教学阶段。可按目标建议{op:"set-group",group}、{op:"remove-group",id}及{op:"batch-nodes",action:{kind:"copy|delete|move",nodeIds,delta?:{x,y}}}。复制由宿主重映射ID，只复制内部连线；不复制执行凭据、缓存、预算或授权。删除原文仍需用户明确要求并确认；批量操作不能绕过大小和能力边界。
未接真实工具的业务流程可用已授权workflow-simulation@1.0.0的step/inspect。按目标设计purpose(目的)、assumptions(假设)、sample(示例输出)，经commands建议、用户确认才应用。sample由用户或你设计，不是本地按输入推理；改输入须重新审阅假设/示例。step输入二选一：input(structured-data.value)或previous(workflow-simulation.result)；previous传入上一步预设输出。每步保留完整轨迹，最多16步、整体64KiB，超限失败不截断；inspect只展示。模拟独立类型不得直连真实转换/检查端口，不得伪装真实工具返回或换类型冒充已验证事实。succeeded仅表示模拟记录完成，cached仅复用模拟，不代表业务成功。仍不支持循环、等待和外部业务执行，不得编造这些调度已经发生；可仅讨论设计、修改或按需运行局部，不强制模拟。
显式条件分支：执行节点可有when:{nodeId:"条件来源执行节点",portId:"输出端口",pointer:"标准JSON Pointer，可为空表示整体",equals:完整JSON值,match:布尔值}。本地从当前完整单值输出读取pointer，结构化精确相等结果与match一致时才运行本节点；match:false表示不相等分支，不等同于验证失败。仅支持core.assessment、structured-data.value、workflow-simulation.result来源，判断模拟轨迹时conditionEvidence.simulation为true，不能称为真实业务验证。条件来源也是依赖，需自动包含在所选子图中；数据依赖+条件依赖整体拒绝循环。缺字段、条件来源失败或没有完整产物会blocked，不能猜成false；未命中为skipped，不扣调用次数，普通数据下游也跳过。不要把互斥两支连入普通的必需全部输入节点期待自动合并，需要显式互斥合流组件。可用{op:"set-execution-condition",id,when}设置、用when:null明确解除。删除仍被引用的条件来源会被拒绝，不能自动解除保护。条件节点不能通过pluginRequests单独绕过，必须executionRequest确认调度；执行图不运行未选中的其他分支或业务阶段。
互斥分支合流：根据目标可选workflow-merge@1.0.0的merge-json(structured-data.value)、merge-assessment(core.assessment)或merge-simulation(workflow-simulation.result)。各分支同类型输出接多路输入candidates，输出selected保留相同语义类型；不混用JSON、评价和模拟类型，不把模拟变成真实结果。只能executionRequest执行，不能pluginRequests单独调用从而绕过候选检查。宿主先完成所选依赖，仅跳过skipped分支；失败/阻塞/取消/未知分支仍阻塞合流，不能偷选另一支冒充完成。零路候选则合流及其下游skipped，不扣调用次数；恰好一路才转交；两路以上即使值相同也报冲突，不自动取首项、合并或择优。冲突是在调用适配器前拒绝，不生成执行凭据；执行记录mergeEvidence列出候选产物、跳过/阻塞来源和本轮选中产物，缓存命中仍需重新检查本轮候选，不能把旧选择当成本轮来源。常量绑定只算一项完整候选，可与多路连线共同计数，不会覆盖连线。无数据线的语义关联不算候选。不强制使用合流，互斥规则由你按用户目标设计；本地仍只负责校验和调度。`;
export const S2_WORKFLOW_AGENT_RULES = WORKFLOW_RULES.replace('仍不支持循环、等待和外部业务执行', '仍不支持循环和外部业务执行')
  .replace('仅支持core.assessment、structured-data.value、workflow-simulation.result来源', '支持core.assessment、structured-data.value、workflow-simulation.result和human-input.decision来源')
  + `\n人工等待：按场景目标可选择human-input@1.0.0的text、json、confirm，kind=human；都需prompt(core.text)，可选context(structured-data.value)或simulation(workflow-simulation.result)供用户核对。text输出text(core.text)，json输出value(structured-data.value)，confirm输出decision(human-input.decision)。confirm的/approved为用户真实布尔选择，可作为when条件来源；拒绝也是有效选择，必须用approved=true条件保护需要同意的下游，不要把拒绝当作工具失败或自动同意。
人工节点只能通过executionRequest进入等待，不能pluginRequests调用、不能由Agent填写/确认答案或用commands伪造提交。宿主显示本次真实输入，用户提交后产生source.kind=user的完整产物及humanEvidence，不是插件执行凭据、不扣工具次数、不缓存答案、不扩大授权；不代表人工输入事实正确。等待保留已完成节点，不重复执行上游；独立分支和其他队列仍可运行，依赖该输入的节点才等待。取消、结束或画布语义修改使等待失效，布局移动不失效；再次运行需新的人工回答。只在当前内存会话恢复，保存模板/导入/刷新不恢复等待或用户确认。等待期间可继续自由对话，但对话文本不自动作为节点答案。不要强制场景必须有等待节点。`;
function object(raw: unknown, allowed: string[]) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`S2 执行画布字段必须为对象；此层仅允许：${allowed.join(', ')}`);
  const unknown = Object.keys(raw).filter(key => !allowed.includes(key));
  if (unknown.length) throw new Error(`S2 执行画布包含未支持配置：${unknown.join(', ')}；此层仅允许：${allowed.join(', ')}`);
  return raw as Record<string, any>;
}
function id(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length > 64 || !/^[A-Za-z][A-Za-z0-9_-]*$/.test(raw) || ['__proto__', 'constructor', 'prototype'].includes(raw)) throw new Error('S2 执行对象标识符无效');
  return raw;
}
/** Editing allows incomplete inputs, NEVER incompatible ports or execution cycles. Run preflight is strict. */
export function readS2Workflow(raw: unknown, document: Pick<S2Document, 'nodes'>, plugins: S2CanvasDefinition['plugins'], complete = false): S2Workflow {
  const graph = object(raw, ['version', 'nodes', 'links']);
  if (graph.version !== 1 || !Array.isArray(graph.nodes) || graph.nodes.length > 40 || !Array.isArray(graph.links) || graph.links.length > 80) throw new Error('S2 执行画布必须有version:1、nodes数组（≤40）、links数组（≤80）；即使无连线也需links:[]');
  const allowed = new Set(readS2PluginBindings(plugins ?? []).map(s2CapabilityKey));
  const nodes: S2WorkflowNode[] = graph.nodes.map((raw: unknown) => {
    const node = object(raw, ['id', 'pluginId', 'pluginVersion', 'capabilityId', 'componentId', 'position', 'bindings', 'when', 'presentation']);
    const ref = { id: id(node.id), pluginId: node.pluginId, pluginVersion: node.pluginVersion, capabilityId: node.capabilityId };
    if (!allowed.has(s2CapabilityKey(ref))) throw new Error('执行节点使用了场景未装配的插件能力');
    const cap = registry.capability(ref), position = object(node.position, ['x', 'y']);
    if (!['x', 'y'].every(key => typeof position[key] === 'number' && Number.isFinite(position[key]) && Math.abs(position[key]) <= 100000)) throw new Error('S2 执行节点位置无效');
    if (document.nodes.some(item => item.id === ref.id)) throw new Error('S2 内容块与执行节点不能重名');
    const inputs = object(node.bindings, cap.inputs.map(port => port.id));
    const bindings = Object.fromEntries(Object.entries(inputs).map(([key, raw]) => {
      const port = cap.inputs.find(port => port.id === key)!;
      if (raw?.kind === 'field') {
        const binding = object(raw, ['kind', 'nodeId', 'fieldId']);
        const source = document.nodes.find(node => node.id === id(binding.nodeId));
        if (port.type.id !== 'core.text' || port.type.version !== 1) throw new Error(`执行节点 ${ref.id} 的 bindings.${key} 字段引用类型不符：kind=field仅提供core.text@1，目标需要${port.type.id}@${port.type.version}；请改用匹配类型的execution.links或原始JSON常量，不能隐式解析或转换`);
        if (!source) throw new Error(`执行节点 ${ref.id} 的 bindings.${key} 字段引用来源不存在：${binding.nodeId}`);
        if (!Object.hasOwn(source.values, id(binding.fieldId))) throw new Error(`执行节点 ${ref.id} 的 bindings.${key} 字段引用不存在：${binding.nodeId}.${binding.fieldId}；可用字段：${Object.keys(source.values).join(', ')}`);
        return [key, { kind: 'field', nodeId: binding.nodeId, fieldId: binding.fieldId } satisfies S2InputBinding];
      }
      const binding = object(raw, ['kind', 'value']);
      if (binding.kind !== 'literal') throw new Error('S2 只允许字段引用或完整类型化常量');
      readS2Artifact(registry, { protocolVersion: 1, id: 'validation', type: port.type, complete: true,
        source: { sceneId: 'validation', runId: 'validation', nodeId: ref.id, revision: 0, kind: 'host' }, payload: { kind: 'inline', value: binding.value } });
      return [key, { kind: 'literal', value: structuredClone(binding.value) } satisfies S2InputBinding];
    }));
    let when: S2WorkflowCondition | undefined;
    if (node.when !== undefined) {
      const condition = object(node.when, ['nodeId', 'portId', 'pointer', 'equals', 'match']);
      if (typeof condition.pointer !== 'string' || condition.pointer.length > 500 || condition.pointer !== '' && (!condition.pointer.startsWith('/') || /~(?![01])/u.test(condition.pointer))
        || typeof condition.match !== 'boolean' || !Object.hasOwn(condition, 'equals')) throw new Error('条件需要标准 JSON Pointer、完整 equals 和布尔 match');
      readS2Artifact(registry, { protocolVersion: 1, id: 'validation', type: { id: 'structured-data.value', version: 1 }, complete: true,
        source: { sceneId: 'validation', runId: 'validation', nodeId: ref.id, revision: 0, kind: 'host' }, payload: { kind: 'inline', value: condition.equals } });
      if (new TextEncoder().encode(canonicalS2Json(condition.equals)).byteLength > 6000) throw new Error('条件比较值最多6000字节');
      when = { nodeId: id(condition.nodeId), portId: id(condition.portId), pointer: condition.pointer, equals: structuredClone(condition.equals), match: condition.match };
    }
    return { ...ref, ...(node.componentId !== undefined ? { componentId: id(node.componentId) } : {}), position: { x: position.x, y: position.y }, bindings, ...(when ? { when } : {}),
      ...(node.presentation !== undefined ? { presentation: readS2NodePresentation(node.presentation, cap, ref) } : {}) };
  });
  // Use the shared port/version/cardinality/DAG checks. Placeholder counts permit editing ONLY.
  const links = structuredClone(graph.links) as S2ExecutionLink[];
  const provided = nodes.flatMap(node => registry.capability(node).inputs.flatMap(port => {
    const bound = Object.hasOwn(node.bindings, port.id);
    const connected = links.some(link => link?.target?.nodeId === node.id && link?.target?.portId === port.id);
    return bound || !complete && port.required && !connected ? [{ nodeId: node.id, portId: port.id, count: 1 }] : [];
  }));
  preflightS2ExecutionGraph(registry, nodes.map(({ id, pluginId, pluginVersion, capabilityId }) => ({ id, pluginId, pluginVersion, capabilityId })), links, provided);
  for (const node of nodes) if (node.when) {
    const source = nodes.find(item => item.id === node.when!.nodeId);
    if (!source) throw new Error('条件来源不存在；不能删除来源后静默取消条件，请先明确解除条件或删除依赖节点');
    const port = registry.capability(source).outputs.find(port => port.id === node.when!.portId);
    if (!port?.required || port.multiple || !['core.assessment', 'structured-data.value', 'workflow-simulation.result', 'human-input.decision'].includes(port.type.id)) throw new Error('条件来源必须是受支持的单值完整 JSON 输出端口');
  }
  s2WorkflowOrder({ version: 1, nodes, links }); // Data and control dependencies MUST be acyclic together.
  return { version: 1, nodes, links };
}
/** A condition is a control dependency, never a synthetic data port or a semantic edge. */
export function s2WorkflowOrder(graph: S2Workflow): string[] {
  const pending = new Map(graph.nodes.map(node => [node.id, new Set([...graph.links.filter(link => link.target.nodeId === node.id).map(link => link.source.nodeId), ...(node.when ? [node.when.nodeId] : [])])])), order: string[] = [];
  while (pending.size) {
    const ready = [...pending].filter(([, dependencies]) => !dependencies.size).map(([id]) => id);
    if (!ready.length) throw new Error('数据与条件依赖组成循环，不能执行');
    for (const id of ready) { order.push(id); pending.delete(id); for (const dependencies of pending.values()) dependencies.delete(id); }
  }
  return order;
}
/** Select only requested targets and their real ancestors, not a mandatory full-scene workflow. */
export function selectS2Execution(document: S2Document, plugins: S2CanvasDefinition['plugins'], targets?: string[]) {
  const graph = readS2Workflow(document.execution ?? { version: 1, nodes: [], links: [] }, document, plugins);
  if (!graph.nodes.length) throw new Error('尚未添加执行节点');
  if (targets && (!targets.length || targets.some(target => !graph.nodes.some(node => node.id === target)))) throw new Error('执行目标不存在');
  const needed = new Set<string>();
  const visit = (id: string) => { if (needed.has(id)) return; needed.add(id); graph.links.filter(link => link.target.nodeId === id).forEach(link => visit(link.source.nodeId)); const when = graph.nodes.find(node => node.id === id)!.when; if (when) visit(when.nodeId); };
  (targets ?? graph.nodes.map(node => node.id)).forEach(visit);
  const selected = readS2Workflow({ ...graph, nodes: graph.nodes.filter(node => needed.has(node.id)), links: graph.links.filter(link => needed.has(link.target.nodeId)) }, document, plugins, true);
  const order = s2WorkflowOrder(selected);
  return { graph: selected, order };
}
/** Layout changes do not invalidate data/receipts or schedule model calls. */
export function s2SemanticDocument(document: S2Document): S2Json {
  return { nodes: document.nodes.map(({ position, label, ...node }) => node), edges: document.edges,
    ...(document.execution ? { execution: { ...document.execution, nodes: document.execution.nodes.map(({ position, presentation, ...node }) => node) } } : {}) } as unknown as S2Json;
}
export function s2ExecutionLinkKey(link: S2ExecutionLink) { return JSON.stringify([link.source.nodeId, link.source.portId, link.target.nodeId, link.target.portId]); }
