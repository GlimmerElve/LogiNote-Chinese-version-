import type { ArgDoc } from '../argumentDoc/types';
import {
  assessArgumentDoc,
  assessArgumentEvidence,
  computeArgumentRevisionHash,
  getEffectiveArgumentQuality,
  rejectedEvidenceNodeIds,
} from '../argumentDoc/quality';

export type ArgumentPublicationChoice = 'draft' | 'publish';

export function prepareArgumentPublication(doc: ArgDoc, now = new Date().toISOString()) {
  const assessment = assessArgumentDoc(doc, now);
  const revisionHash = computeArgumentRevisionHash(doc);
  const semanticAssessment = doc.rag?.semanticAssessment;
  const semanticFresh = semanticAssessment?.revisionHash === revisionHash;
  const evidenceAssessment = assessArgumentEvidence(
    doc,
    now,
    semanticFresh ? rejectedEvidenceNodeIds(semanticAssessment) : undefined,
  );
  const effective = semanticFresh
    ? getEffectiveArgumentQuality(assessment, semanticAssessment)
    : { score: assessment.score, admission: 'review_required' as const };
  const deterministicCorrections = assessment.issues
    .filter((issue) => issue.severity !== 'info')
    .slice(0, 4)
    .map((issue) => `${issue.message} ${issue.suggestion}`);
  const semanticCorrections = semanticFresh
    ? semanticAssessment.issues
        .filter((issue) => !doc.rag?.issueDecisions?.some((decision) => (
          decision.revisionHash === revisionHash && decision.issueId === issue.id
          && decision.action === 'ignored' && issue.severity !== 'blocker'
        )))
        .slice(0, 4)
        .map((issue) => `${issue.explanation} ${issue.suggestedAction}`)
    : [];
  const corrections = [...deterministicCorrections, ...semanticCorrections].slice(0, 5);
  const canPublish = semanticFresh && effective.admission !== 'review_required';
  const draftReason = canPublish ? null : !semanticFresh
    ? '还没有当前版本的语义质量报告，请先运行“RAG 质量复核”。'
    : corrections.join('\n') || '请修正阻断问题后重新复核。';
  return { assessment, revisionHash, semanticAssessment, semanticFresh, evidenceAssessment,
    effective, corrections, canPublish, draftReason, now };
}

export type ArgumentPublicationPreview = ReturnType<typeof prepareArgumentPublication>;
