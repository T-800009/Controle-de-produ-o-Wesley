import {test} from 'node:test';
import assert from 'node:assert/strict';
import {stockProjectsReport,stockProjectsExportRows,projectDemand,stock7000Groups,type ProjectInput} from '../lib/stock-projects.ts';
import {shortageReport} from '../lib/shortages.ts';
import {manualCheckKey} from '../lib/warehouse.ts';

const line=(material:string,required:number|null,unit='PCS',classification='C',extra:any={})=>({id:material+unit,material,description:'Desc '+material,unit,classification,required,consumption:{},...extra});
const stock=(rows:any[]):any=>({id:'7000',name:'Depósito 7000',revision:'',source:'Teste',rows:rows.map((row,i)=>({id:String(i),center:'BR02',depot:'7000',value:null,...row}))});
const project=(id:string,role:ProjectInput['role'],ops:string[],rows:any[],extra:Partial<ProjectInput>={}):ProjectInput=>({id,name:id.toUpperCase(),revision:'REV',role,ops,rows,...extra});
const find=(report:any,material:string)=>report.items.find((item:any)=>item.material===material);

test('material fora de todas as BOMs volta inteiro ao 2000; saldo zero não entra na lista',()=>{
 const report=stockProjectsReport(stock([{material:'X-1',unit:'PCS',quantity:12,value:120},{material:'Z-0',unit:'PCS',quantity:0}]),
  [project('a','active',['OP1'],[line('A-1',1)])]);
 const item=find(report,'X-1');
 assert.equal(item.state,'return_all');assert.equal(item.returnQty,12);assert.equal(item.keep,0);
 assert.equal(item.returnValue,120);assert.equal(report.zeroBalance,1);assert.equal(find(report,'Z-0'),undefined);
 assert.match(item.reason,/Não aparece em nenhuma BOM/);
});

test('mantém a demanda das OPs abertas e devolve só o excedente',()=>{
 const report=stockProjectsReport(stock([{material:'A-1',unit:'PCS',quantity:8,value:80}]),
  [project('a','active',['OP1','OP2'],[line('A-1',2)])]);
 const item=find(report,'A-1');
 assert.equal(item.demand,4);assert.equal(item.keep,4);assert.equal(item.returnQty,4);assert.equal(item.returnValue,40);
 assert.equal(item.state,'return_excess');assert.deepEqual(item.uses[0].openOps,['OP1','OP2']);
 assert.equal(item.keep+item.returnQty,item.balance);
});

test('saldo é distribuído uma vez: primeiro Em produção, depois Vai entrar, mesmo fora da ordem da lista',()=>{
 const report=stockProjectsReport(stock([{material:'A-1',unit:'PCS',quantity:6}]),[
  project('novo','incoming',['N1','N2'],[line('A-1',5)]),
  project('atual','active',['OP1','OP2'],[line('A-1',2)]),
 ]);
 const item=find(report,'A-1');
 assert.deepEqual(item.uses.map((use:any)=>[use.projectId,use.demand,use.allocated]),[['atual',4,4],['novo',10,2]]);
 assert.equal(item.state,'keep');assert.equal(item.returnQty,0);assert.equal(item.shortfall,8);
 assert.match(item.reason,/Ainda faltam 8 PCS/);
});

test('projeto fora da análise não segura saldo, mas aparece como informação',()=>{
 const report=stockProjectsReport(stock([{material:'OLD-1',unit:'KG',quantity:30}]),[
  project('antigo','excluded',['OP1'],[line('OLD-1',10,'KG')]),
  project('novo','incoming',['N1'],[line('NEW-1',1)]),
 ]);
 const item=find(report,'OLD-1');
 assert.equal(item.state,'return_all');assert.equal(item.returnQty,30);assert.equal(item.uses.length,0);
 assert.deepEqual(item.excludedUses.map((use:any)=>use.projectId),['antigo']);
 assert.match(item.reason,/fora da análise \(ANTIGO · REV\)/);
});

test('OP concluída e item OK não geram demanda; OP aguardando continua contando',()=>{
 const rows=[line('A-1',3)];
 const statuses:any={OP1:{status:'complete',updatedAt:'x'},OP2:{status:'waiting',updatedAt:'x'}};
 const checks={[manualCheckKey({op:'OP3',material:'A-1',unit:'PCS'})]:true};
 const report=stockProjectsReport(stock([{material:'A-1',unit:'PCS',quantity:10}]),
  [project('a','active',['OP1','OP2','OP3'],rows,{statuses,checks})]);
 const item=find(report,'A-1');
 assert.equal(item.demand,3);assert.deepEqual(item.uses[0].openOps,['OP2']);assert.equal(item.returnQty,7);
 const summary=report.projects[0];
 assert.equal(summary.closedOps,1);assert.equal(summary.openOps,2);assert.equal(summary.checkedItems,1);
});

test('todas as OPs já consumiram: usado no projeto, mas devolve tudo',()=>{
 const statuses:any={OP1:{status:'complete',updatedAt:'x'}};
 const report=stockProjectsReport(stock([{material:'A-1',unit:'PCS',quantity:5}]),
  [project('a','active',['OP1'],[line('A-1',1)],{statuses})]);
 const item=find(report,'A-1');
 assert.equal(item.state,'return_all');assert.equal(item.uses.length,1);assert.match(item.reason,/não precisam mais/);
});

test('com MB51: desconta o consumo efetivo e trata OP sem movimento como não iniciada',()=>{
 const bom:any={id:'consumo:a',name:'A',revision:'R',source:'t',ops:['OP1','OP2','OP3'],
  mb51OrderCoverage:{OP1:4,OP2:2,OP3:0},
  rows:[line('A-1',4,'PCS','B',{consumption:{OP1:4,OP2:1,OP3:0}})]};
 const consumption=shortageReport(bom,null,null,null).allRows;
 const input=project('a','active',bom.ops,bom.rows,{consumption});
 const report=stockProjectsReport(stock([{material:'A-1',unit:'PCS',quantity:10}]),[input]);
 const item=find(report,'A-1');
 // OP1 atendida (0) + OP2 faltam 3 + OP3 sem MB51 = BOM cheia 4.
 assert.equal(item.demand,7);assert.equal(item.returnQty,3);assert.deepEqual(item.uses[0].openOps,['OP2','OP3']);
 assert.equal(item.uses[0].notStartedOps,1);assert.equal(item.uses[0].basis,'mb51');
 const bomOnly=stockProjectsReport(stock([{material:'A-1',unit:'PCS',quantity:10}]),[{...input,consumption:null}]);
 assert.equal(find(bomOnly,'A-1').demand,12,'Sem MB51 a demanda é a BOM cheia das OPs abertas');
});

test('consumo sem conciliação confiável conta a BOM cheia (lado seguro)',()=>{
 const bom:any={id:'consumo:a',name:'A',revision:'R',source:'t',ops:['OP1'],mb51OrderCoverage:{OP1:3},
  rows:[line('A-1',2,'PCS','C',{consumption:{OP1:null}})]};
 const consumption=shortageReport(bom,null,null,null).allRows;
 const item=find(stockProjectsReport(stock([{material:'A-1',unit:'PCS',quantity:5}]),[project('a','active',['OP1'],bom.rows,{consumption})]),'A-1');
 assert.equal(item.demand,2);assert.equal(item.uses[0].uncertainOps,1);assert.match(item.reason,/sem consumo confiável/);
});

test('unidade diferente, saldo negativo, saldo desconhecido e BOM sem quantidade ficam em Conferir',()=>{
 const report=stockProjectsReport(stock([
  {material:'U-1',unit:'M',quantity:10},
  {material:'N-1',unit:'PCS',quantity:-2},
  {material:'Q-1',unit:'PCS',quantity:null},
  {material:'B-1',unit:'PCS',quantity:4},
 ]),[project('a','active',['OP1'],[line('U-1',1,'PCS'),line('N-1',1),line('Q-1',1),line('B-1',null)])]);
 for(const material of ['U-1','N-1','Q-1','B-1']){
  const item=find(report,material);
  assert.equal(item.state,'review',material);assert.equal(item.returnQty,null,material);
 }
 assert.match(find(report,'U-1').reason,/Unidade do 7000 \(M\) diferente da BOM/);
 assert.equal(report.counts.review,4);
});

test('mesma OP em duas BOMs consideradas conta uma vez',()=>{
 const report=stockProjectsReport(stock([{material:'A-1',unit:'PCS',quantity:10}]),[
  project('r1268','active',['OP1','OP2'],[line('A-1',2)]),
  project('r1339','active',['OP2','OP3'],[line('A-1',2)]),
 ]);
 const item=find(report,'A-1');
 assert.equal(item.demand,6,'OP1+OP2 na 1268 (4) e somente OP3 na 1339 (2)');
 assert.deepEqual(report.projects.find((p:any)=>p.id==='r1339')!.duplicateOps,['OP2']);
 assert.equal(item.returnQty,4);
});

test('linhas repetidas da BOM somam; 7000 soma lotes e ignora outro depósito/centro',()=>{
 const groups=stock7000Groups(stock([
  {material:'A-1',unit:'PCS',quantity:3,value:3},{material:'A-1',unit:'PCS',quantity:2,value:2},
  {material:'A-1',unit:'PCS',quantity:50,depot:'2000'},{material:'A-1',unit:'PCS',quantity:50,center:'BR01'},
 ]));
 assert.equal(groups.length,1);assert.equal(groups[0].balance,5);assert.equal(groups[0].value,5);
 const demand=projectDemand(project('a','active',['OP1'],[line('A-1',1),{...line('A-1',2),id:'dup'}]));
 assert.equal([...demand.demands.values()].find(d=>d.material==='A-1')!.demand,3);
});

test('componente fixo por OP (Tirreno) também é demanda do projeto',()=>{
 const report=stockProjectsReport(stock([{material:'11242550-00',unit:'KG',quantity:40}]),
  [project('a','active',['OP1','OP2'],[line('A-1',1)])]);
 const item=find(report,'11242550-00');
 assert.equal(item.demand,30);assert.equal(item.returnQty,10);
});

test('exportação leva todos os itens e o detalhe por projeto',()=>{
 const report=stockProjectsReport(stock([{material:'A-1',unit:'PCS',quantity:8},{material:'X-1',unit:'PCS',quantity:1}]),[
  project('a','active',['OP1'],[line('A-1',2)]),project('b','excluded',['OP9'],[line('A-1',1)])]);
 const out=stockProjectsExportRows(report.items);
 assert.equal(out.totals.length,2);
 assert.equal(out.details.length,2,'Uso no projeto ativo + informação do projeto fora');
 const a=out.totals.find(row=>row.SAP==='A-1')!;
 assert.equal(a['Devolver ao 2000'],6);assert.equal(a['Manter no 7000'],2);
 assert.match(String(a['Também usado (fora da análise)']),/B · REV/);
});

test('7000 × PROJETOS lê a MB51 e o SCRAP uma única vez para todas as BOMs',async()=>{
 const {readConsumptionMany,clearAutomaticCache}=await import('../lib/automatic-client.ts');
 const gviz=(headers:string[],rows:any[][])=>new Response('google.visualization.Query.setResponse('+JSON.stringify({status:'ok',table:{
  cols:headers.map(label=>({label})),rows:rows.map(values=>({c:values.map(v=>({v}))}))}})+');',{headers:{'X-Source-Format':'gviz','X-Source-Read-At':'2026-09-30T11:00:00Z'}});
 const calls:string[]=[],original=globalThis.fetch;
 clearAutomaticCache();
 globalThis.fetch=(async(input:any)=>{
  const url=new URL(String(input),'https://portal.test');calls.push(url.searchParams.get('id')||'');
  if(url.searchParams.get('id')==='scrap')return Response.json({error:'A aba SCRAP não está disponível.'},{status:422});
  return gviz(['Material','Ordem','Quantidade','Tipo de movimento','Centro'],[['A-1','19000000001',-2,261,'BR02'],['A-1','19000000101',-1,261,'BR02']]);
 }) as any;
 try{
  const results=await readConsumptionMany([
   {id:'consumo:a',name:'A',revision:'1',source:'',ops:['19000000001'],rows:[line('A-1',2)]},
   {id:'consumo:b',name:'B',revision:'2',source:'',ops:['19000000101','19000000102'],rows:[line('A-1',3)]},
   {id:'consumo:c',name:'C',revision:'3',source:'',ops:[],rows:[line('A-1',3)]},
  ] as any);
  assert.deepEqual(calls,['consumo:a','scrap'],'Uma leitura MB51 + uma leitura SCRAP');
  assert.equal(results[0].data!.rows[0].consumption['19000000001'],2);
  assert.deepEqual(results[1].data!.mb51OrderCoverage,{'19000000101':1,'19000000102':0});
  assert.match(results[2].error!,/Cadastre as OPs/,'Erro de uma BOM não derruba as demais');
 }finally{globalThis.fetch=original;clearAutomaticCache();}
});

test('resumo do projeto informa OPs sem movimento na MB51',()=>{
 const bom:any={id:'consumo:n',name:'N',revision:'R',source:'t',ops:['OP1','OP2'],mb51OrderCoverage:{OP1:1,OP2:0},
  rows:[line('A-1',1,'PCS','C',{consumption:{OP1:1,OP2:0}})]};
 const consumption=shortageReport(bom,null,null,null).allRows;
 const report=stockProjectsReport(stock([{material:'A-1',unit:'PCS',quantity:3}]),[project('n','incoming',bom.ops,bom.rows,{consumption})]);
 assert.equal(report.projects[0].notStartedOps,1);assert.equal(find(report,'A-1').demand,1);
});

test('BOM duplicada com as mesmas OPs não reabre OP concluída na outra BOM',()=>{
 const statuses:any={OP1:{status:'complete',updatedAt:'x'}};
 const report=stockProjectsReport(stock([{material:'A-1',unit:'PCS',quantity:10}]),[
  project('original','active',['OP1','OP2'],[line('A-1',2)],{statuses}),
  project('duplicada','active',['OP1','OP2','OP3'],[line('A-1',2)]),
 ]);
 const item=find(report,'A-1');
 // original: OP2 (2) · duplicada: só OP3 (2). OP1 concluída não volta pela cópia.
 assert.equal(item.demand,4);assert.equal(item.returnQty,6);
 const dup=report.projects.find((p:any)=>p.id==='duplicada')!;
 assert.deepEqual(dup.duplicateOps,['OP1','OP2']);assert.equal(dup.openOps,1);
 // Concluída somente na cópia também vale para a original.
 const reverse=stockProjectsReport(stock([{material:'A-1',unit:'PCS',quantity:10}]),[
  project('original','active',['OP1','OP2'],[line('A-1',2)]),
  project('duplicada','active',['OP1'],[line('A-1',2)],{statuses}),
 ]);
 assert.equal(find(reverse,'A-1').demand,2);
});
