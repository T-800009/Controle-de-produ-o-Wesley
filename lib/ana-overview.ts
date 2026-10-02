import type {AnaRecord} from './ana-check.ts';
export type AnaOrderFlag='balanced'|'posted_pending'|'pending'|'excess'|'review'|'incomplete';
export const orderFlagLabels:Record<AnaOrderFlag,string>={balanced:'Sem diferenças',posted_pending:'Apontada · consumo pendente',pending:'Consumo pendente',excess:'Consumo acima da BOM',review:'Conferir dados',incomplete:'Base incompleta'};
export const orderFlagColors:Record<AnaOrderFlag,string>={balanced:'#79d3ad',posted_pending:'#f3cc69',pending:'#ef8790',excess:'#bba3ef',review:'#b7c0ce',incomplete:'#6886a5'};
export const orderFlagOrder:AnaOrderFlag[]=['posted_pending','pending','excess','review','balanced','incomplete'];
export type AnaOrderOverview={op:string;total:number;complete:number;shortage:number;excess:number;review:number;incomplete:number;reported:boolean;confirmation:string;cooisStatus:string;flag:AnaOrderFlag};
/** One linear pass. OP flags always use every component, never just table filters. */
export function anaOrderOverview(rows:AnaRecord[]):AnaOrderOverview[]{
 const map=new Map<string,AnaOrderOverview>();
 for(const row of rows){
  let entry=map.get(row.op);
  if(!entry){entry={op:row.op,total:0,complete:0,shortage:0,excess:0,review:0,incomplete:0,reported:row.cooisReported,confirmation:row.cooisConfirmation,cooisStatus:row.cooisStatus,flag:'review'};map.set(row.op,entry);}
  entry.total++;entry[row.status]++;entry.reported ||= row.cooisReported;
 }
 for(const item of map.values())item.flag=item.incomplete?'incomplete':item.reported&&item.shortage?'posted_pending':item.shortage?'pending':item.review?'review':item.excess?'excess':'balanced';
 return [...map.values()].sort((a,b)=>orderFlagOrder.indexOf(a.flag)-orderFlagOrder.indexOf(b.flag)||a.op.localeCompare(b.op));
}
