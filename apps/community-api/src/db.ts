import pg from 'pg';
export type Row = Record<string, unknown>;
export interface QueryResult<R = Row> {rows:R[];rowCount:number|null}
export interface Sql {query<R = Row>(text:string,values?:readonly unknown[]):Promise<QueryResult<R>>}
export interface Database extends Sql {transaction<T>(work:(sql:Sql)=>Promise<T>):Promise<T>;close():Promise<void>}
export function createDatabase(connectionString:string):Database {
  const pool=new pg.Pool({connectionString,max:10,connectionTimeoutMillis:5000,idleTimeoutMillis:10000});
  pool.on('error',()=>{process.stderr.write('community_database_connection_error\n');});
  return {
    async query<R>(text:string,values?:readonly unknown[]){const result=await pool.query(text,values?[...values]:undefined);return {rows:result.rows as R[],rowCount:result.rowCount};},
    async transaction<T>(work:(sql:Sql)=>Promise<T>){
      const client=await pool.connect();
      const sql:Sql={async query<R>(text:string,values?:readonly unknown[]){const result=await client.query(text,values?[...values]:undefined);return {rows:result.rows as R[],rowCount:result.rowCount};}};
      try{await client.query('BEGIN');const result=await work(sql);await client.query('COMMIT');return result;}
      catch(error){await client.query('ROLLBACK');throw error;}
      finally{client.release();}
    },
    close:()=>pool.end(),
  };
}
