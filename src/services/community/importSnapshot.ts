import type {NoteItem} from '../../types';
/** Protect newly committed imports until a renderer has actually observed their IDs. */
export class CommunityImportFence{
  private readonly pending=new Set<string>();
  observe(before:NoteItem[],after:NoteItem[]){const known=new Set(before.map(note=>note.id));for(const note of after)if(!known.has(note.id)&&note.communityImport)this.pending.add(note.id);}
  merge(requested:NoteItem[],current:NoteItem[]){const seen=new Set(requested.map(note=>note.id)),byId=new Map(current.map(note=>[note.id,note]));const next=[...requested];for(const id of [...this.pending]){if(seen.has(id)){this.pending.delete(id);continue;}const note=byId.get(id);if(note?.communityImport)next.push(note);else this.pending.delete(id);}return next;}
}
