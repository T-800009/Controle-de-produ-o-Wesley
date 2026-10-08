import {normalize,type Row} from './materials.ts';
import {OP_STATUS_LABELS,type OpStatuses} from './op-status.ts';

const canonical=(value:unknown)=>normalize(String(value??'').trim().replace(/\.0+$/,''));
const round=(value:number)=>Math.round(value*1e9)/1e9;
const quantity=(value:unknown):number|null=>typeof value==='number'&&Number.isFinite(value)?value:null;
export const manualCheckKey=(row:Row)=>[row.op,row.material,row.unit].map(value=>String(value??'').trim()).join('|');
export type WarehouseState='covered'|'transfer'|'short'|'review';
export const WAREHOUSE_LABELS:Record<WarehouseState,string>={covered:'Tem no 7000 · conferir apontamento',transfer:'Solicitar transferência do 2000',short:'Solicitar reposição ao Warehouse',review:'Conferir saldos'};
export type WarehouseItem={
 key:string;material:string;description:string;unit:string;classes:string[];ops:string[];demand:number;
 s7000:number|null;s2000:number|null;s1500:number|null;covered:number|null;request:number|null;
 transfer:number|null;uncovered:number|null;state:WarehouseState;details:Row[];
};

/** One balance per material + unit, across ALL active OPs of the selected BOM.
 * Filters are applied after this aggregation. They must never release and reuse
 * the same 7000 quantity for each selected OP. No stock is actually reserved. */
export function warehouseReport(rows:Row[],statuses:OpStatuses={},checks:Record<string,boolean>={}){
 const groups=new Map<string,WarehouseItem>(),closedOps=new Set<string>();
 let checkedItems=0,reviewItems=0;
 for(const row of rows){
  const op=String(row.op||'');
  if(statuses[op]?.status==='complete'){closedOps.add(op);continue;}
  if(checks[manualCheckKey(row)]){checkedItems++;continue;}
  if(row.completion==='review'){reviewItems++;continue;}
  if(row.completion!=='pending')continue;
  const demand=quantity(row.pending),unit=String(row.unit||'').trim(),material=String(row.material||'').trim();
  if(demand===null||demand<=0||!unit||!material||!op){reviewItems++;continue;}
  const key=JSON.stringify([canonical(material),canonical(unit)]);
  let group=groups.get(key);
  if(!group){
   group={key,material,description:String(row.description||''),unit,classes:[],ops:[],demand:0,
    s7000:quantity(row.s7000),s2000:quantity(row.s2000),s1500:quantity(row.s1500),
    covered:null,request:null,transfer:null,uncovered:null,state:'review',details:[]};
   groups.set(key,group);
  }else{
   // Different or absent balances for the same material/unit are not a second
   // lot of stock. Keep them unknown rather than summing conflicting snapshots.
   for(const field of ['s7000','s2000','s1500'] as const)if(group[field]!==quantity(row[field]))group[field]=null;
  }
  group.demand=round(group.demand+demand);group.details.push(row);
  if(!group.ops.includes(op))group.ops.push(op);
  const cls=String(row.classification||'').trim().toUpperCase();
  if(cls&&!group.classes.includes(cls))group.classes.push(cls);
 }
 const items=[...groups.values()];
 for(const group of items){
  group.ops.sort();group.classes.sort();group.details.sort((a,b)=>String(a.op).localeCompare(String(b.op)));
  group.covered=group.s7000===null?null:Math.min(group.demand,Math.max(0,group.s7000));
  group.request=group.covered===null?null:round(group.demand-group.covered);
  group.transfer=group.request===0?0:group.request===null||group.s2000===null?null:Math.min(group.request,Math.max(0,group.s2000));
  group.uncovered=group.request===null||group.transfer===null?null:round(group.request-group.transfer);
  group.state=group.request===0?'covered':group.uncovered===null?'review':group.uncovered>0?'short':'transfer';
 }
 items.sort((a,b)=>a.material.localeCompare(b.material)||a.unit.localeCompare(b.unit));
 return {items,closedOps:closedOps.size,checkedItems,reviewItems};
}

/** Export the full filtered result, never only the visible page. Per-OP detail
 * carries BOM/consumption/demand only: shared stock is not repeated there. */
export function warehouseExportRows(items:WarehouseItem[],statuses:OpStatuses){
 return {
  totals:items.map(item=>({SAP:item.material,Descrição:item.description,UMB:item.unit,Classes:item.classes.join(' / '),
   'Quantidade a conferir/apontar SAP':item.demand,'Saldo 7000':item.s7000,'Coberto no 7000':item.covered,
   'Solicitar ao Warehouse (2000)':item.request,'Saldo 2000':item.s2000,'Pode transferir do 2000':item.transfer,
   'Reposição além do saldo 2000':item.uncovered,'Saldo 1500 (referência)':item.s1500,
   OPs:item.ops.join(' / '),Situação:WAREHOUSE_LABELS[item.state]})),
  details:items.flatMap(item=>item.details.map(row=>({OP:String(row.op),SAP:item.material,Descrição:item.description,
   Classe:String(row.classification||''),UMB:item.unit,'Qtd. BOM':row.required,'Consumo MB51':row.consumed,
   'SCRAP aplicado':row.scrapApplied??0,'Consumo efetivo':row.consumedWithScrap??row.consumed,
   'Quantidade a conferir/apontar SAP':row.pending,'Status da OP':OP_STATUS_LABELS[statuses[String(row.op)]?.status||'not_started']})))
 };
}

const readAt=(value?:string)=>value&&Number.isFinite(Date.parse(value))?new Date(value).toLocaleString('pt-BR'):'Sem leitura confirmada';
type Source={source?:string;updatedAt?:string}|null|undefined;
type XlsxModule=typeof import('xlsx');
/** Planilha do Warehouse (Total_por_Item, Falta_por_OP e Criterios): a mesma do botão
 * "Baixar planilha para o Lougas" e do anexo do e-mail do GRÁFICO. */
export function warehouseWorkbook(x:XlsxModule,{items,statuses,report,bom,stocks,filter,query='',classLabel,version,title='Resumo para o Warehouse / Lougas'}:{
 items:WarehouseItem[];statuses:OpStatuses;report:{closedOps:number;checkedItems:number;reviewItems:number};
 bom:{name:string;revision:string;source?:string;updatedAt?:string};stocks:Source[];filter:string;query?:string;classLabel:string;version:string;title?:string;
}){
 const book=x.utils.book_new(),output=warehouseExportRows(items,statuses);
 const totals=x.utils.json_to_sheet(output.totals),detail=x.utils.json_to_sheet(output.details);
 totals['!cols']=[18,42,8,10,22,16,18,25,16,24,25,22,55,45].map(wch=>({wch}));
 detail['!cols']=[20,18,42,10,9,16,19,19,20,30,28].map(wch=>({wch}));
 for(const sheet of [totals,detail])if(sheet['!ref'])sheet['!autofilter']={ref:sheet['!ref']};
 x.utils.book_append_sheet(book,totals,'Total_por_Item');
 x.utils.book_append_sheet(book,detail,'Falta_por_OP');
 const criteria=x.utils.aoa_to_sheet([
  [title,version],['BOM ativa',bom.name+' · '+bom.revision],['Gerado em',new Date().toLocaleString('pt-BR')],
  ['MB51',bom.source||'',readAt(bom.updatedAt)],['7000',stocks[0]?.source||'Indisponível',readAt(stocks[0]?.updatedAt)],
  ['2000',stocks[1]?.source||'Indisponível',readAt(stocks[1]?.updatedAt)],['1500 (referência)',stocks[2]?.source||'Indisponível',readAt(stocks[2]?.updatedAt)],
  ['Escopo','Todas as OPs da BOM ativa. Não inclui outras revisões.'],
  ['Consolidação','Material + unidade; saldos contados uma única vez para o total das OPs abertas.'],
  ['Falta SAP','BOM − consumo efetivo MB51/SCRAP, mínimo zero. Diferença de apontamento não comprova falta física.'],
  ['Solicitar do 2000','Máximo(demanda consolidada − disponível 7000, 0).'],
  ['Pode transferir','Mínimo(solicitação, disponível 2000). Reposição = solicitação − pode transferir.'],
  ['1500','Informativo; não abate a solicitação.'],['Sem leitura','Célula vazia/— = saldo desconhecido, nunca zero presumido.'],
  ['Marcações','OP concluída e item OK pelo administrador não entram na solicitação. Os lançamentos SAP não são alterados.'],
  ['Excluídos',`${report.closedOps} OPs concluídas; ${report.checkedItems} itens OK; ${report.reviewItems} itens sem conciliação confiável.`],
  ['Filtros',filter,query],['Classe selecionada',classLabel],['Filtro de OP','Localiza materiais; os totais mantêm a demanda de todas as OPs abertas da BOM.'],
  ['Detalhe por OP','A quantidade é a diferença SAP da OP. Veja o saldo compartilhado e a solicitação somente em Total_por_Item.'],
  ['Reserva','Esta consulta não reserva nem movimenta estoque.'],
 ]);
 criteria['!cols']=[{wch:26},{wch:110},{wch:26}];x.utils.book_append_sheet(book,criteria,'Criterios');
 return book;
}
