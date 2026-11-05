import test from 'node:test';
import assert from 'node:assert/strict';
import {pgConnection} from '../src/pgConnection.js';
test('backup tools and empty-target check cannot disagree on connection target',()=>{
  const original=pgConnection('postgresql://tester:synthetic@127.0.0.1:55432/community');
  assert.equal(pgConnection('postgresql://tester:synthetic@127.0.0.1:55432/%63ommunity').identity,original.identity);
  assert.throws(()=>pgConnection('postgresql://tester:synthetic@127.0.0.1:55432/%63ommunity?port=55433'),{code:'invalid_connection'});
  for(const name of ['host','port','user','password','dbname','service'])assert.throws(()=>pgConnection(`postgresql://tester@127.0.0.1/community?${name}=other`),{code:'invalid_connection'});
  assert.notEqual(pgConnection('postgresql://tester@127.0.0.1:55433/community').identity,original.identity);
  assert.throws(()=>pgConnection('postgresql://tester@127.0.0.1/host%3Dother'),{code:'invalid_connection'});
  assert.equal(pgConnection('postgresql://tester@127.0.0.1/community?options=-csearch_path%3Dtest&sslmode=disable').options,'-csearch_path=test');
});
