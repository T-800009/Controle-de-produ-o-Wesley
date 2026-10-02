import test from 'node:test';
import assert from 'node:assert/strict';
import {buildAnaCheck,anaNumber} from '../lib/ana-check.ts';
import {anaColumns} from '../lib/ana-columns.ts';
import {decodeAnaSource,readAnaCheck,clearAnaCache} from '../lib/ana-client.ts';
import {automaticAnaSource} from '../worker/automatic.ts';

// Column names and grouping from the native SAP screenshots supplied on 25/09.
const zppHeaders=['WERKS','Pro. No.','SAP No.','客户编号','机种','Description','Planning QTY','Issued QTY','BOM QTY','Alternative Group','Planned input of Raw material','Actual input of raw material','Difference','Input Cost'];
const kobHeaders=['Empresa','Exercício','Período','Ordem','Denominação objeto','Classe de custo','Denom.classe custo','Valor/MR','Moeda do relatório','Qtd.total entrada','Unid.medida lançamento','Material','Texto breve material'];
const zrow=(op:unknown,material:string,bom:unknown,planning:unknown=null,issued:unknown=null)=>Object.fromEntries(zppHeaders.map((header,i)=>[header,['BR02',op,material,null,null,'Componente SAP',planning,issued,bom,'',999,-999,999,999][i]]));
const krow=(op:unknown,material:string,qty:unknown,unit='PCS')=>Object.fromEntries(kobHeaders.map((header,i)=>[header,['BR00',2026,9,op,'CHASSIS',material?'411101':'6431100',material?'CONSUMO':'MO',100,'BRL',qty,unit,material,'Descrição do componente'][i]]));
const gviz=(headers:string[],rows:unknown[][])=>'google.visualization.Query.setResponse('+JSON.stringify({status:'ok',table:{cols:headers.map(label=>({label})),rows:rows.map(c=>({c:c.map(v=>({v}))}))}})+');';
const response=(headers:string[],rows:unknown[][])=>new Response(gviz(headers,rows),{headers:{'X-Source-Format':'gviz','Content-Type':'application/javascript'}});

test('native header resolution follows names, even when the columns move',()=>{
 const columns=anaColumns(zppHeaders,'ZPP009');
 assert.deepEqual(columns.map(c=>[c.field,c.index]),[['Ordem',1],['Material',2],['BOM QTY',8],['Descrição',5],['Planning QTY',6],['Issued QTY',7],['Input Cost',13],['Actual input of raw material',11]]);
 const reversed=anaColumns([...zppHeaders].reverse(),'ZPP009');
 assert.equal(reversed.find(c=>c.field==='BOM QTY')!.name,'BOM QTY');
 assert.equal(anaColumns(kobHeaders,'KOB1').find(c=>c.field==='Unidade')!.index,10);
});

test('native groups assign components to the correct OP without treating the product or labor as a component',()=>{
 const zpp=[zrow(19000002315,'19006834-00',0,1,1),zrow(null,'15875588-00',5),zrow(null,'17329419-00',2),zrow(19000002316,'19006834-00',0,1,1),zrow(null,'15875588-00',5)];
 const kob=[krow(19000002315,'',387,'MIN'),krow('019000002315','15875588-00',5),krow(19000002315,'15875588-00',2),krow(19000002315,'15875588-00','2,000-'),krow(19000002315,'17329419-00',2),krow(19000002316,'15875588-00',4)];
 const result=buildAnaCheck(kob,zpp);
 assert.equal(result.rows.length,3);
 assert.equal(result.rows.filter(r=>r.op==='19000002315').every(r=>r.status==='complete'),true);
 const short=result.rows.find(r=>r.op==='19000002316')!;
 assert.equal(short.difference,-1);assert.equal(short.bom,5);assert.equal(short.actual,4);
 assert.equal(result.rows.some(r=>r.material==='19006834-00'),false);
 assert.equal(result.diagnostics.kobWithoutMaterial,1);assert.equal(result.diagnostics.inheritedOrders,3);assert.equal(result.diagnostics.productHeaders,2);
 assert.equal(result.rows[0].description,'Descrição do componente');
 assert.equal(result.rows[0].differenceValue,null);
});

test('separators, totals and repeated headings cannot leak an order to unrelated materials',()=>{
 const repeated=Object.fromEntries(zppHeaders.map(h=>[h,h]));
 const result=buildAnaCheck([], [zrow(2315,'A',1),zrow(null,'B',1),{},zrow(null,'C',1),zrow(2316,'D',1),zrow('Total','',99),zrow(null,'E',1),zrow(2317,'F',1),repeated,zrow(null,'G',1)]);
 assert.deepEqual(result.rows.map(r=>r.material).sort(),['A','B','D','F']);
 assert.equal(result.diagnostics.zppWithoutOrder,3);
 assert.equal(result.diagnostics.ignoredHeadersAndTotals,2);
});

test('flat exports stay compatible and never borrow an absent OP',()=>{
 const result=buildAnaCheck([{Ordem:2315,Material:'A-1','Qtd.total entrada':1},{Ordem:2315,Material:'A1','Qtd.total entrada':2}], [{Ordem:2315,Material:'A-1','BOM QTY':1},{Ordem:2315,Material:'A1','BOM QTY':2},{Ordem:'',Material:'orphan','BOM QTY':9}]);
 assert.equal(result.rows.length,2);assert.ok(result.rows.every(r=>r.status==='complete'));
 assert.equal(result.diagnostics.zppWithoutOrder,1);
});

test('blank or invalid quantities produce review, never a false shortage or complete status',()=>{
 const result=buildAnaCheck([krow(2315,'A',2),krow(2315,'A',null),krow(2315,'B',2)],[zrow(2315,'A',2),zrow(null,'B','inválida')],[],[{Ordem:2315,'Status do sistema':'TECO'}]);
 assert.ok(result.rows.every(r=>r.status==='review'&&r.difference===null&&r.completed));
 assert.equal(result.diagnostics.invalidQuantities,2);
 assert.equal(anaNumber('1.234,500-'),-1234.5);assert.equal(anaNumber('(2,5)'),-2.5);assert.equal(anaNumber(0),0);
});

test('incompatible units cannot be silently summed into a trusted shortage',()=>{
 const result=buildAnaCheck([krow(2315,'A',1,'KG'),krow(2315,'A',1,'PCS')],[zrow(2315,'A',2)]);
 assert.equal(result.rows[0].status,'review');assert.equal(result.rows[0].difference,null);
});

test('Sheets API column decoding keeps all blank positions and separators',()=>{
 const decoded=decodeAnaSource(JSON.stringify({valueRanges:[{values:[['Pro. No.'],[2315],[],[],[],[2316]]},{values:[['SAP No.'],['A'],['B'],[],['C'],['D']]},{values:[['BOM QTY'],[1],[2],[],[3],[4]]}]}),'sheets-api','ZPP009');
 const result=buildAnaCheck([],decoded);
 assert.deepEqual(result.rows.map(r=>[r.op,r.material,r.bom]),[['2315','A',1],['2315','B',2],['2316','D',4]]);
 assert.equal(result.diagnostics.zppWithoutOrder,1);
});

test('public source streams the native columns without parsing or loading the whole SAP export in the Worker',async()=>{
 const original=globalThis.fetch;
 try{
  globalThis.fetch=async input=>{
   const url=new URL(String(input));
   if(url.searchParams.has('range'))return new Response(gviz(zppHeaders,[zppHeaders]));
   assert.equal(url.searchParams.get('tq'),'select B,C,I,F,G,H,N,L');
   const r=response(['Pro. No.','SAP No.','BOM QTY','Description','Planning QTY','Issued QTY','Input Cost','Actual input of raw material'],[[2315,'PRODUCT',0,'Product',1,1,0,0],[null,'PART',5,'Part',0,0,-20,-2]]);
   r.text=async()=>{throw Error('Do not parse the data in the Worker');};
   return r;
  };
  const result=await automaticAnaSource('ZPP009',{});
  assert.equal(result.status,200);
  const row=buildAnaCheck([],decodeAnaSource(await result.text(),'gviz','ZPP009')).rows[0];
  assert.equal(row.op,'2315');assert.equal(row.price,10);assert.equal(row.differenceValue,-50);assert.equal(row.priceCurrency,null);
 }finally{globalThis.fetch=original;}
});

test('optional MM60/COOIS failures do not block the quantity check or become zero money',async()=>{
 const original=globalThis.fetch;
 try{
  clearAnaCache();
  globalThis.fetch=async input=>{
   const sheet=new URL(String(input),'https://local.test').searchParams.get('sheet');
   if(sheet==='KOB1')return response(kobHeaders,[Object.values({...krow(2315,'PART',5),'Valor/MR':null})]);
   if(sheet==='ZPP009')return response(zppHeaders,[Object.values(zrow(2315,'PRODUCT',0,1,1)),Object.values(zrow(null,'PART',5))]);
   if(sheet==='MM60')return Response.json({error:'Aba não existe'},{status:422});
   throw Error('Network failure');
  };
  const result=await readAnaCheck();
  assert.equal(result.rows[0].status,'complete');assert.equal(result.rows[0].differenceValue,null);
  assert.equal(result.warnings.length,2);
 }finally{clearAnaCache();globalThis.fetch=original;}
});

test('a required source failure cannot be replaced with stale or zero results',async()=>{
 const original=globalThis.fetch;
 try{
  clearAnaCache();globalThis.fetch=async()=>Response.json({error:'ZPP009 indisponível'},{status:422});
  await assert.rejects(readAnaCheck(),/ZPP009 indisponível/);
 }finally{clearAnaCache();globalThis.fetch=original;}
});

test('an entire OP absent from KOB1 is incomplete, while one missing material within a present OP still follows SUMIFS',()=>{
 const result=buildAnaCheck([krow('019000002315','A',2),krow(2316,'',30,'MIN')],
  [zrow(19000002315,'A',2),zrow(null,'B',1),zrow(2316,'A',2),zrow(null,'B',0)]);
 const a=result.rows.find(row=>row.op==='19000002315'&&row.material==='B')!;
 assert.equal(a.status,'shortage');assert.equal(a.difference,-1);assert.equal(a.coverage,'both');
 const absent=result.rows.filter(row=>row.op==='2316');
 assert.ok(absent.every(row=>row.status==='incomplete'&&row.coverage==='missing_kob'));
 assert.equal(absent.find(row=>row.material==='B')!.status,'incomplete','Even zero BOM does not certify an absent order');
 assert.equal(result.orderCoverage.find(row=>row.op==='2316')!.kobMaterials,0,'Labor is not material coverage');
 assert.equal(absent.find(row=>row.material==='A')!.difference,-2,'Literal Excel arithmetic is preserved for audit');
});

test('an order absent from ZPP009 cannot become confirmed excess consumption',()=>{
 const row=buildAnaCheck([krow(2315,'A',5)],[]).rows[0];
 assert.equal(row.status,'incomplete');assert.equal(row.coverage,'missing_zpp');
 assert.equal(row.difference,5);assert.match(row.issues[0],/ZPP009/);
});

test('native Unid.medida lançada header enforces unit compatibility',()=>{
 const rows=[{Ordem:2315,Material:'A','Qtd.total entrada':1,'Unid.medida lançada':'KG'},
  {Ordem:2315,Material:'A','Qtd.total entrada':1,'Unid.medida lançada':'PCS'}];
 const result=buildAnaCheck(rows,[zrow(2315,'A',2)]);
 assert.equal(result.rows[0].status,'review');assert.equal(result.rows[0].difference,null);
});
