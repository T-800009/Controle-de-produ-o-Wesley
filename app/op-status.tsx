import {useEffect,useRef,useState} from 'react';
import {responseError,pollRetryMs} from '@/lib/api';
import {OP_STATUSES,OP_STATUS_LABELS,type OpStatus,type OpStatuses} from '@/lib/op-status';

type StatusPayload={error?:string;revision:number;statuses?:OpStatuses;unchanged?:boolean;canEdit:boolean};

export function useOpStatuses(dataset:string|null){
 const [states,setStates]=useState<OpStatuses>({}),[canEdit,setCanEdit]=useState(false);
 const [loading,setLoading]=useState(true),[saving,setSaving]=useState(''),[error,setError]=useState('');
 const [retryEpoch,setRetryEpoch]=useState(0);
 const generation=useRef(0),revision=useRef<number|null>(null),writeInFlight=useRef(false);
 useEffect(()=>{
  const gen=++generation.current;let alive=true,timer:ReturnType<typeof setTimeout>;let failures=0;
  revision.current=null;writeInFlight.current=false;setStates({});setCanEdit(false);setSaving('');setError('');setLoading(!!dataset);
  if(!dataset)return;
  async function poll(){
   if(writeInFlight.current){if(alive)timer=setTimeout(poll,5_000);return;}
   const startRevision=revision.current;let delay=document.visibilityState==='visible'?5_000:15_000;
   try{
    const query=new URLSearchParams({id:dataset!});if(startRevision!==null)query.set('revision',String(startRevision));
    const response=await fetch('/api/op-status?'+query,{signal:AbortSignal.timeout(15_000)});
    const payload=await response.json() as StatusPayload;if(!response.ok)throw responseError(response,payload,'Atualize o pacote completo para salvar o status das OPs.');
    if(!alive||gen!==generation.current||writeInFlight.current||revision.current!==startRevision)return;
    setCanEdit(payload.canEdit===true);revision.current=payload.revision;
    if(!payload.unchanged)setStates(payload.statuses||{});setError('');failures=0;
   }catch(e){failures++;delay=pollRetryMs(e,failures);if(alive&&gen===generation.current){setError((e as Error).message);setCanEdit(false);}}
   finally{if(alive&&gen===generation.current){setLoading(false);timer=setTimeout(poll,delay);}}
  }
  void poll();return()=>{alive=false;clearTimeout(timer);};
 },[dataset,retryEpoch]);
 async function save(op:string,status:OpStatus){
  if(!dataset||!canEdit||writeInFlight.current)return;
  const gen=generation.current;writeInFlight.current=true;setSaving(op);setError('');
  try{
   const response=await fetch('/api/op-status?id='+encodeURIComponent(dataset),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:dataset,op,status}),signal:AbortSignal.timeout(20_000)});
   const payload=await response.json() as StatusPayload;if(!response.ok)throw Error(payload.error||'Não foi possível salvar o status da OP.');
   if(gen!==generation.current)return;
   setStates(payload.statuses||{});revision.current=payload.revision;
  }catch(e){if(gen===generation.current)setError((e as Error).message);}
  finally{if(gen===generation.current){writeInFlight.current=false;setSaving('');}}
 }
 /** Several OPs of the same BOM in one request (Tudo OK / Reabrir todas). */
 async function saveMany(ops:string[],status:OpStatus){
  if(!dataset||!canEdit||writeInFlight.current||!ops.length)return false;
  const gen=generation.current;writeInFlight.current=true;setSaving('*');setError('');
  try{
   const response=await fetch('/api/op-status?id='+encodeURIComponent(dataset),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:dataset,ops,status}),signal:AbortSignal.timeout(30_000)});
   const payload=await response.json() as StatusPayload;if(!response.ok)throw Error(payload.error||'Não foi possível salvar o status das OPs.');
   if(gen!==generation.current)return false;
   setStates(payload.statuses||{});revision.current=payload.revision;return true;
  }catch(e){if(gen===generation.current)setError((e as Error).message);return false;}
  finally{if(gen===generation.current){writeInFlight.current=false;setSaving('');}}
 }
 return {states,canEdit,loading,saving,error,save,saveMany,retry:()=>setRetryEpoch(value=>value+1)};
}
export type OpStatusControls=ReturnType<typeof useOpStatuses>;

export function OpStatusButton({op,control}:{op:string;control:OpStatusControls}){
 const [open,setOpen]=useState(false);
 const current=control.states[op]?.status||'not_started';
 return <div className={`op-status-control status-${current}`} onBlur={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node|null))setOpen(false);}} onKeyDown={event=>{if(event.key==='Escape')setOpen(false);}}>
  <button type="button" className="op-status-button" disabled={!control.canEdit||control.loading||!!control.saving} aria-label={`Status manual da OP ${op}: ${OP_STATUS_LABELS[current]}`} aria-haspopup="menu" aria-expanded={open} onClick={()=>setOpen(!open)} title="Status de acompanhamento definido pela equipe"><i aria-hidden="true"/>{control.saving===op?'Salvando…':OP_STATUS_LABELS[current]}<span aria-hidden="true">▾</span></button>
  {open&&<div className="op-status-menu" role="menu" aria-label={`Definir status da OP ${op}`}>{OP_STATUSES.map(status=><button type="button" className={`status-${status}`} role="menuitemradio" aria-checked={current===status} key={status} onClick={()=>{setOpen(false);void control.save(op,status);}}><i aria-hidden="true"/>{OP_STATUS_LABELS[status]}</button>)}</div>}
 </div>;
}

/** "Tudo OK": todas as OPs da BOM ficam Concluídas (verdes) e todos os itens
 * aparecem como OK, com uma única gravação. Com tudo concluído, o mesmo botão
 * oferece "Reabrir todas as OPs". Não cria lançamentos SAP. */
export function AllOpsOkButton({ops,control,bomLabel}:{ops:string[];control:OpStatusControls;bomLabel:string}){
 const list=[...new Set(ops.map(String))];
 if(!control.canEdit||!list.length)return null;
 const done=list.every(op=>control.states[op]?.status==='complete');
 function run(){
  const message=done
   ?`Reabrir as ${list.length} OPs de ${bomLabel}?\n\nTodas voltam para "Não iniciada" e reaparecem nos pedidos do Warehouse. As marcações OK feitas item a item continuam salvas.`
   :`Tudo OK: marcar as ${list.length} OPs de ${bomLabel} como Concluídas?\n\nTodas ficam verdes e todos os itens aparecem como OK. Elas saem dos pedidos do Warehouse e do 7000 × PROJETOS.\nNada é lançado no SAP: as diferenças continuam registradas para auditoria.\nPara desfazer, use "Reabrir todas as OPs".`;
  if(typeof window!=='undefined'&&!window.confirm(message))return;
  void control.saveMany(list,done?'not_started':'complete');
 }
 return <button type="button" className={`all-ok${done?' reopen':''}`} disabled={control.loading||!!control.saving} onClick={run} title={done?'Voltar todas as OPs desta BOM para Não iniciada':'Marcar todas as OPs desta BOM como Concluídas e todos os itens como OK'}>
  {control.saving==='*'?'Salvando…':done?`Reabrir todas as OPs (${list.length})`:`✓ Tudo OK (${list.length} OPs)`}
 </button>;
}
