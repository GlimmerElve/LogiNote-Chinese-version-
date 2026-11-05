import type { S2Document } from '../../types/sceneS2';
import type { S2BusinessPackage } from '../../types/sceneS2Business';
import type { S2Artifact, S2Json } from '../../types/sceneS2Plugin';
import { readS2BusinessRule, s2BusinessRulePointerSegments } from './sceneS2BusinessRule';
import { s2BuiltinPluginRegistry } from './sceneS2PluginRegistry';
import { canonicalS2Json } from './sceneS2PluginProtocol';
import { readS2AssessmentArtifact, resolveS2AssessmentOutput, type S2AssessmentArtifactScope } from './sceneS2ArtifactAccess';

export type S2AssessmentVerdict = 'met' | 'unmet' | 'uncertain';
export interface S2AssessmentEvidence { sourceId: string; quote: string }
export interface S2AssessmentCheck {
  criterionId: string;
  label: string;
  method: 'local' | 'semantic';
  verdict: S2AssessmentVerdict;
  reason: string;
  evidence: S2AssessmentEvidence[];
  /** Host-resolved provenance, never model-supplied metadata or a claim of business success. */
  source?: { artifactId: string; portId: string; type: S2Artifact['type']; source: S2Artifact['source']; simulationOnly: boolean };
}
/** An observation of selected criteria, never a scene-completion, mutation or authorization record. */
export interface S2AssessmentReport {
  checks: S2AssessmentCheck[];
  advice: Array<{ criterionId: string; text: string }>;
  overall: S2AssessmentVerdict | 'advisory';
  scope: 'selected-criteria-only';
  omittedCriterionIds: string[];
}
const validatedAssessments = new WeakMap<object, { json: string; criterionKeys: Record<string, string> }>();
/** Local host handoff only: model JSON and mutated copies are not computed reports. */
export function readS2ComputedAssessment(report: S2AssessmentReport) {
  const saved = validatedAssessments.get(report);
  if (!saved || JSON.stringify(report) !== saved.json) throw new Error('只能记录宿主已核对且未被修改的评价报告');
  return { report: structuredClone(report), criterionKeys: { ...saved.criterionKeys } };
}

type Criterion = S2BusinessPackage['criteria'][number];
type Judgment = { criterionId: string; verdict: S2AssessmentVerdict; reason: string; evidence: S2AssessmentEvidence[] };
const unsafeKeys = new Set(['__proto__', 'prototype', 'constructor']);
function object(raw: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) throw new Error('S2 评价字段必须是普通对象');
  for (const key of Reflect.ownKeys(raw)) {
    if (typeof key !== 'string' || unsafeKeys.has(key) || !fields.includes(key)
      || !Object.hasOwn(Object.getOwnPropertyDescriptor(raw, key)!, 'value')) throw new Error('S2 评价包含未知、原型或访问器字段');
  }
  return raw as Record<string, unknown>;
}
function text(raw: unknown, max: number, empty = false): string {
  if (typeof raw !== 'string' || raw.length > max || !empty && !raw.trim()) throw new Error('S2 评价文本无效或超出大小上限');
  return raw;
}
function id(raw: unknown): string {
  const value = text(raw, 64);
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(value) || unsafeKeys.has(value)) throw new Error('S2 评价标识符无效');
  return value;
}
function array(raw: unknown, max: number): unknown[] {
  if (!Array.isArray(raw) || Object.getPrototypeOf(raw) !== Array.prototype || raw.length > max
    || Reflect.ownKeys(raw).length !== raw.length + 1) throw new Error('S2 评价列表无效或超出大小上限');
  for (let index = 0; index < raw.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, index);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new Error('S2 评价列表不接受空项或访问器');
  }
  return raw;
}
function boundedJson(raw: unknown): S2Json {
  let entries = 0;
  const visit = (value: unknown, depth: number): S2Json => {
    if (++entries > 2048 || depth > 16) throw new Error('S2 评价 JSON 超出大小或深度上限');
    if (value === null || typeof value === 'boolean') return value as null | boolean;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') return text(value, 6000, true);
    if (Array.isArray(value)) return array(value, 2048).map(item => visit(item, depth + 1));
    if (value && typeof value === 'object') {
      const keys = Object.keys(value), source = object(value, keys);
      return Object.fromEntries(keys.map(key => [key, visit(source[key], depth + 1)]));
    }
    throw new Error('S2 评价仅支持有限 JSON 值');
  };
  const value = visit(raw, 0);
  if (JSON.stringify(value).length > 12000) throw new Error('S2 评价 JSON 超出大小上限');
  return value;
}
function equalJson(left: S2Json, right: S2Json): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((value, index) => equalJson(value, right[index]));
  if (left && right && typeof left === 'object' && typeof right === 'object' && !Array.isArray(left) && !Array.isArray(right)) {
    const keys = Object.keys(left);
    return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && equalJson(left[key], right[key]));
  }
  return false;
}
function validateCriterion(raw: Criterion): Criterion {
  const value = object(raw, ['id', 'label', 'expectation', 'method', 'required', 'target', 'rule']);
  id(value.id); text(value.label, 200); text(value.expectation, 1000);
  if (!['local', 'semantic', 'advisory'].includes(value.method as string) || typeof value.required !== 'boolean') throw new Error('S2 评价指标方式或required无效');
  if (value.target !== undefined) {
    const target = object(value.target, ['nodeId', 'fieldId', 'portId']); id(target.nodeId);
    const hasField = Object.hasOwn(target, 'fieldId'), hasPort = Object.hasOwn(target, 'portId');
    if (hasField === hasPort) throw new Error('S2 评价target必须且只能选择fieldId或portId之一');
    id(hasField ? target.fieldId : target.portId);
  }
  const rule = value.rule === undefined ? undefined : readS2BusinessRule(value.rule);
  if (value.method === 'local' && (!value.target || !value.rule)) throw new Error('S2 本地指标须有target和rule');
  if (value.method !== 'local' && value.rule !== undefined) throw new Error('S2 非本地指标不能携带本地执行规则');
  if (value.method === 'advisory' && value.required) throw new Error('S2 开放建议不能设为必过指标');
  return { ...raw, ...(rule ? { rule } : {}) };
}
function fieldText(current: S2Document, nodeId: string, fieldId: string): string | undefined {
  const node = current.nodes.find(node => node.id === nodeId);
  if (!node || !Object.hasOwn(node.values, fieldId)) return undefined;
  return text(node.values[fieldId], 6000, true);
}
type TargetContent = { text: string; sourceId: string; source?: S2AssessmentCheck['source'] };
function targetContent(criterion: Criterion, current: S2Document, artifactScope?: S2AssessmentArtifactScope): TargetContent | undefined {
  const target = criterion.target;
  if (!target) return undefined;
  if (target.fieldId !== undefined) {
    const actual = fieldText(current, target.nodeId, target.fieldId);
    return actual === undefined ? undefined : { text: actual, sourceId: `field:${target.nodeId}:${target.fieldId}` };
  }
  const node = current.execution?.nodes.find(node => node.id === target.nodeId);
  if (!node) return undefined;
  const port = s2BuiltinPluginRegistry().capability(node).outputs.find(port => port.id === target.portId);
  if (!port || port.multiple) return undefined;
  const resolved = resolveS2AssessmentOutput(artifactScope, target.nodeId, target.portId!);
  if (!resolved || resolved.artifact.source.nodeId !== target.nodeId || resolved.artifact.type.id !== port.type.id || resolved.artifact.type.version !== port.type.version) return undefined;
  return { text: resolved.text, sourceId: `artifact:${resolved.artifact.id}`, source: { artifactId: resolved.artifact.id, portId: target.portId!,
    type: structuredClone(resolved.artifact.type), source: structuredClone(resolved.artifact.source), simulationOnly: resolved.artifact.type.id === 'workflow-simulation.result' } };
}
function readEvidence(raw: unknown, current: S2Document, query: string | undefined, artifactScope?: S2AssessmentArtifactScope,
  unavailableOutput = false): S2AssessmentEvidence[] {
  const seen = new Set<string>();
  return array(raw, 4).flatMap(item => {
    const source = object(item, ['sourceId', 'quote']), sourceId = text(source.sourceId, 140), quote = text(source.quote, 500);
    let actual: string | undefined;
    if (sourceId === 'query') actual = query;
    else if (sourceId.startsWith('artifact:')) {
      const artifactId = sourceId.slice('artifact:'.length);
      if (!artifactId || !/^[A-Za-z][A-Za-z0-9_-]{0,119}$/.test(artifactId) || unsafeKeys.has(artifactId)) throw new Error('S2 评价产物来源标识无效');
      try { actual = readS2AssessmentArtifact(artifactScope, artifactId).text; }
      catch (error) {
        // An unavailable target cannot become a pass or fail from a made-up or
        // unprovided quote. Discard that evidence and publish uncertain below.
        if (unavailableOutput) return [];
        throw error;
      }
    }
    else {
      const segments = sourceId.split(':');
      if (segments.length !== 3 || segments[0] !== 'field') throw new Error('S2 评价来源只能是当前field:nodeId:fieldId、query或本轮已全文提供的artifact:真实ID，不接受预览、参考答案和虚构回执');
      actual = fieldText(current, id(segments[1]), id(segments[2]));
    }
    if (actual === undefined || !actual.includes(quote)) throw new Error('S2 评价证据须为当前来源中真实存在的连续原文');
    const key = `${sourceId}\u0000${quote}`;
    if (seen.has(key)) throw new Error('S2 评价证据重复');
    seen.add(key); return [{ sourceId, quote }];
  });
}
function localCheck(criterion: Criterion, content: TargetContent | undefined): S2AssessmentCheck {
  const rule = criterion.rule!, actual = content?.text;
  const base = { criterionId: criterion.id, label: criterion.label, method: 'local' as const, ...(content?.source ? { source: content.source } : {}) };
  if (actual === undefined) return { ...base, verdict: 'uncertain', reason: criterion.target?.portId !== undefined
    ? '当前指标目标输出没有已全文提供且仍有效的最新完整产物；尚未运行、失败、截断或取材不可用均不能由其他字段或用户要求替代。'
    : '当前画布中不存在指标目标字段，无法核对；这不是执行结果。', evidence: [] };
  const evidence = [{ sourceId: content!.sourceId, quote: actual.slice(0, 500) }];
  const subject = content?.source ? '当前输出' : '当前字段';
  let met: boolean, reason: string;
  if (rule.kind === 'text-includes') { met = actual.includes(rule.value); reason = met ? `${subject}包含预设的精确文本。` : `${subject}未包含预设的精确文本。`; }
  else if (rule.kind === 'text-length') {
    const length = Array.from(actual).length;
    met = length >= rule.min && length <= rule.max; reason = `${subject}共${length}个Unicode字符，要求${rule.min}–${rule.max}个。`;
  } else {
    let parsed: unknown, value: S2Json;
    try { parsed = JSON.parse(actual); }
    catch { return { ...base, verdict: 'unmet', reason: `${subject}不是完整合法JSON，不能满足指定JSON值核对。`, evidence }; }
    try { value = boundedJson(parsed); }
    catch { return { ...base, verdict: 'uncertain', reason: '当前JSON超出本地有限规则的安全核对范围；不能据此判定业务失败。', evidence }; }
    let found = true;
    for (const segment of s2BusinessRulePointerSegments(rule.pointer)) {
      if (!value || typeof value !== 'object' || Array.isArray(value) && !/^(0|[1-9]\d*)$/.test(segment) || !Object.hasOwn(value, segment)) { found = false; break; }
      value = (value as Record<string, S2Json>)[segment];
    }
    met = found && equalJson(value!, rule.value);
    reason = !found ? '当前JSON中不存在指标指定的路径。' : met ? '当前JSON路径值与预设值一致。' : '当前JSON路径值与预设值不一致。';
  }
  return { ...base, verdict: met ? 'met' : 'unmet', reason, evidence };
}

/** Evaluate selected criteria against complete current fields or opaque host-scoped outputs supplied in full this turn. */
export function readS2AssessmentRequest(raw: unknown, business: Pick<S2BusinessPackage, 'criteria'>, current: S2Document, query?: string,
  artifactScope?: S2AssessmentArtifactScope): S2AssessmentReport {
  const request = object(raw, ['criterionIds', 'judgments']);
  if (query !== undefined) text(query, 16000, true);
  const rawCriteria = array(business.criteria, 6) as Criterion[];
  const criterionIds = rawCriteria.map(value => id(object(value, ['id', 'label', 'expectation', 'method', 'required', 'target', 'rule']).id));
  if (new Set(criterionIds).size !== criterionIds.length) throw new Error('S2 评价指标ID重复');
  const selectedIds = array(request.criterionIds, 6).map(id);
  if (!selectedIds.length || new Set(selectedIds).size !== selectedIds.length) throw new Error('S2 评价须明确选择至少一个且不重复的指标');
  const selected = selectedIds.map(criterionId => {
    const criterion = rawCriteria.find(value => value.id === criterionId);
    if (!criterion) throw new Error(`S2 评价不能创建未知指标：${criterionId}`); return criterion;
  }).map(validateCriterion);
  const contents = new Map(selected.filter(criterion => criterion.target).map(criterion => [criterion.id, targetContent(criterion, current, artifactScope)]));
  const judgments = new Map<string, Judgment>();
  for (const raw of request.judgments === undefined ? [] : array(request.judgments, 6)) {
    const item = object(raw, ['criterionId', 'verdict', 'reason', 'evidence']), criterionId = id(item.criterionId);
    if (!selectedIds.includes(criterionId) || judgments.has(criterionId)) throw new Error('S2 评价判断只能引用已选择且不重复的指标');
    if (!['met', 'unmet', 'uncertain'].includes(item.verdict as string)) throw new Error('S2 评价verdict无效');
    const criterion = selected.find(criterion => criterion.id === criterionId)!;
    judgments.set(criterionId, { criterionId, verdict: item.verdict as S2AssessmentVerdict, reason: text(item.reason, 1200),
      evidence: readEvidence(item.evidence, current, query, artifactScope, criterion.target?.portId !== undefined && !contents.get(criterionId)) });
  }
  const checks: S2AssessmentCheck[] = [], advice: S2AssessmentReport['advice'] = [];
  for (const criterion of selected) {
    const judgment = judgments.get(criterion.id);
    if (criterion.method === 'advisory') { advice.push({ criterionId: criterion.id, text: judgment?.reason ?? criterion.expectation }); continue; }
    const content = contents.get(criterion.id);
    if (criterion.method === 'local') { checks.push(localCheck(criterion, content)); continue; }
    if (criterion.target && !content) {
      checks.push({ criterionId: criterion.id, label: criterion.label, method: 'semantic', verdict: 'uncertain',
        reason: criterion.target.portId !== undefined
          ? '当前指标目标输出没有已全文提供且仍有效的最新完整产物，无法作语义判断；其他产物、字段或用户要求不能替代。'
          : '当前画布中不存在指标目标字段，无法核对；其他字段或用户要求不能替代该目标的实际内容。', evidence: [] });
      continue;
    }
    if (judgment && judgment.verdict !== 'uncertain' && !judgment.evidence.length) throw new Error('S2 语义指标的met/unmet判断必须有当前来源的连续原文证据；无法判断请返回uncertain');
    if (judgment && judgment.verdict !== 'uncertain' && criterion.target
      && !judgment.evidence.some(evidence => evidence.sourceId === content!.sourceId)) {
      throw new Error(criterion.target.portId !== undefined
        ? 'S2 带输出target的语义指标必须引用该目标端口当前最新且本轮已全文提供的匹配artifact；其他产物、field或query不能证明目标达标'
        : 'S2 带target的语义指标必须引用该目标字段的当前原文；仅引用query或其他字段不能证明目标达标');
    }
    checks.push({ criterionId: criterion.id, label: criterion.label, method: 'semantic', verdict: judgment?.verdict ?? 'uncertain',
      reason: judgment?.reason ?? '尚无针对本指标的带依据语义判断，请补充证据或向用户确认。', evidence: judgment?.evidence ?? [],
      ...(content?.source ? { source: content.source } : {}) });
  }
  const required = selected.filter(criterion => criterion.method !== 'advisory' && criterion.required).map(criterion => criterion.id);
  const counted = required.length ? checks.filter(check => required.includes(check.criterionId)) : checks;
  const overall = !counted.length ? 'advisory' : counted.some(check => check.verdict === 'unmet') ? 'unmet' : counted.some(check => check.verdict === 'uncertain') ? 'uncertain' : 'met';
  const report: S2AssessmentReport = { checks, advice, overall, scope: 'selected-criteria-only', omittedCriterionIds: criterionIds.filter(criterionId => !selectedIds.includes(criterionId)) };
  validatedAssessments.set(report, { json: JSON.stringify(report), criterionKeys: Object.fromEntries(selected.map(criterion => [criterion.id, canonicalS2Json(criterion as unknown as S2Json)])) });
  return report;
}

export const S2_ASSESSMENT_RULES = `评价是按本轮语义选择的行动，不要求每轮评价，不规定教学推进流程。只有场景声明的criteria（根字段或兼容旧业务包）可作正式比对；其他非指标反馈只是建议，不能阻断用户操作或判定失败，更不能凭一次输出宣判知识已掌握。intent.evaluation=criteria表示本轮已明确选择指标比对：有已声明标准时必须附assessment，不能把它降级成纯文字建议或在reply里自称完成了本地程序核对。用户已要求指标比对且本轮附有assessment时，不再要求重复确认是否提交同一评价；准确说明本轮已提交的比对范围，实际本地结论仍以宿主重算为准。这不是改图或运行授权。evaluation=advice表示本轮解释/建议或暂停正式评价，不输出正式checks；可省略assessment或仅选择advisory。没有标准时解释限制，不自行创建指标。旧轮次的局部要求不覆盖本轮最新表达。
行动阶段可附assessment:{criterionIds:[已声明指标ID],judgments?:[{criterionId,verdict:"met"|"unmet"|"uncertain",reason,evidence:[{sourceId:"field:块ID:字段ID"|"query"|"artifact:真实产物ID",quote:当前来源连续原文}]}]}。本地local指标由程序重算，不采信你提供的结论；semantic的met/unmet必须引用当前完整字段、当前用户原文或本轮已全文交付且仍有效的真实artifact。target严格为{nodeId,fieldId}或{nodeId,portId}二选一；字段目标至少引用其当前原文，输出目标必须引用宿主为该节点/单值端口匹配的当前最新完整artifact，不能拿其他field、query、其他端口或旧尝试产物替代。模型返回可以直接作为输出target，无需复制到内容块。目标被删、尚未运行、失败、截断、全文未交付或超取材预算时用uncertain，可按需请求全文或向用户确认，不虚构证据或靠预览判断；advisory永远只是建议。
每项指标的解释只能覆盖实际检查范围，不能把窄检查外推成更宽目标达成。单个JSON路径/字段的值相等，只能证明该值满足这一条件，不能证明整条记录、其他字段或整个数据集原样保留；原文未改动若有独立宿主状态证据，应单独说明，不能归功于该单字段指标。即使指标说明提到较宽目标，仍以实际核对范围为限；不清楚规则范围时明确限制，不虚构完整性证明。
只能评价所选指标，必须保留未评指标范围，不能把局部达标说成整场景完成。引用只能证明原文存在，不证明语义理解必然正确。产物来源由宿主保留artifactId、类型、场景/会话/修订/节点/调用身份；simulationOnly=true只能证明显式模拟轨迹自身的标准，不能冒充真实模型或真实业务效果。不能以工具预览、参考解、模拟成功或虚构执行回执充当业务证据；本评价不执行插件、不改图、不授权、不标记场景完成。`;

export function formatS2Assessment(report: S2AssessmentReport): string {
  const names = { met: '达到所选指标', unmet: '所选指标尚未达到', uncertain: '所选指标待确认', advisory: '仅建议，不作正式判定' };
  const verdicts = { met: '达到', unmet: '未达到', uncertain: '待确认' };
  const summary = (value: string) => value.length <= 240 ? value : `${value.slice(0, 240)}…（详见本次评价记录）`;
  const lines = [`指标比对（仅限本次所选，不代表整场景完成）：${names[report.overall]}。`,
    ...report.checks.map(check => `${check.label}（${check.method === 'local' ? '本地核对' : '语义判断'}）：${verdicts[check.verdict]}。${summary(check.reason)}${check.source?.simulationOnly ? ' 仅核对模拟轨迹，不代表真实模型或业务效果。' : ''}`),
    ...report.advice.map(item => `建议：${summary(item.text)}`)];
  if (report.omittedCriterionIds.length) lines.push(`未评指标：${report.omittedCriterionIds.join('、')}。`);
  return lines.join('\n');
}
