import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AgentConversationWorkspace } from '../../src/components/AgentConversationWorkspace';
import '../../src/index.css';
import type { AgentRuntimeContext } from '../../src/services/agent/types';
import type { NoteItem } from '../../src/types';

const notes = [{ id: 'preview-A', title: '概率论教材', noteType: 'project', content: '' },
  { id: 'preview-B', title: '我的认知讨论', noteType: 'knowledge', content: '' }] as NoteItem[];
function Preview() {
  const [open, setOpen] = useState(true), [focus, setFocus] = useState(0);
  const ctx = { getNotes: () => notes, getActiveNote: () => notes[focus],
    getWorkspaceSnapshot: () => ({ revision: focus, view: 'editor', focusedNoteId: notes[focus].id, focusedNoteTitle: notes[focus].title, focusedNoteType: notes[focus].noteType }),
    getPlanDraftSession: () => null, getResourceDraftSession: () => null, hasPendingPlanEditorDraft: () => false,
    ensureDataFresh: async () => {}, navigate: () => {}, openNoteByTitle: () => false,
  } as unknown as AgentRuntimeContext;
  return <><main style={{ padding: 24 }}><h1>并行对话测试</h1><button onClick={() => setOpen(true)}>打开助手</button>
    <button onClick={() => setFocus(value => 1 - value)}>切换页面焦点</button><p>页面：{notes[focus].title}</p></main>
    <AgentConversationWorkspace open={open} role={{ id: 'default', name: '学习助手', systemPrompt: '', memoryWorkflow: 'agent-chat', allowedTools: [] }}
      ctx={ctx} workflowDraftReady selectedProjectTitle={notes[focus].title} planDraftSession={null} resourceDraftSession={null}
      onDiscardPlanDraft={() => {}} onDiscardResourceDraft={() => {}} onOpenResource={() => {}} onDownloadResource={async () => false}
      onScanResourcePage={async () => 0} onAuthorizeResource={async () => false} onSetResourceCandidateDecision={async () => {}}
      workflowHandoff={null} onWorkflowHandoffChange={() => {}} onClose={() => setOpen(false)} onBusyChange={() => {}} />
  </>;
}
createRoot(document.getElementById('root')!).render(<Preview />);
