/** Experimental contract only. No transport, production imports, edge admission or semantic label repair. */
import type { AuditInput } from './relationAuditShadow';
import { parseIdenticalCoreJson } from './identicalJson';
import { USE_AXES, type UseAxis, type UseAnswer } from './authorUseProbe';

export const ACTION_EVIDENCE_V2_VERSION = 'action-bound-evidence-shadow-v2';
export const REQUESTED_ACTION = { establish: 'ESTABLISH', rebut: 'REBUT', restrict: 'LIMIT', explain: 'EXPLAIN' } as const;
export type ActionCode = typeof REQUESTED_ACTION[UseAxis];
export const ACTION_QUESTIONS: Record<UseAxis, string> = {
  establish: '作者是否把固定前提作为接受或增强完整目标成立的理由？不判断科学充分性。',
  rebut: '作者是否把固定前提用于否定或削弱完整目标，或明确指定的局部对象？局部对象不自动等于完整命题。',
  restrict: '作者是否把固定前提用于独立限定目标的依据、可保证范围或确定程度？不要求先证明或否定目标成立。',
  explain: '作者是否把固定前提用于解释目标所述现象为何出现或怎样形成？这不自动证明观测发生。',
};
export interface ActionEvidence { id: string; passageId: string; quote: string }
export interface ActionFinding { answer: UseAnswer; observedActions: ActionCode[]; evidenceIds: string[]; reason: string }
export interface SourceBinding { nodeId: string | null; scope: 'whole' | 'part' | 'unknown'; span: string | null }
export interface TargetBinding { nodeId: string | null; scope: 'whole' | 'antecedent' | 'consequent' | 'part' | 'unknown'; span: string | null }
export interface ActionBinding {
  candidateId: string; requestedAction: ActionCode; sourceRefs: SourceBinding[]; targetRef: TargetBinding;
  evidenceIds: string[]; bindingStatus: 'model_declared' | 'unresolved' | 'not_checked';
}
export interface ActionEvidenceV2Parsed {
  evidence: Array<ActionEvidence & { start: number; end: number }>;
  actions: Array<{ candidateId: string; requestedAction: ActionCode; axis: UseAxis; result: ActionFinding }>;
  bindings: ActionBinding[];
  issues: Array<{ candidateId: string; action?: ActionCode; code: string }>;
  warnings: Array<{ candidateId: string; action: ActionCode; code: string }>;
}

const enumSchema = (values: readonly string[]) => ({ type: 'string', enum: [...values] });
const idList = { type: 'array', items: { type: 'string', minLength: 1, maxLength: 80 }, uniqueItems: true, maxItems: 4 };
const closed = (properties: Record<string, unknown>) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const refSchema = (scope: string[]) => closed({ nodeId: { type: ['string', 'null'] }, scope: enumSchema(scope), span: { type: ['string', 'null'] } });
const actionSchema = closed({ answer: enumSchema(['YES','NO','UNCERTAIN']), observedActions: { type: 'array', items: enumSchema(Object.values(REQUESTED_ACTION)), uniqueItems: true, maxItems: 4 },
  evidenceIds: idList, reason: { type: 'string', maxLength: 180 } });
/** Shape declaration only; cross-reference, quote and semantic guarantees are not provided by JSON Schema. */
export const ACTION_EVIDENCE_V2_SCHEMA = closed({
  evidence: { type: 'array', maxItems: 64, items: closed({ id: { type: 'string', minLength: 1, maxLength: 80 }, passageId: { type: 'string' }, quote: { type: 'string', minLength: 4, maxLength: 300 } }) },
  decisions: { type: 'array', maxItems: 8, items: closed({ candidateId: { type: 'string' }, actions: closed(Object.fromEntries(USE_AXES.map(axis => [axis, actionSchema]))) }) },
  bindings: { type: 'array', maxItems: 32, items: closed({ candidateId: { type: 'string' }, requestedAction: enumSchema(Object.values(REQUESTED_ACTION)),
    sourceRefs: { type: 'array', maxItems: 14, items: refSchema(['whole','part','unknown']) },
    targetRef: refSchema(['whole','antecedent','consequent','part','unknown']), evidenceIds: idList,
    bindingStatus: enumSchema(['model_declared','unresolved','not_checked']) }) },
});

const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const keys = (v: unknown, expected: string[]): v is Record<string, any> => object(v) && Object.keys(v).length === expected.length && expected.every(k => Object.hasOwn(v, k));
const member = (values: readonly string[], v: unknown) => typeof v === 'string' && values.includes(v);
const identifier = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && v.length <= 80;
const uniqueStrings = (v: unknown, max: number): v is string[] => Array.isArray(v) && v.length <= max && v.every(identifier) && new Set(v).size === v.length;
const countIds = (rows: unknown[], get: (row: Record<string, any>) => unknown) => {
  const counts = new Map<string, number>();
  for (const row of rows) { const id = object(row) ? get(row) : undefined; if (typeof id === 'string') counts.set(id, (counts.get(id) ?? 0) + 1); }
  return counts;
};

function validateInput(input: AuditInput) {
  if (!input.candidates.length || input.candidates.length > 4 || input.nodes.length > 14) throw new Error('V2 contract accepts1–4 candidates and at most14 nodes; no truncation');
  for (const rows of [input.nodes, input.passages, input.candidates]) if (new Set(rows.map(r => r.id)).size !== rows.length) throw new Error('Duplicate input ID');
  for (const c of input.candidates) if (!c.premises.length || new Set(c.premises).size !== c.premises.length || c.premises.includes(c.target)
    || [...c.premises,c.target].some(id => !input.nodes.some(n => n.id === id))) throw new Error('Invalid fixed candidate endpoints');
}

/** One shared source pack, four explicitly defined tasks per candidate. Not an executable cloud request. */
export function buildActionEvidenceV2Packet(input: AuditInput) {
  validateInput(input);
  const packet = { version: ACTION_EVIDENCE_V2_VERSION, sourceId: input.sourceId, sourceHash: input.sourceHash,
    passages: input.passages.map(({ id, text }) => ({ id, text })),
    nodes: input.nodes.map(({ id, text, sourcePassageIds, speaker }) => ({ id, text, sourcePassageIds, ...(speaker ? { speaker } : {}) })),
    candidates: input.candidates.map(({ id, premises, target }) => ({ id, premises, target })),
    taskDefinitions: USE_AXES.map(axis => ({ axis, requestedAction: REQUESTED_ACTION[axis], question: ACTION_QUESTIONS[axis] })),
    boundary: { task: 'offline-action-evidence-contract', observedActionIsModelDeclaration: true, semanticVerification: 'not_performed', productionWrites: false } };
  if (JSON.stringify(packet).length > 22000) throw new Error('V2 packet exceeds22000 characters; no truncation');
  return packet;
}

export function parseActionEvidenceV2(raw: string, input: AuditInput): ActionEvidenceV2Parsed {
  validateInput(input);
  const decoded = parseIdenticalCoreJson(raw), root = decoded.value;
  if (!keys(root, ['evidence','decisions','bindings']) || !Array.isArray(root.evidence) || !Array.isArray(root.decisions) || !Array.isArray(root.bindings)
    || root.evidence.length > 64 || root.decisions.length > 8 || root.bindings.length > 32) throw new Error('Invalid V2 container; retain raw response');
  const result: ActionEvidenceV2Parsed = { evidence: [], actions: [], bindings: [], issues: [], warnings: [] };
  const issue = (candidateId: string, code: string, action?: ActionCode) => result.issues.push({ candidateId, code, ...(action ? { action } : {}) });
  for (const d of decoded.coalesced) issue(d.path, 'identical-duplicate-json-key');
  const evidenceCounts = countIds(root.evidence, r => r.id), decisionCounts = countIds(root.decisions, r => r.candidateId);
  for (const e of root.evidence) {
    if (!keys(e, ['id','passageId','quote']) || !identifier(e.id) || evidenceCounts.get(e.id) !== 1 || typeof e.quote !== 'string' || e.quote.length < 4 || e.quote.length > 300) {
      issue(object(e) && typeof e.id === 'string' ? e.id : 'UNKNOWN', 'evidence-invalid-or-duplicate'); continue;
    }
    const passage = input.passages.find(p => p.id === e.passageId), at = passage?.text.indexOf(e.quote) ?? -1;
    if (!passage || at < 0) { issue(e.id, 'evidence-quote-mismatch'); continue; }
    result.evidence.push({ ...structuredClone(e) as ActionEvidence, start: passage.start + at, end: passage.start + at + e.quote.length });
  }
  const refsValid = (ids: unknown): ids is string[] => uniqueStrings(ids, 4) && ids.every(id => result.evidence.some(e => e.id === id));
  for (const row of root.decisions) {
    const candidateId = object(row) && typeof row.candidateId === 'string' ? row.candidateId : 'UNKNOWN';
    if (!input.candidates.some(c => c.id === candidateId) || decisionCounts.get(candidateId) !== 1 || !keys(row, ['candidateId','actions']) || !object(row.actions)
      || Object.keys(row.actions).some(k => !USE_AXES.includes(k as UseAxis))) { issue(candidateId, 'decision-invalid-or-duplicate'); continue; }
    for (const axis of USE_AXES) {
      const action = REQUESTED_ACTION[axis], value = row.actions[axis];
      if (!keys(value, ['answer','observedActions','evidenceIds','reason']) || !member(['YES','NO','UNCERTAIN'], value.answer)
        || !uniqueStrings(value.observedActions, 4) || value.observedActions.some(a => !member(Object.values(REQUESTED_ACTION), a))
        || typeof value.reason !== 'string' || value.reason.length > 180 || (value.answer === 'YES' && !value.reason.trim()) || !refsValid(value.evidenceIds)
        || (value.answer === 'YES' && value.evidenceIds.length === 0)) { issue(candidateId, 'action-invalid-or-missing-own-evidence', action); continue; }
      result.actions.push({ candidateId, requestedAction: action, axis, result: structuredClone(value) as ActionFinding });
      if (value.answer === 'NO' && value.observedActions.includes(action)) result.warnings.push({ candidateId, action, code: 'no-with-observed-requested-action' });
      if (value.answer === 'YES' && !value.observedActions.includes(action)) result.warnings.push({ candidateId, action, code: 'yes-without-observed-requested-action' });
    }
  }
  const bindingCounts = countIds(root.bindings, r => typeof r.candidateId === 'string' && typeof r.requestedAction === 'string' ? JSON.stringify([r.candidateId,r.requestedAction]) : undefined);
  const spanValid = (ref: unknown, scopes: string[]) => {
    if (!keys(ref, ['nodeId','scope','span']) || !member(scopes, ref.scope)) return false;
    if (ref.scope === 'unknown') return ref.span === null && (ref.nodeId === null || input.nodes.some(n => n.id === ref.nodeId));
    const node = input.nodes.find(n => n.id === ref.nodeId);
    return !!node && typeof ref.span === 'string' && !!ref.span.trim() && (ref.scope === 'whole' ? ref.span === node.text : node.text.includes(ref.span));
  };
  for (const b of root.bindings) {
    const id = object(b) && typeof b.candidateId === 'string' ? b.candidateId : 'UNKNOWN';
    const action = object(b) && member(Object.values(REQUESTED_ACTION), b.requestedAction) ? b.requestedAction as ActionCode : undefined;
    const candidate = input.candidates.find(c => c.id === id);
    if (!candidate || !action || bindingCounts.get(JSON.stringify([id,action])) !== 1 || !keys(b, ['candidateId','requestedAction','sourceRefs','targetRef','evidenceIds','bindingStatus'])
      || !Array.isArray(b.sourceRefs) || b.sourceRefs.length > 14 || !b.sourceRefs.every((r: unknown) => spanValid(r, ['whole','part','unknown']))
      || new Set(b.sourceRefs.map((r: SourceBinding) => r.nodeId)).size !== b.sourceRefs.length
      || !spanValid(b.targetRef, ['whole','antecedent','consequent','part','unknown']) || !refsValid(b.evidenceIds)
      || !member(['model_declared','unresolved','not_checked'], b.bindingStatus) || (b.bindingStatus === 'model_declared' && !b.evidenceIds.length)) {
      issue(id, 'binding-invalid', action); continue;
    }
    result.bindings.push(structuredClone(b) as ActionBinding);
    const warn = (code: string) => result.warnings.push({ candidateId: id, action, code });
    if (!b.sourceRefs.length || b.sourceRefs.some((r: SourceBinding) => r.scope === 'unknown') || b.targetRef.scope === 'unknown') warn('endpoint-unmapped-or-not-checked');
    if (b.targetRef.scope !== 'whole' && b.targetRef.scope !== 'unknown') warn('partial-target-requires-atomic-node-before-any-future-edge');
    const sources = b.sourceRefs.map((r: SourceBinding) => r.nodeId);
    if (sources.length !== candidate.premises.length || !candidate.premises.every(id => sources.includes(id))) warn('actual-source-ids-differ-from-fixed-candidate');
    if (b.targetRef.nodeId !== candidate.target) warn('actual-target-id-differs-from-fixed-candidate');
    if (sources.includes(b.targetRef.nodeId) && b.targetRef.nodeId !== null) warn('self-use-declared');
    for (const ref of [...b.sourceRefs,b.targetRef]) if (ref.scope !== 'whole' && ref.scope !== 'unknown' && input.nodes.find(n => n.id === ref.nodeId)?.text === ref.span) warn('part-scope-with-whole-node-span');
  }
  for (const candidate of input.candidates) for (const axis of USE_AXES) if (!result.actions.some(a => a.candidateId === candidate.id && a.axis === axis)) issue(candidate.id, 'action-unassessed', REQUESTED_ACTION[axis]);
  return result;
}

/** U=(Action,Source,TargetScope,Evidence) is an auditable declaration, never semantic verification. */
export function buildActionEvidenceUnits(input: AuditInput, parsed: ActionEvidenceV2Parsed) {
  return input.candidates.flatMap(candidate => USE_AXES.map(axis => {
    const requestedAction = REQUESTED_ACTION[axis], action = parsed.actions.find(a => a.candidateId === candidate.id && a.axis === axis);
    const binding = parsed.bindings.find(b => b.candidateId === candidate.id && b.requestedAction === requestedAction);
    return { candidateId: candidate.id, requestedAction, action: action ? structuredClone(action.result) : null,
      sourceTargetBinding: binding ? structuredClone(binding) : null,
      actionEvidence: action?.result.evidenceIds.map(id => structuredClone(parsed.evidence.find(e => e.id === id)!)) ?? [],
      actionCheck: action ? 'structurally_valid_model_declaration' : 'unassessed',
      bindingCheck: binding ? 'structurally_valid_model_declaration' : 'not_performed_or_invalid',
      wholeTargetDeclared: binding ? binding.targetRef.nodeId === candidate.target && binding.targetRef.scope === 'whole' : null,
      warnings: parsed.warnings.filter(w => w.candidateId === candidate.id && w.action === requestedAction),
      semanticVerification: 'not_performed', formalGraphAdmission: false, productionWrites: false };
  }));
}
