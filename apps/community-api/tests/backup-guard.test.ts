import test from 'node:test';
import assert from 'node:assert/strict';
import {createTestDatabase} from './helpers.js';
import {assertEmptyRestoreDatabase} from '../src/pgConnection.js';
test('restore refuses existing objects even when role privileges hide them from information_schema',async t=>{
  const fixture=await createTestDatabase('backup_guard');t.after(()=>fixture.cleanup());
  await assert.rejects(fixture.db.transaction(async sql=>{
    await sql.query('SET LOCAL ROLE pg_read_all_settings');
    assert.equal((await sql.query<{n:string}>("SELECT count(*)::text AS n FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema')")).rows[0].n,'0');
    await assertEmptyRestoreDatabase(sql);
  }),{code:'destination_not_empty'});
});
