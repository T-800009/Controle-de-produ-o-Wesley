import type {AnaRecord} from './ana-check.ts';
import {summarizeAnaMoney} from './ana-cost.ts';

/** Counts OP/material pairs separately from unique material codes. */
export function summarizeAnaAudit(rows:AnaRecord[]){
 const counts={complete:0,shortage:0,excess:0,review:0,incomplete:0};
 const orders=new Set<string>(),materials=new Set<string>(),divergentMaterials=new Set<string>();
 for(const row of rows){
  counts[row.status]++;orders.add(row.op);materials.add(row.material);
  if(row.status==='shortage'||row.status==='excess')divergentMaterials.add(row.material);
 }
 return {...counts,all:rows.length,orders:orders.size,materials:materials.size,divergentMaterials:divergentMaterials.size,
  divergentPairs:counts.shortage+counts.excess,financial:summarizeAnaMoney(rows)};
}
