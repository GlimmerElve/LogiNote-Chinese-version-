import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { build } from 'esbuild';
import type { LearningCompletionCardProps } from '../src/components/LearningCompletionCard';
import { getLearningCompletionTarget, getProjectCompletionTarget } from '../src/services/learningCompletion';
import type { NoteItem } from '../src/types';

// Ignore the stylesheet in this in-memory SSR bundle; never write a fixture or vault.
const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/components/LearningCompletionCard.tsx', import.meta.url))],
  bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', loader: { '.css': 'empty' },
});
const module = { exports: {} as { LearningCompletionCard: ComponentType<LearningCompletionCardProps> } };
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const { LearningCompletionCard } = module.exports;
const now = '2026-10-06T00:00:00.000Z';
const project = (id: string, title: string, parentId?: string, scheduled = true): NoteItem => ({
  id, title, parentId, noteType: 'project', content: '', tags: [], links: [], backlinks: [],
  dueDates: scheduled ? [{ id: `due-${id}`, noteId: id, noteTitle: title, taskText: title,
    startDate: '2026-10-06', dueDate: '2026-10-08', completed: false, priority: 'medium' }] : [],
  createdAt: now, updatedAt: now,
});
const notes = [project('root', '概率论'), project('leaf', '学习正态分布', 'root'), project('plain', '普通项目对象', undefined, false)];
const render = (target: LearningCompletionCardProps['target'], variant: LearningCompletionCardProps['variant'] = 'inline') => renderToStaticMarkup(createElement(LearningCompletionCard, {
  target, variant, context: 'flow', onSetCompleted: async () => {},
}));

assert.equal(render(null), '', 'unbound learning must not invent a completion action');
assert.equal(render(getProjectCompletionTarget(notes, 'plain')), '', 'ordinary unscheduled projects have no completion action');
assert.equal(render(getProjectCompletionTarget(notes, 'root')), '', 'a parent cannot bulk-complete its descendants from learning UI');
const leaf = getProjectCompletionTarget(notes, 'leaf')!;
const leafMarkup = render(leaf, 'compact');
assert.match(leafMarkup, /标记项目完成/);
assert.match(leafMarkup, /aria-busy="false"/);
assert.doesNotMatch(leafMarkup, /撤销完成/);
const resultMarkup = render({ ...leaf, completed: true }, 'result');
assert.match(resultMarkup, /已完成/);
assert.match(resultMarkup, /撤销完成/);
assert.match(resultMarkup, /学习收尾/);
assert.equal((resultMarkup.match(/<button/g) || []).length, 1, 'the result card has one state-change action, not duplicate completion controls');
assert.match(resultMarkup, /learning-completion-path[^>]*>概率论<\/p>/, 'breadcrumbs omit the title already displayed on the card');

const taskNotes: NoteItem[] = [{ ...notes[0], dueDates: [...notes[0].dueDates, {
  id: 'review', noteId: 'root', noteTitle: '概率论', taskText: '复习正态分布', dueDate: '2026-10-06',
  startDate: '2026-10-06', completed: false, priority: 'medium', recurrence: { frequency: 'daily' },
}] }];
const taskMarkup = render(getLearningCompletionTarget(taskNotes, { noteId: 'root', taskId: 'review', occurrenceDate: '2026-10-06' }));
assert.match(taskMarkup, /完成本次待办/);
assert.match(taskMarkup, /下次周期仍会按计划提醒/);
assert.doesNotMatch(taskMarkup, /标记项目完成/);

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const card = source('src/components/LearningCompletionCard.tsx');
assert.match(card, /await onSetCompleted\(target, completed\)/);
assert.match(card, /setRetryAction\(completed\)/, 'failed retries keep the explicit intended value');
assert.match(card, /setCompleted\(retryAction\)/);
assert.match(card, /if \(mountedRef\.current\)/, 'late write responses do not alter unmounted controls');
assert.match(card, /errorRef\.current\?\.focus\(\{ preventScroll: true \}\)/);
const editor = source('src/components/NoteEditor.tsx');
assert.match(editor, /completionTarget && onSetLearningCompletion && !hideLearningCompletionControl/);
assert.match(editor, /!completionTarget && childProgress/);
assert.match(editor, /<progress value=\{childProgress\.progress\}/);
assert.match(editor, /<MdxNoteEditor\s+key=\{note\?\.id\}/, 'completion never keys the editor by status or progress');
assert.match(editor, /const completionVersion = JSON\.stringify\(\[note\.id, note\.dueDates\.map/,
  'the editor tracks explicitly saved completion changes independently of local typing');
assert.match(editor, /previousTaskCompletionRef\.current !== completionVersion/);
assert.match(editor, /note\.content !== content && \(!isLocalTypingRef\.current \|\| completionChanged\)/,
  'a persisted checkbox update is synchronized without remounting or reverting user text');
const result = source('src/components/FlowResultView.tsx');
assert.equal((result.match(/className="flow-result-completion-slot"/g) || []).length, 1, 'one results slot survives both desktop and focused layouts');
const css = source('src/components/LearningCompletionCard.css');
assert.match(css, /has-learning-completion\.is-canvas-focused > \.flow-result-completion-slot \{ grid-column: 1;/);
assert.match(css, /@media \(max-width: 820px\)[\s\S]*?has-learning-completion > \.flow-result-completion-slot \{ grid-column: 1;/);
assert.match(css, /:focus-visible/);
assert.match(css, /prefers-reduced-motion/);
console.log('Learning completion UI checks passed: task identities, leaf-only controls, one results slot, retry intent and keyboard feedback.');
