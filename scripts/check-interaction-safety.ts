import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createUndoHistory, recordUndoHistory, moveUndoHistory } from '../src/services/ui/undoHistory';
import { sceneAllowsNavigation, sceneAllowsExit } from '../src/components/useSceneGuard';
import { acknowledgedSaveState } from '../src/services/ui/saveFeedback';
import { clearManualPlanDraft, loadConflictingManualPlanDraft, loadManualPlanDraft, saveManualPlanDraft } from '../src/services/ui/manualPlanDraft';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SceneRichMessage } from '../src/components/scene/SceneRichMessage';
import { saveAllNotesToStorage } from '../src/services/storage';
import type { PlanBuilderDraftValue } from '../src/components/PlanBuilder';
import type { NoteItem } from '../src/types';

const first: PlanBuilderDraftValue = { tree: [{ key: 'root', title: '学习', children: [
  { key: 'child', title: '概念', startDate: '2026-10-06', dueDate: '2026-10-08', children: [] },
]}], planMeta: { weeklyBudgetMinutes: 600, milestones: [{ id: 'flag', title: '验收', dueDate: '2026-10-08' }] } };
const second = structuredClone(first);
second.tree[0].children[0].startDate = '2026-10-07';
second.planMeta.weeklyBudgetMinutes = 300;
let history = recordUndoHistory(createUndoHistory(first), second);
assert.deepEqual(moveUndoHistory(history, 'undo').present, first, 'dates, properties and milestones undo as one snapshot');
history = moveUndoHistory(history, 'undo');
assert.deepEqual(moveUndoHistory(history, 'redo').present, second);
const changed = structuredClone(first); changed.tree[0].children = [];
history = recordUndoHistory(history, changed);
assert.equal(history.future.length, 0, 'a new edit invalidates old redo');
assert.deepEqual(moveUndoHistory(history, 'undo').present.tree[0].children.map((node) => node.key), ['child']);
history = recordUndoHistory(history, second, true);
assert.equal(history.past.length, 1, 'typing coalesces without losing the pre-edit snapshot');
assert.equal(sceneAllowsNavigation('running'), false);
assert.equal(sceneAllowsNavigation('finished'), false, 'completion alone must not unlock navigation');
assert.equal(sceneAllowsExit('running'), false);
assert.equal(sceneAllowsExit('finished'), true, 'only explicit exit unlocks a completed scene');
assert.equal(sceneAllowsNavigation('idle'), true, 'setup and failed generation remain cancellable');
const disabledLink = renderToStaticMarkup(createElement(SceneRichMessage, { content: '[资料](https://example.com)', externalLinksDisabled: true }));
assert.doesNotMatch(disabledLink, /href=|target=/, 'scene material previews cannot launch external pages');
assert.equal(acknowledgedSaveState(2, 1, true), 'pending', 'old save acknowledgments cannot hide newer edits');
assert.equal(acknowledgedSaveState(2, 2, false), 'error');
assert.equal(acknowledgedSaveState(2, 2, true), 'saved');

const memory = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem: (key: string) => memory.get(key) || null,
  setItem: (key: string, value: string) => memory.set(key, value),
  removeItem: (key: string) => memory.delete(key),
} });
saveManualPlanDraft('test-draft', 'base-1', first);
assert.deepEqual(loadManualPlanDraft('test-draft', 'base-1'), first);
assert.equal(loadManualPlanDraft('test-draft', 'base-2'), null, 'a stale draft must not override an externally changed published plan');
saveManualPlanDraft('test-draft', 'base-2', second);
assert.deepEqual(loadConflictingManualPlanDraft('test-draft', 'base-2'), first, 'stale unsubmitted edits remain recoverable');
assert.deepEqual(loadManualPlanDraft('test-draft', 'base-2'), second);
clearManualPlanDraft('test-draft');
assert.equal(loadManualPlanDraft('test-draft', 'base-1'), null);
assert.equal(loadConflictingManualPlanDraft('test-draft', 'base-3'), null);
memory.set('test-draft', '{bad json');
assert.equal(loadManualPlanDraft('test-draft', 'base-1'), null);

const writes: string[] = [];
let release!: () => void;
const gate = new Promise<void>((resolve) => { release = resolve; });
Object.defineProperty(globalThis, 'window', { configurable: true, value: { electronAPI: { vault: { saveVault: async (notes: NoteItem[]) => {
  const title = notes[0].title;
  writes.push(`start:${title}`);
  if (title === 'first') await gate;
  if (title === 'failed') throw new Error('test disk error');
  writes.push(`finish:${title}`);
} } } } });
const note = (title: string): NoteItem => ({ id: 'test', title, content: '', noteType: 'knowledge', tags: [], links: [], backlinks: [], dueDates: [], createdAt: '', updatedAt: '' });
const write1 = saveAllNotesToStorage([note('first')]);
const write2 = saveAllNotesToStorage([note('second')]);
await new Promise((resolve) => setTimeout(resolve, 0));
assert.deepEqual(writes, ['start:first']);
release(); await Promise.all([write1, write2]);
assert.deepEqual(writes, ['start:first', 'finish:first', 'start:second', 'finish:second']);
await assert.rejects(saveAllNotesToStorage([note('failed')]), /test disk error/);
await saveAllNotesToStorage([note('retry')]);
assert.equal(writes.at(-1), 'finish:retry', 'a failed write must not poison subsequent saves');

const source = (file: string) => readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
assert.match(source('App.tsx'), /const setCurrentView = [\s\S]*?if \(!sceneGuard.allowNavigation\(\)\) return/);
assert.match(source('App.tsx'), /onOpenNote: handleSceneReference/);
assert.doesNotMatch(source('components/scene/SceneReferenceDialog.tsx'), /onSelectNote|onEdit|openExternal/);
assert.match(source('components/scene/SceneChatView.tsx'), /finished && onExit/);
assert.match(source('components/PlanDualTrackComposer.tsx'), /event.defaultPrevented \|\| hasActiveDialog\(\)/);
assert.match(source('components/PlanBuilder.tsx'), /useDialog\(commitConfirmOpen/);
assert.match(source('components/ContextNotePages.tsx'), /data-context-source-forward/);
console.log('Interaction safety checks passed: scene lock, draft recovery, undo/redo, write ordering and failure retry.');
