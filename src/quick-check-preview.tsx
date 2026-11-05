import React, { StrictMode, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/noto-serif-sc';
import './index.css';
import 'katex/dist/katex.min.css';
import { QuickCheckButton, QuickCheckProvider, type QuickCheckAdapters, type QuickCheckController } from './components/quickCheck';
import { applyQuickCheckAssessment, evaluateQuickCheck, generateQuickCheck, type QuickCheckCall } from './services/quickCheck';
import { createMasteryShadowState } from './services/masteryShadow/stateMachine';
import { MASTERY_SHADOW_CRITERIA } from './services/masteryShadow/rubric';
import { masteryBaselineFixture, masteryComparisonFixture } from '../scripts/fixtures/mastery-baselines';
import { quickCheckDesignFixture } from '../scripts/fixtures/quick-check-design';
import type { NoteItem } from './types';

// Isolated UI acceptance surface: actual card/core, synthetic model transport,
// one in-memory note and a preview-only draft cache. No real vault or network.
const initial: NoteItem = { id: 'quick-check-preview-arithmetic', title: '等差数列', noteType: 'knowledge',
  content: '# 含义与边界\n等差数列相邻两项的差相等，公差为d。通项公式为aₙ=a₁+(n−1)d，其中n为正整数。不能仅凭前三项符合规律，就断言所有后续项都遵循同一规律。\n\n# 应用与推导\n已知数列为等差数列且首项3、公差2，第10项为3+(10−1)×2=21。应先确认数列满足等差条件，再使用通项公式。公式中的n−1表示从首项到第n项共有n−1次公差增量。',
  tags: [], links: [], backlinks: [], dueDates: [], createdAt: '2026-10-18T00:00:00Z', updatedAt: '2026-10-18T00:00:00Z' };
const previewRun = (new URLSearchParams(window.location.search).get('run') || 'default').replace(/[^a-z0-9-]/gi, '').slice(0, 48);

function Preview() {
  const [notes, setNotes] = useState([initial]);
  const [counts, setCounts] = useState({ generation: 0, evaluation: 0 });
  const controllerRef = useRef<QuickCheckController | null>(null);
  const generationRef = useRef(0);
  const adapters = useMemo<Partial<QuickCheckAdapters>>(() => {
    const call: QuickCheckCall = async request => {
      await new Promise(resolve => setTimeout(resolve, 250));
      const input = JSON.parse(request.userInput);
      if (input.targets) {
        generationRef.current++;
        setCounts(value => ({ ...value, generation: value.generation + 1 }));
        const prompts = generationRef.current % 2 ? ['已知数列为等差数列，首项3、公差2。求第10项，并说明关键步骤。',
          '哪组数的相邻差都相等？', '只看到前三项3、5、7，就能断言所有后续项都保持公差2吗？']
          : ['为什么等差数列第n项公式中是(n−1)d，而不是nd？说明你的理由。',
            '使用等差数列通项公式前，应先确认哪一点？', '仅凭前三项相邻差相等，就足以确认整个数列都是等差数列吗？'];
        return { content: JSON.stringify(quickCheckDesignFixture(request, { questions: (input.requestedSlots || ['Q1', 'Q2', 'Q3']).map((id: string) => {
          const i = Number(id.slice(1)) - 1, target = input.targets[i % input.targets.length];
          const reference = input.references.find((ref: { criterionIds: string[] }) => ref.criterionIds.includes(target.id));
          return { id, type: i === 0 ? 'calculation' : i === 1 ? 'choice' : 'true_false', prompt: prompts[i],
            criterionIds: [target.id], referenceIds: [reference.id],
            ...(i ? { options: i === 1 ? [{ id: 'A', text: generationRef.current % 2 ? '3、5、7' : '数列满足等差条件' },
              { id: 'B', text: generationRef.current % 2 ? '3、5、8' : '只要前两项已知即可' }]
              : [{ id: 'A', text: '能' }, { id: 'B', text: '不能' }] } : {}),
            privateAnswer: { ...(i ? { optionId: i === 1 ? 'A' : 'B' } : {}),
              explanation: i === 0 ? '第10项为21；首项之后增加9次公差。使用公式前必须确认等差条件。'
                : i === 1 ? '等差条件要求相邻差相等，不能只根据两项套用公式。' : '有限的前三项不足以确定全部后续项。',
              referenceQuotes: [{ referenceId: reference.id, quote: reference.quote.slice(0, 180) }] } };
        }) })) };
      }
      setCounts(value => ({ ...value, evaluation: value.evaluation + 1 }));
      return { content: JSON.stringify({ protocol: 'quick-check-evaluation-v2', sessionId: input.sessionId,
        questionEvaluations: input.questionTasks.map((task: any) => {
          const scope = task.task.verificationScopes[0];
          const scoped = { ...task, references: input.references.filter((ref: any) => scope.referenceIds.includes(ref.id)) };
          // Preview-only semantic oracle uses the displayed option TEXT, never
          // the generator's old letter: choices are now shuffled locally.
          const correctOption = task.questionId === 'Q2'
            ? /^([ABCD])\. (?:3、5、7|数列满足等差条件)$/mu.exec(task.task.prompt)?.[1] || '' : 'B';
          const pass = task.questionId === 'Q1' || task.answer.includes(`选择：${correctOption}`);
          const reference = scoped.references[0];
          return { questionId: task.questionId, result: { protocol: 'mastery-shadow-evaluator-v1', evaluationId: task.evaluationId,
            knowledgePointId: input.knowledgePointId, baselines: masteryBaselineFixture(scoped), evidence: [{ id: 'E1', quote: task.answer }],
            criteria: task.criteria.map((criterion: { id: string }) => ({ id: criterion.id, state: pass ? 'pass' : 'fail', evidenceIds: ['E1'],
              ...(!pass ? { comparison: masteryComparisonFixture(scoped, criterion.id, ['E1']) } : {}),
              reason: '仅用于预览的逐题模拟评价，不是实际模型语义验收。' })), summary: '演示：本题已单独核对。' },
            ...(task.questionId === 'Q1' ? {} : { answerKey: { optionId: correctOption, explanation: '应先确认等差条件，不能用前三项推定全部后续项。',
              referenceQuotes: [{ referenceId: reference.id, quote: reference.quote.slice(0, 180) }] } }) };
        }) }) };
    };
    return {
      generate: options => generateQuickCheck({ ...options, call, readers: { searchNotes: async () => [] } }),
      evaluate: (session, answers, options) => evaluateQuickCheck(session, answers, { ...options, call }),
    };
  }, []);
  return <QuickCheckProvider notes={notes} controllerRef={controllerRef} storageScope={`isolated-quick-check-preview-v1:${previewRun}`} adapters={adapters}
    onCommit={async (session, assessment) => {
      const outcome = applyQuickCheckAssessment(notes, session, assessment);
      if (outcome.reason) throw new Error(outcome.reason);
      setNotes(outcome.notes);
      return outcome.result;
    }}>
    <main style={{ maxWidth: 850, margin: '10vh auto', padding: 28, color: 'var(--ln-text-primary)', background: 'var(--ln-bg-surface)', border: '1px solid var(--ln-border)', borderRadius: 24 }}>
      <p style={{ color: 'var(--ln-accent)', fontSize: 12, letterSpacing: 2 }}>QUICK CHECK · 隔离交互预览</p>
      <h1 style={{ fontSize: 28, margin: '12px 0' }}>针对缺口，三题检验</h1>
      <p style={{ color: 'var(--ln-text-muted)', lineHeight: 1.8 }}>使用真实简测组件和状态机，出题与评价接口为模拟返回。不读取正式笔记，不调用云模型，不修改正式掌握度。</p>
      <section style={{ margin: '28px 0', padding: 24, borderRadius: 16, background: 'var(--ln-bg-subtle)' }}>
        <h2 style={{ fontSize: 22, marginBottom: 8 }}>等差数列</h2>
        <p style={{ color: 'var(--ln-text-muted)', marginBottom: 18 }}>保留同一张卡片，完成后再根据最新缺口出题。</p>
        <QuickCheckButton noteId={initial.id} source="preview" />
        <button type="button" className="quick-check-entry" style={{ marginLeft: 10 }} onClick={() =>
          controllerRef.current?.open({ noteId: initial.id, regenerate: true, source: 'agent' })}>模拟 Agent 重新出题</button>
        <button type="button" className="quick-check-entry" style={{ marginLeft: 10 }} onClick={() => {
          setNotes(current => current.map(note => {
            const state = structuredClone(note.dsrState?.masteryShadow || createMasteryShadowState(note.id));
            const criterion = state.layers.concept.criteria!.concept_accuracy;
            criterion.state = criterion.state === 'confirmed' ? 'needs_review' : 'confirmed';
            criterion.independentPasses = criterion.state === 'confirmed' ? 2 : 0;
            criterion.unresolvedFailures = criterion.state === 'needs_review' ? 1 : 0;
            return { ...note, dsrState: { difficulty: 5, stability: 2, reviewCount: 0, lastReviewedAt: null,
              consecutiveCorrect: 0, consecutiveWrong: 0, ...note.dsrState, masteryShadow: state } };
          }));
        }}>模拟掌握情况变化</button>
      </section>
      <p style={{ fontSize: 13, color: 'var(--ln-text-muted)' }}>出题请求 {counts.generation} 次 · 统一评价 {counts.evaluation} 次</p>
      <details style={{ marginTop: 12, color: 'var(--ln-text-muted)', fontSize: 13 }}><summary>查看演示状态</summary>
        {MASTERY_SHADOW_CRITERIA.map(criterion => <p key={criterion.id}>{criterion.label}：{notes[0].dsrState?.masteryShadow?.layers[criterion.layer].criteria?.[criterion.id]?.state || 'unassessed'}</p>)}
      </details>
    </main>
  </QuickCheckProvider>;
}

createRoot(document.getElementById('root')!).render(<StrictMode><Preview /></StrictMode>);
