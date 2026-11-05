import React from 'react';
import './AgentPromptReplacement.css';

/** Keep the current input visible until the user explicitly approves replacement. */
export const AgentPromptReplacement: React.FC<{ prompt: string; busy: boolean; onKeep: () => void; onReplace: () => void }> = ({ prompt, busy, onKeep, onReplace }) => (
  <section className="agent-prompt-replacement" aria-label="确认替换未发送指令">
    <p role="status">输入框已有未发送内容，是否替换为这条指令？</p>
    <details><summary>查看待填入指令</summary><p>{prompt}</p></details>
    <div><button type="button" onClick={onKeep}>保留原输入</button><button type="button" onClick={onReplace} disabled={busy}>替换输入</button></div>
  </section>
);
