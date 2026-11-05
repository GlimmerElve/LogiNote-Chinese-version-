import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const argumentBlock = readFileSync('src/components/ArgumentBlockNode.tsx', 'utf8');
const mathNode = readFileSync('src/components/MathNode.tsx', 'utf8');
const errorBoundary = readFileSync('src/components/ArgumentEditErrorBoundary.tsx', 'utf8');
const argumentQuality = readFileSync('src/components/ArgumentQualityIssues.tsx', 'utf8');
const argumentEvidence = readFileSync('src/components/ArgumentEvidenceSources.tsx', 'utf8');
const referenceArgument = readFileSync('src/components/ReferenceArgumentStatus.tsx', 'utf8');
const noteEditor = readFileSync('src/components/NoteEditor.tsx', 'utf8');
const css = readFileSync('src/index.css', 'utf8');

assert.match(argumentBlock, /<button\s+type="button"[\s\S]*?aria-label="打开论证结构图进行编辑"/,
  'missing argument maps must expose a native, named activation control');
assert.match(argumentBlock, /aria-label="编辑此论证结构图"/);
assert.match(argumentBlock, /aria-label="删除此论证结构图"/);
assert.doesNotMatch(argumentBlock, /border-indigo|bg-indigo|text-indigo|dark:bg-slate/,
  'embedded argument maps must not revive the legacy blue-purple theme');
assert.match(css, /\.argument-block-action\s*\{[\s\S]*?width:\s*44px;[\s\S]*?height:\s*44px;/,
  'embedded action targets must remain at least 44 by 44 pixels');
assert.match(mathNode, /focus-visible:outline-\[var\(--ln-accent\)\]/,
  'formula editing must use the application focus color');
assert.doesNotMatch(mathNode, /outline-indigo/);
assert.match(errorBoundary, /role="alert"/);
assert.match(errorBoundary, /type="button"[\s\S]*?onClick=\{this\.props\.onBack\}/,
  'the argument editor fallback must retain a native return action');
assert.match(argumentQuality, /className="argument-quality-ui/);
assert.doesNotMatch(argumentQuality, /blue-|focus-visible:ring-blue|min-h-8/,
  'argument quality actions must use semantic theme tokens and full-size targets');
assert.match(css, /\.argument-quality-action\s*\{[\s\S]*?min-height:\s*44px;/);
assert.match(noteEditor, /role="menu" aria-label="笔记更多功能"/);
assert.ok((noteEditor.match(/role="menuitem"/g) || []).length >= 6,
  'every note overflow action must expose menu-item semantics');
assert.match(noteEditor, /className=\{!readTextbook \? 'is-active' : ''\}/);
assert.match(noteEditor, /className=\{readTextbook \? 'is-active' : ''\}/);
assert.match(css, /\.note-textbook-mode-tabs button\.is-active/,
  'the edit/read switch must show a visible selected state');
const logicPanel = noteEditor.slice(noteEditor.indexOf('{(logicResult || logicError || logicScopeNotice || isAnalyzing)'), noteEditor.indexOf('{/* 「更多」扩展功能'));
assert.match(logicPanel, /className="note-logic-panel"/);
assert.match(logicPanel, /logicScopeNotice/,
  'logical analysis must disclose when textbook content was excluded from its scope');
assert.doesNotMatch(logicPanel, /(?:bg|text|border)-(?:indigo|blue|purple|cyan|orange|green|emerald|slate|red|amber)-/,
  'logical analysis must communicate hierarchy through semantic states rather than a rainbow of utility colors');
assert.match(css, /\.note-logic-close\s*\{[\s\S]*?min-height:\s*44px;/);
const moreMenu = noteEditor.slice(noteEditor.indexOf('{/* 「更多」扩展功能'));
assert.doesNotMatch(moreMenu, /(?:hover:bg|text)-(?:indigo|blue|purple|cyan|orange|green|emerald|slate|red|amber)-/,
  'note overflow actions must share one icon and hover language');
assert.match(css, /\.note-editor-more-icon\s*\{[\s\S]*?color:\s*var\(--ln-accent\)/);
assert.match(argumentEvidence, /<section className="argument-evidence-ui"/);
assert.doesNotMatch(argumentEvidence, /blue-|indigo-|emerald-|slate-|rose-/,
  'evidence workflows must use the same semantic theme language as the editor');
assert.match(argumentEvidence, /className="argument-evidence-action is-danger"/);
assert.match(css, /\.argument-evidence-action,[\s\S]*?min-height:\s*44px;/,
  'evidence actions must keep full-size targets');
assert.doesNotMatch(referenceArgument, /min-h-8/,
  'reference processing actions must not regress to compact click targets');
assert.match(referenceArgument, /className=\{`\$\{buttonStyle\} is-primary`\}/);
assert.match(css, /\.reference-argument-action\s*\{\s*padding:/);

console.log('Embedded editor UI passed: native argument actions, 44px quality/evidence/reference controls, semantic menus and logic states, selected note modes, themed formula focus and recoverable error fallback. No IO.');
