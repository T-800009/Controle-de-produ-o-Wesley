import {normalize,type Dataset,type Row} from './materials.ts';
import {consolidateBomRows} from './report.ts';
import {convertScrap,applyScrapConsumption,indexScrap} from './scrap.ts';

const canonical=(value:unknown)=>normalize(String(value??'').trim().replace(/\.0+$/,''));
const key=(row:Row)=>JSON.stringify([canonical(row.material),canonical(row.unit)]);
const round=(value:number)=>Math.round(value*1e9)/1e9;

function stockIndex(data:Dataset|null,depot:string){
 const sums=new Map<string,number|null>(),materials=new Set<string>();
 for(const row of data?.rows||[]){
  if(row.depot&&canonical(row.depot)!==canonical(depot))continue;
  if(row.center&&canonical(row.center)!==canonical('BR02'))continue;
  const material=canonical(row.material);if(!material)continue;
  materials.add(material);
  const k=key(row),previous=sums.get(k);
  sums.set(k,previous===null||!canonical(row.unit)||typeof row.quantity!=='number'||!Number.isFinite(row.quantity)
   ?null:round((previous||0)+row.quantity));
 }
 return (row:Row):number|null=>{
  if(!data?.rows.length||(data.id&&data.id!==depot)||!canonical(row.unit))return null;
  const k=key(row),material=canonical(row.material);
  return sums.has(k)?sums.get(k)!:materials.has(material)?null:0;
 };
}

export function shortageReport(data:Dataset,stock7000:Dataset|null,stock1500:Dataset|null,stock2000:Dataset|null=null){
 const balance7000=stockIndex(stock7000,'7000'),balance2000=stockIndex(stock2000,'2000'),other=stockIndex(stock1500,'1500');
 const scrapRecords=convertScrap(data.scrap||[]);
 const scrapIndex=indexScrap(scrapRecords);
 const result:Row[]=[],completed:Row[]=[],sapPending:Row[]=[],reviewRows:Row[]=[],allRows:Row[]=[];
 const ops=[...new Set((data.ops||[]).map(String))];
 let unknown=0;const unknownByOp:Record<string,number>={};

 // Consolidate the BOM once for all OPs. The previous implementation called
 // orderReport (and therefore rebuilt every material/unit group) once per OP,
 // which multiplied the cost of a large BOM by the number of orders.
 const consolidated=consolidateBomRows(data.rows,ops);

 // Compare the actual BOM and consumption independently of COOIS status.
 for(const op of ops)for(const row of consolidated){
  const consumed=row.consumption?.[op];
  const missingOrder=data.mb51OrderCoverage?.[op]===0;
  const known=!missingOrder&&typeof consumed==='number'&&Number.isFinite(consumed);
  const valid=typeof row.required==='number'&&Number.isFinite(row.required)&&row.required>=0;
  const linePending=known&&valid&&!row.consolidationIssue
   ?Math.max(0,round(row.required-(consumed as number))):null;
  const reportStatus=row.consolidationIssue||!known||!valid?'Dados para conferir':
   consumed!<0?'Estorno · conferir':linePending!>0?'Pendente de conferência':
   consumed!>row.required?'Consumo acima da BOM':'Previsto atendido';
  const reportRow={...row,op,consumed:known?consumed:null,pending:linePending,reportStatus};
  // A SCRAP PROCESS is a consumed piece for this Material + OP.  Apply it
  // before classifying the line so a duplicated scrap movement can close the
  // BOM item instead of becoming a false "conferir" or Warehouse request.
  const rowWithScrap=applyScrapConsumption(reportRow,scrapRecords,scrapIndex);
  // Consumption above the BOM is not a physical shortage. It is common when
  // SAP has a scrap/process posting or the BOM carries a smaller quantity.
  // Keep the excess visible as a warning, but classify the item as attended
  // (green), not as a false "Conferir dados" row.
  const overage=typeof rowWithScrap.required==='number'&&typeof rowWithScrap.consumed==='number'&&rowWithScrap.consumed>rowWithScrap.required;
  const dataIssue=missingOrder||!!rowWithScrap.consolidationIssue||rowWithScrap.pending===null||rowWithScrap.consumed<0||rowWithScrap.consumedWithScrap<0;
  if(dataIssue){
   unknown++;unknownByOp[op]=(unknownByOp[op]||0)+1;
   const action=(missingOrder?'OP sem movimentos 261/262 na MB51 recebida. Confira o período e a extração completa; não é uma falta confirmada.':'')||rowWithScrap.consolidationIssue||
    (rowWithScrap.consumed<0?'Consumo líquido negativo — confira os estornos 262.':
     'Sem cálculo confiável — confira BOM e movimentos da MB51.');
   const review={...rowWithScrap,pending:null,consumptionCoverage:missingOrder?'missing_order':'review',s7000:balance7000(row),s2000:balance2000(row),s1500:other(row),available:null,covered:null,transferable2000:null,uncoveredBoth:null,request:null,stockSituation:'check_stock',completion:'review',completionSource:'MB51',action};
   reviewRows.push(review);allRows.push(review);continue;
  }
  if(rowWithScrap.pending<=0){
   const done={...rowWithScrap,s7000:balance7000(row),s2000:balance2000(row),s1500:other(row),available:null,covered:0,transferable2000:0,uncoveredBoth:0,stockSituation:'none',request:0,completion:'complete',overage,action:overage?`Atendido; o consumo SAP está acima da BOM (${rowWithScrap.consumed} > ${rowWithScrap.required}). Não pedir saldo.`:`MB51${rowWithScrap.scrapQuantity!==null?' + SCRAP':''} confirma 100% concluído do previsto na BOM. Não pedir saldo.`};
   completed.push(done);allRows.push(done);continue;
  }
  const classification=String(rowWithScrap.classification||'').trim().toUpperCase();
  // Confirm that the item belongs to the A/B/C scope before recommending a
  // transfer. All confirmed classes use the same 7000-first stock rule.
  if(!['A','B','C'].includes(classification)){
   unknown++;unknownByOp[op]=(unknownByOp[op]||0)+1;
   const review={...rowWithScrap,s7000:balance7000(row),s1500:other(row),s2000:balance2000(row),available:null,covered:null,transferable2000:null,uncoveredBoth:null,request:null,stockSituation:'check_stock',completion:'review',completionSource:'BOM',action:'Classe A, B ou C ausente na BOM — confira antes de solicitar ao Warehouse.'};
   reviewRows.push(review);allRows.push(review);continue;
  }
  // All classes consult production 7000 first. Stock still held at 2000
  // requires a transfer; it must never be described as already in production.
  const s7000=balance7000(row),s2000=balance2000(row),s1500=other(row);
  const available=s7000===null?null:Math.max(0,s7000);
  const available2000=s2000===null?null:Math.max(0,s2000);
  const covered=available===null?null:Math.min(available,rowWithScrap.pending);
  const request=covered===null?null:round(rowWithScrap.pending-covered);
  // Unknown 2000 cannot block a decision already covered by known 7000.
  const transferable2000=request===0?0:request===null||available2000===null?null:Math.min(request,available2000);
  const uncoveredBoth=request===0?0:request===null||transferable2000===null?null:round(request-transferable2000);
  const stockSituation=request===0?'covered_7000':request===null||uncoveredBoth===null?'check_stock':uncoveredBoth>0?'short_both':'transfer_2000';
  const quantity=(value:number)=>value.toLocaleString('pt-BR',{maximumFractionDigits:3})+' '+row.unit;
  const action=request===null
   ?'Saldo 7000 não confirmado. Confira a leitura antes de definir uma solicitação ao 2000.'
   :request===0
    ?'Tem saldo no 7000. Não precisa solicitar ao 2000. Falta conferir/apontar o consumo no SAP.'
    :available2000===null
     ?`O 7000 não cobre ${quantity(request)}. Confira o saldo 2000 antes de solicitar a transferência.`
     :uncoveredBoth===0
      ?`Solicitar transferência de ${quantity(request)} do 2000 para o 7000. O 2000 tem saldo para essa quantidade.`
      :`O 7000 não cobre ${quantity(request)}. O 2000 permite transferir ${quantity(transferable2000!)}; ainda faltam ${quantity(uncoveredBoth!)} nos dois depósitos. Verificar reposição com o Warehouse.`;
  const pending={...rowWithScrap,s7000,s2000,s1500,coverageBalance:s7000,stockDepot:'7000',available,available2000,covered,request,transferable2000,uncoveredBoth,stockSituation,completion:'pending',action};
  result.push(pending);allRows.push(pending);
 }
 const rows=result,completedRows=completed,sapPendingRows=sapPending,reviewRowsDecorated=reviewRows,allRowsDecorated=allRows;
 const scrapRows=allRowsDecorated.filter(row=>row.scrapStatus&&row.scrapStatus!=='none');
 return {rows,completed:completedRows,sapPending:sapPendingRows,reviewRows:reviewRowsDecorated,allRows:allRowsDecorated,scrapRows,scrapRecords,unknown,unknownByOp,orderStatus:{}};
}
