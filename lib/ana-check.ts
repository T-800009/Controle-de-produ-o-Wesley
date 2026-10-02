import {normalize,number,type Row} from './materials.ts';
import {anaReader,anaAliases,type AnaSource} from './ana-columns.ts';
import {materialDescription,type MaterialDescription} from './material-description.ts';
import {addCost,costLedger,costReference,currencyCode,type CostLedger,type PriceReference,type PriceSource} from './ana-cost.ts';
export {anaAliases,type AnaSource} from './ana-columns.ts';

export type AnaCoverage='both'|'missing_kob'|'missing_zpp';
export type AnaOrderCoverage={op:string;kobMaterials:number;zppMaterials:number;coverage:AnaCoverage};
export type AnaRecord={
 id:string;op:string;material:string;description:string;unit:string;costClass:string;
 actual:number|null;bom:number|null;difference:number|null;price:number|null;differenceValue:number|null;
 priceSource:PriceSource|null;priceCurrency:string|null;priceEstimated:boolean;priceMethod:string;priceNote:string;
 priceAmount:number|null;priceQuantity:number|null;
 cooisStatus:string;cooisReported:boolean;cooisConfirmation:string;displayDescription:MaterialDescription;completed:boolean;status:'complete'|'shortage'|'excess'|'review'|'incomplete';statusLabel:string;
 coverage:AnaCoverage;actualSeen:boolean;bomSeen:boolean;
 issues:string[];
};
export type AnaDiagnostics={
 kobWithoutMaterial:number;kobWithoutOrder:number;zppWithoutOrder:number;zppWithoutMaterial:number;
 inheritedOrders:number;productHeaders:number;invalidQuantities:number;ignoredHeadersAndTotals:number;
};
export type AnaSummary={
 rows:AnaRecord[];orders:string[];orderCoverage:AnaOrderCoverage[];sourceCounts:Record<AnaSource,number>;diagnostics:AnaDiagnostics;readAt?:string;
};
const text=(value:unknown)=>String(value??'').trim();
// Order numbers may be numbers, SAP text padded with zeroes or Excel text ending in .0.
const orderKey=(value:unknown)=>{const s=text(value).replace(/\.0+$/,'');return /^\d+$/.test(s)?s.replace(/^0+(?=\d)/,''):s.toUpperCase();};
// Preserve punctuation in material IDs: A-1 and A1 are different materials.
const materialKey=(value:unknown)=>text(value).replace(/^(\d+)\.0+$/,'$1').toUpperCase();
const round=(value:number)=>{const rounded=Math.round(value*1e9)/1e9;return Object.is(rounded,-0)?0:rounded;};
const empty=(row:Row)=>Object.values(row).every(value=>value===null||value===undefined||text(value)==='');
const summaryLabel=(value:unknown)=>/^(total|subtotal|totalgeral|grandtotal|overallresult|resultado|resultadofinal|soma)$/.test(normalize(value));
export function anaNumber(value:unknown):number|null{
 if(typeof value!=='string')return number(value);
 let raw=value.trim();
 // SAP text exports can put the minus after the amount. Keep reversals signed.
 if(/^\(.*\)$/.test(raw))raw='-'+raw.slice(1,-1);
 else if(raw.endsWith('-'))raw='-'+raw.slice(0,-1);
 return number(raw);
}

function completionValue(value:unknown){
 const v=normalize(value);if(!v||['nao','no','n','false','0','aberta','aberto','pendente','naofinalizada','naofinalizado'].includes(v))return false;
 if(['sim','s','yes','y','true','1','ok','finalizado','finalizada','concluido','concluida','completo','completa','complete','completed','physicalcomplete','physicallycomplete'].includes(v))return true;
 return /(finalizad|conclu|complete|physicalcomplete|physicallycomplete)/.test(v)&&!/(nao|no|pendente|abert)/.test(v);
}
function makeOrderStates(rows:Row[]){
 const read=anaReader(rows,'COOIS'),states=new Map<string,{status:string;completed:boolean;reported:boolean;confirmation:string}>();
 for(const row of rows){
  const op=orderKey(read.get(row,'Ordem'));if(!op)continue;
  const qty=anaNumber(read.get(row,'Quantidade da ordem')),supplied=anaNumber(read.get(row,'Qtd.fornecida')),good=anaNumber(read.get(row,'Quantidade boa confirmada'));
  const user=text(read.get(row,'Status do usuário')),system=text(read.get(row,'Status do sistema'));
  const status=[user,system].filter(Boolean).join(' · ');
  const completed=completionValue(read.get(row,'Finalizada física'))||(qty!==null&&qty>0&&[supplied,good].some(value=>value!==null&&value>=qty))||/\b(?:CONF|FORN|TECO|CLSD|CLOSED|FINAL|ENCERR|ENTREG)\b/i.test(user+' '+system);
  const previous=states.get(op);
  // Confirmation and delivery/technical closure are independent. Do not infer
  // consumed material from FORN/TECO/CLSD or from physical completion.
  const final=/\b(?:CONF|CNF)\b/i.test(status),partial=/\b(?:PCNF|MCNF)\b/i.test(status);
  const confirmation=final?'Confirmação final na COOIS':partial?'Confirmação parcial na COOIS':good!==null&&good>0?'Quantidade boa confirmada: '+good.toLocaleString('pt-BR'):'';
  states.set(op,{status:[previous?.status,status].filter(Boolean).filter((v,i,a)=>a.indexOf(v)===i).join(' · '),completed:Boolean(previous?.completed||completed),reported:!!(previous?.reported||confirmation),confirmation:previous?.confirmation||confirmation});
 }
 return states;
}
type Aggregate={op:string;material:string;description:string;units:Set<string>;costs:Set<string>;issues:Set<string>;actual:number;bom:number;actualSeen:boolean;bomSeen:boolean;actualInvalid:boolean;bomInvalid:boolean;reportCost:CostLedger;transactionCost:CostLedger;inputCost:CostLedger};

/** SUMIFS by Ordem + Material, exactly as the reference check: KOB1 - ZPP009.
 * Only native Pro. No. groups inherit their order. Never carry a KOB1 material
 * into a labor/cost row, and never use Planning QTY or Issued QTY as BOM QTY.
 */
export function buildAnaCheck(kobRows:Row[],zppRows:Row[],mmRows:Row[]=[],cooisRows:Row[]=[]):AnaSummary{
 const diagnostics:AnaDiagnostics={kobWithoutMaterial:0,kobWithoutOrder:0,zppWithoutOrder:0,zppWithoutMaterial:0,inheritedOrders:0,productHeaders:0,invalidQuantities:0,ignoredHeadersAndTotals:0};
 const records=new Map<string,Aggregate>();
 function aggregate(op:string,material:string){
  const key=JSON.stringify([orderKey(op),materialKey(material)]);
  let value=records.get(key);
  if(!value){value={op:orderKey(op),material:materialKey(material),description:'',units:new Set(),costs:new Set(),issues:new Set(),actual:0,bom:0,actualSeen:false,bomSeen:false,actualInvalid:false,bomInvalid:false,reportCost:costLedger(),transactionCost:costLedger(),inputCost:costLedger()};records.set(key,value);}
  return value;
 }
 const kob=anaReader(kobRows,'KOB1'),zpp=anaReader(zppRows,'ZPP009'),mm=anaReader(mmRows,'MM60');
 const opHeaders=new Set(anaAliases.op.map(normalize)),matHeaders=new Set(anaAliases.material.map(normalize));
 function isHeading(op:string,material:string,description:string){return opHeaders.has(normalize(op))&&matHeaders.has(normalize(material))||summaryLabel(op)||summaryLabel(material)||(!material&&summaryLabel(description));}
 for(const row of kobRows){
  if(empty(row))continue;
  const op=text(kob.get(row,'Ordem')),material=text(kob.get(row,'Material')),description=text(kob.get(row,'Descrição'));
  if(isHeading(op,material,description)){diagnostics.ignoredHeadersAndTotals++;continue;}
  if(!material){diagnostics.kobWithoutMaterial++;continue;}
  if(!op){diagnostics.kobWithoutOrder++;continue;}
  const entry=aggregate(op,material),quantity=anaNumber(kob.get(row,'Qtd.total entrada'));
  entry.actualSeen=true;
  if(quantity===null){entry.actualInvalid=true;entry.issues.add('KOB1: quantidade vazia ou inválida');diagnostics.invalidQuantities++;}
  else entry.actual+=quantity;
  if(kob.header('Valor/MR'))addCost(entry.reportCost,quantity,anaNumber(kob.get(row,'Valor/MR')),kob.get(row,'Moeda do relatório'));
  if(kob.header('Valor/moed.transação'))addCost(entry.transactionCost,quantity,anaNumber(kob.get(row,'Valor/moed.transação')),kob.get(row,'Moeda da transação'));
  if(!entry.description&&description)entry.description=description;
  const unit=text(kob.get(row,'Unidade')).toUpperCase();if(unit)entry.units.add(unit);
  const cost=text(kob.get(row,'Classe de custo'))||text(kob.get(row,'Descrição de custo'));if(cost)entry.costs.add(cost);
 }
 const grouped=normalize(zpp.header('Ordem'))==='prono';
 let currentOrder='';
 for(const row of zppRows){
  // Preserve separators in decoding. An orphan below a separator is reported,
  // rather than silently being attached to the preceding order.
  if(empty(row)){currentOrder='';continue;}
  const explicitOrder=text(zpp.get(row,'Ordem')),material=text(zpp.get(row,'Material')),description=text(zpp.get(row,'Descrição'));
  if(isHeading(explicitOrder,material,description)){currentOrder='';diagnostics.ignoredHeadersAndTotals++;continue;}
  if(explicitOrder)currentOrder=explicitOrder;
  const op=explicitOrder||(grouped?currentOrder:'');
  if(!material){if(!explicitOrder)diagnostics.zppWithoutMaterial++;continue;}
  if(!op){diagnostics.zppWithoutOrder++;continue;}
  const quantity=anaNumber(zpp.get(row,'BOM QTY'));
  // SAP puts the finished product on the group header. It has production
  // Planning/Issued QTY and zero BOM QTY; it is not a component to consume.
  if(grouped&&explicitOrder&&quantity===0&&[zpp.get(row,'Planning QTY'),zpp.get(row,'Issued QTY')].some(value=>(anaNumber(value)??0)>0)){
   diagnostics.productHeaders++;continue;
  }
  if(!explicitOrder)diagnostics.inheritedOrders++;
  const entry=aggregate(op,material);entry.bomSeen=true;
  if(quantity===null){entry.bomInvalid=true;entry.issues.add('ZPP009: BOM QTY vazia ou inválida');diagnostics.invalidQuantities++;}
  else entry.bom+=quantity;
  if(zpp.header('Input Cost'))addCost(entry.inputCost,anaNumber(zpp.get(row,'Actual input of raw material')),anaNumber(zpp.get(row,'Input Cost')),zpp.get(row,'Moeda'));
  if(!entry.description&&description)entry.description=description;
  const unit=text(zpp.get(row,'Unidade')).toUpperCase();if(unit)entry.units.add(unit);
 }
 const prices=new Map<string,PriceReference>(),descriptions=new Map<string,string>(),units=new Map<string,string>();
 for(const row of mmRows){
  const key=materialKey(mm.get(row,'Material'));if(!key)continue;
  const price=anaNumber(mm.get(row,'Preço'));
  const priceUnit=mm.header('Unidade preço')?anaNumber(mm.get(row,'Unidade preço')):1;
  if(!prices.has(key)&&price!==null&&price>=0&&priceUnit!==null&&priceUnit>0&&Number.isFinite(price/priceUnit))prices.set(key,{price:price/priceUnit,currency:currencyCode(mm.get(row,'Moeda')),source:'MM60',estimated:false,method:'Preço MM60 ÷ Unidade preço',amount:price,quantity:priceUnit});
  if(!descriptions.has(key))descriptions.set(key,text(mm.get(row,'Descrição')));
  if(!units.has(key))units.set(key,text(mm.get(row,'Unidade')));
 }
 // Absence of one material is zero for SUMIFS. Absence of an entire order
 // is a coverage gap, not evidence of missing parts. Preserve the formula
 // separately from the verdict so incomplete exports can still be audited.
 const coverageByOrder=new Map<string,AnaOrderCoverage>();
 for(const entry of records.values()){
  const scope=coverageByOrder.get(entry.op)||{op:entry.op,kobMaterials:0,zppMaterials:0,coverage:'both' as AnaCoverage};
  if(entry.actualSeen)scope.kobMaterials++;
  if(entry.bomSeen)scope.zppMaterials++;
  coverageByOrder.set(entry.op,scope);
 }
 for(const scope of coverageByOrder.values())scope.coverage=!scope.kobMaterials?'missing_kob':!scope.zppMaterials?'missing_zpp':'both';
 const orderCoverage=[...coverageByOrder.values()].sort((a,b)=>a.op.localeCompare(b.op));
 const orderStates=makeOrderStates(cooisRows),rows:AnaRecord[]=[];
 for(const [id,entry] of records){
  if(entry.units.size>1)entry.issues.add('Unidades diferentes para o mesmo material/OP');
  const actual=entry.actualSeen&&!entry.actualInvalid?round(entry.actual):null,bom=entry.bomSeen&&!entry.bomInvalid?round(entry.bom):null;
  // No matching posting is zero in SUMIFS. An invalid matched quantity is not.
  const difference=entry.issues.size?null:round((actual??0)-(bom??0));
  const report=costReference(entry.reportCost,'KOB1','Soma Valor/MR ÷ soma Qtd.total entrada');
  const transaction=costReference(entry.transactionCost,'KOB1','Soma Valor/moed.transação ÷ soma Qtd.total entrada');
  // Prefer an explicit MM60 reference, then complete costs for this same OP
  // and material. A transaction currency must never be borrowed by a report
  // amount; their totals and currencies remain separate throughout aggregation.
  const kobPrice=report?.currency?report:transaction?.currency?transaction:report??transaction;
  const reference=prices.get(entry.material)??kobPrice??costReference(entry.inputCost,'ZPP009','Soma Input Cost ÷ soma Actual input of raw material');
  const price=reference?.price??null,differenceValue=difference===null||price===null?null:round(difference*price);
  const priceNote=reference?(reference.estimated?'Estimativa pelo custo observado nesta OP/material. ':'Preço da MM60. ')+(reference.currency?'Moeda '+reference.currency+'.':'Moeda não informada na fonte; fora dos totais por moeda.'):'Sem preço MM60 ou custo com quantidade líquida válida para esta OP/material.';
  const coverage=coverageByOrder.get(entry.op)!.coverage;
  const state=orderStates.get(entry.op),status=coverage!=='both'?'incomplete':difference===null?'review':Math.abs(difference)<1e-9?'complete':difference<0?'shortage':'excess';
  const statusLabel=status==='incomplete'?'Base incompleta':status==='complete'?'Sem diferenças':status==='shortage'?'Consumo abaixo da BOM':status==='excess'?'Consumo acima da BOM':'Dados para conferir';
  const issues=[...entry.issues];
  if(coverage!=='both')issues.unshift(coverage==='missing_kob'?'OP sem lançamentos de material na KOB1 lida. Confira o período e o export completo.':'OP sem componentes na ZPP009 lida. Confira o export da BOM desta OP.');
  rows.push({id,op:entry.op,material:entry.material,description:entry.description||descriptions.get(entry.material)||'',unit:[...entry.units].join(' / ')||units.get(entry.material)||'',costClass:[...entry.costs].join(' · '),actual,bom,difference,price,differenceValue,priceSource:reference?.source??null,priceCurrency:reference?.currency??null,priceEstimated:reference?.estimated??false,priceMethod:reference?.method??'',priceNote,priceAmount:reference?.amount??null,priceQuantity:reference?.quantity??null,cooisStatus:state?.status||'COOIS não encontrada',cooisReported:!!state?.reported,cooisConfirmation:state?.confirmation||'',displayDescription:materialDescription(entry.material,entry.description||descriptions.get(entry.material)||'',descriptions.get(entry.material)),completed:Boolean(state?.completed),coverage,actualSeen:entry.actualSeen,bomSeen:entry.bomSeen,status,statusLabel,issues});
 }
 rows.sort((a,b)=>a.op.localeCompare(b.op)||a.status.localeCompare(b.status)||a.material.localeCompare(b.material));
 return {rows,orders:[...new Set(rows.map(row=>row.op))].sort(),orderCoverage,sourceCounts:{KOB1:kobRows.filter(row=>!empty(row)).length,ZPP009:zppRows.filter(row=>!empty(row)).length,MM60:mmRows.filter(row=>!empty(row)).length,COOIS:cooisRows.filter(row=>!empty(row)).length},diagnostics};
}
