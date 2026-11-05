import type { SceneInteractionPack, ScenePackConfig } from '../../types/sceneInteractionPack';
import type { S2CanvasDefinition } from '../../types/sceneS2';
import { snapshotS2CompositeData } from './sceneS2Composite';
import { canonicalS2Json } from './sceneS2PluginProtocol';
import { readS2Definition } from './sceneS2Canvas';
import { S2DesignJsonError, type S2DesignSources, type S2DesignStage } from './sceneS2Design';
import { assertS2PublicEdit, compileS2PublicCanvas, projectS2PublicCanvas, publicS2Catalog, type S2PublicCanvas } from './sceneS2PublicAuthoring';
import { projectS2AgentComponents, S2_AGENT_COMPONENT_RULES } from './sceneS2AgentCatalog';
import { createS2PublicRepair, S2PublicDesignValidationError, type S2PublicRepair } from './sceneS2PublicRepair';
import { S2_BUILTIN_INTERACTION_EVENTS } from './sceneS2InteractionProtocol';
import { validateS2PublicInteraction } from './sceneS2InteractionEvents';
import { scenePackAllowsExecution } from './sceneInteractionPackProtocol';

export const S2_PUBLIC_DESIGN_SELECT = `按用户目标从publicComponentIndex选择要阅读的组件，只返回{componentIds:[组件id]}。索引只有用途，不能据此猜参数或端口。现有公开实例要继续使用时也读取其组件。读取不执行组件。`;
export const S2_PUBLIC_DESIGN_COMPOSE = `按目标搭建公开画布。返回{canvas:{version:1,nodes:[{id,componentId,position:{x,y},label?,readOnly?:布尔值,values?:{公开参数id:原生JSON值}}],connections:[{source:{nodeId,portId},target:{nodeId,portId}}]},instructions?:{understanding,planning,response},interaction?:{version:1,triggers:[{id,on:{event,nodeId},task,scope?:{actions?:["reply"|"edit"|"execute"],nodeIds?:[公开实例id]}}]}}。
${S2_AGENT_COMPONENT_RULES}
只使用已读组件，连接输出到输入，遵守required/multiple。readOnly只用于内容实例，既有固定原文不得删除、替换或解锁。保留用户原文，缺少资料留入口；不用文字冒充连线，不编造运行结果。instructions是可选的场景内互动Agent策略，不强制教学或评判流程。
仅按用户目标配置自动响应：event选interactionEvents；nodeId是事件来源的公开实例，s2.node事件须来自执行组件。最多16条，id唯一且遵循实例标识规则，task最多4000字符。scope默认仅reply；actions非空且不重复，nodeIds省略表示所有公开实例、[]表示空范围，指定时最多80个且不得新增节点。省略interaction保留currentInteraction；返回triggers:[]清空。删除被规则引用的实例时须明确修正规则，配置不执行或授权。`;
const CONTINUE = `需要补读时只能返回{read:{componentIds:[尚未读的组件id]}}，不能混合canvas、instructions或interaction。最多补读一批；不能猜未读接口。`;
const NO_MORE_READS = '本轮不能补读，直接使用已读接口返回公开画布，不输出read。';
const REVIEW = `只审查公开候选是否表达用户目标、保留原文，连接和参数用途合理，自动任务符合目标。返回{approved:布尔值,feedback?:简短修改意见}。这是设计审查，不运行组件、不评价实际业务结果，也不读取内部实现。`;
const fail = (message: string): never => { throw new Error(`S2 公开搭建：${message}；原画布未修改`); };

export interface S2PublicDesignOptions {
  pack: SceneInteractionPack;
  current: S2CanvasDefinition;
  sources: S2DesignSources;
  /** The terminal retains transport configuration, abort and truncation checks. */
  call(prompt: string, input: Record<string, unknown>, maxOutputTokens: number): Promise<Record<string, unknown>>;
  signal?: AbortSignal;
  onProgress?: (stage: S2DesignStage, attempt: number) => void;
  /** Explicit compatibility input never exposes the native implementation catalogue. */
  disclosure?: 'progressive' | 'complete';
  review?: boolean;
}

function object(raw: unknown, allowed: readonly string[], required: readonly string[] = [], path = '/'): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new S2PublicDesignValidationError('PUBLIC_FIELD', path, '需要完整对象');
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).some(name => !allowed.includes(name)) || required.some(name => !Object.hasOwn(value, name)))
    throw new S2PublicDesignValidationError('PUBLIC_FIELD', path, '包含未知字段或缺少必需字段');
  return value;
}
function instructions(raw: unknown): S2CanvasDefinition['instructions'] {
  const value = object(raw, ['understanding', 'planning', 'response'], ['understanding', 'planning', 'response'], '/instructions');
  for (const [key, text] of Object.entries(value)) if (typeof text !== 'string' || text.length > 6000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(text))
    throw new S2PublicDesignValidationError('PUBLIC_INSTRUCTIONS', `/instructions/${key}`, '互动策略须为完整文本');
  return value as unknown as S2CanvasDefinition['instructions'];
}

/** New explicit-authoring packages have one public vocabulary for people and Agents.
 * Native definitions, runtime manifests and package instructions never enter a model call. */
export async function buildS2PublicDesign(options: S2PublicDesignOptions): Promise<S2CanvasDefinition> {
  const check = () => { if (options.signal?.aborted) throw new DOMException('已停止', 'AbortError'); };
  check();
  const catalog = publicS2Catalog(options.pack);
  if (!catalog) fail('当前包未声明公开搭建目录');
  const context = { goal: options.current.goal, instructions: structuredClone(options.current.instructions) };
  let currentInteraction = options.current.interaction === undefined ? undefined : structuredClone(options.current.interaction);
  const interactionEvents = [...S2_BUILTIN_INTERACTION_EVENTS, ...(options.pack.interaction?.events ?? [])].map(({ id, purpose }) => ({ id, purpose }));
  const keepMetadata = (compiled: ScenePackConfig, interaction: unknown = currentInteraction): ScenePackConfig => {
    const metadata = {
      ...(options.current.business === undefined ? {} : { business: structuredClone(options.current.business) }),
      ...(options.current.criteria === undefined ? {} : { criteria: structuredClone(options.current.criteria) }),
      ...(options.current.designBrief === undefined ? {} : { designBrief: structuredClone(options.current.designBrief) }),
    };
    const definition = readS2Definition({ ...compiled.definition, ...metadata, ...(interaction === undefined ? {} : { interaction }) });
    validateS2PublicInteraction(options.pack, definition);
    return { ...compiled, definition };
  };
  // An explicitly empty public directory is a closed authoring surface, not a
  // reason to disclose the runtime catalogue or ask an Agent to rebuild it.
  if (!catalog.components.length) {
    const result = keepMetadata(compileS2PublicCanvas(options.pack, { version: 1, nodes: [], connections: [] }, context));
    assertS2PublicEdit(options.pack, { definition: options.current, document: options.current.initial }, result);
    return result.definition;
  }

  const current = projectS2PublicCanvas(options.pack, options.current, options.current.initial);
  // All packages pass through the same local projection. The original catalogue
  // remains intact for menus, the compiler and runtime validation.
  const components = projectS2AgentComponents(catalog.components);
  const index = components.map(({ id, label, purpose }) => ({ id, label, purpose }));
  const byId = new Map(components.map(component => [component.id, component]));
  const selected = new Set<string>();
  const sources = snapshotS2CompositeData({ task: options.sources.task, subject: options.sources.subject,
    currentGoal: options.sources.currentGoal, knowledgePointTitles: options.sources.knowledgePointTitles });
  let calls = 0, reads = 0, formatRepairUsed = false, protocolRepairUsed = false;
  const maxCalls = options.review === true ? 6 : 4;
  const copy = <T>(value: T) => snapshotS2CompositeData(value, { maxBytes: 786432, maxEntries: 48000 });
  const dispatch = async (prompt: string, data: Record<string, unknown>, outputTokens: number, stage: S2DesignStage = 'assemble'): Promise<Record<string, unknown>> => {
    const invoke = async (extra: Record<string, unknown> = {}) => {
      check();
      if (calls >= maxCalls) fail(`本次搭建已达到${maxCalls}次请求上限`);
      options.onProgress?.(stage, calls + 1); check(); calls++;
      const raw = await options.call(prompt + (Object.keys(extra).length ? '\nformatRepair只修复同阶段JSON语法，保留原目标，不增加组件或权限。' : ''),
        copy({ stage, ...data, ...extra }), outputTokens);
      check();
      return object(copy(raw), Object.keys(raw));
    };
    try { return await invoke(); }
    catch (error) {
      if (!(error instanceof S2DesignJsonError) || formatRepairUsed || error.output.length > 64000 || calls >= maxCalls) throw error;
      formatRepairUsed = true;
      return invoke({ formatRepair: { previousOutput: error.output } });
    }
  };
  const read = (raw: unknown) => {
    const value = object(raw, ['componentIds'], ['componentIds']);
    if (!Array.isArray(value.componentIds) || value.componentIds.length > 16 || value.componentIds.some(id => typeof id !== 'string')) fail('componentIds须为最多16项的组件ID数组');
    const ids = value.componentIds as string[];
    if (new Set(ids).size !== ids.length || ids.some(id => !byId.has(id) || selected.has(id))) fail('组件未公开、重复或已经读取');
    if (reads && !ids.length) fail('补读不能是空列表');
    if (reads >= 2 || selected.size + ids.length > 16) fail('公开接口读取超出本次范围');
    ids.forEach(id => selected.add(id)); reads++;
  };
  const execution = scenePackAllowsExecution(options.pack) ? 'on-demand' : 'none';
  const selectionData = { authoringPhase: 'select', sources, publicComponentIndex: index, execution,
    currentComponents: current.nodes.map(({ id, componentId }) => ({ id, componentId })) };
  let selection = await dispatch(S2_PUBLIC_DESIGN_SELECT, selectionData, 4096);
  try { read(selection); }
  catch (error) {
    if (protocolRepairUsed || formatRepairUsed || calls + 2 > maxCalls) throw error;
    protocolRepairUsed = true;
    selection = await dispatch(S2_PUBLIC_DESIGN_SELECT, { ...selectionData, selectionError: '只选择索引中尚未读取的公开组件ID，不填写其它字段。' }, 4096);
    read(selection);
  }
  const details = () => [...selected].map(id => byId.get(id)!);
  let previousCanvas: S2PublicCanvas | undefined, previousInstructions: S2CanvasDefinition['instructions'] | undefined, feedback: string | undefined;
  let repair: S2PublicRepair | undefined;
  while (calls < maxCalls) {
    const unread = index.filter(component => !selected.has(component.id));
    const canRead = unread.length > 0 && selected.size < 16 && reads < 2 && maxCalls - calls >= (options.review === true ? 3 : 2);
    const output = await dispatch(`${S2_PUBLIC_DESIGN_COMPOSE}\n${canRead ? CONTINUE : NO_MORE_READS}${repair ? '\n按repair.issue修正repair.candidate，保留其它正确内容，返回完整canvas；候选未通过校验，不是执行结果或权限。' : ''}`, {
      authoringPhase: 'compose', sources, execution, ...(canRead ? { publicComponentIndex: unread } : {}), components: details(),
      interactionEvents, ...(currentInteraction === undefined ? {} : { currentInteraction }),
      current, ...(previousCanvas ? { previousCanvas } : {}), ...(previousInstructions ? { previousInstructions } : {}), ...(feedback ? { feedback } : {}),
      ...(repair ? { repair } : {}),
    }, 16384);
    if (Object.hasOwn(output, 'read')) {
      if (!canRead) fail('本轮已无可用补读批次');
      object(output, ['read'], ['read']); read(output.read); continue;
    }
    let canvas: S2PublicCanvas, policy: S2CanvasDefinition['instructions'], candidate: S2CanvasDefinition;
    try {
      const envelope = object(output, ['canvas', 'instructions', 'interaction'], ['canvas']);
      const rawCanvas = object(envelope.canvas, ['version', 'nodes', 'connections'], ['version', 'nodes', 'connections'], '/canvas');
      if (!Array.isArray(rawCanvas.nodes)) throw new S2PublicDesignValidationError('PUBLIC_FIELD', '/canvas/nodes', 'nodes需要完整数组');
      const unreadIndex = rawCanvas.nodes.findIndex(node => !node || typeof node !== 'object' || !selected.has((node as { componentId?: string }).componentId ?? ''));
      if (unreadIndex >= 0) throw new S2PublicDesignValidationError('PUBLIC_COMPONENT_UNREAD', `/canvas/nodes/${unreadIndex}/componentId`, '候选使用了未公开或尚未读取的组件');
      for (const fixed of current.nodes.filter(node => node.readOnly)) {
        const next = (rawCanvas.nodes as S2PublicCanvas['nodes']).find(node => node.id === fixed.id);
        if (!next || !next.readOnly || next.componentId !== fixed.componentId || canonicalS2Json(next.values ?? {}) !== canonicalS2Json(fixed.values ?? {}))
          throw new S2PublicDesignValidationError('PUBLIC_READONLY', '/canvas/nodes', '既有固定原文不能删除、替换或解锁');
      }
      policy = envelope.instructions === undefined ? previousInstructions ?? context.instructions : instructions(envelope.instructions);
      const interaction = Object.hasOwn(envelope, 'interaction') ? envelope.interaction : repair?.candidate.interaction ?? currentInteraction;
      const result = keepMetadata(compileS2PublicCanvas(options.pack, rawCanvas, { goal: context.goal, instructions: policy }), interaction);
      assertS2PublicEdit(options.pack, { definition: options.current, document: options.current.initial }, result);
      candidate = result.definition;
      canvas = copy(rawCanvas as unknown as S2PublicCanvas);
    } catch (error) {
      if (protocolRepairUsed || formatRepairUsed || calls >= maxCalls - (options.review === true ? 1 : 0)) throw error;
      const nextRepair = createS2PublicRepair(error, output, details());
      if (!nextRepair) throw error;
      protocolRepairUsed = true;
      repair = nextRepair;
      // A protocol repair already carries the current failed candidate; do not
      // duplicate an earlier review candidate/feedback in the independent call.
      previousCanvas = undefined; previousInstructions = undefined; feedback = undefined;
      continue;
    }
    repair = undefined;
    currentInteraction = candidate.interaction;
    if (options.review !== true) { check(); return candidate; }
    const review = object(await dispatch(`${REVIEW}\n${S2_AGENT_COMPONENT_RULES}`, { authoringPhase: 'review', sources, components: details(),
      current, candidate: canvas, instructions: policy, interactionEvents,
      ...(candidate.interaction === undefined ? {} : { interaction: candidate.interaction }) }, 4096, 'review'), ['approved', 'feedback'], ['approved']);
    if (typeof review.approved !== 'boolean' || review.feedback !== undefined && (typeof review.feedback !== 'string' || review.feedback.length > 2000)) fail('公开设计审查格式无效');
    if (review.approved) { check(); return candidate; }
    if (previousCanvas || calls + 2 > maxCalls) fail('公开候选尚未通过设计审查');
    previousCanvas = canvas; previousInstructions = policy;
    feedback = typeof review.feedback === 'string' && review.feedback.trim() ? review.feedback : '按用户目标修正公开候选。';
  }
  return fail(`本次搭建已达到${maxCalls}次请求上限`);
}
