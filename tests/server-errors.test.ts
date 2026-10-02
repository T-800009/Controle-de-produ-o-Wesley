import {test} from 'node:test';
import assert from 'node:assert/strict';
import {classifyFailure,serverFailure} from '../worker/server-errors.ts';
import {responseError,pollRetryMs} from '../lib/api.ts';

for(const kind of ['read','write'])test(`D1 daily ${kind} limit is identified even inside the cause`,()=>{
 const error=new Error('D1_ERROR',{cause:new Error(`Your account has exceeded D1's free tier daily row ${kind} limit. Upgrade to a paid plan or wait until tomorrow (midnight UTC) to continue.`)});
 const result=classifyFailure(error,Date.parse('2026-09-28T23:59:50Z'));
 assert.equal(result.code,kind==='read'?'D1_DAILY_READ_LIMIT':'D1_DAILY_WRITE_LIMIT');assert.equal(result.retryAfter,10);
 assert.match(result.message,/cota diária/);
});

test('a schema error is not mislabeled as a quota or missing spreadsheet',()=>{
 const error=new Error('D1_ERROR: no such column: generation');
 assert.equal(classifyFailure(error).code,'D1_SCHEMA_MISMATCH');
 assert.equal(classifyFailure(new Error('D1_ERROR: no such table: op_statuses')).code,'D1_SCHEMA_MISMATCH');
});

test('binding, storage and temporary overload have distinct recovery messages',()=>{
 assert.equal(classifyFailure(new Error('env.DB.prepare is not a function')).code,'D1_BINDING_INVALID');
 assert.equal(classifyFailure(new Error('D1_ERROR: database or disk is full: SQLITE_FULL')).code,'D1_STORAGE_LIMIT');
 assert.equal(classifyFailure(new Error('D1_ERROR: database not found')).code,'D1_NOT_FOUND');
 assert.equal(classifyFailure(new Error('D1_ERROR: database is overloaded')).retryAfter,60);
});

test('server logs correlate the failure without putting raw SQL in the public response',async t=>{
 const logs:unknown[][]=[];t.mock.method(console,'error',(...args:unknown[])=>logs.push(args));
 const response=serverFailure(new Error('D1_ERROR: no such column: private_column SELECT private_payload FROM private_table'),'/api/data');
 const body=await response.json() as any;
 assert.equal(response.status,503);assert.equal(body.code,'D1_SCHEMA_MISMATCH');assert.equal(response.headers.get('Retry-After'),'300');
 assert.doesNotMatch(body.error,/SELECT|private_payload|private_column/);assert.match(body.reference,/^[a-f0-9-]{36}$/);
 assert.match(JSON.stringify(logs),new RegExp(body.reference));
});

test('client respects Retry-After and backs off instead of hitting a failing D1 every five seconds',()=>{
 const response=new Response('',{status:503,headers:{'Retry-After':'3600'}});
 const error=responseError(response,{error:'Limite diário',code:'D1_DAILY_READ_LIMIT'});
 assert.equal(error.code,'D1_DAILY_READ_LIMIT');assert.equal(pollRetryMs(error,1),3_600_000);
 assert.equal(pollRetryMs(Error('offline'),1),30_000);assert.equal(pollRetryMs(Error('offline'),2),60_000);
 assert.equal(pollRetryMs(Error('offline'),9),300_000);
});
