import React, { useRef, useState } from 'react';
import type { S2WorkflowCondition } from '../../types/sceneS2';
import { s2ConditionDraft, type S2ConditionDrafts, type S2ConditionState, type S2SubmitVia } from '../../services/scene/sceneS2ControlDrafts';
import { s2HumanConfirmationOutcome } from '../../services/scene/sceneS2Presentation';

export interface S2ConditionFields {
  options: Array<{ pointer: string; label: string; type: string }>;
  /** Host-owned closure rechecks the source identity and current scene before using the menu. */
  check: (pointer?: string) => void;
}
function expectedKind(raw: string): 'string' | 'number' | 'boolean' | 'null' | 'json' {
  try { const value = JSON.parse(raw); return value === null ? 'null' : ['string', 'number', 'boolean'].includes(typeof value) ? typeof value as 'string' | 'number' | 'boolean' : 'json'; }
  catch { return 'json'; }
}
export function S2ConditionEditor({ nodeId = 'local', when, sources, sourceKey, drafts: providedDrafts, disabled, onApply, onStateChange, onInspectSource }: {
  nodeId?: string; sourceKey?: string; drafts?: S2ConditionDrafts;
  when?: S2WorkflowCondition; sources: Array<{ nodeId: string; portId: string; typeId: string; label?: string; confirmation?: boolean }>; disabled: boolean;
  onInspectSource?: (nodeId: string, portId: string) => S2ConditionFields;
  onApply: (when: S2WorkflowCondition | null, base: string, via?: S2SubmitVia) => string | void;
  onStateChange?: (state: S2ConditionState, base: string, via?: S2SubmitVia) => void;
}) {
  const localDrafts = useRef<S2ConditionDrafts>(new Map()), applying = useRef('');
  const inspected = useRef<{ source: string; fields: S2ConditionFields } | null>(null);
  const drafts = providedDrafts ?? localDrafts.current, currentSource = sourceKey ?? JSON.stringify([when ?? null, sources]);
  const [, refresh] = useState(0), [error, setError] = useState(''), [notice, setNotice] = useState('');
  let saved = drafts.get(nodeId);
  if (!saved) { if (drafts.size >= 80) drafts.delete(drafts.keys().next().value!); saved = s2ConditionDraft(when, currentSource); drafts.set(nodeId, saved); }
  const conflict = saved.base !== currentSource, errorId = `s2-condition-${nodeId}-error`;
  const displayError = conflict ? '条件或可选来源已变化，草稿已保留；请载入当前条件后重新编辑。' : error || (saved.state === 'invalid' ? '草稿上次校验未通过，请修改后重试。' : '');
  const report = (state: S2ConditionState, base = saved!.base, via?: S2SubmitVia) => { try { onStateChange?.(state, base, via); } catch { /* Observation never blocks local editing. */ } };
  const edit = (change: Partial<typeof saved>) => {
    if (disabled || conflict || drafts.get(nodeId) !== saved) return;
    drafts.set(nodeId, { ...saved!, ...change, state: 'editing' }); applying.current = ''; report('editing'); setError(''); setNotice('尚未应用'); refresh(v => v + 1);
  };
  const kind = saved.expectedKind ?? expectedKind(saved.expected);
  const fields = inspected.current?.source === saved.source ? inspected.current.fields : null;
  let fieldsError = '';
  if (fields) try { fields.check(); } catch (error) { fieldsError = (error as Error).message; }
  const sourceLabel = (id: string, port: string) => sources.find(item => item.nodeId === id && item.portId === port)?.label ?? '所选步骤的输出';
  const selectedSource = sources.find(item => JSON.stringify([item.nodeId, item.portId]) === saved!.source);
  const confirmationField = selectedSource?.confirmation === true && saved.pointer === '/approved';
  let expected: unknown;
  try { expected = JSON.parse(saved.expected); } catch { /* Incomplete drafts keep the original advanced editor. */ }
  const outcome = confirmationField && kind === 'boolean' && typeof expected === 'boolean'
    ? s2HumanConfirmationOutcome({ pointer: saved.pointer, equals: expected, match: saved.match }) : undefined;
  const savedConfirmation = when && sources.find(item => item.nodeId === when.nodeId && item.portId === when.portId)?.confirmation === true;
  const savedOutcome = savedConfirmation ? s2HumanConfirmationOutcome(when!) : undefined;
  function apply(remove: boolean, via: S2SubmitVia) {
    if (disabled || drafts.get(nodeId) !== saved) return;
    if (conflict) { report('conflict', saved!.base, via); return; }
    const attempt = JSON.stringify([saved!.base, remove, saved!.source, saved!.pointer, saved!.expected, saved!.match]);
    if (applying.current === attempt) return;
    applying.current = attempt;
    try {
      let value: S2WorkflowCondition | null = null;
      if (!remove) {
        if (saved!.pointer.length > 500 || saved!.expected.length > 6000) throw new Error('条件草稿超过长度限制');
        const source = sources.find(item => JSON.stringify([item.nodeId, item.portId]) === saved!.source);
        if (!source) throw new Error('请选择当前可用的条件来源');
        fields?.check(saved!.pointer);
        const equals = JSON.parse(saved!.expected);
        if (kind !== 'json' && expectedKind(saved!.expected) !== kind) throw new Error('请填写所选类型的完整比较值');
        value = { nodeId: source.nodeId, portId: source.portId, pointer: saved!.pointer, equals, match: saved!.match };
      }
      const applied = onApply(value, saved!.base, via);
      const base = typeof applied === 'string' ? applied : sourceKey ?? JSON.stringify([value, sources]);
      const state = remove ? 'cleared' : 'submitted';
      // This successful design edit invalidates the source artifact. Retire the menu rather than
      // presenting our own successful application as a stale-operation error on the next render.
      inspected.current = null;
      drafts.set(nodeId, { ...saved!, base, state }); report(state, base, via); setError(''); setNotice(remove ? '已明确解除条件；未执行' : '已应用条件；未执行'); refresh(v => v + 1);
    } catch (error) { applying.current = ''; drafts.set(nodeId, { ...saved!, state: 'invalid' }); report('invalid', saved!.base, via); setError(`条件未应用：${error instanceof Error ? error.message : '无效条件'}`); refresh(v => v + 1); }
  }
  const comparisonControls = <>
    <label>期望内容类型<select aria-label="期望内容类型" value={kind} onChange={event => {
      const next = event.target.value as typeof kind;
      if (!['string', 'number', 'boolean', 'null', 'json'].includes(next)) return;
      edit({ expectedKind: next, expected: next === 'json' || expectedKind(saved!.expected) === next ? saved!.expected : next === 'null' ? 'null' : next === 'string' ? '""' : '' });
    }}><option value="string">文字</option><option value="number">数字</option><option value="boolean">是 / 否</option><option value="null">空值</option><option value="json">复杂内容（高级）</option></select></label>
    {kind === 'string' && <label>期望文字<textarea aria-label="期望文字" value={JSON.parse(saved.expected)} maxLength={6000} onChange={event => edit({ expected: JSON.stringify(event.target.value) })} /></label>}
    {kind === 'number' && <label>期望数字<input aria-label="期望数字" inputMode="decimal" value={saved.expected} maxLength={500} onChange={event => edit({ expected: event.target.value })} /></label>}
    {kind === 'boolean' && <label>期望选择<select aria-label="期望选择" value={saved.expected} onChange={event => { if (['true', 'false'].includes(event.target.value)) edit({ expected: event.target.value }); }}><option value="">请选择</option><option value="true">{confirmationField ? '同意' : '是'}</option><option value="false">{confirmationField ? '不同意' : '否'}</option></select></label>}
    {kind === 'null' && <p>期望一个明确的空值；它不同于没有这个字段，也不同于空文字。</p>}
    <details open={kind === 'json' ? true : undefined}><summary>高级路径与完整比较值</summary>
      <label>条件 JSON Pointer<input aria-label="条件 JSON Pointer" value={saved.pointer} maxLength={500} onChange={event => { inspected.current = null; edit({ pointer: event.target.value }); }} placeholder="例如 /status；空表示整体" /></label>
      <label>条件比较值（JSON）<textarea aria-label="条件比较值（JSON）" aria-invalid={!!displayError} aria-describedby={displayError ? errorId : undefined} value={saved.expected} maxLength={6000} onChange={event => edit({ expected: event.target.value, expectedKind: 'json' })} /></label>
    </details>
    <label>分支命中方式<select aria-label="分支命中方式" value={String(saved.match)} onChange={event => { if (['true', 'false'].includes(event.target.value)) edit({ match: event.target.value === 'true' }); }}><option value="true">相等时执行</option><option value="false">不相等时执行</option></select></label>
  </>;
  return <form aria-label="编辑执行条件" noValidate onSubmit={event => { event.preventDefault(); apply(false, 'form'); }} onKeyDown={event => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey
      && !event.nativeEvent?.isComposing && event.keyCode !== 229) { event.preventDefault(); event.stopPropagation(); apply(false, 'shortcut'); }
  }}><fieldset disabled={disabled || conflict}><legend>条件分支（可选）</legend>
    <p>{selectedSource?.confirmation === true ? '选择本人确认的结果，查看“是否同意”，再设置这一步在同意还是不同意时运行。这里只设置规则，不会替本人作出选择；其他比较方式仍在高级设置中保留。'
      : '选择要比较的结果和期望值，再决定相等或不相等时执行。文字“80”和数字80不同；这里只做严格相等比较，不判断业务是否正确。缺少字段会阻塞，模拟数据仅代表模拟假设。'}</p>
    <p>{selectedSource?.confirmation === true ? '这项设置决定本步骤和依赖它的后续步骤是否运行；前面的准备步骤仍可先运行。'
      : '条件约束本节点及依赖它的数据下游；未设条件的上游仍按依赖执行。控制整条分支时，请在该分支入口设置条件。'}</p>
    <label>比较哪一步的结果<select aria-label="条件来源输出" value={saved.source} onChange={event => { inspected.current = null; edit({ source: event.target.value, pointer: '' }); }}><option value="">请选择</option>
      {sources.map((item, index) => <option key={JSON.stringify([item.nodeId, item.portId])} value={JSON.stringify([item.nodeId, item.portId])}>{item.label ?? `可用结果 ${index + 1}`}</option>)}</select></label>
    {selectedSource?.confirmation === true && <p>这是本人对本次内容的确认，不是工具授权或质量评价。可查看实际结果中的“是否同意”，再选择同意或不同意时运行；查看不会代答或运行来源。</p>}
    {onInspectSource && <button type="button" disabled={!saved.source} onClick={() => {
      if (disabled || conflict || drafts.get(nodeId) !== saved) return;
      try {
        const source = sources.find(item => JSON.stringify([item.nodeId, item.portId]) === saved!.source);
        if (!source) throw new Error('请先选择结果来源');
        inspected.current = { source: saved!.source, fields: onInspectSource(source.nodeId, source.portId) };
        setError(''); setNotice('已查看当前结果的字段；没有设置条件或运行步骤'); refresh(v => v + 1);
      } catch (error) { setError((error as Error).message); }
    }}>查看可比较的字段（不运行）</button>}
    {fieldsError && <p role="status">{fieldsError} 请重新查看字段，或使用高级路径编辑。</p>}
    {fields && !fieldsError ? <label>比较哪部分内容<select aria-label="比较哪部分内容" value={fields.options.some(item => item.pointer === saved!.pointer) ? JSON.stringify(saved.pointer) : ''} onChange={event => {
      const option = fields.options.find(item => JSON.stringify(item.pointer) === event.target.value);
      if (option) { try { fields.check(option.pointer); edit({ pointer: option.pointer }); } catch (error) { setError((error as Error).message); } }
    }}><option value="">请选择要比较的内容</option>{fields.options.map(item => <option key={item.pointer} value={JSON.stringify(item.pointer)}>{item.label}（{selectedSource?.confirmation === true && item.pointer === '/approved' && item.type === '布尔值' ? '同意／不同意' : item.type}）</option>)}</select></label>
      : <p>{confirmationField ? '比较范围：是否同意（本人本次确认）。这里只描述配置，不表示已经作出选择。'
        : saved.pointer === '' ? '比较范围：整体结果。若要选择其中字段，可先单独运行来源步骤，再查看字段。' : '比较范围：已保存的指定位置，可查看字段核对，或在高级编辑中调整。'}</p>}
    {outcome && <label>这一步何时运行<select aria-label="确认后的执行时机" value={outcome === '同意' ? 'approved' : 'declined'} onChange={event => {
      if (typeof expected !== 'boolean' || !['approved', 'declined'].includes(event.target.value)) return;
      // Preserve the saved comparison value (including equals:false); only change its strict predicate.
      edit({ match: expected === (event.target.value === 'approved') });
    }}><option value="approved">同意时运行</option><option value="declined">不同意时运行</option></select></label>}
    {outcome ? <details><summary>高级比较方式与原始字段</summary>{comparisonControls}</details> : comparisonControls}
    <button type="submit" disabled={!saved.source}>应用执行条件</button>
    <button type="button" disabled={!when} onClick={() => apply(true, 'form')}>明确解除执行条件</button>
    {when && <p>已保存条件：{sourceLabel(when.nodeId, when.portId)} · {savedOutcome ? `本人${savedOutcome}时运行；不表示已经确认，也不新增授权`
      : `${savedConfirmation && when.pointer === '/approved' ? '是否同意' : fields?.options.find(item => item.pointer === when.pointer)?.label ?? (when.pointer ? '指定位置（见高级编辑）' : '整体结果')} · ${when.match ? '相等' : '不相等'}时执行`}</p>}
    </fieldset><button type="button" disabled={disabled} onClick={() => {
      if (disabled) return;
      inspected.current = null; drafts.set(nodeId, { ...s2ConditionDraft(when, currentSource), state: 'reloaded' }); applying.current = ''; report('reloaded', currentSource); setError(''); setNotice('已载入当前条件'); refresh(v => v + 1);
    }}>载入当前执行条件</button><p>草稿仅在本局保留；Ctrl/⌘+Enter 可应用，普通 Enter 在文本框中换行。应用或解除条件不会自动执行。</p>
    {displayError && <p id={errorId} role="alert">{displayError}</p>}<span role="status">{notice}</span>
  </form>;
}
