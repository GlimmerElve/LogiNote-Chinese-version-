import React from 'react';
import type { ScenePackViewContext, ScenePackNavigationTarget } from '../../types/sceneInteractionPack';
import { inspectS2PromptControls, setS2PromptPurpose, applyS2PromptSections, inspectS2PromptTemplate, compileS2PromptSections, decodeS2PromptParts, compileS2PromptParts, applyS2PromptParts, S2_PROMPT_PART_LIMIT, type S2PromptPart, type S2PromptSection, type S2PromptRecovery, type S2PromptRecoveryTarget } from './promptControls';

export function PromptTemplateControls(props: ScenePackViewContext) {
    const {definition, document, node}=props, finished=!props.active;
    if (node.pluginId !== 'text-template' || node.pluginVersion !== '1.0.0' || !['bind', 'render'].includes(node.capabilityId)) return null;
    const guard = props.guard;
    const act = (action: () => void) => { try { action(); } catch(error) { props.onError((error as Error).message); } };
    const commit = props.onDocumentChange, setNotice = props.onNotice;
    const draftMap = <T,>(key: string) => ({ get: (_id: string): T | undefined => props.state.get<T>(key), has: (_id: string) => props.state.get(key) !== undefined, initialize: (create: () => T) => props.state.initialize<T>(key, create), set: (_id: string, value: T) => props.state.set(key, value), delete: (_id: string) => props.state.delete(key) });
    const promptPurposeDrafts = {current: draftMap<string>('purpose')}, promptLayoutDrafts = {current: draftMap<{base:string;rows:S2PromptSection[]}>('layout')}, promptTemplateDrafts = {current: draftMap<{base:string;parts:S2PromptPart[];raw:string;mode:'parts'|'raw'}>('template')};
    const promptTargetKey = (target: S2PromptRecoveryTarget) => JSON.stringify(target);
    const toNavigation = (value: S2PromptRecoveryTarget): ScenePackNavigationTarget => value.kind === 'purpose' ? {kind:'settings',nodeId:value.nodeId,sectionId:'purpose'} : value.kind === 'content' ? value : {kind:'input',nodeId:value.nodeId,portId:value.portId,...(value.kind==='advanced'?{sectionId:'advanced'}:{})};
    const registerPromptPanel = (value: S2PromptRecoveryTarget, element: HTMLElement|null) => props.registerPanel(toNavigation(value), element);
    const fallback = (recovery: S2PromptRecovery, reason: string, base: string) => <section className="s2-control-editor s2-prompt-fallback" aria-label="按名称编辑的使用说明">
      <h4>暂不能按名称编辑</h4><p>{reason}</p><p>{recovery.guidance}</p>
      {recovery.targets.map((target, index) => {
        const field = target.kind === 'content' ? definition.blockTypes.find(type => type.id === document.nodes.find(item => item.id === target.nodeId)?.type)?.fields.find(item => item.id === target.fieldId) : undefined;
        const label = props.nodeLabel(target.nodeId) + ('portId' in target ? '「'+props.inputLabel(target.nodeId,target.portId)+'」' : field ? '「'+field.label+'」' : '');
        return <button key={promptTargetKey(target)} type="button" disabled={finished} onClick={() => act(() => {
          guard();
          const current = inspectS2PromptControls(definition!, props.readCurrent().document, node.id), template = node.capabilityId === 'render' ? inspectS2PromptTemplate(definition!, props.readCurrent().document, node.id) : null;
          const liveRecovery = current.kind === 'purpose' ? current.recovery : template?.kind === 'unavailable' ? template.recovery : current.kind === 'unavailable' ? current.recovery : undefined;
          if (current.base !== base || JSON.stringify(liveRecovery) !== JSON.stringify(recovery) || promptTargetKey(liveRecovery!.targets[index]) !== promptTargetKey(target)) throw new Error('排版或材料来源已变化，请重新查看；原引用与草稿保留。');
          props.navigate(toNavigation(target));
          setNotice('已打开原设置；没有改值、断线、读取资料或运行。修改后可返回原排版步骤重新查看，旧草稿不会自动应用。');
        })}>{`查看${target.kind === 'purpose' ? '内容用途' : target.kind === 'content' ? '原内容' : '来源设置'}：${label}`}</button>;
      })}
      <small>这里只定位已有设置。查看不会替换动态输入、重置草稿或执行插件；完整模板和高级入口继续保留。</small>
    </section>;
    // A referenced block owns its content editor. This node only edits its own literal parameters.
    const sourceBinding = node.capabilityId === 'render' && node.bindings.template;
    if (sourceBinding && sourceBinding.kind === 'field') {
      const source = document.nodes.find(item => item.id === sourceBinding.nodeId);
      const field = definition.blockTypes.find(type => type.id === source?.type)?.fields.find(item => item.id === sourceBinding.fieldId);
      const readOnly = source?.readOnly || definition.initial.nodes.some(item => item.id === sourceBinding.nodeId && item.readOnly);
      return <section className="s2-prompt-source" aria-label="提示词排版来源">
        <p>排版来自{props.nodeLabel(sourceBinding.nodeId)}{field ? `「${field.label}」` : ''}。</p>
        <button type="button" disabled={finished} onClick={() => act(() => {
          guard();
          const current = props.readCurrent().document.execution?.nodes.find(item => item.id === node.id)?.bindings.template;
          if (JSON.stringify(current) !== JSON.stringify(sourceBinding)) throw new Error('排版来源已变化，请重新查看。');
          props.navigate({ kind: 'content', nodeId: sourceBinding.nodeId, fieldId: sourceBinding.fieldId });
        })}>{readOnly ? '查看原内容' : '编辑原内容'}</button>
      </section>;
    }
    const state = inspectS2PromptControls(definition, document, node.id);
    if (state.kind === 'purpose') {
      if (!state.canSet) return state.recovery ? fallback(state.recovery, state.recovery.code === 'name-invalid' ? '现有内容名称不符合模板规则；原输入与引用保留。' : '这份内容的名称尚不能静态确定；下游按名称排版不会猜测或替换。', state.base) : null;
      const label = promptPurposeDrafts.current.get(node.id) ?? '';
      return <form ref={element => registerPromptPanel({ kind: 'purpose', nodeId: node.id }, element)} tabIndex={-1} className="s2-control-editor" aria-label="设置内容用途" onSubmit={event => { event.preventDefault(); act(() => {
        guard(); if ((promptPurposeDrafts.current.get(node.id) ?? '') !== label) throw new Error('用途草稿已变化，请重新确认。');
        commit(setS2PromptPurpose(definition!, props.readCurrent().document, node.id, label, state.base));
        promptPurposeDrafts.current.delete(node.id); setNotice('已设置内容用途；内部名称由系统维护，原文与连线保留，没有运行。');
      }); }}>
        <label>这份内容叫什么<input value={label} maxLength={80} placeholder="例如：角色设定、任务要求、参考案例" disabled={finished} onChange={event => act(() => {
          guard();
          promptPurposeDrafts.current.set(node.id, event.target.value);
        })} /></label><p>只填写便于理解的用途名称。系统维护内部字段；设置后再填写或选择这份内容，不改写正文，也不会运行。</p>
        <button type="submit" disabled={finished || !label.trim()}>设置内容用途（不运行）</button>
      </form>;
    }
    const template = inspectS2PromptTemplate(definition!, document, node.id);
    if (template.kind === 'template' && (state.kind !== 'layout' || promptTemplateDrafts.current.has(node.id))) {
      let entry = promptTemplateDrafts.current.get(node.id);
      if (!entry) {
        entry = promptTemplateDrafts.current.initialize(() => ({ base: template.base, parts: template.parts, raw: template.text, mode: 'parts' }));
      }
      const saved = entry, conflict = saved.base !== template.base;
      const check = () => {
        guard(); if (conflict || promptTemplateDrafts.current.get(node.id) !== saved) throw new Error('排版来源或草稿已变化，请载入当前排版。');
      };
      const edit = (parts: S2PromptPart[]) => act(() => {
        check(); if (parts.length > S2_PROMPT_PART_LIMIT) throw new Error('最多128个排版片段，未裁剪草稿。');
        promptTemplateDrafts.current.set(node.id, { ...saved, parts });
      });
      const insert = (index: number, part: S2PromptPart) => edit([...saved.parts.slice(0, index), part, ...saved.parts.slice(index)]);
      const move = (index: number, offset: number) => {
        if (index + offset < 0 || index + offset >= saved.parts.length) return;
        const next = [...saved.parts]; [next[index], next[index + offset]] = [next[index + offset], next[index]]; edit(next);
      };
      return <form className="s2-control-editor s2-prompt-template" aria-label="自由编辑提示词排版" onSubmit={event => { event.preventDefault(); act(() => {
        check(); const parts = saved.mode === 'raw' ? decodeS2PromptParts(saved.raw, template.available) : saved.parts;
        commit(applyS2PromptParts(definition!, props.readCurrent().document, node.id, parts, saved.base));
        const next = inspectS2PromptTemplate(definition!, props.readCurrent().document, node.id);
        if (next.kind !== 'template') throw new Error('已应用排版，但当前来源需要重新查看。');
        promptTemplateDrafts.current.set(node.id, { ...saved, base: next.base, parts, raw: saved.mode === 'raw' ? saved.raw : compileS2PromptParts(parts, template.available) });
        setNotice('已应用自由排版；原材料与引用保留，未运行装配或发送模型请求。');
      }); }}>
        <h4>自由编辑提示词排版</h4><p>文字原样保留；按名称插入材料，可穿插在句子中，也可重复引用。片段之间不会自动加空格或换行。</p>
        <p>只更新当前步骤的排版参数。</p>
        <fieldset disabled={finished || conflict}>
          {saved.mode === 'raw' ? <label>完整模板原文（高级）<textarea aria-label="完整模板原文（高级）" maxLength={6000} value={saved.raw} onChange={event => act(() => {
            check(); promptTemplateDrafts.current.set(node.id, { ...saved, raw: event.target.value });
          })} /></label> : <>
            {saved.parts.map((part, index) => <details key={index} className="s2-prompt-part"><summary>{`第${index + 1}片段 · ${part.kind === 'text' ? '文字' : '引用材料'}`}
              <small>{part.kind === 'text' ? `摘要：${part.text.replace(/\r\n|\r|\n/g, ' ↵ ').slice(0, 48)}${part.text.replace(/\r\n|\r|\n/g, ' ↵ ').length > 48 ? '…' : ''}`
                : template.available.find(item => item.key === part.material)?.label ?? '请选择材料'}</small>
            </summary><fieldset><legend>{`编辑第${index + 1}片段`}</legend>
              {part.kind === 'text' ? <label>{`第${index + 1}片段文字`}<textarea aria-label={`第${index + 1}片段文字`} maxLength={6000} value={part.text}
                onChange={event => edit(saved.parts.map((item, i) => i === index ? { kind: 'text', text: event.target.value } : item))} /></label>
                : <label>{`第${index + 1}片段引用的材料`}<select aria-label={`第${index + 1}片段引用的材料`} value={part.material}
                  onChange={event => edit(saved.parts.map((item, i) => i === index ? { kind: 'material', material: event.target.value } : item))}>
                  <option value="">请选择材料</option>{template.available.map((item, i) => <option key={item.key} value={item.key}>{item.label}（内容 {i + 1}）</option>)}
                </select></label>}
              <div className="s2-actions">
                <button type="button" disabled={index === 0} onClick={() => move(index, -1)}>{`上移第${index + 1}片段`}</button>
                <button type="button" disabled={index === saved.parts.length - 1} onClick={() => move(index, 1)}>{`下移第${index + 1}片段`}</button>
                <button type="button" onClick={() => edit(saved.parts.filter((_, i) => i !== index))}>{`移除第${index + 1}片段`}</button>
                <button type="button" disabled={saved.parts.length >= S2_PROMPT_PART_LIMIT} onClick={() => insert(index + 1, { kind: 'text', text: '' })}>{`在第${index + 1}片段后加文字`}</button>
                <button type="button" disabled={!template.available.length || saved.parts.length >= S2_PROMPT_PART_LIMIT} onClick={() => insert(index + 1, { kind: 'material', material: '' })}>{`在第${index + 1}片段后插入材料`}</button>
              </div>
            </fieldset></details>)}
            <button type="button" disabled={saved.parts.length >= S2_PROMPT_PART_LIMIT} onClick={() => insert(saved.parts.length, { kind: 'text', text: '' })}>添加文字片段</button>
            <button type="button" disabled={!template.available.length || saved.parts.length >= S2_PROMPT_PART_LIMIT} onClick={() => insert(saved.parts.length, { kind: 'material', material: '' })}>添加材料引用</button>
          </>}
          <button type="submit">应用自由排版（不运行）</button>
          <button type="button" onClick={() => act(() => {
            check(); const update = saved.mode === 'parts' ? { raw: compileS2PromptParts(saved.parts, template.available), mode: 'raw' as const }
              : { parts: decodeS2PromptParts(saved.raw, template.available), mode: 'parts' as const };
            promptTemplateDrafts.current.set(node.id, { ...saved, ...update });
            setNotice('已切换排版编辑方式；未应用、运行或发送请求。');
          })}>{saved.mode === 'parts' ? '查看或编辑完整模板（高级）' : '切回按名称编辑'}</button>
        </fieldset>
        {conflict && <p role="alert">画布或材料来源已变化，草稿已保留且未应用；请载入当前排版后重新编辑。</p>}
        <button type="button" disabled={finished} onClick={() => act(() => {
          guard(); if (promptTemplateDrafts.current.get(node.id) !== saved) throw new Error('草稿已变化，请使用当前入口。');
          promptTemplateDrafts.current.set(node.id, { base: template.base, parts: template.parts, raw: template.text, mode: 'parts' });
        })}>载入当前自由排版</button>
        <small>最多128个片段、完整模板6000字；原始占位符的空白保留。这里只排版；装配、完整输出检查及模型测试仍由原有插件和独立确认负责。</small>
      </form>;
    }
    if (state.kind === 'unavailable') return template.kind === 'unavailable' ? fallback(template.recovery, template.reason, template.base) : fallback(state.recovery, state.reason, state.base);
    let draft = promptLayoutDrafts.current.get(node.id);
    if (!draft) {
      draft = promptLayoutDrafts.current.initialize(() => ({ base: state.base, rows: state.rows }));
    }
    const currentDraft = draft, conflict = draft.base !== state.base;
    const edit = (rows: S2PromptSection[]) => act(() => {
      guard(); if (conflict || promptLayoutDrafts.current.get(node.id) !== currentDraft) throw new Error('排版来源或草稿已变化，请载入当前排版。');
      promptLayoutDrafts.current.set(node.id, { ...currentDraft, rows });
    });
    return <form className="s2-control-editor" aria-label="按内容名称安排提示词" onSubmit={event => { event.preventDefault(); act(() => {
      guard(); if (conflict || promptLayoutDrafts.current.get(node.id) !== currentDraft) throw new Error('排版来源或草稿已变化，请载入当前排版。');
      const next = applyS2PromptSections(definition!, props.readCurrent().document, node.id, currentDraft.rows, currentDraft.base); commit(next);
      promptLayoutDrafts.current.set(node.id, { base: inspectS2PromptControls(definition!, props.readCurrent().document, node.id).base, rows: currentDraft.rows });
      setNotice('已应用提示词段落排版；仅修改排版参数，正文和材料连接保留，没有运行。');
    }); }}>
      <h4>按内容名称安排提示词</h4><p>添加段落、选择要使用的内容，再调整标题和顺序。占位符由系统生成；这里只编辑草稿，应用后也不会运行。</p>
      <fieldset disabled={finished || conflict}>{draft.rows.map((row, index) => <div key={index}>
        <label>{`第${index + 1}段使用的内容`}<select value={row.material} onChange={event => edit(currentDraft.rows.map((item, i) => i === index ? { ...item, material: event.target.value } : item))}>
          {state.available.map((item, i) => <option key={item.key} value={item.key}>{item.label}（内容 {i + 1}）</option>)}
        </select></label>
        <label>{`第${index + 1}段标题（可选）`}<input value={row.heading} maxLength={120} onChange={event => edit(currentDraft.rows.map((item, i) => i === index ? { ...item, heading: event.target.value } : item))} /></label>
        <button type="button" disabled={index === 0} onClick={() => { const rows = [...currentDraft.rows]; [rows[index - 1], rows[index]] = [rows[index], rows[index - 1]]; edit(rows); }}>{`上移第${index + 1}段`}</button>
        <button type="button" disabled={index === draft.rows.length - 1} onClick={() => { const rows = [...currentDraft.rows]; [rows[index], rows[index + 1]] = [rows[index + 1], rows[index]]; edit(rows); }}>{`下移第${index + 1}段`}</button>
        <button type="button" onClick={() => edit(currentDraft.rows.filter((_, i) => i !== index))}>{`移除第${index + 1}段`}</button>
      </div>)}
      <button type="button" disabled={!state.available.length || draft.rows.length >= 32} onClick={() => edit([...currentDraft.rows, { material: state.available[0].key, heading: '' }])}>添加提示词段落</button>
      <button type="submit" disabled={!draft.rows.length}>应用这份排版（不运行）</button></fieldset>
      {conflict && <p role="alert">画布或材料来源已变化，草稿已保留且未应用；请载入当前排版后重新编辑。</p>}
      <button type="button" disabled={finished} onClick={() => act(() => { guard(); promptLayoutDrafts.current.set(node.id, { base: state.base, rows: state.rows }); })}>载入当前排版</button>
      <button type="button" disabled={finished || conflict} onClick={() => act(() => {
        guard(); if (conflict || promptLayoutDrafts.current.get(node.id) !== currentDraft) throw new Error('排版草稿已变化，请重新确认。');
        const text = compileS2PromptSections(currentDraft.rows, state.available).text, parts = decodeS2PromptParts(text, state.available);
        promptTemplateDrafts.current.set(node.id, { base: state.base, parts, raw: text, mode: 'parts' }); promptLayoutDrafts.current.delete(node.id);
        setNotice('已进入自由排版，当前段落草稿完整保留；未应用或运行。');
      })}>自由编辑这份排版</button>
      <p>段落只引用选定汇集链路中的内容，不读取运行结果、不替你填写材料；需要正文穿插材料时可进入自由排版。</p>
    </form>;
  }

export function promptTemplateHiddenInputs(props: ScenePackViewContext) {
 if (props.node.capabilityId==='render'&&props.node.bindings.template?.kind==='field') return ['template'];
 const state=inspectS2PromptControls(props.definition,props.document,props.node.id);
 const template=props.node.capabilityId==='render'?inspectS2PromptTemplate(props.definition,props.document,props.node.id):undefined;
 return props.node.capabilityId==='bind' && (props.node.bindings.key?.kind==='literal'||state.kind==='purpose'&&state.canSet) ? ['key'] : props.node.capabilityId==='render'&&(state.kind==='layout'||template?.kind==='template') ? ['template'] : [];
}
