import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../../src/styles/design-tokens.css';
import { SceneS2PackBoundary } from '../../src/components/scene/SceneS2PackBoundary';
import { createS2Scene } from '../../src/services/scene/sceneS2Canvas';
import { saveScene } from '../../src/services/scene/sceneSkillStore';
import type { SceneInitialRequest, SceneSpec } from '../../src/types';
import type { S2CanvasDefinition } from '../../src/types/sceneS2';
import { experimentDefinition, experimentRequest } from './s2-experiment';
import { arithmeticConfig } from './s2-arithmetic-pack';
import { browserFixtureState, setBrowserFixtureScenario, subscribeBrowserFixture } from './s2-browser-model';
import { listSceneInteractionPacks } from '../../src/services/scene/sceneInteractionPackLoader';

type Kind = 'prompt' | 'legacy' | 'base' | 'arithmetic';
interface Session { kind: Kind; sequence: number; request: SceneInitialRequest; draft: SceneSpec | null }
interface PackClient {
  ready: boolean;
  kind: Kind;
  latestDraft: SceneSpec | null;
  latestConfig: S2CanvasDefinition | null;
  sessionStatus: 'idle' | 'running' | 'finished';
  readonly syntheticModelRequests: typeof browserFixtureState.syntheticModelRequests;
  open(kind: Kind): void;
  openSaved(sceneId: string): void;
  refreshPackages(): Promise<void>;
  saveCurrent(): Promise<SceneSpec>;
}
declare global { interface Window { __packClient: PackClient } }
const choices: Array<{ kind: Kind; label: string }> = [
  { kind: 'prompt', label: '打开打包提示词实验' }, { kind: 'legacy', label: '打开旧提示词实验' },
  { kind: 'base', label: '打开基础 S2 画布' }, { kind: 'arithmetic', label: '打开独立计算包' },
];
function assertKind(value: string): asserts value is Kind {
  if (!choices.some(item => item.kind === value)) throw new Error('未知客户端验收示例');
}
function makeSession(kind: Kind, sequence: number): Session {
  const request: SceneInitialRequest = { ...structuredClone(experimentRequest), source: 'custom',
    subject: choices.find(item => item.kind === kind)!.label.replace('打开', ''),
    ...(kind === 'prompt' ? { interactionPack: { id: 'prompt-lab', version: '0.1.0' } }
      : kind === 'arithmetic' ? { interactionPack: { id: 'arithmetic-lab', version: '1.0.0' } }
      : kind === 'base' ? { interactionPack: null } : {}) };
  const draft = createS2Scene(request);
  if (kind === 'prompt' || kind === 'legacy') draft.canvasWorkspace = structuredClone(experimentDefinition);
  if (kind === 'arithmetic') draft.canvasWorkspace = structuredClone(arithmeticConfig.definition);
  // A legacy scene deliberately has no interactionPack property at all.
  if (kind === 'legacy') delete draft.interactionPack;
  return { kind, sequence, request, draft };
}
let changeSession: React.Dispatch<React.SetStateAction<Session>>;
let sequence = 0;
const initialKind = new URLSearchParams(location.search).get('kind') || 'prompt';
assertKind(initialKind);
const initial = makeSession(initialKind, ++sequence);
setBrowserFixtureScenario('experiment');
const client: PackClient = {
  ready: false, kind: initialKind, latestDraft: null, latestConfig: null, sessionStatus: 'idle',
  get syntheticModelRequests() { return structuredClone(browserFixtureState.syntheticModelRequests); },
  async refreshPackages() { await listSceneInteractionPacks({ refresh: true }); },
  open(kind) { assertKind(kind); client.ready = false; client.kind = kind; client.latestDraft = null;
    client.latestConfig = null; client.sessionStatus = 'idle'; changeSession(makeSession(kind, ++sequence)); },
  openSaved(sceneId) {
    if (!/^scene-[a-zA-Z0-9-]+$/.test(sceneId)) throw new Error('无效验收场景ID');
    client.ready = false; client.latestDraft = null; client.latestConfig = null; client.sessionStatus = 'idle';
    changeSession({ kind: client.kind, sequence: ++sequence,
      request: { source: 'existing', sceneId, sceneSkill: 'S2', subject: '已保存的验收场景', knowledgePoints: [] }, draft: null });
  },
  async saveCurrent() {
    if (!client.latestDraft) throw new Error('场景尚未就绪');
    return saveScene(structuredClone(client.latestDraft));
  },
};
window.__packClient = client;
function PackClientPage() {
  const [session, setSession] = useState(initial);
  const [modelRequests, setModelRequests] = useState(0);
  const [status, setStatus] = useState('idle');
  changeSession = setSession;
  useEffect(() => subscribeBrowserFixture(() => setModelRequests(browserFixtureState.syntheticModelRequests.length)), []);
  useEffect(() => { client.ready = true; }, []);
  return <div className="pack-client">
    <header><h1>S2 交互包客户端验收</h1>
      <nav aria-label="客户端验收示例">{choices.map(choice => <button key={choice.kind} type="button"
        aria-pressed={session.kind === choice.kind} onClick={() => client.open(choice.kind)}>{choice.label}</button>)}</nav>
      <p role="status">当前示例：{session.kind}；会话：{status}；合成模型请求：{modelRequests}。包和场景由隔离测试目录的真实 Electron IPC 读写；模型只用合成回应。</p>
    </header>
    <main><SceneS2PackBoundary key={session.sequence} initialRequest={session.request} initialDraft={session.draft}
      onDraftChange={draft => { client.latestDraft = draft ? structuredClone(draft) : null;
        client.latestConfig = draft?.canvasWorkspace ? structuredClone(draft.canvasWorkspace) : null; client.ready = true; }}
      onSessionStatusChange={next => { client.sessionStatus = next; setStatus(next); }}
      onExit={() => client.open(session.kind)} /></main>
  </div>;
}
createRoot(document.getElementById('root')!).render(<PackClientPage />);
