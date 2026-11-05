import React from 'react';
import { emptyS2SimpleScalar, S2_SIMPLE_VALUE_MAX_FIELDS, S2_SIMPLE_VALUE_MAX_RECORDS, S2_SIMPLE_VALUE_MAX_ITEMS, S2_SIMPLE_VALUE_MAX_GROUP_DEPTH, type S2SimpleValueRow, type S2SimpleScalarDraft, type S2SimpleValueDraft, type S2SimpleListDraft, type S2SimpleListItem, type S2SimpleControlPath, type S2SimpleValueIssue } from '../../services/scene/sceneS2SimpleValueForm';

/** Exact control metadata, scoped to this live form. Never build a selector from user names or error text. */
export function focusS2SimpleValueIssue(form: HTMLFormElement, control: string): boolean {
  if (!form.isConnected) return false;
  const matches = Array.from(form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement>('[data-s2-simple-control]'))
    .filter(element => element.getAttribute('data-s2-simple-control') === control && element.closest('form') === form);
  if (matches.length !== 1 || !matches[0].matches('input,select,textarea,button[type="button"]') || matches[0].matches(':disabled')) return false;
  const target = matches[0], parents: HTMLDetailsElement[] = [];
  for (let parent = target.parentElement; parent && parent !== form; parent = parent.parentElement) {
    if (parent.tagName === 'DETAILS') parents.push(parent as HTMLDetailsElement);
  }
  parents.reverse().forEach(details => { details.open = true; });
  target.scrollIntoView({ block: 'center', behavior: 'auto' }); target.focus({ preventScroll: true });
  return form.ownerDocument.activeElement === target;
}

/** Native labelled controls edit a private draft; only the parent can apply it. */
export function S2SimpleValueInput({ draft, label, disabled, onChange, issue }: {
  draft: S2SimpleValueDraft; label: string; disabled: boolean; onChange: (draft: S2SimpleValueDraft) => void;
  issue?: S2SimpleValueIssue & { errorId: string };
}) {
  const controlProps = (path: S2SimpleControlPath) => {
    const control = JSON.stringify(path), invalid = !disabled && issue?.control === control;
    return { 'data-s2-simple-control': control, 'aria-invalid': invalid || undefined, 'aria-describedby': invalid ? `${issue!.errorId}-field` : undefined };
  };
  const feedback = (path: S2SimpleControlPath) => !disabled && issue?.control === JSON.stringify(path)
    ? <small className="s2-simple-value-issue" id={`${issue.errorId}-field`}>{issue.message}</small> : null;
  const choose = (value: S2SimpleScalarDraft | S2SimpleValueDraft | S2SimpleValueRow | S2SimpleListItem, path: string, change: (value: any) => void, object = false, display = path, group = false, list = false, controlPath: S2SimpleControlPath = [], objectLabel = '信息分组（展开填写）') => <>
    <label>{display}的内容类型<select {...controlProps([...controlPath, 'kind'])} aria-label={`${path}的内容类型`} disabled={disabled} value={value.kind}
      onChange={event => { if (!disabled) change({ ...value, kind: event.target.value,
        ...(event.target.value === 'object' && !('rows' in value) ? { rows: [] } : {}),
        ...(event.target.value === 'records' && !('records' in value) ? { records: [], nextRecordId: 1 } : {}),
        ...(event.target.value === 'list' && !('items' in value) ? { items: [], nextItemId: 1 } : {}) }); }}>
      <option value="missing">尚未填写</option><option value="string">文字</option><option value="number">数字</option>
      <option value="boolean">是／否</option><option value="null">空值（明确没有值）</option>{(object || group) && <option value="object">{object ? '多项内容（可分组）' : objectLabel}</option>}{object && <option value="records">多条记录（逐条填写）</option>}{(object || list) && <option value="list">普通列表（逐项填写）</option>}
    </select></label>{feedback([...controlPath, 'kind'])}
    {value.kind === 'string' && <label>{display}的文字<textarea {...controlProps([...controlPath, 'text'])} aria-label={`${path}的文字`} disabled={disabled} value={value.text} maxLength={24000}
      onChange={event => { if (!disabled) change({ ...value, text: event.target.value }); }} /><small>文字原样保留；空白文字也是明确填写的内容。</small></label>}
    {value.kind === 'number' && <label>{display}的数字<input {...controlProps([...controlPath, 'number'])} aria-label={`${path}的数字`} type="text" inputMode="decimal" disabled={disabled} value={value.number} maxLength={24000}
      onChange={event => { if (!disabled) change({ ...value, number: event.target.value }); }} />{feedback([...controlPath, 'number'])}</label>}
    {value.kind === 'boolean' && <label>{display}的选择<select {...controlProps([...controlPath, 'boolean'])} aria-label={`${path}的选择`} disabled={disabled} value={value.boolean}
      onChange={event => { if (!disabled) change({ ...value, boolean: event.target.value }); }}><option value="">请选择</option><option value="true">是</option><option value="false">否</option></select>{feedback([...controlPath, 'boolean'])}</label>}
    {value.kind === 'null' && <p>已选择空值：应用后明确记录此处没有值。</p>}
  </>;
  const listEditor = (value: S2SimpleListDraft, path: string, change: (value: S2SimpleListDraft) => void, controlPath: S2SimpleControlPath = []): React.ReactNode => {
    const items = value.items ?? [];
    const move = (index: number, offset: number) => {
      if (disabled || index + offset < 0 || index + offset >= items.length) return;
      const next = [...items]; [next[index], next[index + offset]] = [next[index + offset], next[index]]; change({ ...value, items: next });
    };
    return <div className="s2-records-input">
      <p>共 {items.length} 项。每项可选文字、数字、是／否、空值或多项内容；多项内容按字段名称填写，其他项不用填写名称。先应用材料，再单独运行。</p>
      {!items.length && <p>当前是空列表。可直接应用空列表，或添加一项后填写。</p>}
      {items.map((item, index) => <fieldset key={item.id} disabled={disabled}><legend>列表第 {index + 1} 项</legend>
        {choose(item, `${path}第${index + 1}项`, next => change({ ...value, items: items.map(entry => entry.id === item.id ? next : entry) }), false, `第${index + 1}项`, true, false, [...controlPath, 'items', index], '多项内容（按名称填写）')}
        {item.kind === 'object' && <details className="s2-value-group"><summary>第 {index + 1} 项 · {item.rows?.length ?? 0} 项内容</summary>
          {fields(item.rows ?? [], `${path}第${index + 1}项`, rows => change({ ...value, items: items.map(entry => entry.id === item.id ? { ...entry, rows } : entry) }),
            S2_SIMPLE_VALUE_MAX_GROUP_DEPTH, [...controlPath, 'items', index, 'rows'], true)}
          <small>只修改这一项的具名内容；名称在本项内独立，空对象不补字段。移动或删除会处理这一整项。</small>
        </details>}
        <div className="s2-actions">
          <button type="button" disabled={disabled || index === 0} aria-label={`上移${path}第${index + 1}项`} onClick={() => move(index, -1)}>上移</button>
          <button type="button" disabled={disabled || index === items.length - 1} aria-label={`下移${path}第${index + 1}项`} onClick={() => move(index, 1)}>下移</button>
          <button type="button" disabled={disabled} aria-label={`删除${path}第${index + 1}项`}
            onClick={() => { if (!disabled) change({ ...value, items: items.filter(entry => entry.id !== item.id) }); }}>删除这一项</button>
        </div>
      </fieldset>)}
      <button type="button" aria-label={`为${path}添加一个列表项`} disabled={disabled || items.length >= S2_SIMPLE_VALUE_MAX_ITEMS || !value.nextItemId || value.nextItemId >= 1000000}
        onClick={() => { if (!disabled && items.length < S2_SIMPLE_VALUE_MAX_ITEMS && value.nextItemId && value.nextItemId < 1000000)
          change({ ...value, items: [...items, { id: `item-${value.nextItemId}`, ...emptyS2SimpleScalar() }], nextItemId: value.nextItemId + 1 }); }}>添加一个列表项</button>
      <small>最多32项，允许各项类型不同；多项内容最多32个普通字段，不再套对象或列表。空文字、0、否、空值和空对象分别保留，尚未填写会提示补齐，不会删除或补值。超出范围请用高级JSON完整编辑，不自动转表格。</small>
    </div>;
  };
  const fields = (rows: S2SimpleValueDraft['rows'], path: string, update: (rows: S2SimpleValueDraft['rows']) => void, depth = 0, controlPath: S2SimpleControlPath = ['rows'], scalarOnly = false): React.ReactNode => <>
    {rows.map((row, index) => <fieldset key={index} disabled={disabled}><legend>第 {index + 1} 项</legend>
      <label>字段名称<input {...controlProps([...controlPath, index, 'name'])} aria-label={`${path}第${index + 1}项的字段名称`} type="text" disabled={disabled} maxLength={200} value={row.name}
        onChange={event => { if (!disabled) update(rows.map((entry, i) => i === index ? { ...entry, name: event.target.value } : entry)); }} />{feedback([...controlPath, index, 'name'])}</label>
      {choose(row, `${path}第${index + 1}项`, value => update(rows.map((entry, i) => i === index ? value : entry)), false, row.name || `第${index + 1}项内容`, !scalarOnly && depth < S2_SIMPLE_VALUE_MAX_GROUP_DEPTH, !scalarOnly, [...controlPath, index])}
      {!scalarOnly && row.kind === 'list' && <details className="s2-value-group"><summary>{row.name || `第${index + 1}项内容`} · {row.items?.length ?? 0} 个列表项</summary>
        {listEditor(row, `${path}第${index + 1}项的列表`, value => update(rows.map((entry, i) => i === index ? { ...entry, ...value } : entry)), [...controlPath, index])}
        <small>仅修改本项列表；删除外层这一项会移除整个列表。未应用时可载入当前材料恢复。</small>
      </details>}
      {!scalarOnly && row.kind === 'object' && depth < S2_SIMPLE_VALUE_MAX_GROUP_DEPTH && <details className="s2-value-group">
        <summary>{row.name || `第${index + 1}项内容`} · {row.rows?.length ?? 0} 项内容</summary>
        {fields(row.rows ?? [], `${path}第${index + 1}项`, children => update(rows.map((entry, i) => i === index ? { ...entry, rows: children } : entry)), depth + 1, [...controlPath, index, 'rows'])}
        <small>分组内的名称独立保存，不会展开合并到外层。删除分组会移除其中全部内容；尚未应用时可载入当前材料恢复。</small>
      </details>}
      <button type="button" disabled={disabled} aria-label={`删除${path}第${index + 1}项`} onClick={() => { if (!disabled) update(rows.filter((_, i) => i !== index)); }}>删除这一项</button>
    </fieldset>)}
    <button type="button" disabled={disabled || rows.length >= S2_SIMPLE_VALUE_MAX_FIELDS} aria-label={`为${path}添加一项内容`}
      onClick={() => { if (!disabled && rows.length < S2_SIMPLE_VALUE_MAX_FIELDS) update([...rows, { name: '', ...emptyS2SimpleScalar() }]); }}>添加一项内容</button>
  </>;
  const records = draft.records ?? [];
  const moveRecord = (index: number, offset: number) => {
    if (disabled || index + offset < 0 || index + offset >= records.length) return;
    const next = [...records]; [next[index], next[index + offset]] = [next[index + offset], next[index]]; onChange({ ...draft, records: next });
  };
  return <fieldset disabled={disabled}><legend>{label}</legend>
    {choose(draft, label, onChange, true)}
    {draft.kind === 'object' && <>
      {fields(draft.rows, label, rows => onChange({ ...draft, rows }))}
      <small>名称可使用中文，同一组内不能重复。可添加一层信息分组及具名列表；列表项可为普通值或单层具名内容，每层或列表最多32项。更深容器仍用高级编辑，完整内容不丢失。</small>
    </>}
    {draft.kind === 'list' && listEditor(draft, label, value => onChange({ ...draft, ...value }))}
    {draft.kind === 'records' && <div className="s2-records-input">
      <p>共 {records.length} 条记录。点开一条记录填写；每条可有不同字段，不会补空值。上移、下移只调整顺序，应用后才更新材料。</p>
      {!records.length && <p>当前是空记录列表。可直接应用空列表，或添加记录后填写。</p>}
      {records.map((record, index) => <section key={record.id} aria-label={`${label}第${index + 1}条记录`}>
        <details><summary>第 {index + 1} 条记录 · {record.rows.length} 项内容</summary>
          {fields(record.rows, `${label}第${index + 1}条记录`, rows => onChange({ ...draft, records: records.map(entry => entry.id === record.id ? { ...entry, rows } : entry) }), 0, ['records', index, 'rows'])}
          {!record.rows.length && <small>这是一条没有字段的记录；添加内容后再填写。</small>}
        </details>
        <div className="s2-actions">
          <button type="button" disabled={disabled || index === 0} aria-label={`上移${label}第${index + 1}条记录`} onClick={() => moveRecord(index, -1)}>上移</button>
          <button type="button" disabled={disabled || index === records.length - 1} aria-label={`下移${label}第${index + 1}条记录`} onClick={() => moveRecord(index, 1)}>下移</button>
          <button type="button" disabled={disabled} aria-label={`删除${label}第${index + 1}条记录`}
            onClick={() => { if (!disabled) onChange({ ...draft, records: records.filter(entry => entry.id !== record.id) }); }}>删除这条记录</button>
        </div>
      </section>)}
      <button type="button" disabled={disabled || records.length >= S2_SIMPLE_VALUE_MAX_RECORDS || !draft.nextRecordId || draft.nextRecordId >= 1000000}
        onClick={() => { if (!disabled && records.length < S2_SIMPLE_VALUE_MAX_RECORDS && draft.nextRecordId && draft.nextRecordId < 1000000)
          onChange({ ...draft, records: [...records, { id: `record-${draft.nextRecordId}`, rows: [] }], nextRecordId: draft.nextRecordId + 1 }); }}>添加一条记录</button>
      <small>常用表单最多32条、每层32项，支持一层信息分组和具名列表，列表内可填单层具名内容；更多记录、更深容器用高级JSON完整编辑，不截断。空文字、0、否和空值分别保留；不需要的字段请明确删除。</small>
    </div>}
  </fieldset>;
}
