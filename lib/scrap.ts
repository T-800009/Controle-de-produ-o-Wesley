import {normalize,number,pick,type Row} from './materials.ts';
import {documentYear,orderKey,unitKey} from './mb51-evidence.ts';

const text=(value:unknown)=>String(value??'').trim();
const canonical=(value:unknown)=>normalize(text(value).replace(/\.0+$/,''));
const round=(value:number)=>Math.round(value*1e9)/1e9;

/** A normalized row from the optional SCRAP Google Sheets tab. */
export type ScrapRecord={
 material:string;
 op:string;
 quantity:number|null;
 /** 261 consumes; 262 reverses a previous SCRAP PROCESS. */
 movementType:string;
 center:string;
 depot:string;
 /** Material document/year/item, when SAP supplied them. */
 sourceKey:string;
 description:string;
 raw:Row;
};

/** Result shown beside a BOM × SAP row in the Conferir dados view. */
export type ScrapDiagnosis={
 scrapStatus:'none'|'scrap'|'scrap-duplicate'|'scrap-reversed'|'duplicate';
 scrapQuantity:number|null;
 scrapQuantityInferred:boolean;
 scrapCount:number;
 scrapAdjustment?:number;
 scrapMessage:string;
};

/** Lookup table used while reconciling a large BOM. */
export type ScrapIndex=Map<string,ScrapRecord[]>;

const aliases={
 material:['Material','Código SAP','Código','SAP','Part Number','Material SAP','material'],
 op:['Ordem','Ordem de produção','OP','Ordem SAP','Order','Production order','op'],
 composite:['NEW COD','New Cod','Chave material OP','Chave material + OP','Material + Ordem','Material/Ordem'],
 quantity:['Quantidade','Qtd','Qtd.','Quantidade scrap','Qtd scrap','Qtd. scrap','Scrap','Quantidade do scrap','Qtd. perda','Perda','quantity'],
 movementType:['Tipo de movimento','Tipo movimento','Tipo mov.','Tipo de mov.','Tipo movim.','Mov. tipo','TMv','Mvt','MvT','Movement type','movementType'],
 center:['Centro','Plant','center'],
 depot:['Depósito','Deposito','Storage location','SLoc','depot'],
 document:['Documento material','Doc.material','Documento de material','Material Document','Doc. material'],
 year:['Ano doc.material','Ano do documento material','Ano do documento','Material Doc. Year'],
 item:['Item doc.material','Item do documento material','Item material document','Material Doc.Item','Item'],
 description:['Texto breve material','Texto breve do material','Descrição','Material description','Texto','description'],
};

function splitComposite(value:string){
 const raw=value.trim();
 if(!raw)return null;
 // SAP production orders in this workflow are eight or more digits and
 // normally start with 19/20. Looking at compact digits also handles a
 // NEW COD exported as a pure concatenation (without a slash or space).
 const digits=raw.replace(/\D/g,'');
 const opMatch=digits.match(/(19\d{6,}|20\d{6,})$/)||digits.match(/(\d{8,})$/);
 if(!opMatch)return null;
 const op=opMatch[1],materialDigits=digits.slice(0,digits.length-op.length);
 return materialDigits?{material:materialDigits,op}:null;
}

function movement(value:unknown){return text(value).replace(/\.0+$/,'');}
function sourceKey(row:Row){
 const existing=text(row.sourceKey);
 if(existing)return existing;
 const document=canonical(pick(row,aliases.document));
 const year=canonical(pick(row,aliases.year));
 const item=canonical(pick(row,aliases.item));
 return document&&year&&item?`${document}|${year}|${item}`:'';
}

/**
 * Converts the flexible SCRAP export into material + OP keys.
 *
 * SAP extracts can contain other movement types, other plants, and repeated
 * copies of the same material document. Those lines cannot explain a
 * SCRAP PROCESS consumption and are discarded here instead of becoming
 * false diagnostics later in the report.
 */
export function convertScrap(rows:Row[]):ScrapRecord[]{
 const out:ScrapRecord[]=[];
 for(const row of rows){
  let material=text(pick(row,aliases.material));
  let op=text(pick(row,aliases.op));
  const composite=text(pick(row,aliases.composite));
  if((!material||!op)&&composite){
   const parsed=splitComposite(composite);
   if(parsed){if(!material)material=parsed.material;if(!op)op=parsed.op;}
  }
  if(!material||!op)continue;
  const movementType=movement(pick(row,aliases.movementType));
  // A simplified Google tab may omit the movement type. In that case retain
  // the row for backwards compatibility; an explicit non-261/262 type is
  // never a scrap consumption.
  if(movementType&&movementType!=='261'&&movementType!=='262')continue;
  const center=text(pick(row,aliases.center));
  if(center&&canonical(center)!==canonical('BR02'))continue;
  const rawQuantity=number(pick(row,aliases.quantity));
  const quantity=rawQuantity===null?null:Math.abs(rawQuantity);
  out.push({
   material:canonical(material),
   op:canonical(op),
   quantity,
   movementType,
   center,
   depot:text(pick(row,aliases.depot)),
   sourceKey:sourceKey(row),
   description:text(pick(row,aliases.description)),
   raw:row.raw&&typeof row.raw==='object'?row.raw:row,
  });
 }
 return out;
}

/** Only documents absent from the MB51 may complement its consumption.
 * Missing document identities/quantities are diagnostic, never invented pieces. */
export function auditScrapAgainstMB51(scrap:Row[],movements:Row[]):Row[]{
 const readers=(rows:Row[])=>{
  const keys=Object.keys(rows[0]||{}),headers=keys.map(normalize);
  const field=(names:string[])=>{const index=names.map(normalize).map(name=>headers.indexOf(name)).find(i=>i>=0);return (row:Row)=>index===undefined?undefined:row[keys[index]];};
  const doc=field(aliases.document),item=field(aliases.item),year=field(aliases.year),date=field(['Data do documento','Data de lançamento']);
  const material=field(aliases.material),op=field(aliases.op),qty=field(aliases.quantity),type=field(aliases.movementType);
  return {identity:(row:Row)=>{const d=canonical(doc(row)),i=canonical(item(row)),y=canonical(year(row))||documentYear(date(row));return d&&i&&y?`${d}|${y}|${i}`:'';},signature:(row:Row)=>JSON.stringify([canonical(material(row)),orderKey(op(row)),movement(type(row)),number(qty(row))===null?null:Math.abs(number(qty(row))!)]),quantity:qty,type};
 };
 const mb=readers(movements),sc=readers(scrap),documents=new Map<string,string>(),conflicts=new Set<string>();
 for(const row of movements){const id=mb.identity(row);if(!id)continue;const signature=mb.signature(row);if(documents.has(id)&&documents.get(id)!==signature)conflicts.add(id);else documents.set(id,signature);}
 const scrapDocuments=new Map<string,string>();
 for(const row of scrap){const id=sc.identity(row);if(!id)continue;const signature=sc.signature(row);if(scrapDocuments.has(id)&&scrapDocuments.get(id)!==signature)conflicts.add(id);else scrapDocuments.set(id,signature);}
 return scrap.map(row=>{
  const id=sc.identity(row),quantity=number(sc.quantity(row)),type=movement(sc.type(row)),signature=sc.signature(row);
  const matches=id&&documents.has(id)&&documents.get(id)===signature&&!conflicts.has(id);
  const separate=id&&!documents.has(id)&&!conflicts.has(id)&&quantity!==null&&['261','262'].includes(type);
  return {...row,sourceKey:id,mb51Check:matches?'included':separate?'separate':'unverified'};
 });
}

const pairKey=(material:unknown,op:unknown)=>`${canonical(material)}|${orderKey(op)}`;

/** Indexes SCRAP once by Material + OP instead of filtering the whole tab for
 * every BOM line. The flat record list remains available for exports/tests. */
export function indexScrap(records:ScrapRecord[]):ScrapIndex{
 const index:ScrapIndex=new Map();
 for(const record of records){
  const key=pairKey(record.material,record.op);
  const bucket=index.get(key);
  if(bucket)bucket.push(record);else index.set(key,[record]);
 }
 return index;
}

function distinctMatches(matches:ScrapRecord[]){
 // If SAP gave a document identity it is authoritative. For reduced tabs
 // without one, compare the whole row so an exact repeated copy is ignored
 // while two real rows with different quantities/types remain visible.
 const seen=new Set<string>(),out:ScrapRecord[]=[];
 for(const [index,item] of matches.entries()){
  // A reduced hand-built tab has no document identity and no safe way to
  // tell two identical rows apart. Keep those rows visible as distinct
  // events; the full SAP export is deduplicated by sourceKey above.
  const identity=item.sourceKey||(item.movementType?JSON.stringify(item.raw):`reduced-row-${index}`);
  if(seen.has(identity))continue;
  seen.add(identity);out.push(item);
 }
 return out;
}

/**
 * Decides whether a row flagged for checking is explained by SCRAP.
 *
 * 261 adds a scrap piece and 262 reverses one. Exact duplicate copies of a
 * material document are ignored. Multiple distinct documents for the same
 * Material + OP are retained and reported, because they are a genuine
 * duplicate/extra scrap event rather than a duplicated download.
 */
export function diagnoseScrap(row:Row,records:ScrapRecord[],indexed?:ScrapIndex):ScrapDiagnosis{
 const key=pairKey(row.material,row.op);
 const matches=key!=='|'?distinctMatches(indexed?.get(key)||records.filter(item=>pairKey(item.material,item.op)===key)):[];
 const conflict=/diverg|repetid|duplic/i.test(String(row.consolidationIssue??''));
 if(matches.length){
  if(matches.some(item=>item.raw.mb51Check!==undefined)){
   let adjustment=0,net=0,included=0,unverified=0;
   for(const item of matches){
    const amount=item.quantity===null?0:(item.movementType==='262'?-item.quantity:item.quantity);net+=amount;
    if(item.raw.mb51Check==='included')included++;
    else if(item.raw.mb51Check==='separate'&&item.quantity!==null){
     const unit=pick(item.raw,['UM básica','UMB','Unidade de medida básica','Base Unit of Measure']);
     if(unit&&row.unit&&unitKey(unit)!==unitKey(row.unit))unverified++;
     else adjustment+=amount;
    }
    else unverified++;
   }
   adjustment=round(adjustment);net=round(net);
   return {scrapStatus:net<0?'scrap-reversed':matches.length>1?'scrap-duplicate':'scrap',scrapQuantity:net,scrapAdjustment:adjustment,scrapQuantityInferred:false,scrapCount:matches.length,
    scrapMessage:`${included} lançamento(s) já incluído(s) na MB51; ${unverified} sem conciliação segura de documento e quantidade. Ajuste comprovado fora da MB51: ${fmtQuantity(adjustment)}. Nenhuma peça é inferida.`};
  }
  let net=0,unknown=0;
  const hasMovementSemantics=matches.some(item=>!!item.movementType||!!item.sourceKey);
  if(!hasMovementSemantics){
   // A hand-maintained SCRAP tab usually has only Material, OP and an
   // optional quantity. Repeated identical rows cannot be proven to be two
   // physical events, so take the largest quantity once and surface the
   // repetition as a diagnostic instead of manufacturing extra consumption.
   const numeric=matches.map(item=>item.quantity).filter((value):value is number=>typeof value==='number'&&Number.isFinite(value));
   net=numeric.length?Math.max(...numeric):1;
   unknown=matches.length-numeric.length;
  }else for(const item of matches){
   const qty=item.quantity===null?1:item.quantity;
   if(item.quantity===null)unknown++;
   net+=item.movementType==='262'?-qty:qty;
  }
  net=round(net);
  const inferred=unknown>0;
  if(net<=0){
   return {
    scrapStatus:'scrap-reversed',scrapQuantity:0,scrapQuantityInferred:inferred,
    scrapCount:matches.length,
    scrapMessage:`SCRAP PROCESS estornado${matches.length>1?'/repetido':''}: o saldo líquido é ${fmtQuantity(net)}; não entra como consumo.`,
   };
  }
  const duplicated=matches.length>1||conflict;
  return {
   scrapStatus:duplicated?'scrap-duplicate':'scrap',
   scrapQuantity:net,
   scrapQuantityInferred:inferred,
   scrapCount:matches.length,
   scrapMessage:duplicated
    ?`SCRAP PROCESS conciliado: ${matches.length} lançamento(s) distinto(s), saldo líquido ${fmtQuantity(net)}${inferred?' (quantidade vazia inferida como 1).':' Não conte cópias idênticas novamente.'}`
    :`SCRAP PROCESS localizado para esta OP/material; saldo líquido ${fmtQuantity(net)} entra uma única vez no consumo efetivo.`,
  };
 }
 if(conflict){
  return {scrapStatus:'duplicate',scrapQuantity:null,scrapQuantityInferred:false,scrapCount:0,scrapMessage:'Duplicidade BOM × MB51 sem registro correspondente na aba SCRAP.'};
 }
 return {scrapStatus:'none',scrapQuantity:null,scrapQuantityInferred:false,scrapCount:0,scrapMessage:'Sem correspondência na aba SCRAP.'};
}

function fmtQuantity(value:number){return String(value).replace(/\.0+$/,'');}

/**
 * Applies a matched SCRAP PROCESS to a BOM × MB51 line without hiding the
 * original MB51 number. Scrap is counted once as material already consumed;
 * a duplicated or reversed scrap line cannot create a false shortage.
 */
export function applyScrapConsumption(row:Row,records:ScrapRecord[],indexed?:ScrapIndex):Row{
 const diagnosis=diagnoseScrap(row,records,indexed);
 const required=typeof row.required==='number'&&Number.isFinite(row.required)?Math.max(0,row.required):null;
 const raw=typeof row.consumed==='number'&&Number.isFinite(row.consumed)?row.consumed:null;
 const hasScrap=(diagnosis.scrapStatus==='scrap'||diagnosis.scrapStatus==='scrap-duplicate')&&typeof diagnosis.scrapQuantity==='number'&&diagnosis.scrapQuantity>0;
 const audited=diagnosis.scrapAdjustment!==undefined;
 const qty=audited?diagnosis.scrapAdjustment!:(hasScrap?diagnosis.scrapQuantity!:0);
 const consumedWithScrap=raw===null?(audited?null:hasScrap?qty:null):round((audited?raw:Math.max(0,raw))+qty);
 const effective=required===null||consumedWithScrap===null?consumedWithScrap:Math.min(required,consumedWithScrap);
 const pending=required===null||effective===null?row.pending:Math.max(0,round(required-effective));
 const scrapApplied=required===null?0:Math.max(0,Math.min(qty,Math.max(0,required-(raw===null?0:Math.max(0,raw)))));
 const originalConsolidationIssue=String(row.consolidationIssue??'');
 const scrapResolvesConsumptionConflict=!audited&&hasScrap&&/consumo.*diverg|diverg.*consumo|repetid|duplic/i.test(originalConsolidationIssue);
 const consolidationIssue=scrapResolvesConsumptionConflict?'':row.consolidationIssue;
 return {
  ...row,
  ...diagnosis,
  originalConsolidationIssue,
  consolidationIssue,
  consumedWithScrap,
  scrapApplied,
  scrapResolvedOverage:hasScrap&&required!==null&&raw!==null&&raw>required,
  scrapResolvesConsumptionConflict,
  consumptionSource:qty!==0?(raw===null?'SCRAP PROCESS':'MB51 + SCRAP'):(raw===null?'Sem consumo confiável':'MB51'),
  reportStatus:pending!==null&&pending<=0&&hasScrap?'Previsto atendido após considerar SCRAP PROCESS':row.reportStatus,
  pending,
 };
}

export function scrapLabel(status:ScrapDiagnosis['scrapStatus']):string{
 return status==='scrap'?'SCRAP PROCESS':status==='scrap-duplicate'?'DUPLICIDADE · SCRAP':status==='scrap-reversed'?'SCRAP ESTORNADO':status==='duplicate'?'DUPLICIDADE · SEM SCRAP':'SEM SCRAP';
}
