import {normalize,type Row} from './materials.ts';

/**
 * Componentes fixos que precisam ser considerados mesmo quando a extração
 * da BOM não traz a linha. A quantidade é por OP, não um total da revisão.
 */
export const FIXED_BOM_ITEMS=[
 {material:'11242550-00',description:'TIRRENO ADITECH ORGANIC OTC+.',unit:'KG',classification:'C',required:15,item:'ADICIONAL FIXO · TIRRENO'}
] as const;

const code=(value:unknown)=>normalize(String(value??'').trim().replace(/\.0+$/,''));

/** Adds configured per-OP components without duplicating a line already in the BOM. */
export function addFixedBomItems(rows:Row[],ops:string[]):Row[]{
 const known=new Set(rows.map(row=>code(row.material)).filter(Boolean));
 const result=[...rows];
 for(const item of FIXED_BOM_ITEMS){
  if(known.has(code(item.material)))continue;
  result.push({id:`fixed:${item.material}`,...item,consumption:Object.fromEntries(ops.map(op=>[String(op),null]))});
  known.add(code(item.material));
 }
 return result;
}
