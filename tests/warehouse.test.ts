import {test} from 'node:test';
import assert from 'node:assert/strict';
import {warehouseReport,warehouseExportRows,manualCheckKey} from '../lib/warehouse.ts';
import {shortageReport} from '../lib/shortages.ts';

const bom:any={id:'consumo:teste',name:'BC22',revision:'1339',source:'Teste',ops:['OP1','OP2'],rows:[{id:'1',material:'001-A',description:'Arruela',unit:'PCS',classification:'C',required:5,consumption:{OP1:0,OP2:1}}]};
const stock=(id:string,quantity:number|null,unit='PCS'):any=>({id,rows:[{material:'001-A',unit,quantity,center:'BR02',depot:id}]});
const rows=()=>shortageReport(bom,stock('7000',6),stock('1500',999),stock('2000',2)).allRows;
const complete:any={OP1:{status:'complete',updatedAt:'2026-09-28'}};

test('consolidates demand of two OPs; shared production stock is not used twice',()=>{
 const source=rows(),result=warehouseReport(source).items;
 assert.ok(source.every(row=>row.request===0),'The old independent OP check sees enough stock twice');
 assert.equal(result.length,1);const item=result[0];
 assert.equal(item.demand,9);assert.equal(item.s7000,6);assert.equal(item.covered,6);
 assert.equal(item.request,3);assert.equal(item.transfer,2);assert.equal(item.uncovered,1);assert.equal(item.state,'short');
 assert.deepEqual(item.ops,['OP1','OP2']);assert.equal(item.s1500,999);
 assert.equal(item.covered!+item.transfer!+item.uncovered!,item.demand);
});
test('admin completion removes OP demand, reopening restores it without altering SAP',()=>{
 const source=rows(),snapshot=JSON.stringify(source);
 const closed=warehouseReport(source,complete);
 assert.equal(closed.closedOps,1);assert.equal(closed.items[0].demand,4);assert.equal(closed.items[0].request,0);
 assert.deepEqual(closed.items[0].ops,['OP2']);assert.equal(JSON.stringify(source),snapshot);
 assert.equal(warehouseReport(source,{}).items[0].request,3);
});
test('item OK is excluded only when checked; waiting OP still has its actual demand',()=>{
 const source=rows();const statuses:any={OP1:{status:'waiting',updatedAt:'today'}};
 const checked=warehouseReport(source,statuses,{[manualCheckKey(source[0])]:true});
 assert.equal(checked.checkedItems,1);assert.equal(checked.items[0].demand,4);
 assert.equal(warehouseReport(source,statuses,{[manualCheckKey(source[0])]:false}).items[0].demand,9);
});
test('unknown or inconsistent stock stays unknown, even with large 1500 stock',()=>{
 for(const source of [rows().map(row=>({...row,s7000:null})),rows().map((row,i)=>({...row,s7000:i?3:6}))]){
  const item=warehouseReport(source).items[0];assert.equal(item.request,null);assert.equal(item.state,'review');
 }
 const source=rows().map(row=>({...row,s2000:null}));
 assert.equal(warehouseReport(source).items[0].transfer,null);
 assert.equal(warehouseReport(source,complete).items[0].request,0,'Known 7000 can fully cover without a 2000 reading');
});
test('negative balance is unavailable; 2000 does not become production balance',()=>{
 const item=warehouseReport(rows().map(row=>({...row,s7000:-2,s2000:20}))).items[0];
 assert.equal(item.covered,0);assert.equal(item.request,9);assert.equal(item.transfer,9);assert.equal(item.state,'transfer');
});
test('material and unit are the grouping key; leading zeros stay distinct',()=>{
 const first=rows()[0];
 const items=warehouseReport([first,{...first,material:'1-A'},{...first,unit:'KG'},{...first,op:'OP3',unit:'pcs',classification:'A'}]).items;
 assert.equal(items.length,3);
 const pcs=items.find(item=>item.unit==='PCS'&&item.material==='001-A')!;
 assert.equal(pcs.demand,10);assert.deepEqual(pcs.classes,['A','C']);
});
test('missing MB51 order and unreliable BOM records are not Warehouse requests',()=>{
 const source=shortageReport({...bom,mb51OrderCoverage:{OP1:0,OP2:1}},stock('7000',0),null,stock('2000',1)).allRows;
 const report=warehouseReport(source);
 assert.equal(report.reviewItems,1);assert.equal(report.items[0].demand,4);assert.deepEqual(report.items[0].ops,['OP2']);
});
test('SCRAP that closes the BOM item never becomes a Warehouse request',()=>{
 const source=shortageReport({...bom,ops:['OP2'],scrap:[{Material:'001-A',OP:'OP2',Quantidade:4}]},stock('7000',0),null,stock('2000',0)).allRows;
 assert.equal(warehouseReport(source).items.length,0);
});
test('export gives one shared stock row and exact per-OP quantities without repeating stock',()=>{
 const result=warehouseReport(rows()),output=warehouseExportRows(result.items,{});
 assert.equal(output.totals.length,1);assert.equal(output.totals[0]['Solicitar ao Warehouse (2000)'],3);
 assert.equal(output.totals[0].OPs,'OP1 / OP2');assert.equal(output.details.length,2);
 assert.deepEqual(output.details.map(row=>row['Quantidade a conferir/apontar SAP']),[5,4]);
 assert.ok(output.details.every(row=>!('Saldo 7000' in row)));assert.equal(output.totals[0].SAP,'001-A');
});
test('unit precision is preserved for kg instead of producing fractional rounding leftovers',()=>{
 const source=rows().map((row,i)=>({...row,pending:i?0.2:0.1,unit:'KG',s7000:0.3}));
 const item=warehouseReport(source).items[0];assert.equal(item.demand,0.3);assert.equal(item.request,0);
});
test('all OPs marked complete leaves no requests and keeps every original row',()=>{
 const source=rows();const report=warehouseReport(source,{...complete,OP2:complete.OP1});
 assert.equal(report.closedOps,2);assert.equal(report.items.length,0);assert.equal(source.length,2);
});
