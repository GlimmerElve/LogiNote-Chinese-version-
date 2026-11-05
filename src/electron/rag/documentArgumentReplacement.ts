import { promises as fs } from 'node:fs';
import path from 'node:path';
import { assertGraphDocumentId } from './documentGraphStore';
import { atomicWriteTextFile } from '../atomicWrite';

export function argumentWorkingFile(dir: string, docId: string) {
  assertGraphDocumentId(docId); return path.join(dir, `argument-graph-v5-${docId}.pending.json`);
}
export function argumentRebuildMarker(dir: string, docId: string) {
  assertGraphDocumentId(docId); return path.join(dir, `argument-rebuild-${docId}.json`);
}
export const fileExists = (file: string) => fs.stat(file).then(() => true, error => {
  if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
  throw error;
});
export async function startArgumentReplacement(dir: string, docId: string) {
  // Only work-in-progress is reset. The last active graph remains until publication.
  await atomicWriteTextFile(argumentRebuildMarker(dir, docId), JSON.stringify({ docId, requestedAt: new Date().toISOString() }));
  await fs.rm(argumentWorkingFile(dir, docId), { force: true });
  for(const stage of ['extract','bridge'])await fs.rm(path.join(dir,`argument-response-v5-${docId}-${stage}.json`),{force:true});
}

/** Called only after a complete validated v5 graph has been atomically published.
 * Preserve standalone entity facts, remove old argument text/vectors and old graph copies. */
export async function removeSupersededDocumentArguments(dir: string, docId: string) {
  assertGraphDocumentId(docId);
  const legacy = path.join(dir, `argument-graph-${docId}.json`);
  if (await fileExists(legacy)) {
    const graph = JSON.parse(await fs.readFile(legacy, 'utf8'));
    if (Array.isArray(graph.entities) && graph.entities.length) {
      const nodes = new Map<string, any>((graph.nodes || []).map((n: any) => [n.id, n]));
      // Entity mentions retain original source ranges; old argument nodes/embeddings are not copied.
      await atomicWriteTextFile(path.join(dir, `entity-graph-${docId}.json`), JSON.stringify({
        schemaVersion: 1, docId, sourceFingerprint: graph.sourceFingerprint,
        entities: graph.entities.map((e: any) => ({ id: e.id, name: e.name, embedding: e.embedding,
          mentions: e.mentions.map((m: any) => ({ quote: m.quote, reference: m.reference,
            source: nodes.get(m.nodeId)?.source || [] })) })),
        relations: (graph.entityRelations || []).map((r: any) => ({ from: r.from, to: r.to, predicate: r.predicate,
          evidenceSources: r.evidenceNodeIds.flatMap((id: string) => nodes.get(id)?.source || []) })),
      }));
    }
  }
  const shardFile = path.join(dir, `knowledge-${docId}.json`);
  if (await fileExists(shardFile)) {
    const shard = JSON.parse(await fs.readFile(shardFile, 'utf8'));
    if (shard.docId !== docId || !Array.isArray(shard.argumentUnits) || !Array.isArray(shard.argumentEdges)) throw new Error('argument_replacement_invalid_knowledge_shard');
    if (shard.argumentUnits.length || shard.argumentEdges.length) {
      await atomicWriteTextFile(shardFile, JSON.stringify({ ...shard, argumentUnits: [], argumentEdges: [] }));
    }
  }
  const staging=path.join(dir,'staging',docId);
  if(await fileExists(staging))for(const generation of await fs.readdir(staging,{withFileTypes:true})){
    if(!generation.isDirectory()||generation.isSymbolicLink()||! /^[A-Za-z0-9._-]{1,160}$/u.test(generation.name))continue;
    const file=path.join(staging,generation.name,'knowledge.json');
    if(!await fileExists(file))continue;
    const shard=JSON.parse(await fs.readFile(file,'utf8'));
    if(shard.docId===docId&&Array.isArray(shard.argumentUnits)&&Array.isArray(shard.argumentEdges)&&(shard.argumentUnits.length||shard.argumentEdges.length)){
      await atomicWriteTextFile(file,JSON.stringify({...shard,argumentUnits:[],argumentEdges:[]}));
    }
  }
  await fs.rm(legacy, { force: true });
  const prefix = `argument-graph-v5-${docId}.archive-`;
  for (const name of await fs.readdir(dir)) if (name.startsWith(prefix) && /^[0-9a-f-]{36}\.json$/u.test(name.slice(prefix.length))) {
    await fs.rm(path.join(dir, name), { force: true });
  }
  await fs.rm(argumentWorkingFile(dir, docId), { force: true });
  await fs.rm(argumentRebuildMarker(dir, docId), { force: true });
}
