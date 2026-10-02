import type {Row} from './materials.ts';

export const PROGRESS_CLASSES=['A','B','C'] as const;
export type ProgressClass=typeof PROGRESS_CLASSES[number];
export type ClassProgress={total:number;done:number;pending:number;review:number;percent:number|null};
export type OpProgress={op:string;classes:Record<ProgressClass,ClassProgress>;total:number;done:number;pending:number;review:number;unclassified:number;ignored:number;complete:boolean};
const empty=():ClassProgress=>({total:0,done:0,pending:0,review:0,percent:null});

/** Same consolidated Material + OP + unit rows as the report; no quantity
 * sums across units, stock coverage or manual flags in the consumption rate. */
export function summarizeOpProgress(rows:Row[],ops:string[]):OpProgress[]{
 const result=new Map<string,OpProgress>();
 const ensure=(op:string)=>{
  let item=result.get(op);
  if(!item){item={op,classes:{A:empty(),B:empty(),C:empty()},total:0,done:0,pending:0,review:0,unclassified:0,ignored:0,complete:false};result.set(op,item);}
  return item;
 };
 for(const op of ops)ensure(String(op));
 for(const row of rows){
  const op=String(row.op??'').trim();if(!op)continue;
  const item=ensure(op);
  if(row.required===0){item.ignored++;continue;}
  const classification=String(row.classification??'').trim().toUpperCase() as ProgressClass;
  const validClass=PROGRESS_CLASSES.includes(classification);
  const consumed=row.consumedWithScrap??row.consumed;
  // COOIS may flag a missing order record, but this chart measures the known
  // BOM/MB51 quantities. Physical status must neither add nor erase consumption.
  const reliable=!row.consolidationIssue&&!(typeof row.consumed==='number'&&row.consumed<0)&&
   typeof row.required==='number'&&Number.isFinite(row.required)&&row.required>0&&
   typeof consumed==='number'&&Number.isFinite(consumed)&&consumed>=0&&
   typeof row.pending==='number'&&Number.isFinite(row.pending)&&row.pending>=0;
  const state=!reliable?'review':row.pending===0?'done':'pending';
  item.total++;item[state]++;
  if(validClass){const group=item.classes[classification];group.total++;group[state]++;}
  else item.unclassified++;
 }
 for(const item of result.values()){
  for(const group of Object.values(item.classes))group.percent=group.total&&group.review!==group.total?group.done/group.total*100:null;
  item.complete=item.total>0&&item.done===item.total&&item.unclassified===0;
 }
 return [...result.values()];
}

/** Do not round an incomplete class up to a misleading 100%. */
export function progressLabel(group:ClassProgress){
 if(!group.total||group.review===group.total)return '—';
 if(group.done===group.total)return '100%';
 return Math.min(99.9,Math.floor(group.done*1000/group.total+1e-9)/10).toLocaleString('pt-BR',{maximumFractionDigits:1})+'%';
}

export function shortOpLabels(ops:string[]):Map<string,string>{
 let length=4;
 const maxLength=Math.max(4,...ops.map(op=>op.length));
 while(length<maxLength&&new Set(ops.map(op=>op.slice(-length))).size<ops.length)length++;
 return new Map(ops.map(op=>[op,op.slice(-length)]));
}
