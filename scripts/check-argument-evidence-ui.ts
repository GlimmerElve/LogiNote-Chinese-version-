import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ArgDoc } from '../src/services/argumentDoc/types';
import {
  ArgumentEvidenceRequestScope,
  argumentEvidenceScopeKey,
  isCurrentArgumentEvidenceCandidate,
} from '../src/services/ui/argumentEvidenceRequestScope';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function makeDoc(text = '主张 A'): ArgDoc {
  return {
    doc_id: 'doc-1', title: '测试论证', created_at: '', updated_at: '', iteration: 1, status: 'draft', edges: [],
    nodes: [
      {
        id: 'N1', mainType: '事实陈述', text, position: { x: 0, y: 0 }, status: 'ok', issue: null,
        severity: null, suggestion: null, user_edited: false, collapsed: false,
      },
      {
        id: 'N2', mainType: '推理', text: '主张 B', position: { x: 0, y: 0 }, status: 'ok', issue: null,
        severity: null, suggestion: null, user_edited: false, collapsed: false,
      },
    ],
  };
}

const owner = new ArgumentEvidenceRequestScope();
const n1Scope = argumentEvidenceScopeKey(makeDoc(), 'N1');
owner.setScope(n1Scope);
const staleSearch = owner.begin('search');

const n2Scope = argumentEvidenceScopeKey(makeDoc(), 'N2');
owner.setScope(n2Scope);
assert.equal(owner.owns(staleSearch), false, '切换节点后，不得接收旧节点的检索结果');

const olderSearch = owner.begin('search');
const latestSearch = owner.begin('search');
assert.equal(owner.owns(olderSearch), false, '同一节点的较旧检索结果不得覆盖较新结果');
assert.equal(owner.owns(latestSearch), true, '只接收当前节点最新一次检索结果');

const preview = owner.begin('preview');
owner.setScope(argumentEvidenceScopeKey(makeDoc('主张 A 已编辑'), 'N1'));
assert.equal(owner.owns(preview), false, '节点内容变更后，不得展示旧内容对应的预览');

assert.equal(isCurrentArgumentEvidenceCandidate(n1Scope, n2Scope, 'candidate-a', ['candidate-a']), false, '旧节点候选不得绑定到新节点');
assert.equal(isCurrentArgumentEvidenceCandidate(n1Scope, n1Scope, 'candidate-a', []), false, '已移除的候选不得继续绑定');
assert.equal(isCurrentArgumentEvidenceCandidate(n1Scope, n1Scope, 'candidate-a', ['candidate-a']), true, '当前可见候选应允许绑定');

owner.setScope(n1Scope);
const pending = owner.begin('search');
owner.invalidate();
assert.equal(owner.owns(pending), false, '页面卸载后不得继续提交异步结果');

const componentSource = fs.readFileSync(path.join(root, 'src/components/ArgumentEvidenceSources.tsx'), 'utf8');
assert.match(componentSource, /requestScope\.current\.owns\(ticket\)/, '异步结果写入前必须校验请求归属');
assert.match(componentSource, /isCurrentArgumentEvidenceCandidate\(candidateScope, currentScope, candidate\.id/, '绑定前必须校验候选归属');
assert.match(componentSource, /onBind\(requestedNodeId, candidate\)/, '绑定必须使用发起时捕获的节点');

console.log('Argument evidence async ownership UI checks passed.');
