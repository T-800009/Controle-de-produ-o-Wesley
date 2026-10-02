import {readAutomatic as directRead,readConsumptionMany as directMany,clearAutomaticCache as clearDirect,type ConsumptionResult} from './automatic-client';
import type {Dataset} from './materials';
export type {ConsumptionResult} from './automatic-client';
let worker:Worker|null=null,sequence=0;
const pending=new Map<number,{resolve:(data:any)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
function reset(message:string){worker?.terminate();worker=null;for(const task of pending.values()){clearTimeout(task.timer);task.reject(Error(message));}pending.clear();}
export function clearAutomaticCache(){clearDirect();worker?.postMessage({clear:true});}
function ensureWorker(){
 if(worker)return worker;
 worker=new Worker(new URL('./automatic-worker.ts',import.meta.url),{type:'module'});
 worker.onmessage=event=>{const {id,data,error}=event.data;const task=pending.get(id);if(!task)return;clearTimeout(task.timer);pending.delete(id);error?task.reject(Error(error)):task.resolve(data);};
 worker.onerror=()=>reset('Falha ao processar os dados. Tente Atualizar novamente.');
 return worker;
}
function post<T>(message:Record<string,unknown>):Promise<T>{
 const id=++sequence;
 return new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reset('A consulta demorou demais. Tente Atualizar novamente.'),70_000);
  pending.set(id,{resolve,reject,timer});
  try{worker!.postMessage({id,...message});}
  catch{reset('Não foi possível preparar os dados para atualização.');}
 });
}
/** Parsing and SAP reconciliation run off the UI thread. Node/unsupported
 * environments keep the same tested implementation without a worker. */
export async function readAutomatic(base:Dataset):Promise<Dataset>{
 if(typeof Worker==='undefined')return directRead(base);
 try{ensureWorker();}catch{return directRead(base);}
 // Old audit/scrap data is replaced by the new source; do not clone it twice.
 return post<Dataset>({base:{...base,mb51Evidence:undefined,scrap:undefined}});
}
/** One MB51/SCRAP read reconciled with several BOMs (7000 × PROJETOS). */
export async function readConsumptionMany(bases:Dataset[]):Promise<ConsumptionResult[]>{
 if(typeof Worker==='undefined')return directMany(bases);
 try{ensureWorker();}catch{return directMany(bases);}
 return post<ConsumptionResult[]>({bases:bases.map(base=>({...base,mb51Evidence:undefined,scrap:undefined}))});
}
