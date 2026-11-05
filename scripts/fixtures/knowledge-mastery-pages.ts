import type { NoteItem } from '../../src/types';
import { createMasteryShadowState } from '../../src/services/masteryShadow/stateMachine';
import { MASTERY_SHADOW_LAYERS, type MasteryShadowLayerState } from '../../src/services/masteryShadow/types';
import { setMasteryLayerFixture } from './mastery-evidence';

/** Display fixtures only. No real observations, scoring, storage or model requests. */
export function createKnowledgeMasteryPagesFixture(): NoteItem[] {
  const now = Date.now();
  const at = new Date(now).toISOString();
  function knowledge(id: string, title: string, content: string, states?: MasteryShadowLayerState[], history?: number): NoteItem {
    const masteryShadow = states ? createMasteryShadowState(id) : undefined;
    if (masteryShadow) {
      masteryShadow.appliedObservationIds = [`display-only-${id}`];
      masteryShadow.updatedAt = at;
      MASTERY_SHADOW_LAYERS.forEach((layer, index) => {
        const record = masteryShadow.layers[layer];
        setMasteryLayerFixture(masteryShadow, layer, states![index]);
        record.independentPasses = record.state === 'confirmed' ? 2 : record.state === 'provisional' ? 1 : 0;
        record.unresolvedFailures = record.state === 'needs_review' ? 2 : 0;
        record.lastObservedAt = at;
        if (record.state === 'confirmed') record.lastConfirmedAt = at;
      });
    }
    return { id, title, content, noteType: 'knowledge', tags: ['认知与学习'], links: [], backlinks: [],
      dueDates: [], createdAt: at, updatedAt: at,
      dsrState: { difficulty: 5, stability: 14, lastReviewedAt: new Date(now - 86_400_000).toISOString(),
        reviewCount: 2, consecutiveCorrect: 1, consecutiveWrong: 0, masteryShadow,
        conceptMastery: history, conceptMasterySamples: history === undefined ? undefined : 3 } };
  }
  const notes = [
    knowledge('preview-hawthorne', '霍桑效应',
      '霍桑效应是指人们意识到自己正在被观察或受到额外关注时，行为可能随之改变。它提醒我们区分干预本身的效果与被关注所带来的影响。研究时可以设置相同关注程度的对照组，以减少这种混淆。',
      ['provisional', 'unassessed', 'unassessed']),
    knowledge('preview-confirmation', '确认偏误',
      '确认偏误是倾向于寻找、解释和记忆支持既有信念的信息，而忽视或低估反向证据。检验自己的解释时，应主动寻找可能推翻它的证据，并比较不同解释。',
      ['confirmed', 'confirmed', 'confirmed']),
    knowledge('preview-loss', '损失厌恶',
      '损失厌恶描述在其他条件相近时，同等规模的损失往往比收益带来更强的心理影响。它不等于任何风险情境下都回避风险；分析行为时，需要先明确参照点、收益和损失的界定。',
      ['confirmed', 'needs_review', 'unassessed']),
    knowledge('preview-intrinsic', '内驱力',
      '内驱力指活动本身带来的兴趣、满足或自主感驱动的行动。它可以与外部奖励共同存在，但不能仅根据行为持续时间就断言其来源。'),
    knowledge('preview-framework', '知识框架',
      '知识框架通过概念层级、共同维度和显式关系组织一个领域的知识。它既可以帮助检索，也可以暴露尚未建立联系的部分。框架应随着新证据修订，而不是替代证据本身。', undefined, 88),
    knowledge('preview-spacing', '间隔效应',
      '间隔效应是把学习分散到多个时间点，相比同一时段集中重复，通常更有利于长期保持。记忆刷新与理解掌握分开记录：一段时间没有复习，不意味着已经不会理解或推理。',
      ['confirmed', 'confirmed', 'confirmed']),
    knowledge('preview-memory', '工作记忆', '请对该知识点进行定义描述'),
  ];
  notes[5].dsrState!.lastReviewedAt = new Date(now - 60 * 86_400_000).toISOString();
  const links = [
    ['确认偏误', '损失厌恶'], ['霍桑效应', '知识框架'], ['确认偏误', '内驱力'],
    ['损失厌恶', '间隔效应'], ['确认偏误', '工作记忆'], ['内驱力', '工作记忆'], ['知识框架', '间隔效应'],
  ];
  notes.forEach((note, index) => { note.links = links[index]; });
  for (const note of notes) note.backlinks = notes.filter(other => other.links.includes(note.title)).map(other => other.title);
  return [{ id: 'preview-project', title: '认知与学习', noteType: 'project',
    content: '# 认知与学习\n\n了解认知偏差、学习动机与记忆策略，并用具体情境检验自己的解释。\n\n' + notes.map(note => `[[${note.title}]]`).join('、'),
    tags: [], links: notes.map(note => note.title), backlinks: [], dueDates: [], createdAt: at, updatedAt: at }, ...notes];
}
