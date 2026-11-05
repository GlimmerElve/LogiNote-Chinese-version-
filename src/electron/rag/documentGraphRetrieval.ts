import type {SavedDocumentGraph} from '../../services/documentGraphTypes';
import {buildDf,bm25Score,tokenize,weightedFusion} from '../hybridSearch';
import {cosineSimilarity} from './embedding';
import {qualifiedGraphNodeId} from './documentGraphStore';
import {entityReadingLabel} from '../../services/documentGraphEntityReading';

/** Native argument entry ranking only. Graph expansion remains in the bounded QA reader. */
export function rankDocumentGraphEntries(graphs: SavedDocumentGraph[], query: string, vector: number[]) {
  const records = graphs.flatMap(g => g.nodes.map(n => ({g,n,id:qualifiedGraphNodeId(g,n.id)})));
  if (!records.length) return [];
  const df=buildDf(records.map(r => r.n.text)), tokens=tokenize(query);
  const avg=records.reduce((s,r) => s+Math.max(1,tokenize(r.n.text).length),0)/records.length;
  const candidates=records.map(r => ({...r,dense:Math.max(0,cosineSimilarity(vector,r.n.embedding)),
    sparse:bm25Score(tokens,r.n.text,df,records.length,avg)})).filter(r => r.dense>=.25 || r.sparse>0);
  const scores=weightedFusion(candidates.map(r => ({id:r.id,dense:r.dense,sparse:r.sparse})),.4);
  const queryText=entityReadingLabel(query).normalize('NFKC').toLocaleLowerCase();
  const entityScore=(r:typeof records[number])=>{
    const matched=(r.g.entities||[]).map(e=>({e,score:e.mentions.some(m=>!m.reference&&queryText.includes(entityReadingLabel(m.quote).normalize('NFKC').toLocaleLowerCase()))?1:
      (e.embedding?Math.max(0,cosineSimilarity(vector,e.embedding)):0)})).filter(x=>x.score>=.45);
    const direct=matched.filter(x=>x.e.mentions.some(m=>m.nodeId===r.n.id));if(direct.length)return Math.max(...direct.map(x=>x.score));
    // One explicit entity-relation hop, never treating pronouns as universal aliases.
    const hits=new Set(matched.map(x=>x.e.id));
    return (r.g.entityRelations||[]).some(e=>(hits.has(e.from)||hits.has(e.to))&&e.evidenceNodeIds.includes(r.n.id))?.5:0;
  };
  const body=new Map(candidates.map(r=>[r.id,scores.get(r.id)||0]));
  return records.map(r=>({docId:r.g.docId,nodeId:r.id,chunkIds:[...new Set(r.n.source.map(s=>s.chunkId))],
    score:body.get(r.id)||0,entityScore:entityScore(r),text:r.n.text}))
    .filter(r=>r.score>0||r.entityScore>0).sort((a,b)=>(b.score+b.entityScore)-(a.score+a.entityScore)).slice(0,24);
}
