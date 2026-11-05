import assert from 'node:assert/strict';
import './check-concept-fill-ui';
import './check-agent-audit-ui';
import './check-selection-resource-ui';
import './check-reference-recovery-ui';
import './check-secondary-pages-ui';
import './check-profile-overview-ui';
import './check-profile-evidence-ui';
import './check-learning-analysis-dialogs';
import './check-command-palette-ui';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Sidebar, countProjectDescendants } from '../src/components/Sidebar';
import { PrivacyPolicyModal } from '../src/components/PrivacyPolicyModal';
import { WorkspaceTopbar } from '../src/components/Header';
import { AgentOrb } from '../src/components/AgentOrb';
import type { NoteItem, SyncStatus, VaultSettings } from '../src/types';

const note = (id: string, parentId?: string, noteType: NoteItem['noteType'] = 'project'): NoteItem => ({
  id, title: id, parentId, noteType, content: '', tags: [], links: [], backlinks: [], dueDates: [], createdAt: '', updatedAt: '',
});
const fixtures = [note('root'), note('child', 'root'), note('grandchild', 'child'), note('knowledge', 'child', 'knowledge'), note('other')];
const before = structuredClone(fixtures);
assert.equal(countProjectDescendants(fixtures, 'root'), 3, 'confirmation includes descendant notes as well as nested projects');
assert.equal(countProjectDescendants(fixtures, 'child'), 2);
assert.equal(countProjectDescendants(fixtures, 'other'), 0, 'unrelated projects are not included in deletion scope');
assert.deepEqual(fixtures, before, 'calculating deletion scope cannot mutate the vault');

let mutationCalls = 0;
const sidebarMarkup = renderToStaticMarkup(createElement(Sidebar, {
  notes: fixtures, activeNoteId: 'root', onSelectNote: () => {}, onNewNote: () => { mutationCalls += 1; },
  onDeleteNote: () => { mutationCalls += 1; }, onDeleteProject: () => { mutationCalls += 1; },
  onToggleFavorite: () => {}, onTogglePin: () => {}, settings: {} as VaultSettings,
}));
assert.match(sidebarMarkup, /<button[^>]*class="note-tree-open"[^>]*aria-current="page"/);
assert.match(sidebarMarkup, /<button[^>]*class="note-tree-toggle"[^>]*aria-expanded="false"/);
assert.match(sidebarMarkup, /aria-label="删除项目「root」"/);
let buttonDepth = 0;
for (const tag of sidebarMarkup.match(/<\/?button\b[^>]*>/g) || []) {
  if (tag.startsWith('</')) buttonDepth -= 1;
  else { assert.equal(buttonDepth, 0, 'open-note and utility actions must not be nested buttons'); buttonDepth += 1; }
}
assert.equal(buttonDepth, 0);
assert.equal(mutationCalls, 0, 'rendering the sidebar cannot create or delete notes');

const privacyMarkup = renderToStaticMarkup(createElement(PrivacyPolicyModal, { isOpen: true, onClose: () => {} }));
assert.match(privacyMarkup, /role="dialog" aria-modal="true" aria-labelledby=/);
assert.match(privacyMarkup, /aria-label="关闭隐私说明"/);
assert.equal(renderToStaticMarkup(createElement(PrivacyPolicyModal, { isOpen: false, onClose: () => {} })), '');

const source = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const sidebar = source('src/components/Sidebar.tsx');
assert.doesNotMatch(sidebar, /onDeleteNote\s*\(/, 'all project deletion entries must use the confirmed cascading route');
assert.equal((sidebar.match(/onClick=\{\(\) => requestProjectDelete\(/g) || []).length, 2, 'tree and filtered cards share deletion confirmation');
assert.equal((sidebar.match(/await onDeleteProject\(showDeleteConfirm\.id\)/g) || []).length, 1, 'only the explicit confirm action calls and acknowledges project deletion');
assert.match(sidebar, /useDialog\(showNewProjectModal, newProjectDialogRef/);
assert.match(sidebar, /useDialog\(Boolean\(showDeleteConfirm\), deleteDialogRef, deleteBusy \? undefined/);
assert.match(sidebar, /aria-busy=\{deleteBusy\}/);
assert.match(sidebar, /role="alert"[^>]*>\{deleteError\}/);
assert.match(sidebar, /await onDeleteProject[\s\S]*setShowDeleteConfirm\(null\)/,
  'delete confirmation remains open until its App handler accepts the UI operation');
assert.match(sidebar, /e\.defaultPrevented \|\| hasActiveDialog\(\) \|\| isTextInput\(e\.target\)/);
assert.match(sidebar, /sidebar\.closest\('\[inert\]'\)/, 'inactive sidebar cannot own shortcuts');
assert.match(sidebar, /const searchControlsVisible = [^;]*Boolean\(searchQuery\)/, 'an active query keeps its clearing control visible');
assert.match(sidebar, /aria-label="清除搜索"/);
assert.match(source('src/components/PrivacyPolicyModal.tsx'), /useDialog\(isOpen, dialogRef, onClose\)/);
const css = source('src/index.css');
const appSource = source('src/App.tsx');
const deleteStart = appSource.indexOf('const handleDeleteProject = async');
const deleteEnd = appSource.indexOf('const handleToggleFavorite', deleteStart);
const deleteHandler = appSource.slice(deleteStart, deleteEnd);
assert.ok(deleteStart >= 0 && deleteEnd > deleteStart);
assert.match(deleteHandler, /stageNoteDeletion\(\[id, \.\.\.collectDescendantIds\(id, current\)\]\)/u);
assert.doesNotMatch(deleteHandler, /await saveAllNotesToStorage/u, 'project dialog does not wait for disk IO');
const stagedDeletion = appSource.slice(appSource.indexOf('const stageNoteDeletion ='), deleteStart);
assert.ok(stagedDeletion.indexOf('setNotes(next)') < stagedDeletion.indexOf('enqueueLearningWrite'),
  'UI removal precedes background persistence while reserving the shared exit/save queue');
assert.match(stagedDeletion, /rollbackOptimisticNoteDeletions/u, 'failed persistence restores only pending removals');
assert.match(css, /\.note-tree-row:focus-within \.note-tree-actions/);
assert.match(css, /\.note-leaf-card:focus-within \.note-leaf-actions/);
assert.match(css, /\.note-navigator-head button\s*\{[^}]*width:\s*44px;[^}]*height:\s*44px;/,
  'header search and create controls must keep full-size targets');
assert.match(css, /\.note-navigator-head\s*\{[^}]*grid-template-columns:\s*minmax\(max-content,\s*1fr\)\s+auto;/,
  'the note navigator reserves an explicit non-collapsing column for its title');
assert.match(css, /\.note-navigator-head strong\s*\{[^}]*min-width:\s*max-content;[^}]*white-space:\s*nowrap;/,
  'the 我的笔记 title cannot shrink into one-character lines');
assert.match(css, /\.note-navigator-head-actions\s*\{[^}]*min-width:\s*max-content;[^}]*flex-shrink:\s*0;/,
  'header actions cannot consume the title column by shrinking unpredictably');
assert.match(css, /\.note-filter\s*\{[^}]*min-height:\s*44px;/,
  'project filters must remain usable as real controls rather than tiny labels');
assert.match(css, /\.note-tree-actions\s*\{[^}]*pointer-events:\s*none;/,
  'visually hidden project actions must not intercept pointer input');
assert.match(css, /\.note-tree-row\s*\{[^}]*min-height:\s*44px;[^}]*padding-top:\s*0;[^}]*padding-bottom:\s*0;/,
  'tree rows retain a full target without adding vertical padding on top of the target height');
assert.match(css, /\.note-tree-actions\s*\{[^}]*position:\s*absolute;/,
  'hidden tree actions cannot reserve most of the row and collapse note titles');
assert.match(css, /\.note-leaf-card\s*\{[^}]*position:\s*relative;[^}]*padding:\s*0\s+0\.55rem\s+0\s+2\.35rem;/,
  'filtered note rows stay compact while anchoring their overlay actions');
assert.match(css, /\.note-leaf-actions\s*\{[^}]*position:\s*absolute;/,
  'hidden leaf actions cannot shorten note titles before they are revealed');
assert.match(css, /\.note-tree-actions > button, \.note-leaf-actions > button\s*\{[^}]*width:\s*24px;[^}]*height:\s*24px;/,
  'compact title actions must remain consistently sized without dominating the note row');
assert.match(css, /\.note-tree-toggle, \.note-tree-toggle-spacer\s*\{[^}]*width:\s*24px;[^}]*min-width:\s*24px;[^}]*height:\s*24px;/,
  'project disclosure controls must match the compact row action size');
assert.match(css, /\.note-tree-row:hover \.note-tree-open, \.note-tree-row:focus-within \.note-tree-open\s*\{[^}]*padding-right:\s*3\.25rem;/,
  'revealed tree actions reserve their own title gutter instead of covering text');
assert.match(css, /\.note-leaf-card:hover \.note-leaf-open, \.note-leaf-card:focus-within \.note-leaf-open\s*\{[^}]*padding-right:\s*4\.85rem;/,
  'revealed filtered-note actions reserve their own title gutter instead of covering text');
assert.match(css, /\.note-project-dialog-action\s*\{[^}]*min-height:\s*44px;/,
  'project dialog decisions must remain full-size and theme-consistent');
assert.ok((sidebar.match(/aria-pressed=\{filterMode ===/g) || []).length >= 4,
  'each navigation filter must expose its selected state');
assert.doesNotMatch(css, /\.note-tree-row\.is-child\s*\{[^}]*padding-left:[^}]*!important/, 'CSS must not flatten nested project depth');
const orb = source('src/components/AgentOrb.tsx');
assert.match(orb, /onClick=\{\(event\) =>/, 'orb activation must use native button clicks for Enter and Space');
assert.match(orb, /event\.detail > 0 && dragged/, 'drag suppression cannot block keyboard clicks');
assert.doesNotMatch(orb.slice(orb.indexOf('onPointerDown=')), /onToggle\(\)/, 'pointer-up cannot duplicate native click activation');
assert.match(orb, /onPointerCancel=\{cancelDrag\}/);
assert.match(orb, /onLostPointerCapture=\{cancelDrag\}/);
assert.match(orb, /try \{ localStorage\.setItem\([\s\S]*?\} catch/, 'unavailable preference storage cannot interrupt drag cleanup');
assert.match(css, /body:has\(\[role="dialog"\]\[aria-modal="true"\]\) \.agent-orb/);
assert.match(css, /body:has\(\[role="alertdialog"\]\[aria-modal="true"\]\) \.agent-orb \{ visibility: hidden; pointer-events: none; \}/);

const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
try {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { innerWidth: 1280, innerHeight: 800 } });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: () => { throw new Error('preference storage unavailable'); },
  } });
  const orbMarkup = renderToStaticMarkup(createElement(AgentOrb, { open: false, busy: false, onToggle: () => { mutationCalls += 1; } }));
  assert.match(orbMarkup, /<button[^>]*aria-label="打开学习助手"[^>]*aria-expanded="false"/);
  assert.equal(mutationCalls, 0, 'rendering an orb with unavailable storage cannot toggle or mutate data');
  for (const [platform, shortcut] of [['Win32', 'Ctrl+K'], ['MacIntel', '⌘K']]) {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { platform } });
    const headerMarkup = renderToStaticMarkup(createElement(WorkspaceTopbar, {
      onOpenCommandPalette: () => {}, onTriggerSync: () => {}, syncStatus: { isSyncing: false } as SyncStatus,
    }));
    assert.ok(headerMarkup.includes(`<kbd>${shortcut}</kbd>`), `${platform} must show its usable keyboard shortcut`);
    assert.doesNotMatch(headerMarkup, /输入\s*\//, 'search must not advertise unsupported slash commands');
  }
} finally {
  if (windowDescriptor) Object.defineProperty(globalThis, 'window', windowDescriptor); else Reflect.deleteProperty(globalThis, 'window');
  if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor); else Reflect.deleteProperty(globalThis, 'navigator');
  if (storageDescriptor) Object.defineProperty(globalThis, 'localStorage', storageDescriptor); else Reflect.deleteProperty(globalThis, 'localStorage');
}
console.log('Shell navigation checks passed: deletion scope, semantic controls, modal ownership, visible search, hierarchy, platform shortcuts and orb input safety.');
