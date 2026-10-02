import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parsePlanBom,planUnit,planIdentity,validatePlanRows} from '../lib/oebom.ts';
import {stockProjectsReport,stockProjectsExportRows,type ProjectInput} from '../lib/stock-projects.ts';

// Formato real do OEBOM: aba Stats com "Overseas Factory Use Total" e aba KD com título acima do cabeçalho.
const statsHeader=['Car Number(序号/车号)','SAP(物料编码)','Material Description(物料描述)','零部件名称','Part Name Description(零部件名称)','BYD P/N(零部件编码)','P/N(供应商零部件编号)','Unit(单位)','Total(数量)','Overseas Factory Use Total(海外工厂使用数量)'];
const sheets=()=>({
 '采购明细（总清单）BOM（Master）':[['ignorada']],
 '采购明细（统计表）BOM（Stats）':[statsHeader,
  ['BC22S02-DWB1339','10150047-00','X_密封垫','密封垫','SEALING WASHER','K9-1','',"PCS\nPCS",12,4],
  ['BC22S02-DWB1339','14735641-00','Q114_焊接螺柱','螺柱','Welding stud','Q114','',"PCS\nPCS",5,0],
  ['BC22S02-DWB1339','10297453-00','oil','油','Oil','O-1','',"升\nlitre",3,3],
  ['BC22S02-DWB1339','17742636-00','plate','板','Plate','B12','',"PCS\nPCS",1,1]],
 '变更明细-采购明细（统计表）Chang-BOM（Stats）':[statsHeader,['BC22S02-DWB1339','99999999-00','x','x','x','x','','PCS',1,1]],
 '自制件KD清单 Self-made Part KD list':[['BC22S02-DWB1339-EDRO-0009'],['BC22S02-DWB1339(Brazil60)项目KD件清单'],[],[],
  ['序号','物料编码SAP','零部件编号BYD P/N','零部件名称PartName','零部件英文描述Part Name Description','材料/规格','x','单位Unit','数量Quantity'],
  [0,'17742636-00','B12','板','Rear door plate','','',"PCS\nPCS",2],
  [1,'20535377-00','BC22','骨架','Roof frame','','',"PCS\nPCS",3]],
});

test('OEBOM: lê Stats (uso no Brasil) + KD list; ignora quantidade 0 e abas de mudança',()=>{
 const bom=parsePlanBom('BC22S02-DWB1339_OEBOM_A7_V92026-08-14184419.xlsx',sheets());
 assert.equal(bom.id,'plano:bc22s02-dwb1339');assert.equal(bom.name,'BC22S02 · DWB1339');assert.equal(bom.revision,'A7_V9');
 const by=Object.fromEntries(bom.rows.map(r=>[r.material,r]));
 assert.equal(by['10150047-00'].required,4,'usa Overseas Factory Use, não Total');
 assert.equal(by['14735641-00'],undefined,'0 no Brasil (soldado na China) não entra');
 assert.equal(by['10297453-00'].unit,'L');
 assert.equal(by['17742636-00'].required,2,'mesmo material em Stats e KD: vale a maior quantidade, sem somar');
 assert.equal(by['20535377-00'].required,3);assert.equal(by['99999999-00'],undefined);
 assert.equal(bom.statsRows,3);assert.equal(bom.kdRows,2);
});

test('OEBOM: unidade, modelo/DWB/revisão e validações',()=>{
 assert.equal(planUnit('PCS\nPCS'),'PCS');assert.equal(planUnit('M\nM'),'M');assert.equal(planUnit('KG\nKG'),'KG');assert.equal(planUnit('升\nlitre'),'L');
 assert.deepEqual(planIdentity('BC22S02-DWB1045_OEBOM_A29_V312026-08-14190702.xlsx'),{model:'BC22S02',dwb:'1045',revision:'A29_V31'});
 assert.deepEqual(planIdentity('____BC12S01-DWB1493_OEBOM_A2_V32026-05-27090945.xlsx'),{model:'BC12S01',dwb:'1493',revision:'A2_V3'});
 assert.throws(()=>parsePlanBom('qualquer.xlsx',{Plan1:[['a']]}),/Stats/);
 assert.throws(()=>validatePlanRows([{material:'X',required:1}]),/inválido/);
 assert.throws(()=>validatePlanRows([{material:'10150047-00',required:-1}]),/inválida/);
});

const stock=(rows:any[]):any=>({id:'7000',name:'7000',revision:'',source:'t',rows:rows.map((r,i)=>({id:String(i),center:'BR02',depot:'7000',...r}))});
const plan=(id:string,units:number,rows:any[],role:ProjectInput['role']='active'):ProjectInput=>({id,name:id,revision:'',role,ops:[],rows,units});
const row=(material:string,required:number,unit='PCS')=>({id:material,material,description:'d',unit,required});

test('BOM do plano: demanda = qtd. por ônibus × ônibus restantes; 0 ônibus devolve tudo',()=>{
 const report=stockProjectsReport(stock([
  {material:'10150047-00',unit:'PCS',quantity:100,value:1000},
  {material:'11911717-00',unit:'PCS',quantity:820,value:8200},
  {material:'12060467-00',unit:'PCS',quantity:79,value:790},
  {material:'13000000-00',unit:'PCS',quantity:10,value:100},
 ]),[
  plan('plano:bc10s01-dwb1391',204,[row('10150047-00',1),row('11911717-00',1)]),
  plan('plano:bc22s02-dwb1363',40,[row('11911717-00',5)]),
  plan('plano:bc22s02-dwb1268',0,[row('13000000-00',2)]),
 ]);
 const f=(m:string)=>report.items.find(i=>i.material===m)!;
 assert.equal(f('10150047-00').state,'keep');assert.equal(f('10150047-00').shortfall,104);
 const tubo=f('11911717-00');assert.equal(tubo.demand,404);assert.equal(tubo.returnQty,416);assert.equal(tubo.state,'return_excess');
 assert.deepEqual(tubo.uses.map(u=>[u.perOp,u.units,u.demand,u.basis]),[[1,204,204,'plan'],[5,40,200,'plan']]);
 assert.equal(f('12060467-00').state,'return_all');assert.match(f('12060467-00').reason,/Não aparece em nenhuma BOM/);
 assert.equal(f('13000000-00').state,'return_all');assert.match(f('13000000-00').reason,/não há ônibus restantes/);
 const summary=report.projects.find(p=>p.id==='plano:bc10s01-dwb1391')!;assert.equal(summary.basis,'plan');assert.equal(summary.units,204);
 const out=stockProjectsExportRows(report.items).details.find(d=>d.SAP==='11911717-00')!;
 assert.equal(out['Ônibus restantes (plano)'],204);assert.match(String(out.Base),/ônibus/);
});

test('BOM do plano convive com BOM × OP: prioridade Em produção → Vai entrar',()=>{
 const report=stockProjectsReport(stock([{material:'A-1',unit:'PCS',quantity:30}]),[
  plan('plano:novo',10,[row('A-1',2)],'incoming'),
  {id:'consumo:x',name:'BC22X',revision:'OP',role:'active',ops:['19000000001','19000000002'],rows:[{id:'1',material:'A-1',unit:'PCS',required:5,classification:'C',consumption:{}}]},
 ]);
 const item=report.items[0];
 assert.deepEqual(item.uses.map(u=>[u.projectId,u.demand,u.allocated]),[['consumo:x',10,10],['plano:novo',20,20]]);
 assert.equal(item.returnQty,0);
});
