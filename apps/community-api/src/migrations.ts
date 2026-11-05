import { createHash } from 'node:crypto';
import { readdir,readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { Database } from './db.js';
export const migrationsDirectory=fileURLToPath(new URL('../migrations/',import.meta.url));
export async function applyMigrations(db:Database,directory=migrationsDirectory):Promise<string[]> {
  const files=(await readdir(directory)).filter(file=>/^\d+_[a-z0-9_]+\.sql$/.test(file)).sort();
  return db.transaction(async sql=>{
    await sql.query("SELECT pg_advisory_xact_lock(hashtext(current_schema() || ':community-migrations'))");
    await sql.query('CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
    const applied:string[]=[];
    for(const file of files){
      const body=await readFile(path.join(directory,file),'utf8'),checksum=createHash('sha256').update(body).digest('hex');
      const existing=await sql.query<{checksum:string}>('SELECT checksum FROM schema_migrations WHERE name=$1',[file]);
      if(existing.rows.length){if(existing.rows[0].checksum!==checksum)throw Error(`Applied migration changed: ${file}`);continue;}
      await sql.query(body);await sql.query('INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)',[file,checksum]);applied.push(file);
    }
    return applied;
  });
}
