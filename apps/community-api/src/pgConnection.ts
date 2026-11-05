import {requireValue} from './errors.js';
import type {Sql} from './db.js';
export async function assertEmptyRestoreDatabase(db:Sql){
  // information_schema hides objects the connecting role cannot access.
  // Catalog metadata remains visible, so an unprivileged role cannot make a
  // populated database appear empty merely by using a different login.
  const result=await db.query<{n:string}>(`SELECT count(*)::text AS n FROM (
    SELECT c.oid FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname!~'^pg_' AND n.nspname<>'information_schema'
    UNION ALL SELECT p.oid FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname!~'^pg_' AND n.nspname<>'information_schema'
    UNION ALL SELECT t.oid FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname!~'^pg_' AND n.nspname<>'information_schema'
    UNION ALL SELECT oid FROM pg_catalog.pg_namespace WHERE nspname!~'^pg_' AND nspname NOT IN ('public','information_schema')
    UNION ALL SELECT oid FROM pg_catalog.pg_extension WHERE extname<>'plpgsql'
  ) AS user_objects`);
  requireValue(result.rows[0].n==='0',409,'destination_not_empty','恢复需要独立且为空的数据库。');
}
export function pgConnection(raw:string){
  const url=new URL(raw);requireValue(['postgres:','postgresql:'].includes(url.protocol)&&!!url.hostname,400,'invalid_connection','需要明确的 PostgreSQL 地址。');
  // libpq tools and node-postgres must connect to exactly the same target.
  // Connection query parameters such as ?host= or ?port= would override only one parser.
  for(const key of url.searchParams.keys())requireValue(['options','sslmode'].includes(key),400,'invalid_connection','备份连接只接受 options 和 sslmode 查询参数。');
  requireValue([...url.searchParams.keys()].every(key=>url.searchParams.getAll(key).length===1),400,'invalid_connection','连接参数不能重复。');
  const database=decodeURIComponent(url.pathname.slice(1)),host=url.hostname.toLowerCase().replace(/^\[|\]$/g,''),port=Number(url.port||5432);
  requireValue(/^[A-Za-z_][A-Za-z0-9_-]{0,62}$/.test(database)&&Number.isInteger(port)&&port>0&&port<65536,400,'invalid_connection','请使用明确的专用数据库名称和端口。');
  const sslmode=url.searchParams.get('sslmode')||'disable';requireValue(['disable','allow','prefer','require','verify-ca','verify-full'].includes(sslmode),400,'invalid_connection','sslmode 参数不正确。');
  return {url,database,host,port:String(port),user:decodeURIComponent(url.username),password:decodeURIComponent(url.password),options:url.searchParams.get('options')||'',sslmode,identity:`${host}:${port}/${database}`};
}
