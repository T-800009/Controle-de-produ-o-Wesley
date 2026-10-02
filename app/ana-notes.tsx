import {useEffect,useRef,useState} from 'react';
import {MessageSquare,Send,RefreshCw} from 'lucide-react';

type Note={seq:number;id:string;op:string;material:string;text:string;author_role:string;created_at:string};
type NoteResponse={notes:Note[];note:Note;revision:number;canWrite:boolean;nextBefore:number|null;unchanged?:boolean;error?:string};
type Draft={text:string;id:string;saving:boolean;error:string};
const emptyDraft:Draft={text:'',id:'',saving:false,error:''};
type Context={op:string;material:string};
type Props=Context&{orders:string[];onOrder:(op:string)=>void;onClearMaterial:()=>void};
async function request(url:string,init?:RequestInit){
 const response=await fetch(url,{signal:AbortSignal.timeout(12000),...init});
 let data:NoteResponse;try{data=await response.json() as NoteResponse;}catch{throw Error('Não foi possível ler as observações. Confira se a nova versão foi publicada por completo.');}
 if(!response.ok)throw Error(data.error||'Não foi possível salvar. Tente novamente.');
 return data;
}

function NoteThread({op,material,draft,updateDraft}:{op:string;material:string;draft:Draft;updateDraft:(update:(draft:Draft)=>Draft)=>void}){
 const [notes,setNotes]=useState<Note[]>([]),[canWrite,setCanWrite]=useState(false),[error,setError]=useState(''),[loading,setLoading]=useState(true),[notice,setNotice]=useState(''),[before,setBefore]=useState<number|null>(null);
 const revision=useRef(-1),mounted=useRef(true),reading=useRef(false),cursorLoading=useRef(false);
 const url='/api/ana-notes?'+new URLSearchParams({op,material});
 async function read(force=false){
  if(reading.current||!mounted.current)return;
  reading.current=true;
  try{
   const data=await request(url+(!force&&revision.current>=0?'&revision='+revision.current:''));
   if(!mounted.current)return;
   setCanWrite(data.canWrite===true);setError('');
   if(!data.unchanged&&data.revision>=revision.current){
    revision.current=data.revision;
    setNotes(current=>[...new Map([...current,...data.notes].map((note:Note)=>[note.id,note])).values()].sort((a,b)=>b.seq-a.seq));
    setBefore(current=>current===null?data.nextBefore:Math.min(current,data.nextBefore??current));
   }
  }catch(e){if(mounted.current)setError((e as Error).message);}
  finally{reading.current=false;if(mounted.current)setLoading(false);}
 }
 useEffect(()=>{
  mounted.current=true;void read(true);
  const check=()=>{if(document.visibilityState!=='hidden')void read();};
  const timer=setInterval(check,15000);document.addEventListener('visibilitychange',check);
  return()=>{mounted.current=false;clearInterval(timer);document.removeEventListener('visibilitychange',check);};
 },[url]);
 async function save(){
  if(!draft.text.trim()||draft.saving||!canWrite)return;
  const id=draft.id||crypto.randomUUID(),text=draft.text;
  updateDraft(current=>({...current,id,saving:true,error:''}));setNotice('');
  try{
   const data=await request('/api/ana-notes',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id,op,material,text})});
   updateDraft(()=>({...emptyDraft}));
   if(mounted.current){
    revision.current=Math.max(revision.current,data.note.seq);
    setNotes(current=>[data.note,...current.filter(note=>note.id!==data.note.id)]);
    setNotice('Observação salva e compartilhada.');setError('');
   }
  }catch(e){updateDraft(current=>({...current,saving:false,error:(e as Error).message}));}
 }
 async function older(){
  if(!before||cursorLoading.current)return;cursorLoading.current=true;
  try{const data=await request(url+'&before='+before);if(mounted.current){setNotes(current=>[...new Map([...current,...data.notes].map((note:Note)=>[note.id,note])).values()].sort((a,b)=>b.seq-a.seq));setBefore(data.nextBefore);}}
  catch(e){if(mounted.current)setError((e as Error).message);}finally{cursorLoading.current=false;}
 }
 return <>
  {canWrite?<form onSubmit={event=>{event.preventDefault();void save();}}>
   <label htmlFor="ana-note-text">O que precisa ficar registrado?</label>
   <textarea id="ana-note-text" maxLength={4000} rows={5} placeholder="Ex.: Apontamento conferido. Aguardando correção do saldo…" value={draft.text} disabled={draft.saving} onChange={event=>{const text=event.target.value;updateDraft(current=>({...current,text,id:'',error:''}));setNotice('');}}/>
   <div className="ana-note-counter"><span>{draft.text.length} / 4.000</span><span>Visível para a equipe após salvar</span></div>
   <button className="primary" disabled={!draft.text.trim()||draft.saving} type="submit"><Send size={14}/>{draft.saving?'Salvando…':'Salvar observação'}</button>
  </form>:!loading&&<p className="ana-note-readonly">Seu acesso é de consulta. A Ana e o administrador podem registrar observações.</p>}
  {(error||draft.error)&&<p role="alert" className="ana-note-error">{draft.error||error} <button onClick={()=>void read(true)} type="button">Tentar ler novamente</button></p>}
  {notice&&<p role="status" className="ana-note-saved">{notice}</p>}
  <div className="ana-note-history-title"><h4>Histórico compartilhado</h4><button type="button" aria-label="Atualizar observações" onClick={()=>void read(true)}><RefreshCw size={14}/></button></div>
  <p className="ana-note-poll">Atualização das notas a cada 15 s, enquanto esta aba está visível.</p>
  <div className="ana-note-list" aria-live="polite">
   {loading?<p>Lendo observações…</p>:!notes.length&&!error?<p>Nenhuma observação registrada para {material?'este material nesta OP':'esta OP'}.</p>:null}
   {notes.map(note=><article key={note.id}><div><b>{note.author_role==='analyst'?'Analista':'Administrador'}</b><time dateTime={note.created_at}>{new Date(note.created_at).toLocaleString('pt-BR',{dateStyle:'short',timeStyle:'short'})}</time></div><span>{note.material?'Material '+note.material:'Observação geral da OP'}</span><p>{note.text}</p></article>)}
  </div>
  {before&&<button type="button" className="ana-older-notes" onClick={()=>void older()}>Ver observações anteriores</button>}
 </>;
}

export default function AnaNotes({op,material,orders,onOrder,onClearMaterial}:Props){
 const [drafts,setDrafts]=useState<Record<string,Draft>>({});
 const key=JSON.stringify([op,material]);
 return <aside className="ana-notes panel" aria-label="Observações da Ana"><div className="ana-notes-heading"><MessageSquare size={18}/><div><p className="eyebrow">ACOMPANHAMENTO</p><h3>Observações da Ana</h3></div></div>
  <label className="ana-note-order">Ordem de produção<select aria-label="OP das observações" value={op} onChange={event=>onOrder(event.target.value)}><option value="all">Selecione uma OP</option>{orders.map(value=><option key={value} value={value}>OP {value}</option>)}</select></label>
  {op==='all'?<div className="ana-note-placeholder"><MessageSquare size={26}/><p>Clique em uma ordem no gráfico ou selecione acima para escrever ao lado da conferência.</p></div>:<>
   <div className="ana-note-context"><b>{material?'Material '+material:'Anotação geral da OP'}</b>{material&&<button onClick={onClearMaterial}>Ver toda a OP</button>}</div>
   <NoteThread key={key} op={op} material={material} draft={drafts[key]||emptyDraft} updateDraft={update=>setDrafts(current=>({...current,[key]:update(current[key]||emptyDraft)}))}/>
  </>}
 </aside>;
}
