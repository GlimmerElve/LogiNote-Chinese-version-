import type { LocalFileType } from '../types';

/** 取路径末段文件名（含扩展名），前端无 node path 模块，手动拆分 */
export function basename(p: string): string {
  return p.replace(/\\/g, '/').split('/').filter(Boolean).pop() || p;
}

/** 将绝对路径转 file:// URL（Windows 反斜杠→斜杠，按段 encodeURIComponent） */
export function pathToFileUrl(p: string): string {
  const abs = p.replace(/\\/g, '/');
  if (/^[a-zA-Z]:\//.test(abs)) {
    const drive = abs.slice(0, 1).toUpperCase();
    const rest = abs.slice(2);
    const encoded = rest.split('/').map(encodeURIComponent).join('/');
    return `file:///${drive}:/${encoded}`;
  }
  const encoded = abs.split('/').map(encodeURIComponent).join('/');
  return `file://${abs.startsWith('/') ? '' : '/'}${encoded}`;
}

/** 依据扩展名判定本地文件类型（用于 webview 内嵌/兜底决策） */
export function detectLocalFileType(nameOrPath: string): LocalFileType {
  const name = basename(nameOrPath).toLowerCase();
  const ext = name.includes('.') ? (name.split('.').pop() || '') : '';
  if (ext === 'pdf') return 'pdf';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'].includes(ext)) return 'image';
  if (['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac'].includes(ext)) return 'audio';
  if (['mp4', 'webm', 'mkv', 'mov', 'avi', 'm4v'].includes(ext)) return 'video';
  if (['txt', 'md', 'markdown', 'json', 'csv', 'log'].includes(ext)) return 'text';
  if (['html', 'htm', 'xhtml'].includes(ext)) return 'html';
  if (['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp'].includes(ext)) return 'office';
  return 'other';
}