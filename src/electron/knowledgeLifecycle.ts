import fs from 'node:fs/promises';
import path from 'node:path';
import { validateKnowledgeLifecycle } from '../services/knowledgeLifecycle';
export const knowledgeLifecyclePath = (root: string) => path.join(root, 'knowledge-lifecycle.json');
export async function readKnowledgeLifecycle(root: string) {
  try { const file = knowledgeLifecyclePath(root); const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8_000_000) throw Error('知识点整理记录不可读取');
    return validateKnowledgeLifecycle(JSON.parse(await fs.readFile(file, 'utf8')));
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return validateKnowledgeLifecycle(null); throw error; }
}
