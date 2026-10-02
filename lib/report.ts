import {normalize,type Row} from './materials.ts';

const canonical=(value:unknown)=>normalize(String(value??'').trim().replace(/\.0+$/,''));
const key=(row:Row)=>JSON.stringify([canonical(row.material),canonical(row.unit)]);
const round=(value:number)=>Math.round(value*1e9)/1e9;

/** One demand line per SAP and unit, even when the BOM repeats the material. */
export function consolidateBomRows(rows:Row[],ops:string[]):Row[]{
 const groups=new Map<string,Row[]>(),unitsByMaterial=new Map<string,Set<string>>();
 for(const row of rows){
  const material=canonical(row.material),unit=canonical(row.unit),k=key(row);
  const group=groups.get(k);if(group)group.push(row);else groups.set(k,[row]);
  if(material){const units=unitsByMaterial.get(material)||new Set<string>();units.add(unit);unitsByMaterial.set(material,units);}
 }

 return [...groups.entries()].map(([k,items])=>{
  const first=items[0],material=canonical(first.material),unit=canonical(first.unit);
  const classes=[...new Set(items.map(row=>String(row.classification??'').trim().toUpperCase()).filter(Boolean))];
  const requiredValues=items.map(row=>row.required);
  const required=requiredValues.every(value=>typeof value==='number'&&Number.isFinite(value)&&value>=0)
   ?round(requiredValues.reduce((sum,value)=>sum+(value as number),0)):null;
  const consumption=Object.fromEntries(ops.map(op=>{
   const values=items.map(row=>row.consumption?.[op]);
   const known=values.every(value=>typeof value==='number'&&Number.isFinite(value));
   const same=known&&values.every(value=>round(value as number)===round(values[0] as number));
   return [op,same?values[0]:null];
  }));
  const sourceItems=[...new Set(items.map(row=>String(row.item??'').trim()).filter(Boolean))];
  let consolidationIssue='';
  if(!material)consolidationIssue='Código SAP ausente na BOM.';
  else if(!unit)consolidationIssue='Unidade de medida ausente na BOM.';
  else if((unitsByMaterial.get(material)?.size||0)>1)consolidationIssue='O mesmo SAP aparece com unidades diferentes na BOM; confira as unidades antes de comparar.';
  else if(classes.length>1)consolidationIssue='O mesmo SAP aparece com classes diferentes na BOM; confira o cadastro.';
  else if(items.length>1&&ops.some(op=>{
   const values=items.map(row=>row.consumption?.[op]);
   return values.some(value=>typeof value!=='number'||!Number.isFinite(value))||
    values.some(value=>round(value as number)!==round(values[0] as number));
  }))consolidationIssue='O consumo da MB51 diverge entre linhas repetidas do mesmo SAP; confira os dados.';
  return {
   ...first,id:`${String(first.id??'')}:${k}`,required,consumption,
   classification:classes[0]||'',item:sourceItems.join(', '),bomLines:items.length,
   bomItems:sourceItems,consolidationIssue
  };
 });
}

/** Calculates a single OP from the complete BOM, then keeps the requested filters. */
export function orderReport(rows:Row[],op:string,source:Row[]=rows):Row[]{
 const visible=new Set(rows.map(key));
 return consolidateBomRows(source,[op]).filter(row=>visible.has(key(row))).map(row=>{
  const consumed=row.consumption?.[op];
  const known=typeof consumed==='number'&&Number.isFinite(consumed);
  const valid=typeof row.required==='number'&&Number.isFinite(row.required)&&row.required>=0;
  const pending=known&&valid&&!row.consolidationIssue
   ?Math.max(0,round(row.required-consumed as number)):null;
  const reportStatus=row.consolidationIssue||!known||!valid?'Dados para conferir':
   consumed!<0?'Estorno · conferir':pending!>0?'Pendente de conferência':
   consumed!>row.required?'Consumo acima da BOM':'Previsto atendido';
  return {...row,consumed:known?consumed:null,pending,reportStatus};
 });
}
