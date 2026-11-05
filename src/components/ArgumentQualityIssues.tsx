import React, { useEffect, useMemo, useState } from 'react';
import {
  Check,
  EyeOff,
  Focus,
  PencilLine,
  RotateCcw,
  X,
} from 'lucide-react';
import type {
  ArgDoc,
  ArgumentAdmissionLevel,
  ArgumentIssueDecision,
  ArgumentSemanticIssue,
} from '../services/argumentDoc/types';
import { isArgumentSemanticIssueTargetUnchanged } from '../services/argumentDoc/quality';

interface ArgumentQualityIssuesProps {
  doc: ArgDoc;
  semanticFresh: boolean;
  effective: { score: number; admission: ArgumentAdmissionLevel } | null;
  onLocate: (issue: ArgumentSemanticIssue) => void;
  onIgnore: (issue: ArgumentSemanticIssue, reason: string) => void;
  onRestore: (issue: ArgumentSemanticIssue) => void;
  onApplySuggestion: (issue: ArgumentSemanticIssue, text: string) => void;
}

function severityLabel(severity: ArgumentSemanticIssue['severity']): string {
  if (severity === 'blocker') return '阻断';
  if (severity === 'major') return '重要';
  return '次要';
}

function issueTarget(issue: ArgumentSemanticIssue): string {
  if (issue.target.kind === 'graph') return '全图';
  return `${issue.target.kind === 'node' ? '节点' : '连线'} ${issue.target.id || ''}`;
}

function activeDecision(
  decisions: ArgumentIssueDecision[] | undefined,
  revisionHash: string,
  issueId: string,
): ArgumentIssueDecision | undefined {
  return decisions?.find((decision) => (
    decision.revisionHash === revisionHash
    && decision.issueId === issueId
    && decision.action === 'ignored'
  ));
}

export const ArgumentQualityIssues: React.FC<ArgumentQualityIssuesProps> = ({
  doc,
  semanticFresh,
  effective,
  onLocate,
  onIgnore,
  onRestore,
  onApplySuggestion,
}) => {
  const semantic = doc.rag?.semanticAssessment;
  const [editingIssueId, setEditingIssueId] = useState<string | null>(null);
  const [suggestedText, setSuggestedText] = useState('');
  const [ignoringIssueId, setIgnoringIssueId] = useState<string | null>(null);
  const [ignoreReason, setIgnoreReason] = useState('');
  const [message, setMessage] = useState('');

  useEffect(() => {
    setEditingIssueId(null);
    setIgnoringIssueId(null);
    setMessage('');
  }, [semantic?.revisionHash]);

  const nodeById = useMemo(
    () => new Map(doc.nodes.map((node) => [node.id, node])),
    [doc.nodes],
  );

  const beginSuggestion = (issue: ArgumentSemanticIssue) => {
    if (!issue.suggestedText || issue.target.kind !== 'node' || !issue.target.id) return;
    setIgnoringIssueId(null);
    setEditingIssueId(issue.id);
    setSuggestedText(issue.suggestedText);
    setMessage('建议已放入待确认编辑区，确认前不会修改画布。');
  };

  const confirmSuggestion = (issue: ArgumentSemanticIssue) => {
    if (!suggestedText.trim()) {
      setMessage('建议文本不能为空。');
      return;
    }
    onApplySuggestion(issue, suggestedText.trim());
    setEditingIssueId(null);
    setMessage('建议已应用；其余目标未变化的建议仍可继续处理，发布前需重新复核。');
  };

  const confirmIgnore = (issue: ArgumentSemanticIssue) => {
    const reason = ignoreReason.trim();
    if (reason.length < 4) {
      setMessage('请填写至少 4 个字的忽略理由。');
      return;
    }
    onIgnore(issue, reason);
    setIgnoringIssueId(null);
    setIgnoreReason('');
    setMessage('忽略理由已记录；它不会提高分数，也不能绕过 blocker。');
  };

  return (
    <div className="argument-quality-ui mt-4 space-y-4">
      {semantic && (
        <section aria-labelledby="argument-quality-issues-title">
          <div className="mb-2 flex items-center justify-between gap-3">
            <h3 id="argument-quality-issues-title" className="argument-quality-title">
              质量问题
            </h3>
            <span className="argument-quality-count">
              {semantic.issues.length} 项
            </span>
          </div>

          {!semanticFresh && semantic.issues.length > 0 && (
            <div className="argument-quality-notice is-warning">
              报告整体已过期，但目标未变化的建议仍可继续处理；目标已变化的建议需重新复核。
            </div>
          )}

          {semantic.issues.length === 0 ? (
            <div className="argument-quality-notice is-success">
              未发现语义阻断问题。
            </div>
          ) : (
            <div className="space-y-2">
              {semantic.issues.map((issue) => {
                const decision = activeDecision(doc.rag?.issueDecisions, semantic.revisionHash, issue.id);
                const applied = Boolean(doc.rag?.qualityAudit?.some((entry) => (
                  entry.event === 'suggestion_applied'
                  && entry.revisionHash === semantic.revisionHash
                  && entry.issueId === issue.id
                )));
                const targetUnchanged = semanticFresh
                  || isArgumentSemanticIssueTargetUnchanged(doc, semantic, issue);
                const targetChanged = !targetUnchanged && !applied;
                const originalText = issue.target.kind === 'node' && issue.target.id
                  ? nodeById.get(issue.target.id)?.text || ''
                  : '';
                const canApply = Boolean(
                  issue.suggestedText
                  && issue.target.kind === 'node'
                  && issue.target.id
                  && targetUnchanged
                  && !applied,
                );
                const canIgnore = issue.severity !== 'blocker' && targetUnchanged && !applied;
                const resolved = Boolean(decision || applied);

                return (
                  <article
                    key={issue.id}
                    className={`argument-quality-item${resolved ? ' is-resolved' : targetChanged ? ' is-target-changed' : issue.severity === 'blocker' ? ' is-blocker' : ''}`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="argument-quality-item-title">
                        {severityLabel(issue.severity)} · {issueTarget(issue)}
                      </div>
                      {applied ? (
                        <span className="argument-quality-badge is-success">
                          已应用
                        </span>
                      ) : decision ? (
                        <span className="argument-quality-badge">
                          已忽略
                        </span>
                      ) : targetChanged ? (
                        <span className="argument-quality-badge is-warning">
                          目标已变化
                        </span>
                      ) : null}
                    </div>
                    <div className="argument-quality-explanation">{issue.explanation}</div>
                    <div className="argument-quality-suggestion">{issue.suggestedAction}</div>

                    {decision && (
                      <div className="argument-quality-decision">
                        忽略理由：{decision.reason}
                      </div>
                    )}

                    <div className="mt-3 flex flex-wrap gap-2">
                      {issue.target.kind !== 'graph' && issue.target.id && (
                        <button
                          type="button"
                          onClick={() => onLocate(issue)}
                          className="argument-quality-action is-secondary"
                        >
                          <Focus className="h-3.5 w-3.5" aria-hidden="true" />
                          定位
                        </button>
                      )}
                      {canApply && !decision && (
                        <button
                          type="button"
                          onClick={() => beginSuggestion(issue)}
                          className="argument-quality-action is-primary"
                        >
                          <PencilLine className="h-3.5 w-3.5" aria-hidden="true" />
                          接受建议
                        </button>
                      )}
                      {canIgnore && !decision && (
                        <button
                          type="button"
                          onClick={() => {
                            setEditingIssueId(null);
                            setIgnoringIssueId(issue.id);
                            setIgnoreReason('');
                            setMessage('');
                          }}
                          className="argument-quality-action is-muted"
                        >
                          <EyeOff className="h-3.5 w-3.5" aria-hidden="true" />
                          忽略
                        </button>
                      )}
                      {decision && (
                        <button
                          type="button"
                          onClick={() => onRestore(issue)}
                          className="argument-quality-action is-secondary"
                        >
                          <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                          撤销忽略
                        </button>
                      )}
                    </div>

                    {editingIssueId === issue.id && (
                      <div className="argument-quality-editor is-suggestion">
                        <div className="argument-quality-field-label">当前文本</div>
                        <div className="argument-quality-current-text">
                          {originalText || '（空）'}
                        </div>
                        <label htmlFor={`suggestion-${issue.id}`} className="argument-quality-field-label is-input">
                          待确认文本
                        </label>
                        <textarea
                          id={`suggestion-${issue.id}`}
                          value={suggestedText}
                          onChange={(event) => setSuggestedText(event.target.value)}
                          rows={4}
                          autoFocus
                          className="argument-quality-textarea"
                        />
                        <div className="mt-2 flex justify-end gap-2">
                          <button
                            type="button"
                            onClick={() => setEditingIssueId(null)}
                            className="argument-quality-action is-muted"
                          >
                            <X className="h-3.5 w-3.5" aria-hidden="true" />取消
                          </button>
                          <button
                            type="button"
                            onClick={() => confirmSuggestion(issue)}
                            className="argument-quality-action is-primary"
                          >
                            <Check className="h-3.5 w-3.5" aria-hidden="true" />确认应用
                          </button>
                        </div>
                      </div>
                    )}

                    {ignoringIssueId === issue.id && (
                      <div className="argument-quality-editor">
                        <label htmlFor={`ignore-${issue.id}`} className="argument-quality-field-label">
                          忽略理由（必填）
                        </label>
                        <textarea
                          id={`ignore-${issue.id}`}
                          value={ignoreReason}
                          onChange={(event) => setIgnoreReason(event.target.value)}
                          rows={3}
                          maxLength={300}
                          autoFocus
                          placeholder="说明为什么当前上下文中可以保留此问题"
                          className="argument-quality-textarea"
                        />
                        <div className="mt-2 flex justify-end gap-2">
                          <button
                            type="button"
                            onClick={() => setIgnoringIssueId(null)}
                            className="argument-quality-action is-muted"
                          >
                            取消
                          </button>
                          <button
                            type="button"
                            onClick={() => confirmIgnore(issue)}
                            className="argument-quality-action is-secondary"
                          >
                            记录并忽略
                          </button>
                        </div>
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          )}
        </section>
      )}

      {message && (
        <div role="status" aria-live="polite" className="argument-quality-status">
          {message}
        </div>
      )}

      <section aria-labelledby="argument-publish-preview-title" className="argument-quality-preview">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 id="argument-publish-preview-title" className="argument-quality-title">
              发布内容预览
            </h3>
            <p className="argument-quality-preview-copy">
              {semanticFresh && effective?.admission !== 'review_required'
                ? `确认发布后，当前 ${doc.nodes.length} 个节点和 ${doc.edges.length} 条连线会进入论证层 RAG。`
                : '当前版本不会进入论证层 RAG；已发布的旧快照不受影响。'}
            </p>
          </div>
          <span className={`shrink-0 rounded-full px-2 py-1 text-[10px] font-medium ${semanticFresh && effective?.admission !== 'review_required'
            ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300'
            : 'bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300'}`}
          >
            {semanticFresh && effective?.admission !== 'review_required' ? '可发布' : '仅存草稿'}
          </span>
        </div>

        <details className="mt-3 group">
          <summary className="argument-quality-summary">
            查看实际节点与连线
          </summary>
          <div className="mt-2 space-y-3 border-t border-slate-100 pt-3 dark:border-slate-800">
            <div>
              <div className="text-[11px] font-medium text-slate-500">节点（{doc.nodes.length}）</div>
              <ol className="mt-1 max-h-36 space-y-1 overflow-y-auto pr-1 text-[11px] text-slate-600 dark:text-slate-300">
                {doc.nodes.map((node) => (
                  <li key={node.id} className="rounded-md bg-slate-50 px-2 py-1.5 dark:bg-slate-900/60">
                    <span className="font-medium">{node.id} · {node.mainType}</span> — {node.text || '（空）'}
                  </li>
                ))}
              </ol>
            </div>
            <div>
              <div className="text-[11px] font-medium text-slate-500">连线（{doc.edges.length}）</div>
              <ol className="mt-1 max-h-28 space-y-1 overflow-y-auto pr-1 text-[11px] text-slate-600 dark:text-slate-300">
                {doc.edges.map((edge) => (
                  <li key={edge.id} className="rounded-md bg-slate-50 px-2 py-1.5 dark:bg-slate-900/60">
                    {edge.id} · {edge.source} {edge.relation === 'support' ? '支持' : '反对'} {edge.target}
                  </li>
                ))}
              </ol>
            </div>
          </div>
        </details>
      </section>
    </div>
  );
};
