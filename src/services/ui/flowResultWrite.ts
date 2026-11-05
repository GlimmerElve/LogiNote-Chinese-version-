import type { FlowResultData } from '../../components/FlowResultView';
import type { ArgDoc } from '../argumentDoc/types';

export type FlowResultOperation = 'save' | 'reassess';

interface Dependencies {
  current: () => FlowResultData | null;
  save: (snapshot: FlowResultData) => Promise<boolean>;
  reassess: (doc: ArgDoc) => Promise<ArgDoc>;
  apply: (result: FlowResultData) => void;
  saved: (snapshot: FlowResultData) => void;
  phase: (operation: FlowResultOperation | null) => void;
  notice: (message: string) => void;
}

/** One synchronous lock for both actions; late replies cannot replace a new result or newer edits. */
export class FlowResultWriteController {
  private active: object | null = null;
  get busy() { return this.active !== null; }

  async run(operation: FlowResultOperation, dependencies: Dependencies): Promise<boolean> {
    const source = dependencies.current();
    if (!source || this.busy) return false;
    const token = {};
    const snapshot = structuredClone(source);
    const belongsToResult = (current: FlowResultData | null) => current !== null
      && current.report === source.report && current.createdAt === snapshot.createdAt
      && current.noteId === snapshot.noteId && current.reviewSessionId === snapshot.reviewSessionId
      && current.doc.doc_id === snapshot.doc.doc_id;
    const revision = JSON.stringify(snapshot.doc); // Includes positions, not just semantic content.
    this.active = token;
    dependencies.phase(operation);
    dependencies.notice('');
    try {
      const updatedDoc = operation === 'reassess' ? await dependencies.reassess(snapshot.doc) : null;
      if (operation === 'save' && !await dependencies.save(snapshot)) throw new Error('save rejected');
      const current = dependencies.current();
      if (!current || !belongsToResult(current)) return false;
      if (JSON.stringify(current.doc) !== revision) {
        dependencies.notice(operation === 'save'
          ? '提交时的版本已保存，当前新修改尚未保存，请再次保存结果。'
          : '画布已有新修改，本次重评未覆盖它，请重新提交结构评价。');
        return false;
      }
      if (updatedDoc && JSON.stringify(updatedDoc) === JSON.stringify(snapshot.doc)) {
        dependencies.notice('没有待重评的修改或问题，未发送模型请求。');
      } else if (updatedDoc) {
        dependencies.apply({ ...current, doc: updatedDoc });
        const review = updatedDoc.structureReview;
        if (review?.checkedNodes) dependencies.notice(`本次检查 ${review.checkedNodes.length} 个节点、${review.checkedEdges?.length ?? 0} 条关系；${(review.pendingNodes?.length ?? 0) + (review.pendingEdges?.length ?? 0)} 个目标待检查。原始评分不变。`);
      }
      else dependencies.saved(snapshot);
      return true;
    } catch (error) {
      // Failure is recoverable in-place; do not expose provider or filesystem details.
      if (belongsToResult(dependencies.current())) {
        dependencies.notice(operation === 'save'
          ? '结果未能保存，画布和修改已保留。请重试，或检查模型设置与笔记库保存状态。'
          : '结构重评失败，画布和修改已保留。请检查模型设置后重试。');
      }
      console.error('[flow-result]', operation, error);
      return false;
    } finally {
      if (this.active === token) {
        this.active = null;
        dependencies.phase(null);
      }
    }
  }
}
