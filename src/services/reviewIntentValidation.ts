import { REVIEW_COGNITION_PURPOSES, type ReviewCognitionPurpose, type ReviewQuestionIntent } from './reviewIntent';
import { parseReviewAssessment } from './reviewAssessment';
import { parseReviewReferenceRubric } from './reviewReferenceRubric';
import { parseArgumentQuestionReceipt } from './argumentContext/questionReceipt';

const PURPOSES = new Set<string>(REVIEW_COGNITION_PURPOSES);
const id = (value: unknown, label: string, max = 300): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${label}无效`);
  return value;
};

/** Validate persisted/private intent data at the trust boundary. */
export function parseReviewQuestionIntent(raw: unknown): ReviewQuestionIntent {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('复习问题意图无效');
  const value = raw as Record<string, unknown>;
  if (value.version !== 1 || !Array.isArray(value.knowledgeTargets) || value.knowledgeTargets.length > 20) {
    throw new Error('复习问题意图版本或知识点无效');
  }
  const knowledgeTargets = value.knowledgeTargets.map((item) => id(item, '知识点', 1000));
  const result: ReviewQuestionIntent = {
    version: 1,
    questionMessageId: id(value.questionMessageId, '问题消息', 80),
    knowledgeTargets: [...new Set(knowledgeTargets)],
  };
  if (value.assessment !== undefined) result.assessment = parseReviewAssessment(value.assessment, result.knowledgeTargets);
  if (value.referenceRubric !== undefined) {
    if (!result.assessment) throw new Error('invalid_reference_rubric');
    result.referenceRubric = parseReviewReferenceRubric(value.referenceRubric, result.assessment, result.knowledgeTargets);
  }
  if (value.cognitionTarget !== undefined) {
    const target = value.cognitionTarget;
    if (!target || typeof target !== 'object' || Array.isArray(target)) throw new Error('认知坐标无效');
    const pointer = target as Record<string, unknown>;
    if (!PURPOSES.has(pointer.purpose as string)) throw new Error('认知提问目的无效');
    result.cognitionTarget = {
      recordId: id(pointer.recordId, '认知记录'),
      revisionId: id(pointer.revisionId, '认知版本', 200),
      branchId: id(pointer.branchId, '认知分支', 200),
      nodeId: id(pointer.nodeId, '认知节点', 200),
      purpose: pointer.purpose as ReviewCognitionPurpose,
    };
  }
  if (value.referenceStructure !== undefined) result.referenceStructure = parseArgumentQuestionReceipt(value.referenceStructure);
  return result;
}
