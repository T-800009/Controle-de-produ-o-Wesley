import {test} from 'node:test';
import assert from 'node:assert/strict';
import {automaticSource} from '../worker/automatic.ts';
import {decodeSource,readAutomatic,clearAutomaticCache} from '../lib/automatic-client.ts';
import {stockColumns} from '../lib/stock-columns.ts';
import {convert} from '../lib/materials.ts';
import {shortageReport} from '../lib/shortages.ts';

const headers=['Material','Texto breve material','Centro','Depósito','UM básica','Utilização livre','Val.utiliz.livre'];
const wrapped=(body:any)=>'google.visualization.Query.setResponse('+JSON.stringify(body)+');';
const probe=(fields=headers)=>new Response(wrapped({status:'ok',table:{rows:[{c:fields.map(v=>({v}))}]}}));

test('1500 streams its own tab and ignores balances from other depots',async t=>{
 let calls=0;
 t.mock.method(globalThis,'fetch',async (input:RequestInfo|URL)=>{
  const url=new URL(String(input));calls++;
  assert.equal(url.searchParams.get('sheet'),'1500');
  assert.equal(url.searchParams.get('tq'),'select *');
  const response=new Response(wrapped({status:'ok',table:{cols:headers.map(label=>({label})),rows:[
   {c:['0001500-A','Material 1500','BR02','01500.0','PCS',7,21].map(v=>({v}))},
   {c:['0001500-A','Mesmo material','BR02',7000,'PCS',99,297].map(v=>({v}))}
  ]}}));
  response.text=async()=>{throw Error('Stock must remain streamed in the Worker');};return response;
 });
 const response=await automaticSource('1500',{});
 const rows=convert(decodeSource(await response.text(),'gviz','1500'),'1500').rows;
 assert.equal(calls,1);assert.equal(rows.length,1);
 assert.equal(rows[0].material,'0001500-A');assert.equal(rows[0].depot,'1500');assert.equal(rows[0].quantity,7);
});

test('1500 keeps liquid units and does not import another depot',async t=>{
 t.mock.method(globalThis,'fetch',async (input:RequestInfo|URL)=>{
  assert.equal(new URL(String(input)).searchParams.get('sheet'),'1500');
  return new Response(wrapped({status:'ok',table:{cols:headers.map(label=>({label})),rows:[
   {c:['OTC-001','Tirreno','BR02',1500,'KG',15,100].map(v=>({v}))},
   {c:['LIQ-001','Líquido','BR02',1500,'L',2.5,null].map(v=>({v}))}
  ]}}));
 });
 const response=await automaticSource('1500',{});
 const rows=convert(decodeSource(await response.text(),'gviz','1500'),'1500').rows;
 assert.deepEqual(rows.map(row=>[row.material,row.unit,row.quantity,row.depot,row.value]),[
  ['OTC-001','KG',15,'1500',100],['LIQ-001','L',2.5,'1500',null]
 ]);
});

test('private new stock sources accept reordered columns and missing optional values',()=>{
 const cols=[['Quantidade','15,5','0'],['SAP','0001-A','0002-B'],['Unidade','KG','L'],['Descrição','Aditivo','Líquido']];
 const payload=JSON.stringify({valueRanges:cols.map(values=>({values:values.map(v=>[v])}))});
 for(const id of ['1500']){
  const rows=convert(decodeSource(payload,'sheets-api',id),id).rows;
  assert.deepEqual(rows.map(row=>[row.material,row.unit,row.quantity,row.value]),[['0001-A','KG',15.5,null],['0002-B','L',0,null]]);
  assert.equal(rows[0].depot,id==='1500'?'1500':'');
 }
 const invalid=wrapped({status:'error',errors:[{message:'Sheet not found'}]});
 assert.throws(()=>decodeSource(invalid,'gviz','1500'),/indisponíveis/);
 assert.throws(()=>decodeSource(wrapped({table:{cols:[{label:'Material'}],rows:[]}}),'gviz','1500'),/1500.*UM básica/);
});

test('manual refresh reads only the chosen new stock dataset',async t=>{
 clearAutomaticCache();t.after(clearAutomaticCache);
 const calls:string[]=[];
 t.mock.method(globalThis,'fetch',async (input:RequestInfo|URL)=>{
  calls.push(String(input));
  return new Response(wrapped({status:'ok',table:{cols:['Material','UM básica','Utilização livre'].map(label=>({label})),rows:[{c:['0001-A','KG',15].map(v=>({v}))}]}}),{headers:{'X-Source-Format':'gviz'}});
 });
 const base={id:'1500',name:'Depósito 1500',revision:'',source:'',rows:[]};
 const next=await readAutomatic(base);
 assert.deepEqual(calls,['/api/automatic?id=1500']);
 assert.equal(next.source,'Google Sheets · 1500');assert.equal(next.rows[0].quantity,15);
 assert.deepEqual(base.rows,[]);
});
test('2000 with seven columns remains a separate transfer source after 7000',async()=>{
 const original=globalThis.fetch;let calls=0;
 try{
  globalThis.fetch=async input=>{
   calls++;const url=new URL(String(input));assert.equal(url.searchParams.get('sheet'),'2000');
   if(url.searchParams.get('range'))return probe();
   assert.equal(url.searchParams.get('tq'),'select *');
   const response=new Response(wrapped({status:'ok',table:{cols:headers.map(label=>({label})),rows:[{c:['001-A','Peça','BR02',2000,'PCS',4,20].map(v=>({v}))}]}}),{headers:{'Content-Type':'application/javascript'}});
   response.text=async()=>{throw Error('Worker must only stream stock rows');};
   return response;
  };
  const response=await automaticSource('2000',{});assert.equal(response.status,200);assert.equal(calls,1);
  const parsed=decodeSource(await response.text(),'gviz','2000');
  const stock={id:'2000',name:'2000',revision:'',source:'teste',...convert(parsed,'2000')};
  assert.equal(stock.rows[0].quantity,4);
  const bom={id:'test',name:'BOM',revision:'',source:'teste',ops:['OP1'],rows:[{material:'001-A',unit:'PCS',required:5,classification:'A',consumption:{OP1:2}}]};
  const production={...stock,id:'7000',rows:[{...stock.rows[0],depot:'7000',quantity:1}]};
  const report=shortageReport(bom,production,null,stock);
  assert.equal(report.rows[0].s7000,1);assert.equal(report.rows[0].s2000,4);assert.equal(report.rows[0].request,2);assert.equal(report.rows[0].transferable2000,2);assert.equal(report.rows[0].uncoveredBoth,0);
  assert.equal(report.rows[0].pending,3,'Available stock must not change SAP consumption');
 }finally{globalThis.fetch=original;}
});

test('stock headers can move beyond H without a positional query',async()=>{
 const original=globalThis.fetch;const fields=['Texto breve material','Irrelevante','Depósito','Centro','Outra','Outra2','Outra3','UM básica','Utilização livre','Material','Val.utiliz.livre'];
 try{globalThis.fetch=async input=>{
  const url=new URL(String(input));assert.equal(url.searchParams.get('tq'),'select *');assert.equal(url.searchParams.has('range'),false);
  return new Response(wrapped({status:'ok',table:{cols:fields.map(label=>({label})),rows:[{c:['Peça','x',7000,'BR02',0,0,0,'PCS',4,'001-A',20].map(v=>({v}))}]}}));
 };const response=await automaticSource('7000',{});const rows=decodeSource(await response.text(),'gviz','7000');assert.equal(rows[0]['Utilização livre'],4);assert.equal(rows[0].Material,'001-A');assert.equal(Object.hasOwn(rows[0],'Irrelevante'),false);}finally{globalThis.fetch=original;}
});

test('private stock columns preserve empty values and separate depot records',()=>{
 const matrix=[headers,['001-A','Peça','BR02','2000','PCS',0,0],['001-B','Peça B','BR02','2000','KG',null,10],['001-A','Peça','BR02','7000','PCS',99,99]];
 const payload={valueRanges:headers.map((_,i)=>({values:matrix.map(row=>row[i]===null?[]:[row[i]])}))};
 const rows=convert(decodeSource(JSON.stringify(payload),'sheets-api','2000'),'2000').rows;
 assert.equal(rows.length,2);assert.equal(rows[0].quantity,0);assert.equal(rows[1].quantity,null);assert.equal(rows[1].value,10);
});

test('missing stock fields and ambiguous balances stay errors, never invented zeros',()=>{
 const raw=wrapped({status:'ok',table:{cols:['Material','UM básica','Valor'].map(label=>({label})),rows:[]}});
 assert.throws(()=>decodeSource(raw,'gviz','2000'),/2000.*Utilização livre/);
 assert.throws(()=>stockColumns([...headers,'Qtd Livre'],'2000'),/mais de uma/);
});

test('private Worker discovers and streams selected stock columns',async()=>{
 const pair=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
 const key=Buffer.from(await crypto.subtle.exportKey('pkcs8',pair.privateKey)).toString('base64');
 const env={GOOGLE_SERVICE_ACCOUNT_JSON:JSON.stringify({client_email:'stock-test@example.invalid',private_key:`-----BEGIN PRIVATE KEY-----\n${key}\n-----END PRIVATE KEY-----`})};
 const original=globalThis.fetch;
 try{globalThis.fetch=async(input,init)=>{
  const url=new URL(String(input));if(url.hostname==='oauth2.googleapis.com')return Response.json({access_token:'stock-token',expires_in:3600});
  assert.equal(new Headers(init?.headers).get('Authorization'),'Bearer stock-token');
  if(!url.pathname.endsWith('batchGet'))return Response.json({values:[headers]});
  assert.deepEqual(url.searchParams.getAll('ranges'),['A','B','C','D','E','F','G'].map(column=>`'2000'!${column}:${column}`));
  const result=Response.json({valueRanges:[]});result.json=async()=>{throw Error('Worker must stream');};return result;
 };const response=await automaticSource('2000',env);assert.equal(response.status,200);assert.equal(response.headers.get('X-Source-Format'),'sheets-api');}finally{globalThis.fetch=original;}
});
