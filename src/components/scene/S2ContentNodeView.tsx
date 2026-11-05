import React from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { S2Field } from '../../types/sceneS2';
import type { S2Artifact } from '../../types/sceneS2Plugin';
import { S2ArtifactView } from './S2ArtifactView';
import { S2FieldPreview } from './S2FieldPreview';

export interface S2ContentNodeField {
  id?: string; label: string; value: string; definition?: S2Field;
  /** Legacy unconstrained text fields may keep immediate editing. */
  edit?: (value: string) => void;
  startEdit?: () => void;
  editor?: React.ReactNode;
  panelRef?: (element: HTMLDivElement | null) => void;
  connectable?: boolean;
}
export interface S2ContentNodeData {
  title: string; semanticIn?: boolean; semanticOut?: boolean; fields: S2ContentNodeField[];
  artifacts?: S2Artifact[]; disabled?: boolean; advanced?: boolean; readOnly?: boolean;
}

/** Generic presentation. The parent owns edit identity, guards and checked submissions. */
export function S2ContentNodeView({ data }: NodeProps) {
  const value = data as unknown as S2ContentNodeData, writable = !value.disabled && !value.readOnly;
  const interactive = (target: EventTarget | null) => !!(target as Element | null)?.closest?.('button,input,textarea,select,a,summary,.react-flow__handle,[contenteditable="true"]');
  const activate = (event: React.MouseEvent | React.KeyboardEvent, field: S2ContentNodeField) => {
    event.stopPropagation();
    if (!writable || !field.startEdit || interactive(event.target)) return;
    if ('key' in event && !['Enter', 'F2'].includes(event.key)) return;
    event.preventDefault(); field.startEdit();
  };
  const first = value.fields.find(field => field.startEdit);
  return <article className="s2-block">{value.semanticIn && <Handle type="target" position={Position.Left} />}
    <strong className={first ? 'nodrag nopan s2-content-title' : undefined} tabIndex={first && writable ? 0 : undefined}
      onClick={first ? event => event.stopPropagation() : undefined}
      onDoubleClick={first ? event => activate(event, first) : undefined}
      onKeyDown={first ? event => activate(event, first) : undefined}>{value.title}</strong>
    {value.readOnly && <small className="s2-readonly-label">只读 · 场景固定内容</small>}
    {value.fields.map((field, index) => {
      const preview = field.definition && ['table', 'json', 'code'].includes(field.definition.kind)
        ? <S2FieldPreview field={field.definition} value={field.value} /> : <p>{field.value || '（待填写）'}</p>;
      const body = field.editor != null ? <div className="nodrag nopan nowheel s2-inline-field" onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}>{field.editor}</div>
        : field.startEdit ? <div className="nodrag nopan nowheel s2-content-preview" role={writable ? 'button' : undefined}
          tabIndex={writable ? 0 : undefined} aria-label={`${value.title} / ${field.label}${writable ? '，双击或按 Enter 编辑' : ''}`}
          style={{ userSelect: 'text' }} onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}
          onDoubleClick={event => activate(event, field)} onKeyDown={event => activate(event, field)}>{preview}</div>
        : field.edit ? <textarea className="nodrag nopan nowheel s2-inline-text" aria-label={`${value.title} / ${field.label}`}
          disabled={value.disabled} readOnly={value.readOnly} value={field.value} maxLength={6000}
          onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}
          onDoubleClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}
          onChange={event => field.edit!(event.target.value)} /> : preview;
      return <div key={field.id ?? index} ref={field.panelRef} tabIndex={field.panelRef ? -1 : undefined} className="s2-field-port">{(!field.edit || value.fields.length > 1) && <small>{field.label}</small>}
        {value.advanced ? <details className="nodrag nopan"><summary>高级内容与格式</summary>{body}</details> : body}
        {field.id && field.connectable !== false && <Handle type="source" position={Position.Right} id={`field:${field.id}`} />}
      </div>;
    })}
    {value.artifacts?.map(artifact => <S2ArtifactView key={artifact.id} artifact={artifact} presentation="raw" />)}
    {value.semanticOut && <Handle type="source" position={Position.Right} />}
  </article>;
}
