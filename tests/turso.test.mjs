import test from 'node:test';
import assert from 'node:assert/strict';
import {createClient} from '@libsql/client';
import {TursoDatabase,resolveDatabase,tursoUrl} from '../worker/database.ts';

test('provider selection preserves D1 and never falls back after selecting Turso',async()=>{
 const d1={};assert.equal(await resolveDatabase({DB:d1}),d1);
 await assert.rejects(resolveDatabase({DB:d1,DATABASE_PROVIDER:'turso'}),{code:'TURSO_CONFIG'});
 await assert.rejects(resolveDatabase({DATABASE_PROVIDER:'other'}),{code:'DATABASE_CONFIG'});
 assert.equal(tursoUrl('libsql://portal-example.turso.io'),'https://portal-example.turso.io');
 assert.equal(tursoUrl('turso://portal-example.turso.io'),'https://portal-example.turso.io');
 for(const url of ['http://portal.turso.io','https://turso.io.attacker.test','https://user:token@portal.turso.io','https://portal.turso.io/?authToken=secret','file:db'])assert.throws(()=>tursoUrl(url),{code:'TURSO_CONFIG'});
});

test('adapter preserves bound SAP codes, decimals, named columns and affected rows',async()=>{
 const client=createClient({url:':memory:'});const db=new TursoDatabase(client);
 try{
  await db.prepare('CREATE TABLE items(id TEXT PRIMARY KEY,value REAL,note TEXT)').run();
  const statement=db.prepare('INSERT INTO items VALUES(?,?,?)');
  assert.equal((await statement.bind('0000123-00',1.25,"Observação 'teste'").run()).meta.changes,1);
  await statement.bind('0000456-00',2.5,null).run();
  assert.deepEqual(await db.prepare('SELECT * FROM items WHERE id=?').bind('0000123-00').first(),{id:'0000123-00',value:1.25,note:"Observação 'teste'"});
  assert.equal((await db.prepare('UPDATE items SET value=? WHERE id=?').bind(8,'missing').run()).meta.changes,0);
  assert.equal((await db.prepare('UPDATE items SET value=? WHERE id=?').bind(8,'0000123-00').run()).meta.changes,1);
  assert.equal(await db.prepare('SELECT * FROM items WHERE id=?').bind('missing').first(),null);
  assert.throws(()=>statement.bind(undefined),{code:'TURSO_INVALID_VALUE'});
 }finally{client.close();}
});

test('a failed batch rolls back all writes and cross-database batches are refused',async()=>{
 const client=createClient({url:':memory:'});const db=new TursoDatabase(client),other=new TursoDatabase(client);
 try{
  await db.prepare('CREATE TABLE items(id TEXT PRIMARY KEY)').run();
  await assert.rejects(db.batch([db.prepare('INSERT INTO items VALUES(?)').bind('same'),db.prepare('INSERT INTO items VALUES(?)').bind('same')]),{code:'TURSO_QUERY_FAILED'});
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM items').first()).n,0);
  await assert.rejects(db.batch([other.prepare('SELECT 1')]),{code:'TURSO_INVALID_BATCH'});
  assert.deepEqual(await db.batch([]),[]);
 }finally{client.close();}
});

test('an empty remote database cannot activate Turso or fall back to D1',async t=>{
 let requests=0;
 t.mock.method(globalThis,'fetch',async(input,init)=>{
  requests++;const request=new Request(input,init);assert.equal(new URL(request.url).hostname,'portal-example.turso.io');
  const body=await request.json();
  return Response.json({baton:null,base_url:null,results:body.requests.map(part=>({type:'ok',response:part.type==='close'?{type:'close'}:{type:'execute',result:{cols:[],rows:[],affected_row_count:0,last_insert_rowid:null}}}))});
 });
 const env={DATABASE_PROVIDER:'turso',TURSO_DATABASE_URL:'libsql://portal-example.turso.io',TURSO_AUTH_TOKEN:'local-test-token',DB:{prepare(){throw Error('D1 must not run');}}};
 await assert.rejects(resolveDatabase(env),{code:'TURSO_NOT_MIGRATED'});
 assert.ok(requests>0);
});

test('SDK errors cannot expose SQL, data or secrets through public error messages',async()=>{
 const client={execute:async()=>{throw Object.assign(Error('SELECT private_data secret-token'),{code:'SQLITE_ERROR'});}};
 const db=new TursoDatabase(client);
 await assert.rejects(db.prepare('SELECT 1').all(),error=>error.code==='TURSO_QUERY_FAILED'&&!/private_data|secret-token/.test(error.message));
});
