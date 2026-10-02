import {pick,number,normalize,type Row} from './materials.ts';
const text=(v:unknown)=>String(v??'').trim();
const code=(v:unknown)=>text(v).toUpperCase();
export function joinMB51(bom:Row[],ops:string[],movements:Row[]){
 if(!movements.length)throw Error('A aba MB51 está vazia ou o cabeçalho não foi reconhecido.');
 const headers=new Set(Object.keys(movements[0]).map(normalize));
 for(const aliases of [['Material','SAP','Código','Part Number'],['Ordem','Ordem de produção','OP','Order'],['Quantidade','Qtd.','Qtd','Quantity'],['Tipo de movimento','Tipo movimento','Tipo mov.','TMv','Movement type'],['UMB','UM básica','Unidade','Unidade de medida básica','Base Unit of Measure']])if(!aliases.some(a=>headers.has(normalize(a))))throw Error('Coluna necessária na MB51: '+aliases[0]+'.');
 if(!ops.length)throw Error('Falta a lista de ordens deste modelo para cruzar com a MB51.');
 const wanted=new Set(ops.map(text)),sums=new Map<string,number>(),unknown=new Set<string>(),units=new Map<string,Set<string>>(),seen=new Map<string,string>();let matched=0,ignored=0,duplicates=0;
 const key=(sap:string,op:string)=>JSON.stringify([sap,op]);
 for(const r of movements){
  const op=text(pick(r,['Ordem','Ordem de produção','OP','Order']));if(!wanted.has(op)){ignored++;continue;}
  const sap=code(pick(r,['Material','SAP','Código','Part Number']));
  const type=text(pick(r,['Tipo de movimento','Tipo movimento','Tipo mov.','TMv','Movement type']));
  if(!type)throw Error('A MB51 precisa da coluna Tipo de movimento para distinguir consumo e estorno.');
  if(type!=='261'&&type!=='262'){ignored++;continue;}
  if(!sap)throw Error('Existe movimentação de consumo sem SAP.');
  const center=text(pick(r,['Centro','Plant']));if(center&&center!=='BR02'){ignored++;continue;}
  const unit=code(pick(r,['UMB','UM básica','Unidade','Unidade de medida básica','Base Unit of Measure']));
  const qty=number(pick(r,['Quantidade','Qtd.','Qtd','Quantity']));
  const doc=text(pick(r,['Documento material','Doc.material','Documento de material','Material Document'])),year=text(pick(r,['Ano doc.material','Ano do documento material','Ano','Material Doc. Year'])),item=text(pick(r,['Item doc.material','Item do documento material','Item','Material Doc.Item']));
  if(doc&&year&&item){const id=JSON.stringify([doc,year,item]),signature=JSON.stringify([sap,op,unit,qty,type,center]);if(seen.has(id)){if(seen.get(id)!==signature)throw Error('Documento da MB51 repetido com valores diferentes; confira a extração.');duplicates++;continue;}seen.set(id,signature);}
  const k=key(sap,op);if(qty===null||!unit){unknown.add(k);continue;}
  if(!units.has(k))units.set(k,new Set());units.get(k)!.add(unit);const full=JSON.stringify([sap,op,unit]);sums.set(full,(sums.get(full)||0)+(type==='261'?Math.abs(qty):-Math.abs(qty)));matched++;
 }
 const rows=bom.map(r=>{const sap=code(r.material),unit=code(r.unit);const consumption:Row={};for(const op of ops){const availableUnits=units.get(key(sap,op));const incompatible=availableUnits&&(availableUnits.size>1||!availableUnits.has(unit));consumption[op]=!unit||unknown.has(key(sap,op))||incompatible?null:Math.round((sums.get(JSON.stringify([sap,op,unit]))||0)*1e9)/1e9;}return {...r,consumption};});
 return {rows,ops,matched,ignored,duplicates};
}
export const isOrderHeader=(v:unknown)=>['ordem','ordemdeproducao','op','order'].includes(normalize(v));
