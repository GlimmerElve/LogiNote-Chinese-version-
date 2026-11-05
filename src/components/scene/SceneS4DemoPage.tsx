import React, { useLayoutEffect, useState } from 'react';
import type { SceneRunState, SceneSpec } from '../../types';
import type { DerivationCanvasState } from '../../types/sceneS4';
import { createRunState } from '../../services/scene/sceneRuntime';
import { SceneDerivationView } from './SceneDerivationView';

const DEMO_TIME = '2026-10-03T09:00:00.000Z';

const DEMO_SPEC: SceneSpec = {
  sceneId: 'demo-s4-convexity',
  version: '1.0',
  meta: {
    name: '严格凸函数·推导画布',
    subject: '高等数学',
    sceneSkill: 'S4',
    knowledgePoints: ['拉格朗日中值定理', '导数的单调性', '严格凸函数的等价刻画'],
    goal: '由二阶导数为正，推出函数在区间上严格凸',
  },
  capabilityRecipeId: 'guided-derivation',
  capabilityIds: ['given-node', 'assumption-node', 'formula-node', 'conclusion-node', 'derivation-edge', 'mathlive-editor', 'step-submit', 'premise-validation', 'compute-help'],
  situation: '在显式前提链上构造一个可验证的凸性证明。',
  task: "设函数 $f$ 在区间 $I$ 上二阶可导，且 $f''(x)>0$。请通过显式推导证明 $f$ 在 $I$ 上严格凸。",
  role: { id: 's4-helper', name: '推导助手', attributes: [] },
  userRole: '证明者',
  openingNarrative: '',
  resources: ['拉格朗日中值定理', '严格凸性定义'],
  rules: ['节点必须通过连线显式引用前提', '结论节点必须由已验证支路推出'],
  metrics: [
    { id: 'structure', name: '结构完整度', type: 'continuous', initial: 58, target: 85, range: [0, 100], source: 'rule', description: '前提、中间步骤和结论是否形成可追溯链路。' },
    { id: 'rigor', name: '符号严谨度', type: 'continuous', initial: 72, target: 85, range: [0, 100], source: 'engine', description: '公式与定义域是否一致。' },
    { id: 'independence', name: '独立推导', type: 'continuous', initial: 100, target: 80, range: [0, 100], source: 'rule', description: '使用求助后逐步降低。' },
  ],
  completion: { mode: 'signal', successExpression: '结论节点通过前提链验证。', maxTurns: 30 },
  evaluationDimensions: ['推导严谨性', '前提完整性', '表达可读性'],
  engineConfig: { paradigm: 'single-role-dialogue', roleMemory: false, technologies: ['SymPy 计算引擎', '推导画布', '前提链判定'], engines: ['SymPyServer', 'DerivationCanvas', 'MetricEngine'] },
  events: [],
  eventInjection: false,
  injectProfile: true,
  compute: {
    type: 'formula',
    given: [
      { name: 'smooth', display: 'f\\in C^2(I)', note: 'f 在区间 I 上二阶可导', entries: [{ kind: 'domain', display: 'f\\in C^2(I)', symbolic: 'f in C2(I)', meta: { vars: ['f'] } }] },
      { name: 'positive', display: "f''(x)>0,\\;x\\in I", note: '二阶导数在定义域内恒正', entries: [{ kind: 'domain', display: "f''(x)>0", symbolic: 'diff(f(x),x,2)>0', meta: { vars: ['f', 'x'] } }] },
    ],
    symbols: [{ name: 'x', kind: 'variable', display: '自变量' }, { name: 'f', kind: 'function', params: ['x'], display: '目标函数' }],
    operation: 'prove strict convexity',
    expected_formula: 'f(lambda*x1+(1-lambda)*x2) < lambda*f(x1)+(1-lambda)*f(x2)',
    expected_steps: [
      { display: '取 x_1<x_2 并在区间上应用中值定理' },
      { display: "f'(x_2)-f'(x_1)=f''(xi)(x_2-x_1)", symbolic: 'diff(f(x2),x2)-diff(f(x1),x1)=diff(f(xi),xi,2)*(x2-x1)' },
      { display: '由导数严格递增推出凸性不等式' },
    ],
    expected_steps_count: 3,
    boundary_conditions: ['x1<x2', 'lambda->(0,1)'],
  },
  help: { base_help_count: 2, difficulty_factor: 1, user_factor: 1, max_help_count: 2, penalty_per_help: .1 },
  origin: 'new',
  createdAt: DEMO_TIME,
  updatedAt: DEMO_TIME,
};

const DEMO_CANVAS: DerivationCanvasState = {
  viewport: { x: 20, y: 15, zoom: .86 },
  helpUsed: 0,
  maxHelp: 2,
  independenceScore: 1,
  nodes: [
    { id: 'given-1', type: 'given', position: { x: 30, y: 70 }, data: { label: '已知·可导性', latex: 'f\\in C^2(I)', note: '在区间 I 上二阶可导', status: 'frozen', frozen: true } },
    { id: 'given-2', type: 'given', position: { x: 30, y: 270 }, data: { label: '已知·二阶导数', latex: "f''(x)>0", note: '\\forall x\\in I', status: 'frozen', frozen: true } },
    { id: 'step-1', type: 'formula', position: { x: 345, y: 70 }, data: { label: '取区间内两点', latex: 'x_1<x_2', note: '固定任意两点，为应用中值定理建立区间。', status: 'pass', frozen: false, verification: { formula_correct: true, dimension_check: true, feedback: '定义域条件与前提一致。', verdictSource: 'premise' } } },
    { id: 'step-2', type: 'formula', position: { x: 345, y: 280 }, data: { label: '应用中值定理', latex: "f'(x_2)-f'(x_1)=f''(\\xi)(x_2-x_1)", status: 'warn', frozen: false, verification: { formula_correct: true, dimension_check: true, feedback: '公式正确，请补充 \\xi 的取值范围。', suggestions: ['写明 \\xi\\in(x_1,x_2)'], verdictSource: 'premise' } } },
    { id: 'assumption-1', type: 'assumption', position: { x: 660, y: 65 }, data: { label: '引入参数', latex: '\\lambda\\in(0,1)', note: '用于构造区间内分点。', status: 'draft', frozen: false } },
    { id: 'conclusion-1', type: 'conclusion', position: { x: 660, y: 285 }, data: { label: '严格凸性结论', latex: 'f(\\lambda x_1+(1-\\lambda)x_2)<\\lambda f(x_1)+(1-\\lambda)f(x_2)', status: 'draft', frozen: false } },
  ],
  edges: [
    { id: 'edge-1', source: 'given-1', target: 'step-1', type: 'derivation' },
    { id: 'edge-2', source: 'given-2', target: 'step-2', type: 'derivation' },
    { id: 'edge-3', source: 'step-1', target: 'step-2', type: 'derivation' },
    { id: 'edge-4', source: 'step-2', target: 'conclusion-1', type: 'derivation' },
    { id: 'edge-5', source: 'assumption-1', target: 'conclusion-1', type: 'derivation' },
  ],
};

function createDemoRun(): SceneRunState {
  const run = createRunState(DEMO_SPEC);
  return {
    ...run,
    runId: 'demo-run-s4-convexity',
    startedAt: DEMO_TIME,
    canvas: structuredClone(DEMO_CANVAS),
    metrics: [
      { metricId: 'structure', value: 68, lastDelta: 10, lastReason: '已建立主干前提链。' },
      { metricId: 'rigor', value: 74, lastDelta: 2, lastReason: '发现一处取值范围需补充。' },
      { metricId: 'independence', value: 100, lastDelta: 0, lastReason: '尚未使用求助。' },
    ],
  };
}

export const SceneS4DemoPage: React.FC<{ onExit?: () => void; onSessionStatusChange?: (status: 'idle' | 'running' | 'finished') => void; completionContent?: React.ReactNode }> = ({ onExit, onSessionStatusChange, completionContent }) => {
  const [run, setRun] = useState<SceneRunState>(() => createDemoRun());
  useLayoutEffect(() => { onSessionStatusChange?.(run.status === 'running' ? 'running' : 'finished'); }, [run.status, onSessionStatusChange]);

  return (
    <div className="scene-s4-demo-page">
      <div className="scene-s4-demo-notice" role="status">
        <strong>交互预览</strong>
        <span>模拟数据 · 不调用 Provider · 不写入学习记录</span>
      </div>
      <SceneDerivationView
        spec={DEMO_SPEC}
        run={run}
        busy={false}
        onExit={onExit}
        completionContent={completionContent}
        onRunChange={setRun}
        onEnd={() => setRun((current) => ({
          ...current,
          status: 'success',
          endReason: '模拟推导已提交',
          endedAt: new Date().toISOString(),
          endedByUser: true,
          finalScore: 82,
        }))}
        onRerun={() => setRun(createDemoRun())}
        hasPrevRun
        previewMode
      />
    </div>
  );
};

export default SceneS4DemoPage;
