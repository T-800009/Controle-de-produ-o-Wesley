import test from 'node:test';
import assert from 'node:assert/strict';
import {requestJson} from '../lib/api.ts';

test('JSON válido e POST preservam os dados enviados',async t=>{
 t.mock.method(globalThis,'fetch',async (_url:any,init:any)=>{
  assert.equal(init.method,'POST');
  assert.deepEqual(JSON.parse(init.body),{checked:false});
  return Response.json({ok:true});
 });
 assert.deepEqual(await requestJson('/api/checks',{checked:false}),{ok:true});
});

test('uma resposta HTML não vira uma tela vazia',async t=>{
 t.mock.method(globalThis,'fetch',async()=>new Response('<html>erro</html>',{headers:{'Content-Type':'text/html'}}));
 await assert.rejects(requestJson('/api/data'),/página em vez dos dados/);
});

test('erro do servidor aparece com a mensagem original',async t=>{
 t.mock.method(globalThis,'fetch',async()=>Response.json({error:'Banco indisponível'},{status:503}));
 await assert.rejects(requestJson('/api/data'),/Banco indisponível/);
});

test('sessão expirada tem instrução de recuperação',async t=>{
 t.mock.method(globalThis,'fetch',async()=>new Response('',{status:401}));
 await assert.rejects(requestJson('/api/data'),/Sessão expirada/);
});

test('consulta sem resposta termina por timeout',async t=>{
 t.mock.method(globalThis,'fetch',(_url:any,init:any)=>new Promise<Response>((_,reject)=>{
  init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true});
 }));
 await assert.rejects(requestJson('/api/data',undefined,15),/demorou mais/);
});

test('timeout também limita a leitura do corpo da resposta',async t=>{
 t.mock.method(globalThis,'fetch',async (_url:any,init:any)=>new Response(new ReadableStream({
  start(controller){init.signal.addEventListener('abort',()=>controller.error(init.signal.reason),{once:true});}
 }),{headers:{'Content-Type':'application/json'}}));
 await assert.rejects(requestJson('/api/data',undefined,15),/demorou mais/);
});
