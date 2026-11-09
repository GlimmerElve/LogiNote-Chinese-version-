import React, { forwardRef, useCallback, useImperativeHandle, useRef } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { ArgumentCanvas } from '../../modules/argumentCanvas/ArgumentCanvas';
import { Toolbar } from '../../modules/argumentCanvas/components/Toolbar';
import { useCanvasStore } from '../../modules/argumentCanvas/store/canvasStore';
import { layoutDoc } from '../../services/argumentDoc/layout';
import { LEGACY_TYPE_FOR_ROLE } from '../../services/argumentDoc/editorModel';
import type { ArgDoc, ArgumentRole } from '../../services/argumentDoc/types';
import { exportMarkdown } from '../../modules/argumentCanvas/export/markdown';
import { exportJSON } from '../../modules/argumentCanvas/export/json';

export interface ProgressiveGraphEditorHandle { snapshot(): ArgDoc; peek(): ArgDoc; hasPendingInput(): boolean; hasPendingRelation(): boolean; }
const download = (name: string, content: string) => {
  const url = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
/** The existing full editor, mounted only while explicitly editing this segment. */
export const ProgressiveReviewGraphEditor = forwardRef<ProgressiveGraphEditorHandle, { doc: ArgDoc; busy: boolean; onChange(doc: ArgDoc): void; onRelationEditorOpenChange?(open: boolean): void }>(function ProgressiveReviewGraphEditor({ doc, busy, onChange, onRelationEditorOpenChange }, ref) {
  const root = useRef<HTMLDivElement>(null);
  const relationEditorOpen = useRef(false), relationEditorListener = useRef(onRelationEditorOpenChange);
  relationEditorListener.current = onRelationEditorOpenChange;
  const reportRelationEditor = useCallback((open: boolean) => {
    relationEditorOpen.current = open;
    relationEditorListener.current?.(open);
  }, []);
  const peek = () => {
    const current = useCanvasStore.getState().doc;
    return current.doc_id === doc.doc_id ? current : doc;
  };
  const snapshot = () => {
    // Node editors commit on blur; read the synchronous store, not a prior React render.
    const active = document.activeElement;
    if (active instanceof HTMLElement && root.current?.contains(active)) active.blur();
    return peek();
  };
  const hasPendingRelation = () => relationEditorOpen.current;
  const hasPendingInput = () => hasPendingRelation() || Array.from(root.current?.querySelectorAll<HTMLTextAreaElement>('.arg-node-textarea') || []).some(input => {
    const id = input.closest<HTMLElement>('.react-flow__node')?.dataset.id;
    return input.value !== useCanvasStore.getState().doc.nodes.find(node => node.id === id)?.text;
  });
  useImperativeHandle(ref, () => ({ snapshot, peek, hasPendingInput, hasPendingRelation }));
  const addRole = (role: ArgumentRole) => {
    if (busy) return;
    useCanvasStore.getState().addNode(LEGACY_TYPE_FOR_ROLE[role], { role, text: '', position: { x: 140, y: 140 }, status: 'edited', user_edited: true });
  };
  return <div ref={root} className="progressive-review-editor argument-canvas-scope" inert={busy || undefined} aria-busy={busy}>
    <Toolbar onAddNode={type => { if (!busy) useCanvasStore.getState().addNode(type, { text: '', position: { x: 140, y: 140 }, status: 'edited' }); }} onAddRole={addRole}
      onAutoLayout={() => { if (!busy) { const state = useCanvasStore.getState(); state.applyLayout(layoutDoc(state.doc.nodes, state.doc.edges)); } }}
      onExportMarkdown={() => download('复盘论证结构.md', exportMarkdown(snapshot()))}
      onExportJSON={() => download('复盘论证结构.json', exportJSON(snapshot()))}
      onExportPDF={async () => { if (root.current) await (await import('../../modules/argumentCanvas/export/pdf')).exportPDF(root.current, '复盘论证结构'); }}
      onExportPNG={async () => { if (root.current) await (await import('../../modules/argumentCanvas/export/png')).exportPNG(root.current, '复盘论证结构'); }} />
    <div className="progressive-review-editor-canvas"><ReactFlowProvider><ArgumentCanvas doc={doc} onChange={onChange} readOnly={busy} dialogPriority={450} onRelationEditorOpenChange={reportRelationEditor} /></ReactFlowProvider></div>
  </div>;
});
