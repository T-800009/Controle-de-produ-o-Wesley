import {test} from 'node:test';import assert from 'node:assert/strict';
import {mb51Columns,columnLetter} from '../lib/mb51-columns.ts';
import {automaticSource} from '../worker/automatic.ts';import {decodeSource} from '../lib/automatic-client.ts';
const payload='google.visualization.Query.setResponse('+JSON.stringify({status:'ok',table:{cols:[{label:'Material'},{label:'Ordem'},{label:'Quantidade'},{label:'Tipo de movimento'}],rows:[{c:[{v:'001-A'},{v:'19000000123'},{v:-3},{v:'261'}]}]}})+');';
test('Worker streams the source and never downloads an Excel workbook',async()=>{const original=globalThis.fetch;try{globalThis.fetch=async url=>{const u=new URL(String(url));assert.equal(u.searchParams.get('sheet'),'MB51');if(u.searchParams.get('range'))return new Response('google.visualization.Query.setResponse('+JSON.stringify({table:{rows:[{c:['Empresa','Centro','Ordem','Centro custo','Elemento PEP','Material','Data','Quantidade','Tipo de movimento'].map(v=>({v}))}]}})+');');assert.equal(u.searchParams.get('tq'),'select C,F,H,I,B');assert.ok(!u.pathname.includes('export'));const r=new Response(payload,{headers:{'Content-Type':'application/javascript'}});r.text=async()=>{throw Error('Worker must not parse the body')};r.arrayBuffer=async()=>{throw Error('Worker must not parse the body')};return r;};const result=await automaticSource('consumo:bc22x-1268',{});assert.equal(result.headers.get('X-Source-Format'),'gviz');assert.equal(await result.text(),payload);}finally{globalThis.fetch=original;}});
test('browser preserves source quantities and material text',()=>assert.deepEqual(decodeSource(payload,'gviz','consumo'),[{Material:'001-A',Ordem:'19000000123',Quantidade:-3,'Tipo de movimento':'261'}]));
test('rejects moved MB51 columns instead of calculating incorrect results',()=>assert.throws(()=>decodeSource(payload.replace('Quantidade','Outra coluna'),'gviz','consumo'),/coluna/));
test('private Sheets columns preserve blank positions',()=>{const body=JSON.stringify({valueRanges:[{values:[['Ordem'],['19000000123'],['19000000124']]},{values:[['Material'],['001-A'],['002-A']]},{values:[['Quantidade'],[],[-2]]},{values:[['Tipo de movimento'],['261'],['261']]}]});const rows=decodeSource(body,'sheets-api','consumo');assert.equal(rows[0].Quantidade,null);assert.equal(rows[1].Quantidade,-2);});
test('Google error responses remain an explicit failure',()=>assert.throws(()=>decodeSource('google.visualization.Query.setResponse({"status":"error"});','gviz','consumo'),/indisponíveis/));

test('detects SAP headers in different positions and preserves signed quantities',()=>{
 const value=JSON.stringify({valueRanges:[{values:[['Material'],['001-A']]},{values:[['Qtd.'],[-8]]},{values:[['Ordem'],['19000000123']]},{values:[['Tipo de movimento'],['261']]}]});
 assert.deepEqual(decodeSource(value,'sheets-api','consumo'),[{Ordem:'19000000123',Material:'001-A',Quantidade:-8,'Tipo de movimento':'261'}]);
});
test('rejects ambiguous quantity headers',()=>{
 const value=JSON.stringify({valueRanges:[{values:[['Quantidade'],[-8]]},{values:[['Qtd.'],[-8]]},{values:[['Ordem'],['19000000123']]}]});
 assert.throws(()=>decodeSource(value,'sheets-api','consumo'));
});
test('missing quantity fails at header discovery before any movement download',async()=>{
 const original=globalThis.fetch;let calls=0;try{
 globalThis.fetch=async()=>{calls++;return new Response('google.visualization.Query.setResponse('+JSON.stringify({table:{rows:[{c:['Empresa','Ordem','Material','Data do documento'].map(v=>({v}))}]}})+');');};
 const response=await automaticSource('consumo:bc22x-1268',{});assert.equal(response.status,422);assert.match(((await response.json()) as {error:string}).error,/Quantidade/);assert.equal(calls,1);
 }finally{globalThis.fetch=original;}
});

test('1500 discovers the seven SAP columns that exist in the source tab',async()=>{
 const original=globalThis.fetch;try{
  globalThis.fetch=async url=>{
   const u=new URL(String(url));
   assert.equal(u.searchParams.get('sheet'),'1500');
   if(u.searchParams.get('range'))return new Response('google.visualization.Query.setResponse('+JSON.stringify({status:'ok',table:{rows:[{c:['Material','Texto breve material','Centro','Depósito','UM básica','Utilização livre','Val.utiliz.livre'].map(v=>({v}))}]}})+');');
   assert.equal(u.searchParams.get('tq'),'select *');
   assert.ok(!u.searchParams.get('tq')!.includes('H'));
   return new Response('google.visualization.Query.setResponse('+JSON.stringify({status:'ok',table:{cols:[{label:'Material'},{label:'Texto breve material'},{label:'Centro'},{label:'Depósito'},{label:'UM básica'},{label:'Utilização livre'},{label:'Val.utiliz.livre'}],rows:[{c:[{v:'001-A'},{v:'Peça'},{v:'BR02'},{v:'1500'},{v:'PCS'},{v:3},{v:12}]}]}})+');',{headers:{'Content-Type':'application/javascript'}});
  };
  const result=await automaticSource('1500',{});assert.equal(result.status,200);assert.match(await result.text(),/001-A/);
 }finally{globalThis.fetch=original;}
});

test('ambiguous quantity and columns beyond Z',()=>{assert.throws(()=>mb51Columns(['Material','Ordem','Quantidade','Qtd.']),/mais de uma/);assert.equal(columnLetter(26),'AA');assert.equal(columnLetter(51),'AZ');});

test('background Worker returns reconciliation, shares short cache and clears it on refresh',{timeout:10_000},async t=>{
 const {Worker}=await import('node:worker_threads');
 const {createRequire}=await import('node:module');
 const require=createRequire(import.meta.url);
 const {build}=require(require.resolve('esbuild',{paths:[require.resolve('wrangler')]}));
 const compiled=await build({entryPoints:[new URL('../lib/automatic-worker.ts',import.meta.url).pathname],bundle:true,platform:'browser',format:'iife',write:false});
 const runtime=`const {parentPort}=require('node:worker_threads');
 globalThis.self={postMessage:value=>parentPort.postMessage(value)};
 globalThis.fetch=async url=>{parentPort.postMessage({fetchUrl:url});return url.includes('scrap')?new Response(JSON.stringify({error:'A aba SCRAP não está disponível.'}),{status:422}):new Response(${JSON.stringify(payload)},{headers:{'X-Source-Format':'gviz'}});};
 parentPort.on('message',data=>self.onmessage({data}));
 ${compiled.outputFiles[0].text}`;
 const worker=new Worker(runtime,{eval:true});t.after(()=>worker.terminate());
 const requests:string[]=[];worker.on('message',value=>{if(value.fetchUrl)requests.push(value.fetchUrl);});
 const base={id:'consumo:test',name:'Teste',revision:'1',source:'teste',ops:['19000000123'],rows:[{material:'001-A',unit:'PCS',required:3}]};
 const call=(id:number)=>new Promise<any>((resolve,reject)=>{
  const handler=(value:any)=>{if(value.id===id){worker.off('message',handler);value.error?reject(Error(value.error)):resolve(value.data);}};
  worker.on('message',handler);worker.once('error',reject);worker.postMessage({id,base});
 });
 const first=await call(1);assert.equal(first.rows[0].consumption['19000000123'],3);
 assert.equal(Object.values(first.mb51Evidence).length,1);await call(2);
 assert.equal(requests.filter(url=>url.includes('consumo')).length,1);
 worker.postMessage({clear:true});await call(3);
 assert.equal(requests.filter(url=>url.includes('consumo')).length,2);
});
