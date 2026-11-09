import assert from 'node:assert/strict';
import { FIGURE_TEACHING_MODES, figureTeachingModeGuidance, isFigureTeachingMode, selectFigureTeachingMode, type FigureTeachingMode } from '../src/services/textbook/interactiveFigurePedagogy';

const cases: Array<{ brief: string; lesson?: string; wholePage?: boolean; mode: FigureTeachingMode }> = [
  { brief: '动态演示弹簧振动，暂停观察平衡位置', mode: 'dynamic' },
  { brief: '观察质点运动轨迹与速度方向', mode: 'dynamic' },
  { brief: '观察简谐运动的位移与速度', mode: 'dynamic' },
  { brief: '逐步执行 LRU 命中与淘汰', mode: 'step' },
  { brief: '逐步观察振动中的几个阶段', mode: 'step' },
  { brief: '算法状态怎样从输入转为输出', mode: 'step' },
  { brief: '比较两种理论对同一现象的解释', lesson: '弹簧振动是另一个例子。先预测数值。', mode: 'contrast' },
  { brief: '比较位移与速度的相位关系', lesson: '# 简谐运动\n逐步计算。', mode: 'contrast' },
  { brief: '解释心理账户怎样影响选择', mode: 'contrast' },
  { brief: '先预测结果，再操作验证', mode: 'prediction' },
  { brief: '生成一道有关弹簧振动的预测题', mode: 'prediction' },
  { brief: '预测 x=2 时曲线上点的高度', mode: 'prediction' },
  { brief: '预测模型的误差为什么不同', mode: 'contrast' },
  { brief: '检验结论是否适用于这个边界情境', mode: 'prediction' },
  { brief: '不需要预测，只动态演示运动', mode: 'dynamic' },
  { brief: '不要预测题，比较两种解释', mode: 'contrast' },
  { brief: '不要动态演示振动，只对比两种解释', mode: 'contrast' },
  { brief: '不需要自动播放的动态演示，用时间滑块观察', mode: 'dynamic' },
  { brief: '不需要逐步执行算法，只对比初始与结束状态', mode: 'contrast' },
  { brief: '不要对照，逐步执行算法', mode: 'step' },
  { brief: '解释这条结论', lesson: '# 弹簧振动\n请先预测；逐步计算。', mode: 'contrast' },
  { brief: '根据本页教材的核心内容生成交互图。', lesson: '# 平衡位置为什么不是终点\n理想弹簧做简谐运动。先预测一个数值。', wholePage: true, mode: 'dynamic' },
  { brief: '根据本页教材生成交互图。', lesson: '# 队列算法\n逐次入队与出队。', wholePage: true, mode: 'step' },
  { brief: '根据本页教材生成交互图。', lesson: '# 两种理论的对照\n某个运动过程只是例子。', wholePage: true, mode: 'contrast' },
  { brief: '根据本页教材生成交互图。', lesson: '# 函数定义\n先预测，再检查答案。', wholePage: true, mode: 'contrast' },
  { brief: '根据本页教材生成交互图。', lesson: '# 概念解释\n```md\n# 动态演示振动\n```\n同一个词可能有不同含义。', wholePage: true, mode: 'contrast' },
  { brief: '根据本页教材生成交互图。', lesson: '# 概念解释\n<!-- 动态演示运动 -->\n解释一个概念。', wholePage: true, mode: 'contrast' },
  { brief: '逐步说明这一过程', lesson: '# 对比\n随时间演变。', wholePage: true, mode: 'step' },
  { brief: '', lesson: '', wholePage: true, mode: 'contrast' },
];
for (const { brief, lesson = '', wholePage = false, mode } of cases) {
  assert.equal(selectFigureTeachingMode(brief, lesson, wholePage), mode, brief || 'empty safe fallback');
}

for (const mode of FIGURE_TEACHING_MODES) {
  const guide = figureTeachingModeGuidance(mode);
  assert.ok(isFigureTeachingMode(mode));
  assert.ok(guide.length <= 450, `${mode} guidance is bounded: ${guide.length}`);
  assert.ok(guide.includes(`data-figure-mode="${mode}"`));
  assert.ok(guide.includes('data-figure="reset"') && guide.includes('data-figure="result"'));
  for (const other of FIGURE_TEACHING_MODES.filter(value => value !== mode)) {
    assert.ok(!guide.includes(`data-figure-mode="${other}"`), 'only selected teaching guidance is disclosed');
  }
  if (mode !== 'prediction') assert.ok(!/data-figure="(?:prediction|check|transfer)"/u.test(guide), 'non-quiz modes do not require a quiz contract');
}
assert.ok(figureTeachingModeGuidance('dynamic').includes('data-figure="play"') && figureTeachingModeGuidance('dynamic').includes('data-figure="pause"'));
assert.ok(figureTeachingModeGuidance('dynamic').includes('data-figure="time"') && figureTeachingModeGuidance('dynamic').includes('data-figure="step"'));
assert.ok(figureTeachingModeGuidance('step').includes('data-figure="step"') && figureTeachingModeGuidance('step').includes('data-figure="state"'));
assert.ok(figureTeachingModeGuidance('contrast').includes('至少两个 data-figure="case"') && figureTeachingModeGuidance('contrast').includes('同一输入'));
for (const invalid of [null, undefined, {}, '', 'automatic', 'Dynamic', ['dynamic']]) assert.equal(isFigureTeachingMode(invalid), false);

console.log(`PASS ${cases.length} purpose routes, selected-scope isolation, bounded guidance and mode-specific contracts; no model calls`);
