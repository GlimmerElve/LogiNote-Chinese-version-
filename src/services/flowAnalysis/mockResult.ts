import type { FlowResultData } from '../../components/FlowResultView';

export function createMockFlowResult(): FlowResultData {
  const createdAt = '2026-10-01T14:26:00.000+08:00';
  const speakingContent = '间隔复习能够提高长期记忆，因为记忆会随时间自然衰减，而在遗忘发生前主动提取信息，会再次强化记忆痕迹。每次回忆都像一次重新编码，所以分散复习通常比集中复习稳定。不过最佳间隔并不是固定的，它可能受到知识类型、熟悉程度和个体差异影响。';

  return {
    noteId: null,
    noteTitle: '间隔复习',
    speakingContent,
    createdAt,
    entryMode: 'new',
    isMock: true,
    doc: {
      doc_id: 'mock_flow_result_argument',
      title: '间隔复习为什么能够提高长期记忆',
      created_at: createdAt,
      updated_at: createdAt,
      iteration: 1,
      status: 'draft',
      nodes: [
        { id: 's1', mainType: '推理', text: '间隔复习通过在遗忘发生前多次提取信息，增强记忆的稳定性，从而提高长期记忆效果。', position: { x: 410, y: 20 }, status: 'ok', issue: null, severity: null, suggestion: null, subTypes: '核心结论', user_edited: false, collapsed: false },
        { id: 's2', mainType: '事实陈述', text: '记忆会随时间自然衰减，不进行复习时，新获得的信息会逐渐淡忘。', position: { x: 100, y: 260 }, status: 'ok', issue: null, severity: null, suggestion: null, subTypes: '前提 1', user_edited: false, collapsed: false },
        { id: 's3', mainType: '事实陈述', text: '提取练习能够增强记忆痕迹，每次主动回忆都是一次再编码。', position: { x: 700, y: 260 }, status: 'ok', issue: null, severity: null, suggestion: null, subTypes: '前提 2', user_edited: false, collapsed: false },
        { id: 's4', mainType: '推理', text: '在遗忘发生前进行复习，可阻止遗忘并提升下一次回忆的难度与效果。', position: { x: 20, y: 510 }, status: 'ok', issue: null, severity: null, suggestion: null, subTypes: '推论', user_edited: false, collapsed: false },
        { id: 's5', mainType: '举例', text: '多项实验表明，间隔复习在长期保持上通常优于集中复习。', position: { x: 420, y: 510 }, status: 'ok', issue: null, severity: null, suggestion: null, subTypes: '支持证据', user_edited: false, collapsed: false },
        { id: 's6', mainType: '假设', text: '最佳间隔时间因人而异，但本次复述尚未给出适用条件和证据。', position: { x: 820, y: 510 }, status: 'warning', issue: '证据缺口：对最佳间隔时间的判断缺少适用条件', severity: 3, suggestion: '补充不同知识类型与个体差异如何影响间隔选择的证据。', subTypes: '证据缺口', user_edited: false, collapsed: false },
      ],
      edges: [
        { id: 'e1', source: 's2', target: 's1', relation: 'support' },
        { id: 'e2', source: 's3', target: 's1', relation: 'support' },
        { id: 'e3', source: 's4', target: 's2', relation: 'support' },
        { id: 'e4', source: 's5', target: 's3', relation: 'support' },
        { id: 'e5', source: 's6', target: 's3', relation: 'oppose' },
      ],
      summary: '论证已形成“记忆衰减—主动提取—长期保持”的主链，但最佳间隔的适用条件仍需补证。',
      scores: { conceptScore: 82, judgmentScore: 76, logicScore: 68 },
    },
    report: {
      clarityScore: 79,
      clarityComment: '主线清楚，个别条件表达仍较笼统',
      summary: '你已经说明间隔复习的核心机制，并能把遗忘、提取练习与长期保持联系起来。',
      recommendation: '阅读间隔效应的最新实证研究，并比较不同知识类型对应的复习间隔策略。',
      thinkingStyleBrief: '倾向先给出机制解释，再用经验结论支撑；整体收敛，但条件边界表达偏少。',
      conceptSummary: '关键概念理解较完整',
      judgmentSummary: '能区分主要事实与观点',
      reasoningSummary: '主链成立，条件推理仍有提升空间',
      overallComment: '本次复述已经建立稳定主链，下一突破口是补足适用边界与反例。',
      sections: [
        {
          kind: 'argumentQuality',
          title: '论证质量',
          total: 1,
          items: [{
            layeredScores: {
              raw: { concept: 87, judgment: 81, logic: 78 },
              penalty: { concept: 5, judgment: 5, logic: 10 },
              final: { concept: 82, judgment: 76, logic: 68 },
              grade: { concept: '良好', judgment: '良好', logic: '及格' },
            },
            vulnerabilities: [
              { nodeId: 's6', type: '适用边界缺失', severity: 3, layer: '判断层', evidence: '“最佳间隔时间因人而异”没有说明受哪些变量影响。', suggestion: '比较年龄、熟悉度和知识类型对间隔选择的影响。' },
              { nodeId: 's3', type: '证据来源不足', severity: 2, layer: '逻辑层', evidence: '“多项实验表明”没有说明具体证据或研究条件。', suggestion: '补充一项代表性研究及其样本、任务和结论。' },
            ],
            summary: '核心因果链完整，但经验论证的来源与适用边界需要继续补足。',
          }],
        },
        { kind: 'cognitiveInterpretation', title: '认知风格解读', total: 1, items: ['表达偏系统化，能够从机制上组织材料，但对不确定性的展开不足。'] },
        { kind: 'expressionStyle', title: '表达风格', total: 1, items: ['以解释性表达为主，结构明确，限定词使用较少。'] },
        { kind: 'relatedKnowledge', title: '关联知识', total: 2, items: [
          { term: '遗忘曲线', relation: '解释记忆随时间衰减的基础模型', suggestedWikiLink: '遗忘曲线' },
          { term: '提取练习', relation: '支撑主动回忆能够增强记忆痕迹', suggestedWikiLink: '提取练习' },
        ] },
        { kind: 'mastery', title: '知识点掌握度', total: 1, items: [
          { name: '间隔效应', level: 'reasoning', conceptDelta: 8, judgmentDelta: 5, reasoningDelta: 3, comment: '机制理解稳定，适用边界待补充' },
        ] },
      ],
    },
  };
}
