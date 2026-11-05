/** Small persisted SHADOW receipt. A self-hash is not host authority; verify requires the retained host contract. */
export interface ArgumentQuestionReceipt {
  version: 1; status: 'fixed' | 'held'; originQuestionMessageId: string;
  freezeId?: string; contractHash?: string; selectorsHash?: string; reasons: string[];
}
export interface ArgumentQuestionReceiptVerification { status: 'current' | 'held'; reasons: string[] }
export function parseArgumentQuestionReceipt(raw: unknown): ArgumentQuestionReceipt {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid_question_receipt');
  const v = raw as ArgumentQuestionReceipt;
  if (Object.keys(v).some(k => !['version', 'status', 'originQuestionMessageId', 'freezeId', 'contractHash', 'selectorsHash', 'reasons'].includes(k))
    || v.version !== 1 || !['fixed', 'held'].includes(v.status) || typeof v.originQuestionMessageId !== 'string'
    || !v.originQuestionMessageId.trim() || v.originQuestionMessageId.length > 80
    || !Array.isArray(v.reasons) || v.reasons.length > 24 || v.reasons.some(r => typeof r !== 'string' || !/^[a-z_]{1,80}$/u.test(r))
    || new Set(v.reasons).size !== v.reasons.length
    || v.freezeId !== undefined && (typeof v.freezeId !== 'string' || !/^[a-f0-9-]{36}$/u.test(v.freezeId))
    || v.contractHash !== undefined && (typeof v.contractHash !== 'string' || !/^[a-f0-9]{64}$/u.test(v.contractHash))
    || v.selectorsHash !== undefined && (typeof v.selectorsHash !== 'string' || !/^[a-f0-9]{64}$/u.test(v.selectorsHash))
    || (v.freezeId === undefined) !== (v.contractHash === undefined)
    || (v.freezeId === undefined) !== (v.selectorsHash === undefined)
    || v.status === 'fixed' && (!v.freezeId || v.reasons.length)) throw new Error('invalid_question_receipt');
  return structuredClone(v);
}
