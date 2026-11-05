import type { LlmCallRequest, LlmCallResponse, SceneCapabilityId, ScenePromptModuleId, SceneRecipeId } from '../../types';
import { callLLM } from '../llmService';
import { SCENE_CAPABILITY_IDS, SCENE_PROMPT_MODULE_IDS, buildScenePromptModulePrompt, buildUnifiedSceneCapabilityPrompt,
  buildUnifiedSceneRecipePrompt, isSceneRecipeCompatible, normalizeUnifiedSceneRecipeId } from '../scene/sceneCapabilityRegistry';
import { resolveSceneAssembly } from '../scene/sceneAssembly';
import { resolveSceneBuildPermissionPool } from '../scene/sceneBuildPermissionPool';
import { readSceneUnderstanding, readSceneBuildConstraints, SCENE_UNDERSTANDING_PROMPT, SceneUnderstandingError, SceneClarificationRequired, type SceneUnderstanding } from '../scene/sceneUnderstanding';
import { runSceneSetupStage, SceneSetupError, type SceneSetupDiagnostic } from '../scene/sceneSetupStage';
import { AgentCoordinator } from './agentCoordinator';
import { sceneBuildTask, type SceneBuildContext } from '../scene/sceneBuildAgent';
import { buildSceneAbilityCatalog, readSceneCapabilityPlan, SceneCapabilityGapError } from '../scene/sceneAbilityCatalog';
import type { SceneCapabilityPlan } from '../../types';
import type { AgentCoordinationSummary } from './types';
import { collectSceneBuildMaterialEvidence, normalizeSceneBuildMaterialScope, readSceneBuildMaterialRequests,
  type SceneBuildMaterialRequest, type SceneBuildMaterialScope, type SceneBuildMaterialTrace } from '../scene/sceneBuildMaterials';

export interface SceneArchitectureArtifactData { sceneSkill: 'S1' | 'S4'; understanding: SceneUnderstanding }
export interface SceneInteractionPlanArtifactData {
  buildMaterialRequests?: SceneBuildMaterialRequest[];
  capabilityPlan: SceneCapabilityPlan;
  recipeId: SceneRecipeId;
  requestedCapabilities: SceneCapabilityId[];
  requestedPromptModules: ScenePromptModuleId[];
  interactionPlan: string;
  rationale: string;
}
export interface SceneReviewArtifactData {
  valid: boolean;
  sceneSkill: 'S1' | 'S4';
  recipeId: SceneRecipeId;
  requestedCapabilities: SceneCapabilityId[];
  requestedPromptModules: ScenePromptModuleId[];
  diagnosticCodes: string[];
}
export interface SceneMultiAgentResult {
  /** Scoped local reads are separate from architecture-only coordination totals. */
  materialTrace: SceneBuildMaterialTrace;
  buildContext: SceneBuildContext;
  recommendation: SceneReviewArtifactData & {
    understanding: SceneUnderstanding;
    learningObjective: string;
    interactionIntent: string;
    interactionPlan: string;
    constraints: string[];
    capabilityPlan: SceneCapabilityPlan;
  };
  prompt: string;
  coordination: AgentCoordinationSummary;
}
function text(value: unknown, max: number, field: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new SceneUnderstandingError(`${field} 必须是非空字符串，长度不超过 ${max}；不能返回对象或数组。`, 'invalid-design-field');
  return value.trim();
}
function whitelist<T extends string>(value: unknown, available: readonly T[], field: string): T[] {
  if (!Array.isArray(value) || value.length > 16 || value.some(id => !available.includes(id))) throw new SceneUnderstandingError(`${field} 只能是注册 ID 数组：${available.join(', ')}。执行工具不能放进交互组件数组，应通过其所属提示模块启用。`, 'invalid-capability-selection');
  return [...new Set(value)] as T[];
}
function sameIds(actual: string[], expected?: string[]) {
  return expected === undefined || (new Set(actual).size === new Set(expected).size && expected.every(id => actual.includes(id)));
}

export async function runSceneMultiAgent(input: {
  userRequest: string;
  sceneSkillConstraint?: 'S1' | 'S4';
  recipeConstraint?: SceneRecipeId;
  requestedCapabilities?: SceneCapabilityId[];
  requestedPromptModules?: ScenePromptModuleId[];
  conversation?: Array<{ sourceId: string; role: 'user' | 'assistant'; text: string }>;
  memoryPrefix?: string;
  materialSummary?: { candidateCount: number; usableCount: number; emptyCount: number };
  buildMaterialScope?: SceneBuildMaterialScope;
  searchBuildNotes?: Parameters<typeof collectSceneBuildMaterialEvidence>[0]['searchNotes'];
  onMaterialTrace?: (trace: SceneBuildMaterialTrace) => void;
  onDiagnostic?: (diagnostic: SceneSetupDiagnostic) => void;
  signal?: AbortSignal;
  callLlm?: (request: LlmCallRequest) => Promise<LlmCallResponse>;
  runId?: string;
}): Promise<SceneMultiAgentResult> {
  const invoke = input.callLlm || ((request: LlmCallRequest) => callLLM(request, { signal: input.signal }));
  const materialScope = normalizeSceneBuildMaterialScope(input.buildMaterialScope);
  // Keep the tail: it may contain a correction or negation.
  if (!input.userRequest.trim() || input.userRequest.length > 12000) throw new SceneUnderstandingError('场景需求为空或过长，请提供完整、聚焦的需求。');
  const conversation = (input.conversation || []).slice(-8);
  if (conversation.some(item => ['request', 'selections'].includes(item.sourceId)) || new Set(conversation.map(item => item.sourceId)).size !== conversation.length
    || conversation.reduce((length, item) => length + item.text.length, 0) > 24000) throw new SceneUnderstandingError('历史需求上下文无效或过长，请补充一份聚焦的场景要求。');
  const sources = new Map([...conversation.map(item => [item.sourceId, item.text] as const), ['request', input.userRequest] as const]);
  const explicitSelections = { recipeId: input.recipeConstraint, capabilities: input.requestedCapabilities, promptModules: input.requestedPromptModules };
  const selectionText = JSON.stringify(explicitSelections);
  sources.set('selections', selectionText);
  const authorizationSources = new Map([...conversation.filter(item => item.role === 'user').map(item => [item.sourceId, item.text] as const), ['request', input.userRequest] as const, ['selections', selectionText] as const]);
  const buildContext: SceneBuildContext = { version: 1, userRequest: input.userRequest, conversation,
    selectedSurface: input.sceneSkillConstraint, explicitSelections, materialSummary: input.materialSummary };
  const coordinator = new AgentCoordinator({ workflowId: 'scene-design-v1', userRequest: input.userRequest,
    runId: input.runId ? `${input.runId}:scene-design` : undefined, budget: { maxLlmCalls: 4, maxOutputChars: 18000 } });
  const architectureArtifact = await coordinator.runSpecialist<SceneArchitectureArtifactData>({
    specialistId: 'scene-architect', objective: 'Understand the actual experience, requirements and exclusions BEFORE selecting capabilities.',
    throwOnFailure: true,
    runner: async ({ task }) => {
      const result = await runSceneSetupStage({ stage: 'understand', invoke, signal: input.signal, onDiagnostic: input.onDiagnostic,
        maxOutputChars: task.budget.maxOutputChars,
        request: { providerId: '', model: '', workflow: 'agent-scene-setup', skipMemoryInjection: true,
        systemPromptOverride: `${SCENE_UNDERSTANDING_PROMPT}\n你负责搭建需求理解。必须额外返回understanding.buildConstraints={version:1,interactionPolicy:"unrestricted|restricted",answerKinds:[],taskPackaging:"unrestricted|single|batch",excludedBehaviors:[],evidence:[{sourceId,quote}]}。只归一化真实业务硬限制，不选择本轮控件/模块/工具。不把举例、偏好或assistant建议当授权。无题型硬限制写unrestricted和空answerKinds；restricted的answerKinds仅single-choice/multiple-choice/true-false/ordering/fill-blanks/free-text。单题和整卷限制与题型分开。excludedBehaviors仅role-play/narrative/metrics/events/forms/adaptive-progression/free-conversation；只放明确禁止项，限制作答不等于禁止交流。S4写题型unrestricted/[]，画布限制保留原requirements/exclusions与显式选择。明确时 intent=build-scene。显式选择的运行面、配方和交互方式都是用户要求，不是待猜测的目录。主题、练习方式和要求明确即可搭建；期望角色、精确题量、全部知识点正文不是必填项。用户未指定细节时可设计合理题量和覆盖顺序，不要求覆盖所有候选知识点。空笔记只表示不能用其正文取材，不表示需求不清楚。reference-material只记录当前场景设计必需的具体正文缺口；以后出题可能用笔记不代表现在必须读正文，不按候选标题数量创建缺口，不要求通读34个或全部知识点。只有缺失条件会实质改变目标且无法按显式选择解决时才标记 needsClarification，并必须在 informationGaps 中说明 user-clarification 类型的关键缺口；可自行设计的细节不能作为缺口。不要根据关键词猜场景。只输出 {"sceneSkill":"S1|S4","understanding":上述格式}，总长度不超过 7500 字符，保留每条硬约束，不为压缩而省略要求。evidence 只引用短的精确原话，单条最多 500 字符。S4 仅用于用户实际要求的符号推导画布，普通解释、讨论、练习均为 S1。`,
        userInput: JSON.stringify(sceneBuildTask(buildContext, 'understand', task.objective, {}, { sourceId: 'request', request: input.userRequest, conversation,
          contextPolicy: '承接已有用户要求，最新明确纠正优先；历史 assistant 的建议不是用户授权。', selectedSurface: input.sceneSkillConstraint,
          explicitSelections, selectionSource: { sourceId: 'selections', text: selectionText }, materialSummary: input.materialSummary })) },
        validate: raw => {
          const understanding = readSceneUnderstanding(raw.understanding, sources, 'request');
          understanding.buildConstraints = readSceneBuildConstraints((raw.understanding as Record<string, unknown>)?.buildConstraints, authorizationSources);
          if (!understanding.needsClarification && understanding.intent !== 'build-scene') {
            throw new SceneUnderstandingError('用户已进入搭建场景流程；请将已给出的需求组织为 build-scene，而不是要求用户重述目标。', 'intent-conflict');
          }
          if (raw.sceneSkill !== 'S1' && raw.sceneSkill !== 'S4') throw new SceneUnderstandingError('sceneSkill 必须是 S1 或 S4。', 'invalid-surface');
          if (input.sceneSkillConstraint && raw.sceneSkill !== input.sceneSkillConstraint) throw new SceneUnderstandingError('模型改变了用户明确选择的运行面。', 'surface-conflict');
          return { sceneSkill: raw.sceneSkill, understanding } as SceneArchitectureArtifactData;
        } });
      return { ...result, toolCalls: 0, outputChars: JSON.stringify(result.payload).length };
    },
  });
  if (!architectureArtifact) throw new SceneSetupError('understand', 'stage-skipped', '需求理解未执行，请重试。');
  const architecture = architectureArtifact.payload, understanding = architecture.understanding;
  buildContext.understanding = understanding;
  if (understanding.needsClarification) throw new SceneClarificationRequired(understanding.clarificationQuestion!);
  if (understanding.intent !== 'build-scene') throw new SceneSetupError('understand', 'intent-conflict', '模型仍未按场景搭建任务解释已有需求，请重试。');
  const interactionArtifact = await coordinator.runSpecialist<SceneInteractionPlanArtifactData>({
    specialistId: 'scene-interaction-planner', objective: 'Assemble only what the validated semantic requirements need.', inputArtifacts: [architectureArtifact],
    throwOnFailure: true,
    runner: async ({ task }) => {
      const result = await runSceneSetupStage({ stage: 'assemble', invoke, signal: input.signal, onDiagnostic: input.onDiagnostic,
        maxOutputChars: task.budget.maxOutputChars,
        request: { providerId: '', model: '', workflow: 'agent-scene-setup', skipMemoryInjection: true,
        systemPromptOverride: `Assemble a scene only AFTER semantic understanding has passed validation. Return one JSON object:
{"recipeId":"registered id","requestedCapabilities":[],"requestedPromptModules":[],"interactionPlan":"...","rationale":"how selections serve the goal and respect exclusions","capabilityPlan":{"needs":[{"id":"n1","goal":"what the user needs to do or obtain","capabilityIds":["text"]}],"missing":[]},"buildMaterialRequests":[]}.
Derive operations from the goal, success criteria, user participation and agent responsibilities BEFORE mapping to abilities. Recipes are reference patterns, not mandatory scripts. Use agent-designed for S1 when presets impose unnecessary behavior; respect manual recipes. Only real executors supply execution results. Put unavailable necessary operations and reasons in capabilityPlan.missing; do not simulate success, invent tools or request optional user details. This applies to any topic. Link every need to actual selected ability IDs, tool: IDs or module: IDs.
requestedCapabilities contains ONLY client interaction/display IDs from Capabilities. Tool IDs and checks/state IDs belong ONLY in capabilityPlan.needs[].capabilityIds. To enable a tool, add its module field from the catalogue to requestedPromptModules. Do not invent a domain-specific recipe ID; agent-designed is the registered free-design recipe. interactionPlan and rationale must be plain strings, not structured subplans.
input-form is a prompt module, NOT a requestedCapabilities ID or a new interaction type. If needed, select text in requestedCapabilities and input-form in requestedPromptModules, and map the actual form need to module:input-form in capabilityPlan.needs[].capabilityIds. model-experiment also requires a need mapped to tool:model-experiment. Do not add either module unless it serves the user goal.
Understanding is the design input, not a bag of keywords. Preserve negations and distinguish examples from requirements. Select the smallest sufficient set; required items are added by runtime, optional items are not defaults. Respect explicitSelections exactly when supplied. An empty role hint is not missing information. Batch assessment uses question-set and deterministic grading; do not add default roles, events, metrics or adaptive training. Personal cognition/profile require actual need, not mere mention. No queries execute in this model stage. Only when current design truly needs exact note content, a validated reference-material gap exists, resource-grounding is selected, and buildMaterialAccess.available is true, propose at most 2 buildMaterialRequests=[{needId,source:"knowledge-notes",query,reason}]. Every accepted reference-material gap is required for current design and MUST be covered by its original needId; never omit a request or rewrite accepted understanding to bypass it. Do not include resource IDs or scope; the local executor alone supplies the selected project whitelist. These requests declare required material for design, not all future question materials. No current need means []; later question generation can retrieve on demand. Respect no-reading exclusions. Never claim retrieval, full reading or fact verification before actual evidence. Never guess IDs. Keep output under 7500 characters; interactionPlan <= 3000 and rationale <= 1500. Preserve every hard constraint rather than compressing it away.
Recipes:\n${buildUnifiedSceneRecipePrompt()}\nCapabilities:\n${buildUnifiedSceneCapabilityPrompt()}\nPrompt modules:\n${buildScenePromptModulePrompt()}\nExecutable ability catalogue:\n${buildSceneAbilityCatalog(architecture.sceneSkill)}`,
        userInput: JSON.stringify(sceneBuildTask(buildContext, 'assemble', task.objective, { architecture }, { architecture, request: input.userRequest,
          explicitSelections, buildMaterialAccess: { source: 'knowledge-notes', available: Boolean(materialScope?.noteIds.length),
            usableCount: materialScope?.noteIds.length || 0 } })) }, validate: raw => {
      const recipeId = normalizeUnifiedSceneRecipeId(raw.recipeId);
      if (!recipeId || !isSceneRecipeCompatible(recipeId, architecture.sceneSkill)
        || (input.recipeConstraint && recipeId !== input.recipeConstraint)) throw new SceneUnderstandingError('recipeId 必须是已注册且符合显式选择的 ID；S1 自由设计用 agent-designed，S4 用 guided-derivation，不能用主题名称另造配方。', 'invalid-recipe');
      const requestedCapabilities = whitelist(raw.requestedCapabilities, SCENE_CAPABILITY_IDS, 'requestedCapabilities');
      const requestedPromptModules = whitelist(raw.requestedPromptModules, SCENE_PROMPT_MODULE_IDS, 'requestedPromptModules');
      if (!sameIds(requestedCapabilities, input.requestedCapabilities) || !sameIds(requestedPromptModules, input.requestedPromptModules)) throw new SceneUnderstandingError('场景装配改变了显式能力选择，已停止执行。');
      const payload = { recipeId, requestedCapabilities, requestedPromptModules, interactionPlan: text(raw.interactionPlan, 3000, 'interactionPlan'), rationale: text(raw.rationale, 1500, 'rationale') };
      const check = resolveSceneAssembly({ sceneSkill: architecture.sceneSkill, ...payload });
      if (!check.valid) throw new SceneUnderstandingError(`能力组合不兼容：${check.diagnostics.filter(item => item.severity === 'error').map(item => item.code).join('、')}`, 'incompatible-assembly');
      const pool = resolveSceneBuildPermissionPool(architecture.sceneSkill, { ...buildContext, understanding }, check.enabledCapabilities, check.enabledPromptModules, []);
      if (check.enabledCapabilities.some(id => !pool.capabilities.includes(id)) || check.enabledPromptModules.some(id => !pool.promptModules.includes(id))) throw new SceneUnderstandingError('装配违反已接受硬约束或手动选择。', 'incompatible-build-constraints');
      if (architecture.sceneSkill === 'S1' && !check.enabledCapabilities.some(id => pool.interactionTypes.includes(id as never))) throw new SceneUnderstandingError('没有满足硬约束的可执行互动方式。', 'missing-authorized-interaction');
      const capabilityPlan = readSceneCapabilityPlan(raw.capabilityPlan, architecture.sceneSkill, check.enabledCapabilities, check.enabledPromptModules);
      const buildMaterialRequests = readSceneBuildMaterialRequests(raw.buildMaterialRequests, understanding, check.enabledPromptModules, materialScope);
      return { ...payload, capabilityPlan, buildMaterialRequests };
    } });
      return { ...result, toolCalls: 0, outputChars: JSON.stringify(result.payload).length };
    },
  });
  if (!interactionArtifact) throw new SceneUnderstandingError('场景能力装配未通过检查，已停止执行，请重试。');
  const interaction = interactionArtifact.payload;
  if (interaction.capabilityPlan.missing.length) throw new SceneCapabilityGapError(interaction.capabilityPlan.missing);
  buildContext.capabilityPlan = interaction.capabilityPlan;
  const reviewArtifact = await coordinator.runSpecialist<SceneReviewArtifactData>({
    specialistId: 'scene-reviewer', objective: 'Validate the assembly without substituting a guessed workflow.',
    inputArtifacts: [architectureArtifact, interactionArtifact], throwOnFailure: true, runner: () => {
      const assembly = resolveSceneAssembly({ sceneSkill: architecture.sceneSkill, recipeId: interaction.recipeId,
        requestedCapabilities: interaction.requestedCapabilities, requestedPromptModules: interaction.requestedPromptModules });
      const payload = { valid: assembly.valid, sceneSkill: architecture.sceneSkill, recipeId: interaction.recipeId,
        requestedCapabilities: assembly.requestedCapabilities, requestedPromptModules: assembly.enabledPromptModules,
        diagnosticCodes: assembly.diagnostics.map(item => item.code) };
      return { payload, llmCalls: 0, toolCalls: 0, outputChars: JSON.stringify(payload).length,
        validation: { status: assembly.valid ? 'valid' as const : 'invalid' as const, diagnostics: payload.diagnosticCodes } };
    },
  });
  if (!reviewArtifact?.payload.valid) throw new SceneUnderstandingError('场景能力组合不可执行，已停止执行，不会替换为其它场景。');
  let materialTrace: SceneBuildMaterialTrace = { phase: 'build-materials', callCount: 0, results: [] };
  buildContext.materialEvidence = await collectSceneBuildMaterialEvidence({ requests: interaction.buildMaterialRequests || [], understanding,
    promptModules: reviewArtifact.payload.requestedPromptModules, scope: materialScope, searchNotes: input.searchBuildNotes, signal: input.signal,
    onTrace: trace => { materialTrace = trace; input.onMaterialTrace?.(trace); } });
  const recommendation = { ...reviewArtifact.payload, understanding, learningObjective: understanding.userGoal,
    interactionIntent: understanding.expectedExperience, interactionPlan: interaction.interactionPlan,
    capabilityPlan: interaction.capabilityPlan,
    constraints: [...understanding.requirements, ...understanding.exclusions.map(item => `禁止：${item}`)] };
  const prompt = `\n\n[Multi-agent scene design review]\nSemantic understanding was validated before assembly. Use this recommendation without adding suggested modules or inventing knowledge links. Query real data only for actual information gaps.\n${JSON.stringify(recommendation)}`;
  buildContext.assembly = { recipeId: recommendation.recipeId, capabilities: recommendation.requestedCapabilities,
    promptModules: recommendation.requestedPromptModules, interactionPlan: recommendation.interactionPlan };
  return { recommendation, prompt, coordination: coordinator.summarize(false), materialTrace, buildContext: structuredClone(buildContext) };
}
