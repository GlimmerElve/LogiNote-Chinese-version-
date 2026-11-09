import type { NoteItem, UploadedDocument } from '../../types';
import { directDocumentProjects, prepareDocumentProjectBindings } from '../documentProjectBindings';
import { projectAncestors, projectDisplayPath, projectDocumentBindings } from '../projectResourceScope';
import { canonicalAgentValue } from './approvalBinding';
import { applyWorkspaceNoteChange, type WorkspaceNoteChange } from './workspaceOperations';

export const DOCUMENT_BINDING_TOOLS = ['query_local_documents', 'read_local_document', 'update_document_project_bindings'] as const;
export interface DocumentBindingCommand {
  action: 'bind' | 'unbind';
  documentIds: string[];
  projectNoteIds: string[];
}
export interface DocumentBindingCatalog { scopeId: string; documents: UploadedDocument[]; notes: NoteItem[] }
export interface DocumentBindingResult {
  saved: boolean;
  unchanged: boolean;
  operationId?: string;
  changedNoteIds: string[];
  documents: Array<{ documentId: string; directProjectNoteIds: string[] }>;
  bindings: Array<{ documentId: string; projectNoteId: string; directlyBound: boolean; inheritedFromProjectIds: string[] }>;
}
export interface DocumentBindingPort {
  read(): Promise<DocumentBindingCatalog>;
  apply(command: DocumentBindingCommand, expected: unknown): Promise<DocumentBindingResult>;
}
function ids(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.length || value.length > 20
    || value.some(id => typeof id !== 'string' || !id.trim() || id !== id.trim() || id.length > 200)
    || new Set(value).size !== value.length) throw new Error(`${label}必须为 1 至 20 个不重复的稳定 ID`);
  return value as string[];
}
export function readDocumentBindingCommand(args: Record<string, unknown>): DocumentBindingCommand {
  if (Object.keys(args).some(key => !['action', 'documentIds', 'projectNoteIds'].includes(key))) throw new Error('未知资料绑定参数');
  if (args.action !== 'bind' && args.action !== 'unbind') throw new Error('action 必须为 bind 或 unbind');
  const command = { action: args.action, documentIds: ids(args.documentIds, '资料'), projectNoteIds: ids(args.projectNoteIds, '项目') };
  if (command.documentIds.length * command.projectNoteIds.length > 50) throw new Error('一次最多调整 50 个资料与项目关联');
  return command as DocumentBindingCommand;
}
function targets(catalog: DocumentBindingCatalog, command: DocumentBindingCommand) {
  const documents = command.documentIds.map(id => {
    const document = catalog.documents.find(item => item.id === id);
    if (!document) throw new Error('部分资料已不存在，请重新查询资料库');
    return document;
  });
  const projects = command.projectNoteIds.map(id => {
    const note = catalog.notes.find(item => item.id === id && item.noteType === 'project');
    if (!note) throw new Error('部分目标项目已不存在，请重新查询项目');
    projectAncestors(note, catalog.notes); // Reject broken or cyclic inheritance, not empty task lists.
    return note;
  });
  return { documents, projects };
}
/** Internal approval state only. Full target notes never enter model-facing query results. */
export function documentBindingApproval(catalog: DocumentBindingCatalog, command: DocumentBindingCommand) {
  const { documents, projects } = targets(catalog, command);
  const ancestors = new Map(projects.flatMap(note => projectAncestors(note, catalog.notes)).map(note => [note.id, note]));
  return {
    scopeId: catalog.scopeId,
    documents: documents.map(doc => ({ id: doc.id, fileName: doc.fileName, fileType: doc.fileType,
      extension: doc.extension, size: doc.size, uploadAt: doc.uploadAt, sourceUrl: doc.sourceUrl })),
    projects: projects.map(note => structuredClone(note)),
    ancestors: [...ancestors.values()].map(note => ({ id: note.id, title: note.title, parentId: note.parentId,
      resources: (note.resources || []).filter(resource => resource.documentId && command.documentIds.includes(resource.documentId)) })),
    directBindings: documents.map(doc => ({ documentId: doc.id, projectNoteIds: directDocumentProjects(catalog.notes, doc.id).sort() })),
  };
}
export function prepareAgentDocumentBindings(catalog: DocumentBindingCatalog, command: DocumentBindingCommand): WorkspaceNoteChange | null {
  const { documents, projects } = targets(catalog, command);
  let projected = catalog.notes;
  const changedIds = new Set<string>();
  for (const document of documents) {
    const currentIds = directDocumentProjects(projected, document.id);
    const desired = new Set(currentIds);
    for (const project of projects) {
      if (command.action === 'bind') desired.add(project.id);
      else desired.delete(project.id);
    }
    const change = prepareDocumentProjectBindings(projected, document, [...desired], currentIds);
    if (change) {
      change.after.forEach(note => changedIds.add(note.id));
      projected = applyWorkspaceNoteChange(projected, change);
    }
  }
  if (!changedIds.size) return null;
  return { kind: 'edit', label: `${command.action === 'bind' ? '绑定' : '解绑'} ${documents.length} 份已有资料与 ${projects.length} 个项目`,
    before: catalog.notes.filter(note => changedIds.has(note.id)), after: projected.filter(note => changedIds.has(note.id)),
    dependencies: [...new Map(projects.flatMap(note => projectAncestors(note, catalog.notes))
      .filter(note => !changedIds.has(note.id)).map(note => [note.id, note])).values()] };
}
function bindingRows(catalog: DocumentBindingCatalog, command: DocumentBindingCommand) {
  const { documents, projects } = targets(catalog, command);
  return documents.flatMap(doc => projects.map(project => ({ documentId: doc.id, projectNoteId: project.id,
    directlyBound: project.resources?.some(resource => resource.documentId === doc.id) === true,
    inheritedFromProjectIds: projectAncestors(project, catalog.notes).slice(1)
      .filter(ancestor => ancestor.resources?.some(resource => resource.documentId === doc.id)).map(ancestor => ancestor.id) })));
}
/** Read metadata only. Preparing/reading this port never parses documents or invokes a model. */
export function createDocumentBindingPort(ports: {
  assertReady(): void;
  scope(): Promise<string>;
  list(): Promise<UploadedDocument[]>;
  notes(): NoteItem[];
  commit(change: WorkspaceNoteChange, scopeId: string, preflight: () => Promise<void>): Promise<{ operationId: string; saved: boolean; changedNoteIds: string[] }>;
  flush(scopeId: string): Promise<void>;
}): DocumentBindingPort {
  const read = async (): Promise<DocumentBindingCatalog> => {
    ports.assertReady();
    const scopeId = await ports.scope(), documents = await ports.list();
    if (scopeId !== await ports.scope()) throw new Error('资料库已切换，请重新查询资料和项目');
    ports.assertReady();
    return { scopeId, documents: structuredClone(documents), notes: structuredClone(ports.notes()) };
  };
  return { read, apply: async (input, expected) => {
    const command = readDocumentBindingCommand(input as unknown as Record<string, unknown>);
    const catalog = await read();
    const approved = canonicalAgentValue(expected);
    const preflight = async () => {
      const latest = await read();
      if (canonicalAgentValue(documentBindingApproval(latest, command)) !== approved) throw new Error('资料、项目或绑定已变化，请重新查询并确认');
    };
    if (canonicalAgentValue(documentBindingApproval(catalog, command)) !== approved) throw new Error('资料、项目或绑定已变化，请重新查询并确认');
    const change = prepareAgentDocumentBindings(catalog, command);
    let operation: { operationId: string; saved: boolean; changedNoteIds: string[] } | undefined;
    if (change) operation = await ports.commit(change, catalog.scopeId, preflight);
    else { await preflight(); await ports.flush(catalog.scopeId); }
    const latest = await read();
    if (latest.scopeId !== catalog.scopeId) throw new Error('资料库已切换，请回到原资料库核对已保存结果');
    const bindings = bindingRows(latest, command);
    const retained = bindings.every(row => row.directlyBound === (command.action === 'bind'));
    return { saved: operation?.saved !== false && retained, unchanged: !change,
      ...(operation ? { operationId: operation.operationId } : {}), changedNoteIds: operation?.changedNoteIds || [], bindings,
      documents: command.documentIds.map(documentId => ({ documentId, directProjectNoteIds: directDocumentProjects(latest.notes, documentId) })) };
  } };
}

export function queryLocalDocumentBindings(catalog: DocumentBindingCatalog, args: Record<string, unknown>) {
  if (Object.keys(args).some(key => !['fileNameContains', 'documentIds', 'projectNoteId', 'offset', 'limit'].includes(key))) throw new Error('未知资料查询参数');
  const offset = args.offset ?? 0, limit = args.limit ?? 20;
  if (!Number.isSafeInteger(offset) || (offset as number) < 0 || !Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 50) throw new Error('分页参数无效');
  if (args.fileNameContains !== undefined && (typeof args.fileNameContains !== 'string' || args.fileNameContains.length > 200)) throw new Error('文件名筛选无效');
  const selected = args.documentIds === undefined ? undefined : new Set(ids(args.documentIds, '资料'));
  const project = args.projectNoteId === undefined ? undefined : catalog.notes.find(note => note.id === args.projectNoteId && note.noteType === 'project');
  if (args.projectNoteId !== undefined && !project) throw new Error('目标项目不存在');
  const effective = project ? projectDocumentBindings(project, catalog.notes) : undefined;
  const query = String(args.fileNameContains || '').trim().toLocaleLowerCase();
  const documents = catalog.documents.filter(doc => (!selected || selected.has(doc.id))
    && (!query || doc.fileName.toLocaleLowerCase().includes(query)) && (!effective || effective.some(row => row.documentId === doc.id)))
    .sort((a, b) => b.uploadAt.localeCompare(a.uploadAt) || a.id.localeCompare(b.id));
  return { total: documents.length, offset, bindingPolicy: { multipleProjects: true, bindMode: 'append' as const, sharedDocumentId: true },
    ...(project ? { project: { id: project.id, title: project.title, path: projectDisplayPath(project, catalog.notes) } } : {}),
    documents: documents.slice(offset as number, (offset as number) + (limit as number)).map(doc => {
      const direct = directDocumentProjects(catalog.notes, doc.id);
      const binding = effective?.find(row => row.documentId === doc.id);
      return { id: doc.id, fileName: doc.fileName, fileType: doc.fileType, category: doc.category, size: doc.size,
        uploadAt: doc.uploadAt, indexable: doc.indexable, parseStatus: doc.parseStatus, status: doc.status,
        bodyIndexProgress: doc.bodyIndexProgress, needsReindex: doc.needsReindex,
        documentGraphProgress: doc.documentGraphProgress,
        ...(doc.status === 'failed' ? { indexError: '正文索引失败，请到资料页核对错误；未将失败报告为完成。' } : {}),
        directProjectCount: direct.length, directProjects: direct.slice(0, 20).map(id => {
          const note = catalog.notes.find(item => item.id === id)!;
          return { id, title: note.title, path: projectDisplayPath(note, catalog.notes) };
        }), ...(direct.length > 20 ? { directProjectsTruncated: true } : {}),
        ...(binding ? { inherited: binding.inherited, boundAtProjectId: binding.projectNoteId, boundAtProjectTitle: binding.projectTitle } : {}) };
    }), ...((offset as number) + (limit as number) < documents.length ? { nextOffset: (offset as number) + (limit as number) } : {}),
    policy: '同一资料可以同时绑定多个项目或不同根计划，追加绑定保留旧关联，共用同一 documentId、原文件和索引。只查询元数据，不读取正文、不解析、不联网；未完成向量化也可以绑定。父项目绑定可被后代继承；未显式绑定且无祖先继承的项目不会自动使用这份资料。' };
}
