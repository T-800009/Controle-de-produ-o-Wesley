import {number,normalize,type Row} from './materials.ts';
import {sapKey,orderKey,unitKey,movementKey,documentYear,type MovementEvidence} from './mb51-evidence.ts';
const text=(value:unknown)=>String(value??'').trim();
const round=(value:number)=>Math.round(value*1e9)/1e9;

/** SAP Material + Ordem is authoritative; NEW COD is only a fallback.
 * Header accessors are compiled once instead of normalizing every cell name
 * for every movement. Consumption is 261 minus 262, independent of depot. */
export function joinExcelMB51(bom:Row[],ops:string[],movements:Row[]){
 if(!ops.length)throw Error('Cadastre as OPs deste modelo na BOM do site.');
 if(!movements.length)throw Error('MB51 vazia: não é possível confirmar o consumo.');
 const headers=Object.keys(movements[0]),normalized=headers.map(normalize);
 const column=(aliases:string[],required=false)=>{
  const key=aliases.map(normalize).map(alias=>normalized.indexOf(alias)).find(index=>index>=0);
  if(key===undefined&&required)throw Error('Coluna necessária na MB51: '+aliases[0]);
  const name=key===undefined?'':headers[key];return (row:Row)=>name?row[name]:undefined;
 };
 const materialValue=column(['Material','SAP','Código SAP','Código','Part Number'],true);
 const opValue=column(['Ordem','Ordem de produção','OP','Order'],true);
 const qtyValue=column(['Quantidade em UM básica','Qtd.em UM básica','Qtd. em UM básica','Quantidade em UMB','Qtd. em UMB','Quantidade','Qtd.','Qtd','Quantity'],true);
 const typeValue=column(['Tipo de movimento','Tipo movimento','Tipo mov.','Tipo de mov.','Tipo movim.','Mov. tipo','TMv','Mvt','MvT','Movement type','Tipo de movimiento'],true);
 const centerValue=column(['Centro','Plant']);
 const unitValue=column(['UM básica','UMB','Unidade de medida básica','Unidade','Base Unit of Measure']);
 const depotValue=column(['Depósito','Storage location','SLoc']);
 const docValue=column(['Documento material','Doc.material','Documento de material','Material Document']);
 const yearValue=column(['Ano doc.material','Ano do documento material','Ano do documento','Material Doc. Year']);
 const itemValue=column(['Item doc.material','Item do documento material','Item material document','Material Doc.Item']);
 const dateValue=column(['Data do documento','Document Date']);
 const postingDateValue=column(['Data de lançamento','Posting Date']);
 const formulaValue=column(['NEW COD','New Cod','Chave material OP','Chave material + OP','Material + Ordem','Material/Ordem']);
 const hasFormulaKey=headers.some(header=>['newcod','chavematerialop','materialordem'].includes(normalize(header)));
 const allowed=new Set(ops.map(orderKey));
 const resolveOrder=(value:unknown)=>{
  const exact=orderKey(value);if(allowed.has(exact))return exact;
  if(/^\d{1,6}$/.test(exact)){const candidates=[...allowed].filter(op=>op.endsWith(exact));if(candidates.length===1)return candidates[0];}
  return null;
 };
 const bomUnits=new Map<string,Set<string>>();
 for(const row of bom){const key=sapKey(row.material),units=bomUnits.get(key)||new Set<string>();if(row.unit)units.add(unitKey(row.unit));bomUnits.set(key,units);}
 // Most exports have Material and Ordem: never allocate the entire BOM × OP
 // fallback matrix unless a reduced NEW COD row actually needs it.
 let formulaPairs:Map<string,{material:string;op:string}>|undefined;
 const resolveFormula=(raw:string)=>{
  if(!formulaPairs){formulaPairs=new Map();for(const material of bomUnits.keys())for(const op of allowed){formulaPairs.set(material+op,{material,op});formulaPairs.set(op+material,{material,op});}}
  return formulaPairs.get(raw);
 };
 const coverage=new Map<string,number>(),sums=new Map<string,number>(),invalid=new Set<string>();
 const seen=new Map<string,{signature:string;key:string}>();
 const evidence:Record<string,MovementEvidence>={};
 let matched=0,ignored=0,duplicates=0,duplicateConflicts=0,formulaFallbacks=0;
 for(const row of movements){
  const rawOrder=text(opValue(row)),rawMaterial=text(materialValue(row)),formula=sapKey(formulaValue(row));
  let material=sapKey(rawMaterial),op:string|null=null;
  if(rawOrder&&rawMaterial){
   op=resolveOrder(rawOrder);if(!op){ignored++;continue;}
   if(hasFormulaKey&&formula&&formula!==material+op&&formula!==op+material)formulaFallbacks++;
  }else if(!rawOrder&&!rawMaterial&&formula){const pair=resolveFormula(formula);if(pair){material=pair.material;op=pair.op;}}
  if(!material||!op){ignored++;continue;}
  const center=text(centerValue(row));if(center&&sapKey(center)!=='br02'){ignored++;continue;}
  const type=text(typeValue(row)).replace(/\.0+$/,'');
  if(type&&type!=='261'&&type!=='262'){ignored++;continue;}
  const key=movementKey(material,op);
  const ev=evidence[key]||(evidence[key]={issued:0,reversed:0,net:0,count:0,duplicates:0,issue:'',depots:[],units:[],documents:[]});
  if(!type){invalid.add(key);ev.issue='Tipo de movimento ausente em um lançamento.';continue;}
  coverage.set(op,(coverage.get(op)||0)+1);
  const quantity=number(qtyValue(row)),amount=quantity===null?null:Math.abs(quantity),signed=amount===null?null:type==='261'?amount:-amount;
  const unit=text(unitValue(row)),depot=text(depotValue(row)).replace(/\.0+$/,''),date=text(dateValue(row))||text(postingDateValue(row));
  const document=text(docValue(row)),year=text(yearValue(row))||documentYear(date),item=text(itemValue(row));
  const signature=JSON.stringify([material,op,type,sapKey(center),unitKey(unit),signed]);
  if(document&&year&&item){
   const docKey=JSON.stringify([sapKey(document),sapKey(year),sapKey(item)]),previous=seen.get(docKey);
   if(previous){
    if(previous.signature===signature){duplicates++;ev.duplicates++;}
    else{invalid.add(previous.key);invalid.add(key);duplicateConflicts++;ev.issue='Mesmo documento/ano/item com valores diferentes.';if(evidence[previous.key])evidence[previous.key].issue=ev.issue;}
    continue;
   }
   seen.set(docKey,{signature,key});
  }
  ev.count++;if(depot&&!ev.depots.includes(depot))ev.depots.push(depot);if(unit&&!ev.units.includes(unit))ev.units.push(unit);
  if(ev.documents.length<5)ev.documents.push({document,year,item,type,quantity:signed,depot,date});
  if(amount===null){invalid.add(key);ev.issue='Quantidade ausente ou inválida na MB51.';continue;}
  const expected=bomUnits.get(material);
  if((expected?.size||0)>1||new Set(ev.units.map(unitKey)).size>1){invalid.add(key);ev.issue='Há unidades básicas diferentes para o mesmo material. Confira a BOM e a MB51 antes de somar.';continue;}
  if(unit&&expected?.size&&!expected.has(unitKey(unit))){invalid.add(key);ev.issue=`Unidade MB51 (${unit}) incompatível com a unidade da BOM. Não há conversão automática.`;continue;}
  if(type==='261')ev.issued+=amount;else ev.reversed+=amount;
  sums.set(key,(sums.get(key)||0)+signed!);matched++;
 }
 for(const ev of Object.values(evidence)){ev.issued=round(ev.issued);ev.reversed=round(ev.reversed);ev.net=round(ev.issued-ev.reversed);}
 const rows=bom.map(row=>({...row,consumption:Object.fromEntries(ops.map(op=>{const key=movementKey(row.material,op);return [op,invalid.has(key)?null:round(sums.get(key)||0)];}))}));
 return {rows,ops,mb51Evidence:evidence,mb51OrderCoverage:Object.fromEntries(ops.map(op=>[op,coverage.get(orderKey(op))||0])),matched,ignored,duplicates,duplicateConflicts,movementType:true,formulaKey:hasFormulaKey,formulaFallbacks};
}
