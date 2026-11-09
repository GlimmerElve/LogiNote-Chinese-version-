import type { ProgressiveLearningApi, ProgressiveCommand, ProgressiveReply, ProgressiveCourse,
  ProgressiveBeginReply, ProgressiveSourcePacket, ProgressiveLease, ProgressiveCheckpoint,
  ProgressivePublication, ProgressiveProgressRequest, ProgressiveNextRequest, ProgressiveRoute, ProgressiveStudyRequest, ProgressiveStudyReply } from './types';

function bridge(): ProgressiveLearningApi {
  const api = typeof window === 'undefined' ? undefined
    : (window as unknown as { electronAPI?: { progressiveLearning?: ProgressiveLearningApi } }).electronAPI?.progressiveLearning;
  if (!api?.command) throw new Error('渐进学习存储接口不可用，请重启更新后的桌面应用。');
  return api;
}
async function command(input: ProgressiveCommand): Promise<ProgressiveReply> { return bridge().command(input); }
export async function loadProgressiveCourse(projectNoteId: string): Promise<ProgressiveCourse | null> {
  return await command({ op: 'load', projectNoteId }) as ProgressiveCourse | null;
}
export async function readProgressivePage(projectNoteId: string, pageId: string): Promise<ProgressiveCourse> {
  return await command({ op: 'read-page', projectNoteId, pageId }) as ProgressiveCourse;
}
export async function patchProgressiveDiagramPage(input: Extract<ProgressiveCommand, { op: 'patch-diagram' }>): Promise<ProgressiveCourse> {
  return await command(input) as ProgressiveCourse;
}
export async function saveProgressiveStudy(projectNoteId: string, request: ProgressiveStudyRequest): Promise<ProgressiveStudyReply> {
  return await command({ op: 'study', projectNoteId, request }) as ProgressiveStudyReply;
}
export async function routeProgressivePage(lease: ProgressiveLease, route: ProgressiveRoute): Promise<ProgressiveBeginReply> {
  return await command({ op: 'route', lease, route }) as ProgressiveBeginReply;
}
export async function beginProgressiveCourse(projectNoteId: string, sourcePackets: ProgressiveSourcePacket[] = []): Promise<ProgressiveBeginReply> {
  return await command({ op: 'begin', projectNoteId, sourcePackets }) as ProgressiveBeginReply;
}
export async function nextProgressivePage(projectNoteId: string, request: ProgressiveNextRequest): Promise<ProgressiveBeginReply> {
  return await command({ op: 'next', projectNoteId, request }) as ProgressiveBeginReply;
}
export async function checkpointProgressiveCourse(lease: ProgressiveLease, checkpoint: ProgressiveCheckpoint): Promise<ProgressiveCourse> {
  return await command({ op: 'checkpoint', lease, checkpoint }) as ProgressiveCourse;
}
export async function publishProgressiveCourse(lease: ProgressiveLease, teaching: ProgressivePublication): Promise<ProgressiveCourse> {
  return await command({ op: 'publish', lease, teaching }) as ProgressiveCourse;
}
export async function saveProgressiveProgress(projectNoteId: string, progress: ProgressiveProgressRequest): Promise<ProgressiveCourse> {
  return await command({ op: 'save-progress', projectNoteId, progress }) as ProgressiveCourse;
}
export async function interruptProgressiveCourse(lease: ProgressiveLease, error?: string): Promise<ProgressiveCourse> {
  return await command({ op: 'interrupt', lease, error }) as ProgressiveCourse;
}
