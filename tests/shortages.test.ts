import {test} from 'node:test';
import assert from 'node:assert/strict';
import {shortageReport} from '../lib/shortages.ts';
const material={id:'1',material:'001-A',unit:'PCS',classification:'C',required:5,consumption:{'OP1':0,'OP2':1}};
const bom:any={id:'test',name:'Test',revision:'',source:'',rows:[material],ops:['OP1','OP2']};
const stock=(qty:any,unit='PCS',center='BR02'):any=>({rows:[{material:'001-A',quantity:qty,unit,center}]});
test('COOIS completion and missing order records no longer change BOM x MB51',()=>{
 const plain=shortageReport(bom,stock(0),null);
 for(const coois of [[{op:'OP1',completed:true,physicalFinalized:true}],[]]){
  const result=shortageReport({...bom,coois},stock(0),null);
  assert.deepEqual(result.rows,plain.rows);assert.equal(result.sapPending.length,0);assert.equal(result.reviewRows.length,0);
 }
});
test('looks up the current balance independently for each order',()=>{const r=shortageReport(bom,stock(6),stock(10)).rows;assert.equal(r[0].request,0);assert.equal(r[1].available,6);assert.equal(r[1].request,0);assert.match(r[0].action,/Não precisa solicitar ao 2000/);assert.match(r[1].action,/Não precisa solicitar ao 2000/);});
test('1500 does not automatically cover 7000',()=>assert.equal(shortageReport(bom,stock(0),stock(100)).rows[0].request,5));
test('missing, empty or invalid stock stays unknown',()=>{for(const s of [null,{rows:[]},stock(null),stock(2,'KG')])assert.equal(shortageReport(bom,s as any,stock(0)).rows[0].request,null);});
test('stock from other centers does not cover BR02',()=>assert.equal(shortageReport(bom,stock(10,'PCS','BR01'),null).rows[0].request,5));
test('aggregates same SAP and unit across stock locations',()=>{const s=stock(3);s.rows.push({...s.rows[0],quantity:2});assert.equal(shortageReport(bom,s,null).rows[0].request,0)});
test('incomplete consumption requires review and repeated BOM lines are summed once per SAP',()=>{const b={...bom,rows:[{...material,consumption:{OP1:null,OP2:0}}]};assert.equal(shortageReport(b,stock(10),null).unknown,1);const r=shortageReport({...bom,rows:[material,material]},stock(10),null);assert.equal(r.unknown,0);assert.equal(r.rows.length,2);assert.equal(r.rows[0].required,10);assert.equal(r.rows[0].consumed,0);assert.equal(r.rows[0].request,0);assert.equal(r.rows[1].request,0);});
test('SAP leading zeros are preserved and distinct',()=>{const s=stock(10);s.rows[0].material='1-A';assert.equal(shortageReport(bom,s,null).rows[0].request,5);});
test('negative stock is not available; missing 1500 does not hide known 7000',()=>{const r=shortageReport(bom,stock(-2),null).rows[0];assert.equal(r.available,0);assert.equal(r.request,5);assert.equal(r.s1500,null);});
test('BOM x SAP keeps fully consumed materials out of shortages and exposes them as complete',()=>{const b={...bom,rows:[{...material,consumption:{OP1:5,OP2:5}}]};const r=shortageReport(b,stock(0),null);assert.equal(r.rows.length,0);assert.equal(r.completed.length,2);assert.equal(r.completed[0].pending,0);assert.match(r.completed[0].action,/100% concluído/);});
test('SCRAP PROCESS closes a missing BOM piece and is counted only once',()=>{
 const b={...bom,rows:[{...material,required:5,consumption:{OP1:4,OP2:0}}],ops:['OP1']};
 const r=shortageReport({...b,scrap:[{Material:'001-A',OP:'OP1',Quantidade:1}]},stock(0),null);
 assert.equal(r.rows.length,0);
 assert.equal(r.completed.length,1);
 assert.equal(r.completed[0].consumed,4);
 assert.equal(r.completed[0].consumedWithScrap,5);
 assert.equal(r.completed[0].scrapApplied,1);
});
test('duplicate SCRAP rows do not double the quantity',()=>{
 const b={...bom,rows:[{...material,required:5,consumption:{OP1:4}}],ops:['OP1']};
 const r=shortageReport({...b,scrap:[{Material:'001-A',OP:'OP1',Quantidade:1},{Material:'001-A',OP:'OP1',Quantidade:1}]},stock(0),null);
 assert.equal(r.completed.length,1);
 assert.equal(r.completed[0].consumedWithScrap,5);
 assert.equal(r.completed[0].scrapStatus,'scrap-duplicate');
});

test('consumption above the BOM is attended, not a false review',()=>{
 const b={...bom,rows:[{...material,required:1,consumption:{OP1:2}}],ops:['OP1'],coois:undefined};
 const r=shortageReport(b,stock(0),null);
 assert.equal(r.reviewRows.length,0);
 assert.equal(r.rows.length,0);
 assert.equal(r.completed.length,1);
 assert.equal(r.completed[0].overage,true);
});

test('SCRAP can close a line when MB51 has no reliable quantity',()=>{
 const b={...bom,rows:[{...material,required:1,consumption:{OP1:null}}],ops:['OP1']};
 const r=shortageReport({...b,scrap:[{Material:'001-A',OP:'OP1',Quantidade:1}]},stock(0),null);
 assert.equal(r.reviewRows.length,0);
 assert.equal(r.completed.length,1);
 assert.equal(r.completed[0].consumedWithScrap,1);
});

for(const classification of ['A','B','C'])test(`${classification}: 7000 covers first; 2000 is only a transfer source`,()=>{
 const source={...bom,ops:['OP1'],rows:[{...material,classification,consumption:{OP1:1}}]};
 const cases=[
  {production:6,warehouse:0,request:0,transfer:0,missing:0,state:'covered_7000'},
  {production:0,warehouse:6,request:4,transfer:4,missing:0,state:'transfer_2000'},
  {production:1,warehouse:3,request:3,transfer:3,missing:0,state:'transfer_2000'},
  {production:1,warehouse:1,request:3,transfer:1,missing:2,state:'short_both'},
  {production:0,warehouse:0,request:4,transfer:0,missing:4,state:'short_both'},
  {production:-5,warehouse:2,request:4,transfer:2,missing:2,state:'short_both'},
 ];
 for(const scenario of cases){
  const line=shortageReport(source,stock(scenario.production),stock(999),stock(scenario.warehouse)).rows[0];
  assert.equal(line.consumed,1);assert.equal(line.pending,4,'Stock must not invent a consumption posting');
  assert.equal(line.s7000,scenario.production);assert.equal(line.s2000,scenario.warehouse);
  assert.equal(line.request,scenario.request);assert.equal(line.transferable2000,scenario.transfer);assert.equal(line.uncoveredBoth,scenario.missing);assert.equal(line.stockSituation,scenario.state);
  assert.equal(line.covered+line.transferable2000+line.uncoveredBoth,4,'Every pending unit has one disposition, without double counting');
  if(scenario.request===0)assert.match(line.action,/Não precisa solicitar ao 2000/);
  if(scenario.warehouse>0&&scenario.production===0)assert.doesNotMatch(line.action,/Não precisa solicitar/);
 }
});

test('unknown source balances stay unknown, except an unnecessary 2000 after sufficient 7000',()=>{
 const first=shortageReport(bom,stock(5),null,null).rows[0];assert.equal(first.request,0);assert.equal(first.uncoveredBoth,0);assert.equal(first.stockSituation,'covered_7000');
 for(const warehouse of [null,stock(null),stock(99,'KG')]){
  const line=shortageReport(bom,stock(2),null,warehouse).rows[0];assert.equal(line.request,3);assert.equal(line.transferable2000,null);assert.equal(line.uncoveredBoth,null);assert.equal(line.stockSituation,'check_stock');
 }
 const line=shortageReport(bom,null,null,stock(99)).rows[0];assert.equal(line.request,null);assert.equal(line.s2000,99);assert.equal(line.stockSituation,'check_stock');
});

test('wrong-depot and wrong-unit balances never become production stock',()=>{
 const warehouse={...stock(100),id:'2000'};assert.equal(shortageReport(bom,warehouse,null,warehouse).rows[0].request,null);
 const mixed=stock(2);mixed.rows.push({...mixed.rows[0],quantity:99,depot:'2000'});assert.equal(shortageReport(bom,mixed,null,stock(1)).rows[0].s7000,2);
 const unitMismatch=shortageReport(bom,stock(100,'KG'),null,stock(100)).rows[0];assert.equal(unitMismatch.s7000,null);assert.equal(unitMismatch.request,null);
});

import {joinExcelMB51} from '../lib/excel-mb51.ts';
import {summarizeOpProgress,progressLabel} from '../lib/op-progress.ts';
test('an OP absent from the MB51 is incomplete, not zero consumption and hundreds of shortages',()=>{
 const source={...bom,ops:['19000002315','19000002316'],rows:[{...material,required:5}]};
 const joined=joinExcelMB51(source.rows,source.ops,[{Material:'001-A',Ordem:'19000002315',Quantidade:-5,'Tipo de movimento':261}]);
 assert.equal(joined.rows[0].consumption['19000002316'],0,'Raw SUMIFS is preserved for auditing');
 assert.deepEqual(joined.mb51OrderCoverage,{'19000002315':1,'19000002316':0});
 const report=shortageReport({...source,...joined},stock(0),null,stock(0));
 assert.equal(report.rows.length,0);assert.equal(report.completed.length,1);assert.equal(report.reviewRows.length,1);
 assert.equal(report.reviewRows[0].request,null);assert.equal(report.reviewRows[0].pending,null);assert.match(report.reviewRows[0].action,/sem movimentos 261\/262/);
 const graph=summarizeOpProgress(report.allRows,source.ops);assert.equal(graph[1].pending,0);assert.equal(graph[1].classes.C.percent,null);assert.equal(progressLabel(graph[1].classes.C),'—');
});

test('an actually consumed material stays complete even when both stocks are zero',()=>{
 const source={...bom,ops:['OP1'],rows:[{...material,consumption:{OP1:5}}]};
 const report=shortageReport(source,stock(0),null,stock(0));assert.equal(report.rows.length,0);assert.equal(report.completed[0].request,0);assert.equal(report.completed[0].uncoveredBoth,0);
});
