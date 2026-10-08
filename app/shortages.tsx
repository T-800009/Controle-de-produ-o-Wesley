import TableViewport from '@/components/table-viewport';
import {readAutomatic,clearAutomaticCache} from '@/lib/automatic-worker-client';
import {lazy,Suspense,useDeferredValue,useEffect,useMemo,useRef,useState} from 'react';
import type {Dataset,Row} from '@/lib/materials';
import {shortageReport} from '@/lib/shortages';
import {scrapLabel} from '@/lib/scrap';
import {requestJson,responseError,pollRetryMs} from '@/lib/api';
import OpProgressChart from './op-progress-chart';
import Warehouse from './warehouse';
import {Mail} from 'lucide-react';
import type {GraficoEmailProps} from './grafico-email';
const GraficoEmailDialog=lazy(()=>import('./grafico-email'));
import {manualCheckKey} from '@/lib/warehouse';
import {OpStatusButton,AllOpsOkButton,type OpStatusControls} from './op-status';
import {OP_STATUS_LABELS,type OpStatuses} from '@/lib/op-status';
import MovementProof from './movement-proof';
import {movementKey} from '@/lib/mb51-evidence';

/** "Enviar por e-mail" no GRÁFICO: a janela (gráficos, lista de faltas, .eml) só carrega ao clicar. */
function GraficoEmail(props:GraficoEmailProps){
 const [open,setOpen]=useState(false);
 return <><button type="button" className="grafico-email-open" onClick={()=>setOpen(true)} title="E-mail para o Warehouse com os gráficos e os materiais que faltam enviar"><Mail size={16}/>Enviar por e-mail</button>
  {open&&<Suspense fallback={null}><GraficoEmailDialog {...props} onClose={()=>setOpen(false)}/></Suspense>}</>;
}

export type ViewMode='overview'|'chart'|'warehouse'|'missing'|'complete'|'review'|'scrap';
const EMPTY_REPORT=shortageReport({id:'',name:'',revision:'',source:'',rows:[],ops:[]},null,null);
const fmt=(v:number|null|undefined)=>v===null||v===undefined?'—':v.toLocaleString('pt-BR',{maximumFractionDigits:3});
const pct=(value:number,total:number)=>total?Math.max(0,Math.min(100,value/total*100)):0;
const stockLabels:Record<string,string>={covered_7000:'Tem no 7000 · falta apontar',transfer_2000:'Transferir do 2000',short_both:'Sem saldo suficiente nos dois',check_stock:'Conferir saldos'};
const get=requestJson;
async function checksRequest(url:string,method:'GET'|'POST',body?:unknown):Promise<any>{const r=await fetch(url,{method,headers:body?{'Content-Type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(15_000)});const payload:any=await r.json().catch(()=>({}));if(!r.ok)throw responseError(r,payload,'Não foi possível salvar as marcações.');return payload;}

function StockProof({row:r}:{row:Row}){
 return <details className="stock-proof"><summary>Ver conta 7000 + 2000</summary><div><p><b>OP {r.op} · {r.material} · {r.unit}</b></p><p>Previsto {fmt(r.required)} − consumo efetivo {fmt(r.consumedWithScrap??r.consumed)} = {fmt(r.pending)} a conferir no SAP.</p><p>Cobertura no 7000: mínimo({fmt(r.pending)}, {fmt(r.available)}) = {fmt(r.covered)}.</p><p>Necessário do 2000: {fmt(r.pending)} − {fmt(r.covered)} = {fmt(r.request)}.</p><p>Pode transferir: mínimo({fmt(r.request)}, {fmt(r.available2000)}) = {fmt(r.transferable2000)}.</p><p>Sem saldo nos dois: {fmt(r.request)} − {fmt(r.transferable2000)} = {fmt(r.uncoveredBoth)}.</p><p>Consulta independente por OP, sem reservar estoque. Saldo negativo vale zero disponível; leitura ausente permanece desconhecida.</p></div></details>;
}

function Overview({pending,complete,review,ops,onSelect,busy,statuses}:{statuses:OpStatuses;pending:Row[];complete:Row[];review:Row[];ops:string[];onSelect:(op:string)=>void;busy:boolean}){
 const total=pending.length+complete.length+review.length;
 const covered=pending.filter(r=>r.request===0).length;
 const request=pending.filter(r=>typeof r.request==='number'&&r.request>0).length;
 const transfer=pending.filter(r=>r.stockSituation==='transfer_2000').length;
 const shortBoth=pending.filter(r=>r.stockSituation==='short_both').length;
 const noBalance=pending.filter(r=>r.stockSituation==='check_stock').length;
 const classes=['A','B','C'].map(name=>({name,pending:pending.filter(r=>String(r.classification||'').trim().toUpperCase()===name).length,complete:complete.filter(r=>String(r.classification||'').trim().toUpperCase()===name).length}));
 const maxClass=Math.max(1,...classes.map(item=>item.pending));
 const orderSummary=ops.slice(0,10).map(op=>({op,state:statuses[op]?.status||'not_started'}));

 return <section className="overview" aria-label="Visão geral da conciliação BOM e SAP">
  <div className="overview-title"><div><h3>Resumo visual das OPs</h3><p>BOM prevista × consumo líquido da MB51, com SCRAP conciliado por material e OP.</p></div><span>{busy?'Atualizando saldos…':'O andamento da OP é definido manualmente no botão acima de cada ordem.'}</span></div>
  <div className="overview-metrics">
   <article className="overview-metric metric-done"><span>Atendidos no SAP</span><strong>{fmt(complete.length)}</strong><small>materiais com a quantidade da BOM atendida</small></article>
   <article className="overview-metric metric-pending"><span>Diferenças BOM × SAP</span><strong>{fmt(pending.length)}</strong><small>diferenças entre a BOM e o consumo consultado</small></article>


   <article className="overview-metric metric-covered"><span>Já tem no 7000</span><strong>{fmt(covered)}</strong><small>não precisa solicitar ao 2000; conferir apontamento</small></article>
   <article className="overview-metric metric-request"><span>Precisam do 2000</span><strong>{fmt(request)}</strong><small>somente a quantidade que o 7000 não cobre</small></article>
   <article className="overview-metric metric-review"><span>Conferir dados</span><strong>{fmt(review.length)}</strong><small>MB51 ou BOM sem conciliação confiável</small></article>
  </div>
  <div className="overview-grid">
   <article className="overview-panel">
    <div className="overview-panel-title"><div><h4>Situação da BOM × MB51</h4><p>Combinações material/OP no filtro atual</p></div><b>{fmt(total)}</b></div>
    <div className="stacked-bar" role="img" aria-label={`${complete.length} atendidos, ${pending.length} com diferença de consumo e ${review.length} para conferir`}>
     <span className="bar-done" style={{width:`${pct(complete.length,total)}%`}}/>
     <span className="bar-pending" style={{width:`${pct(pending.length,total)}%`}}/>
     <span className="bar-review" style={{width:`${pct(review.length,total)}%`}}/>
    </div>
    <div className="chart-legend"><span><i className="legend-done"/>Atendidos <b>{fmt(complete.length)}</b></span><span><i className="legend-pending"/>Diferenças SAP <b>{fmt(pending.length)}</b></span><span><i className="legend-review"/>Conferir <b>{fmt(review.length)}</b></span></div>
   </article>
   <article className="overview-panel">
    <div className="overview-panel-title"><div><h4>Diferenças por classe</h4><p>Pares OP/material com diferença de consumo</p></div><b>{fmt(pending.length)}</b></div>
    <div className="class-chart">{classes.map(item=><div className="class-chart-row" key={item.name}><div><b>Classe {item.name}</b><span>{fmt(item.pending)} diferenças · {fmt(item.complete)} atendidos</span></div><div className="class-track"><i style={{width:`${pct(item.pending,maxClass)}%`}}/></div><strong>{fmt(item.pending)}</strong></div>)}</div>
   </article>
   <article className="overview-panel">
    <div className="overview-panel-title"><div><h4>O que fazer com a pendência</h4><p>Primeiro 7000; somente a diferença é consultada no 2000</p></div><b>{fmt(pending.length)}</b></div>
    <div className="stacked-bar warehouse-bar" role="img" aria-label={`${covered} cobertas pelo 7000, ${transfer} cobertas após transferência do 2000, ${shortBoth} sem saldo suficiente nos dois e ${noBalance} para conferir saldo`}>
     <span className="bar-done" style={{width:`${pct(covered,pending.length)}%`}}/>
     <span className="bar-transfer" style={{width:`${pct(transfer,pending.length)}%`}}/>
     <span className="bar-pending" style={{width:`${pct(shortBoth,pending.length)}%`}}/>
     <span className="bar-review" style={{width:`${pct(noBalance,pending.length)}%`}}/>
    </div>
    <div className="chart-legend"><span><i className="legend-done"/>Tem no 7000 <b>{fmt(covered)}</b></span><span><i className="legend-transfer"/>Transferir do 2000 <b>{fmt(transfer)}</b></span><span><i className="legend-pending"/>Sem saldo nos dois <b>{fmt(shortBoth)}</b></span><span><i className="legend-review"/>Conferir saldo <b>{fmt(noBalance)}</b></span></div>
    <small className="chart-footnote">Todas as classes consultam primeiro o 7000. O 2000 mostra o que pode ser transferido pelo Warehouse. O 1500 fica separado. Cada OP consulta o mesmo saldo disponível; a visão não reserva nem promete esse saldo para várias OPs ao mesmo tempo.</small>
   </article>
   <article className="overview-panel">
    <div className="overview-panel-title"><div><h4>Andamento das OPs</h4><p>Situação registrada pelo administrador</p></div><span>Até 10 OPs · veja todas no gráfico</span></div>
    <div className="op-chart">{orderSummary.length?orderSummary.map(row=><button className={`op-chart-row operational-op-row status-${row.state}`} key={row.op} onClick={()=>onSelect(row.op)}><span className="op-chart-label"><b>OP {row.op}</b><small>{OP_STATUS_LABELS[row.state]}</small></span><strong>{row.state==='complete'?'✓ 100%':'→'}</strong></button>):<p className="chart-empty">Nenhuma OP neste filtro.</p>}</div>
   </article>
  </div>
 </section>;
}

export default function Shortages({data,view,onViewChange:setView,sourceReady=true,syncing=false,syncError='',opStatus}:{data:Dataset;view:ViewMode;onViewChange:(view:ViewMode)=>void;sourceReady?:boolean;syncing?:boolean;syncError?:string;opStatus:OpStatusControls}){
 const [stocks,setStocks]=useState<(Dataset|null)[]>([null,null,null]);
 const [error,setError]=useState(''),[checksError,setChecksError]=useState('');
 const [busy,setBusy]=useState(true);
 const [readAt,setReadAt]=useState('');
 const [op,setOp]=useState('all');
 const [cls,setCls]=useState('all');
 const [search,setSearch]=useState('');
 const [page,setPage]=useState(0);
 const [stockFilter,setStockFilter]=useState('all');
 const [manualChecks,setManualChecks]=useState<Record<string,boolean>>({});
 const [isAdmin,setIsAdmin]=useState(false);
 const [checksLoading,setChecksLoading]=useState(true);
 const [checksReady,setChecksReady]=useState(false),[checksSaving,setChecksSaving]=useState(false);
 const [checksProgress,setChecksProgress]=useState('');
 const checksWriting=useRef(false),checksNeedSnapshot=useRef(false);
 const checksSeq=useRef(0);
 const checksRevision=useRef<number|null>(null);
 const seq=useRef(0);
 const refreshing=useRef(false);
 const stockBases=useRef(new Map<string,Dataset>());

 const rowKey=manualCheckKey;
 useEffect(()=>{
  let alive=true;let timer:ReturnType<typeof setTimeout>|undefined;let requestInFlight=false;let failures=0,retryDelay=0;
  const sequence=++checksSeq.current;checksRevision.current=null;checksWriting.current=false;checksNeedSnapshot.current=false;setChecksSaving(false);setChecksReady(false);setChecksLoading(true);setChecksError('');setManualChecks({});
  const readSharedChecks=async(initial=false)=>{
   if(requestInFlight||checksWriting.current)return;
   requestInFlight=true;const startRevision=checksRevision.current;
   try{
    const params=new URLSearchParams({id:data.id});
    if(!initial&&!checksNeedSnapshot.current&&checksRevision.current!==null)params.set('revision',String(checksRevision.current));
    const payload=await checksRequest('/api/checks?'+params.toString(),'GET');
    if(!alive||sequence!==checksSeq.current||checksWriting.current||checksRevision.current!==startRevision)return;
    setChecksReady(true);setChecksError('');checksNeedSnapshot.current=false;failures=0;retryDelay=0;
    if(Number.isSafeInteger(payload.revision))checksRevision.current=Number(payload.revision);
    setIsAdmin(payload.role==='admin');
    if(!payload.unchanged)setManualChecks(payload.checks&&typeof payload.checks==='object'?payload.checks:{});
   }catch(error){failures++;retryDelay=pollRetryMs(error,failures);if(alive&&sequence===checksSeq.current){setIsAdmin(false);setChecksReady(false);setChecksError((error as Error).message);}}
   finally{requestInFlight=false;if(initial&&alive&&sequence===checksSeq.current)setChecksLoading(false);}
  };
  const poll=async()=>{
   await readSharedChecks(false);
   if(alive)timer=setTimeout(poll,retryDelay||(document.visibilityState==='visible'?5_000:15_000));
  };
  // Load the marks immediately, then use a tiny revision-only request every
  // five seconds. The viewer sees a new admin mark quickly without reloading
  // MB51, COOIS, SCRAP or any stock tab.
  void (async()=>{await readSharedChecks(true);if(alive)timer=setTimeout(poll,retryDelay||5_000);})();
  return()=>{alive=false;if(timer)clearTimeout(timer);};
 },[data.id,data.version]);
 const manualCount=Object.values(manualChecks).filter(Boolean).length;
 const missingMb51Orders=Object.entries(data.mb51OrderCoverage||{}).filter(([,count])=>count===0).map(([op])=>op);
 /** The server accepts a bounded list per request (and each write costs D1
  * quota). Large "mark all" actions are sent in sequential chunks; if one chunk
  * fails, what was already saved stays saved and the next poll shows it. */
 const CHECK_CHUNK=1000;
 async function saveChecks(keys:string[],checked:boolean){
  if(!isAdmin||!keys.length||checksWriting.current)return;
  const sequence=checksSeq.current;checksWriting.current=true;setChecksSaving(true);
  const done:string[]=[];
  try{
   for(let i=0;i<keys.length;i+=CHECK_CHUNK){
    const chunk=keys.slice(i,i+CHECK_CHUNK);
    if(keys.length>CHECK_CHUNK)setChecksProgress(`Salvando ${Math.min(i+chunk.length,keys.length).toLocaleString('pt-BR')} de ${keys.length.toLocaleString('pt-BR')}…`);
    const payload=await checksRequest('/api/checks?id='+encodeURIComponent(data.id),'POST',{id:data.id,keys:chunk,checked});
    if(sequence!==checksSeq.current)return;
    if(Number.isSafeInteger(payload.revision))checksRevision.current=Number(payload.revision);
    done.push(...chunk);
   }
   setChecksError('');
  }catch(error){
   if(sequence===checksSeq.current)setChecksError((error as Error).message+(done.length?` ${done.length.toLocaleString('pt-BR')} de ${keys.length.toLocaleString('pt-BR')} marcações já foram salvas; clique novamente para concluir.`:''));
  }finally{
   if(sequence===checksSeq.current){
    checksNeedSnapshot.current=true;
    if(done.length)setManualChecks(current=>{const next={...current};for(const key of done){if(checked)next[key]=true;else delete next[key];}return next;});
    checksWriting.current=false;setChecksSaving(false);setChecksProgress('');
   }
  }
 }
 function toggleManual(row:Row){
  if(!isAdmin)return;
  const key=rowKey(row);
  void saveChecks([key],!manualChecks[key]);
 }
 function clearManualChecks(){
  if(!isAdmin)return;
  void saveChecks(Object.keys(manualChecks),false);
 }

 async function readStock(id:string){
 let base=stockBases.current.get(id);
  if(!base){const loaded:Dataset=await get('/api/data?id='+id);base=loaded;stockBases.current.set(id,loaded);}
  if(!base)throw Error(`Depósito ${id} indisponível.`);
  return readAutomatic(base);
 }
 async function refresh(){
  if(!sourceReady||refreshing.current)return;
  refreshing.current=true;
  clearAutomaticCache();
  const n=++seq.current;setBusy(true);setError('');const errors:string[]=[];
  // The 7000/2000 balances are the only sources used to decide a Warehouse
  // request. Load those first so the report becomes usable without waiting on
  // the informational 1500 tab.
  const primary=await Promise.all(['7000','2000'].map(async id=>{try{return await readStock(id);}catch(e){errors.push(`Depósito ${id}: ${(e as Error).message}`);return null;}}));
  if(n!==seq.current){refreshing.current=false;return;}
  setStocks([primary[0],primary[1],null]);setError(errors.join(' '));setReadAt(new Date().toLocaleString('pt-BR'));setBusy(false);
  // 1500 is displayed as a reference only and never affects coverage. Read
  // it after the first paint so a slow/absent tab cannot block the dashboard.
  try{
   const reference=await readStock('1500');
   if(n===seq.current)setStocks(previous=>[previous[0],previous[1],reference]);
  }catch(e){if(n===seq.current)setError(previous=>[previous,...errors,`Depósito 1500: ${(e as Error).message}`].filter(Boolean).join(' '));}
  finally{if(n===seq.current)refreshing.current=false;}
 }
 useEffect(()=>{
  stockBases.current.clear();setStocks([null,null,null]);setError('');
  // Let the MB51/COOIS/SCRAP sync finish before opening the two stock reads.
  // This avoids six simultaneous Google requests on the first paint while
  // the old report remains visible to the user.
  if(!sourceReady||syncing){setBusy(false);return;}
  void refresh();
  return()=>{seq.current++;refreshing.current=false;};
 },[data.id,sourceReady,syncing]);
 useEffect(()=>{setOp('all');setPage(0)},[data.id]);
 useEffect(()=>setPage(0),[op,cls,search,view,stockFilter]);

 // Do not expand every BOM × OP combination before a manual source update.
 const report=useMemo(()=>sourceReady?shortageReport(data,stocks[0],stocks[2],stocks[1]):EMPTY_REPORT,[data,stocks,sourceReady]);
 const deferredSearch=useDeferredValue(search);
 const filteredSets=useMemo(()=>{
  const normalizedSearch=deferredSearch.toLowerCase();
  const matches=(r:Row)=>(op==='all'||r.op===op)&&(cls==='all'||String(r.classification||'').trim().toUpperCase()===cls)&&`${r.material||''} ${r.description||''} ${r.op||''}`.toLowerCase().includes(normalizedSearch);
  return {
   missing:report.rows.filter(matches),
   complete:report.completed.filter(matches),
   review:report.reviewRows.filter(matches),
   scrap:report.scrapRows.filter(matches)
  };
 },[report,op,cls,deferredSearch]);
 const stockCounts=useMemo(()=>Object.fromEntries(Object.keys(stockLabels).map(key=>[key,filteredSets.missing.filter(row=>row.stockSituation===key).length])),[filteredSets.missing]);
 const visibleMissing=filteredSets.missing;
 const visibleComplete=filteredSets.complete;
 const visibleReview=filteredSets.review;
 const visibleScrap=filteredSets.scrap;
 const filtered=view==='missing'?visibleMissing.filter(row=>stockFilter==='all'||row.stockSituation===stockFilter):view==='complete'?visibleComplete:view==='review'?visibleReview:view==='scrap'?visibleScrap:[];
 const overviewRows=[...visibleMissing,...visibleComplete,...visibleReview];
 // Items already attended by MB51 need no manual OK: leaving them out avoids
 // thousands of useless shared writes when marking a whole view.
 const bulkRows=(view==='overview'?overviewRows:filtered).filter(row=>row.completion!=='complete'&&opStatus.states[String(row.op)]?.status!=='complete');
 const bulkMarkedCount=bulkRows.filter(row=>!!manualChecks[rowKey(row)]).length;
 function markAllVisible(){
  if(!isAdmin)return;
  const toMark=bulkRows.filter(row=>!manualChecks[rowKey(row)]);
  if(!toMark.length)return;
  const label=`os ${toMark.length.toLocaleString('pt-BR')} itens ainda não atendidos desta ${view==='overview'?'visão':'lista'}`;
  if(typeof window!=='undefined'&&!window.confirm(`Marcar como OK ${label}?\n\nA marcação será compartilhada com a equipe e ficará bloqueada para usuários de consulta.`))return;
  void saveChecks(toMark.map(rowKey),true);
 }
 const allOps=useMemo(()=>[...new Set((data.ops?.length?data.ops:report.allRows.map(r=>String(r.op))).map(String))],[data.ops,report]);
 const pages=Math.max(1,Math.ceil(filtered.length/25)),current=Math.min(page,pages-1);
 const opStats=useMemo(()=>{
  const stats=new Map<string,{missing:number;complete:number;review:number}>();
  const add=(rows:Row[],field:'missing'|'complete'|'review')=>{for(const row of rows){const key=String(row.op||'');const current=stats.get(key)||{missing:0,complete:0,review:0};current[field]++;stats.set(key,current);}};
  add(report.rows,'missing');add(report.completed,'complete');add(report.reviewRows,'review');
  return stats;
 },[report]);
 const opCounts=(value:string)=>opStats.get(value)||{missing:0,complete:0,review:0};
 function selectOrder(value:string){const counts=opCounts(value);setOp(value);setStockFilter('all');setView(counts.missing?'missing':counts.review?'review':'complete');}
 function selectChartOrder(value:string){setCls('all');setSearch('');selectOrder(value);}

 async function exportExcel(){
  const x=await import('xlsx');
  const exportRows=view==='overview'?overviewRows:filtered;
  const sheet=x.utils.json_to_sheet(exportRows.map(r=>({
   OP:r.op,SAP:r.material,Descrição:r.description,Classe:r.classification,UMB:r.unit,
   'Qtd. BOM':r.required,'Consumido MB51':r.consumed,'SCRAP adicional comprovado':r.scrapAdjustment??r.scrapApplied??0,'Consumo efetivo':r.consumedWithScrap,'Diferença de consumo BOM × SAP + SCRAP':r.pending,'Excesso acima da BOM':r.overage?'Sim':'Não','Fonte do consumo':r.consumptionSource||'—',
   'Saídas 261':data.mb51Evidence?.[movementKey(r.material,r.op)]?.issued??null,'Estornos 262':data.mb51Evidence?.[movementKey(r.material,r.op)]?.reversed??null,'Registros MB51':data.mb51Evidence?.[movementKey(r.material,r.op)]?.count??0,
   'Saldo 7000 (produção)':r.s7000,'Saldo 2000 (Warehouse)':r.s2000,'Saldo 1500 (referência)':r.s1500,'Disponível 7000':r.available,'Disponível 2000':r.available2000,
   'Coberto no 7000':r.covered,'Necessário do 2000':r.request,'Pode transferir do 2000':r.transferable2000,'Sem saldo 7000 + 2000':r.uncoveredBoth,'Situação do saldo':r.completion==='review'?'Conferir dados':stockLabels[r.stockSituation]||'Consumo atendido','Itens da BOM consolidados':r.bomLines,
   'Status manual da OP':OP_STATUS_LABELS[opStatus.states[r.op]?.status||'not_started'],'Diagnóstico SCRAP':scrapLabel(r.scrapStatus||'none'),'Qtd. SCRAP':r.scrapQuantity,'Lançamentos SCRAP':r.scrapCount,'Marcação manual':manualChecks[rowKey(r)]?'Sim':'Não',Status:r.completion,Orientação:r.action
  })));
  sheet['!cols']=[{wch:18},{wch:18},{wch:45},{wch:9},{wch:9},{wch:14},{wch:16},{wch:18},{wch:18},{wch:18},{wch:14},{wch:14},{wch:25},{wch:18},{wch:24},{wch:18},{wch:14},{wch:70}];
  const book=x.utils.book_new();x.utils.book_append_sheet(book,sheet,view==='overview'?'Visao_Geral':view==='missing'?'Pendencias':view==='complete'?'Concluidos':view==='scrap'?'Scrap_Duplicidades':'Conferir');
  const info=x.utils.aoa_to_sheet([
   ['Modelo',data.name],['Revisão',data.revision],['Consulta',readAt],['Origem BOM × SAP',data.source||'Não disponível'],
   ['Regra MB51','261 conta como consumo, 262 desconta estorno e outros tipos são ignorados.'],
   ['Materiais repetidos na BOM','Linhas com o mesmo SAP e unidade são somadas; o consumo MB51 correspondente entra uma vez por OP.'],
   ['Regra dos depósitos','Primeiro 7000, em todas as classes. Necessário do 2000 = máximo(pendência de consumo − disponível 7000, 0). Transferível = mínimo(necessário do 2000, disponível 2000). Sem saldo nos dois = necessário − transferível. Cada OP consulta o mesmo saldo, sem reserva entre ordens.'],
   ['Regra do 1500','Exibido separadamente; não substitui o saldo dos depósitos 2000 ou 7000.'],
   ['7000',stocks[0]?.source||'Não disponível',stocks[0]?.updatedAt||'Sem data'],
   ['2000',stocks[1]?.source||'Não disponível',stocks[1]?.updatedAt||'Sem data'],
   ['1500',stocks[2]?.source||'Não disponível',stocks[2]?.updatedAt||'Sem data'],
   ['SCRAP',data.scrapSource||'Não configurada',data.scrap?.length||0],
   ['Combinações para conferência',report.unknown],['Diagnósticos SCRAP/duplicidade',report.scrapRows.length],['Visão',view]
  ]);
  x.utils.book_append_sheet(book,info,'Criterios');
  const filename=view==='overview'?'Resumo-BOM-SAP.xlsx':view==='missing'?'Pendencias-OP.xlsx':view==='complete'?'Concluidos-OP.xlsx':view==='scrap'?'Scrap-Duplicidades.xlsx':'Conferir-MB51.xlsx';
  x.writeFile(book,filename);
 }

 if(view==='warehouse')return <section className="shortages panel warehouse-screen">
  <div className="panel-head"><div><h2>Resumo Warehouse</h2><p>{data.name} · {data.revision} · todas as ordens desta BOM</p></div><button disabled={busy||!sourceReady} onClick={refresh}>{busy?'Consultando…':'Atualizar depósitos'}</button></div>
  {(error||checksError)&&<div className="notice" role="alert">{[error,checksError].filter(Boolean).join(' ')}</div>}
  {!sourceReady?<div className="empty source-wait" role="status"><h3>{syncing?'Conferindo a MB51 atual…':'Atualize as fontes para montar o resumo'}</h3><p>Clique em Atualizar dados no topo. O resumo usa MB51, SCRAP, os saldos e as marcações do administrador.</p></div>:<Warehouse key={data.id} rows={report.allRows} data={data} stocks={stocks} statuses={opStatus.states} checks={manualChecks} ready={!busy&&!opStatus.loading&&!opStatus.error&&checksReady&&!checksSaving&&!checksError} onSelect={selectChartOrder}/>}
 </section>;

 const tabLabel=view==='chart'?'Gráfico por OP':view==='overview'?'Visão geral':view==='missing'?'Diferenças BOM × SAP':view==='complete'?'Atendidos no SAP':view==='scrap'?'SCRAP / duplicidades':'Conferir dados';
 const movementNote='O consumo é cruzado pelas colunas Material e Ordem do SAP. O 261 conta como consumo e o 262 como estorno. A coluna auxiliar NEW COD não substitui uma Ordem preenchida. A diferença é calculada contra a revisão da BOM selecionada; compare a revisão correta da OP. Marcar uma OP em verde indica a conclusão informada pela equipe, sem criar apontamentos SAP.';

 return <section className={`shortages panel${view==='chart'?' chart-screen':''}`}>
  <div className="panel-head"><div><h2>{tabLabel}</h2><p><b className="active-bom">{data.name} · {data.revision}</b> · {op==='all'?`Todas as ${(data.ops||[]).length} OPs desta BOM`:`OP ${op} · ${OP_STATUS_LABELS[opStatus.states[op]?.status||'not_started']}`} · BOM × MB51 · 7000 primeiro → 2000 somente para o restante</p></div><div className="actions" hidden={view==='chart'}><button disabled={busy||!sourceReady} onClick={refresh}>{busy?'Consultando…':'Atualizar depósitos'}</button><button disabled={busy||!sourceReady||!overviewRows.length} onClick={exportExcel}>Exportar resumo</button>{isAdmin&&<button className="manual-bulk" type="button" disabled={checksLoading||checksSaving||!bulkRows.length||bulkMarkedCount===bulkRows.length} onClick={markAllVisible} title="Marca como OK todos os itens da lista filtrada">{checksProgress||(bulkMarkedCount===bulkRows.length&&bulkRows.length?'Tudo marcado como OK':`Marcar tudo como OK (${bulkRows.length.toLocaleString('pt-BR')})`)}</button>}<AllOpsOkButton ops={(data.ops||[]).map(String)} control={opStatus} bomLabel={`${data.name} · ${data.revision}`}/>{isAdmin&&manualCount>0&&<button className="manual-clear" type="button" disabled={checksLoading||checksSaving} onClick={clearManualChecks}>Limpar marcações compartilhadas ({manualCount})</button>}{!isAdmin&&<span className="permission-note">Somente leitura · marcações do administrador</span>}</div></div>
  {view!=='chart'&&<details className="shortage-details"><summary>Fontes e critérios de cálculo</summary><div className="shortage-sources"><span><b>BOM × SAP</b> · {data.source} · {data.updatedAt||'data não informada'}</span><span><b>SCRAP</b> · {data.scrapSource||'Aguardando Atualizar'}</span>{['7000','2000','1500'].map((id,i)=><span key={id}><b>Depósito {id}</b> · {stocks[i]?.rows.length?`${stocks[i]?.source} · ${stocks[i]?.updatedAt||'data não informada'}`:'Base indisponível / não importada'}</span>)}<span>Consulta: {readAt||'—'}</span><span>Fontes pesadas: somente ao clicar em Atualizar · marcações: sincronização leve</span><span>{isAdmin?'Perfil: administrador · pode marcar':'Perfil: consulta · marcações bloqueadas'}</span></div>{sourceReady&&<div className="notice shortage-explanation"><b>Como ler este painel:</b> {movementNote} As diferenças de consumo representam combinações Material/OP; não comprovam falta física. A diferença é calculada por BOM × MB51. Em todas as classes, o 7000 cobre primeiro; o 2000 é consultado somente para o restante. O 1500 fica separado. A leitura atual cruza SCRAP por Material + OP e documento/ano/item: o que já está na MB51 não é somado novamente. Sem quantidade ou documento comprovável, o SCRAP fica para conferência; nenhuma peça é inventada. Nas linhas, verde = consumo atendido ou marcação manual; azul = há saldo no 7000, com consumo a conferir; amarelo = há saldo para transferir do 2000; vermelho = saldo insuficiente nos dois; cinza = dados a conferir. As marcações ficam salvas no servidor e aparecem para todos, mas só o administrador pode alterá-las. {report.unknown>0&&`${report.unknown} combinações material/OP precisam de conferência; veja a aba Conferir dados.`}</div>}</details>}
  {(error||checksError)&&<div className="notice" role="alert">{[error,checksError].filter(Boolean).join(' ')}</div>}
  {!sourceReady&&view!=='chart'?<div className="empty source-wait" role="status"><h3>{syncing?'Conferindo a MB51 atual…':'A conciliação MB51 ainda não foi atualizada'}</h3><p>{syncError?`${syncError} Os resultados antigos ficam ocultos até uma leitura válida.`:'Clique em Atualizar no topo para ler MB51, SCRAP e saldos antes de consultar as faltas.'}</p></div>:<>

  {view!=='chart'&&<div className="stock-rule-banner"><div><b>1 · Conferir consumo da OP</b><span>BOM − MB51/SCRAP</span></div><div><b>2 · Usar o saldo do 7000</b><span>Se cobre, não solicitar ao 2000</span></div><div><b>3 · Conferir o restante no 2000</b><span>Mostrar quanto pode transferir e quanto falta nos dois</span></div></div>}
  {sourceReady&&missingMb51Orders.length>0&&<div className="notice mb51-coverage-note"><b>{missingMb51Orders.length} OPs sem movimentos 261/262 nesta MB51.</b> A conferência SAP dessas ordens precisa de dados; elas não entram como falta confirmada. Confira o período e a extração completa.</div>}
  <div hidden={view==='chart'} className="shortage-view-tabs" role="tablist" aria-label="Situação BOM × SAP">
   <button role="tab" aria-selected={view==='overview'} aria-pressed={view==='overview'} onClick={()=>setView('overview')}>Visão geral</button>
   <button role="tab" aria-selected={view==='chart'} aria-pressed={view==='chart'} onClick={()=>{setOp('all');setCls('all');setSearch('');setView('chart');}}>Gráfico por OP</button>
   <button role="tab" aria-selected={view==='missing'} aria-pressed={view==='missing'} onClick={()=>setView('missing')}>Diferenças BOM × SAP <b>{report.rows.length}</b></button>
   
   <button role="tab" aria-selected={view==='complete'} aria-pressed={view==='complete'} onClick={()=>setView('complete')}>Atendidos no SAP <b>{report.completed.length}</b></button>
   <button role="tab" aria-selected={view==='review'} aria-pressed={view==='review'} onClick={()=>setView('review')}>Conferir dados <b>{report.reviewRows.length}</b></button>
   <button role="tab" aria-selected={view==='scrap'} aria-pressed={view==='scrap'} onClick={()=>setView('scrap')}>SCRAP / duplicidades <b>{report.scrapRows.length}</b></button>
  </div>
  {view==='chart'?<OpProgressChart rows={report.allRows} ops={allOps} revision={`${data.name} · ${data.revision}`} updatedAt={data.updatedAt} onSelect={selectChartOrder} statuses={opStatus.states} control={opStatus} sourceReady={sourceReady} actions={<GraficoEmail data={data} rows={report.allRows} ops={allOps} stocks={stocks} statuses={opStatus.states} checks={manualChecks} sourceReady={sourceReady} ready={!busy&&!opStatus.loading&&!opStatus.error&&checksReady&&!checksSaving&&!checksError}/>}/>:<div className="shortage-layout">
   <nav className="op-rail" aria-label="OPs">
   <button aria-pressed={op==='all'} onClick={()=>setOp('all')}><span>Todas as OPs</span><small>Visualizar ordens desta BOM</small></button>
    {allOps.map(o=>{const status=opStatus.states[o]?.status||'not_started';return <div key={o} className={`op-card status-${status}`}><OpStatusButton op={o} control={opStatus}/><button className="op-select" aria-pressed={op===o} onClick={()=>selectOrder(o)}><span>OP {o}</span><small>Ver materiais da OP →</small></button></div>})}
   </nav>
   <div className="shortage-content">{op!=='all'&&<div className="selected-op-status"><OpStatusButton op={op} control={opStatus}/><b>OP {op}</b><small>{opStatus.states[op]?.status==='complete'?'Concluída pela equipe. Confira a revisão da BOM e os documentos das diferenças abaixo. Esta OP não entra nos pedidos Warehouse.':'Status manual de acompanhamento'}</small></div>}
    <div className="filters"><label className="search"><input aria-label="Buscar material ou OP" placeholder="SAP, descrição ou OP" value={search} onChange={e=>setSearch(e.target.value)}/></label><select aria-label="Classe" value={cls} onChange={e=>setCls(e.target.value)}><option value="all">Todas as classes</option>{['A','B','C'].map(c=><option key={c} value={c}>Classe {c}</option>)}</select><span>{view==='overview'?`${overviewRows.length} combinações no resumo`:`${filtered.length} ${view==='missing'?'diferenças SAP':view==='complete'?'atendidos no SAP':view==='scrap'?'diagnósticos SCRAP/duplicidade':'itens para conferir'}`}</span></div>
    {view==='missing'&&<div className="stock-filter-tabs" role="group" aria-label="Filtrar disponibilidade nos depósitos"><button aria-pressed={stockFilter==='all'} onClick={()=>setStockFilter('all')}>Todas as diferenças <b>{visibleMissing.length}</b></button>{Object.entries(stockLabels).map(([key,label])=><button className={key} key={key} aria-pressed={stockFilter===key} onClick={()=>setStockFilter(key)}>{label} <b>{stockCounts[key]}</b></button>)}</div>}
    {view==='overview'?<Overview pending={visibleMissing} complete={visibleComplete} review={visibleReview} ops={op==='all'?allOps:[op]} onSelect={selectOrder} busy={busy} statuses={opStatus.states}/>:<>
     {busy&&view==='missing'?<div className="empty">Consultando saldos dos depósitos…</div>:<>
      <TableViewport className="shortage-scroll" label="Materiais da OP"><table><thead><tr>{['Marcação','OP / Material','Previsto BOM','Consumo efetivo','Diferença nesta base','7000 · Produção','2000 · Warehouse','Conferência'].map(h=><th key={h}>{h}</th>)}</tr></thead><tbody>{filtered.slice(current*25,current*25+25).map((r,i)=>{
       const manual=!!manualChecks[rowKey(r)];const opDone=opStatus.states[r.op]?.status==='complete';const flagged=manual||opDone;const completed=manual||r.completion==='complete';
       const evidence=data.mb51Evidence?.[movementKey(r.material,r.op)];
       const explanation=r.completion==='review'?'Dados a conferir':r.completion==='complete'?'Quantidade atendida':evidence&&!evidence.issue&&evidence.net===0?'Consumo estornado':!evidence&&data.mb51Evidence?'Não localizado na MB51':'Diferença de quantidade';
       const rowClass=manual?'manual-complete-row':completed?'complete-row':opDone?'manual-complete-row op-complete-row':r.completion==='review'||r.stockSituation==='check_stock'?'review-row':r.stockSituation==='covered_7000'?'covered-pending-row':r.stockSituation==='transfer_2000'?'transfer-pending-row':'pending-row';
       return <tr className={rowClass} key={`${r.op}:${r.id}:${i}`}>
        <td className="manual-cell"><button type="button" disabled={!isAdmin||checksLoading||checksSaving||(opDone&&!manual)} title={opDone&&!manual?'OK pela OP concluída. Reabra a OP para desmarcar os itens.':undefined} className={`manual-toggle${flagged?' is-checked':''}`} aria-pressed={flagged} aria-label={`${manual?'Desmarcar':'Marcar'} OP ${r.op} material ${r.material} como concluído${isAdmin?' pelo administrador':' pelo administrador (somente leitura)'}`} onClick={()=>toggleManual(r)}><span className="manual-toggle-mark">{flagged?'✓':'○'}</span><span>{manual?'OK · administrador':opDone?'OK · OP concluída':isAdmin?'Marcar como OK':'Somente leitura'}</span></button></td>
        <td><b>OP {r.op}</b><span className="code">{r.material}</span><span className="description">{r.description}</span><small>Classe {r.classification||'não informada'}{r.bomLines>1?` · ${r.bomLines} linhas BOM`:''}</small></td>
        <td className="num">{fmt(r.required)} <small>{r.unit}</small></td>
        <td className="num">{fmt(r.consumedWithScrap)} <small>{r.unit}</small><small>MB51: {fmt(r.consumed)}{(r.scrapAdjustment??r.scrapApplied)?` · SCRAP adicional: ${fmt(r.scrapAdjustment??r.scrapApplied)}`:''}</small></td>
        <td className={'num '+(r.completion==='complete'?'positive':'')}>{fmt(r.pending)} <small>{r.unit}</small><small>{explanation}</small></td>
        <td className="num stock-7000">{fmt(r.s7000)} <small>{r.unit}</small><small>{r.completion==='pending'?`Cobre: ${fmt(r.covered)}`:'Saldo livre'}</small></td>
        <td className="num stock-2000">{fmt(r.s2000)} <small>{r.unit}</small><small>{r.completion==='pending'?`Pode transferir: ${fmt(r.transferable2000)}`:'Saldo livre'}</small></td>
        <td className={'shortage-action '+(completed||r.request===0?'covered':'')}><b>{manual?'Marcado como concluído pelo administrador.':opDone?'OK · OP concluída pela equipe. A diferença SAP fica registrada para auditoria; nada foi lançado no SAP.':r.action}</b><MovementProof row={r} data={data}/>{r.completion==='pending'&&<StockProof row={r}/>}<details className="scrap-proof"><summary>SCRAP e saldo 1500</summary><p><span className={`scrap-badge scrap-${r.scrapStatus||'none'}`}>{scrapLabel(r.scrapStatus||'none')}</span></p><p>{r.scrapMessage}</p><p>1500: {fmt(r.s1500)} {r.unit} · saldo separado.</p><p>Necessário do 2000: <span className="stock-request">{fmt(r.request)} {r.unit}</span>. Sem saldo nos dois: <span className="stock-uncovered">{fmt(r.uncoveredBoth)} {r.unit}</span>.</p></details></td>
       </tr>;
      })}</tbody></table></TableViewport>
      {!filtered.length&&<div className="empty">{view==='missing'?(op==='all'?'Nenhuma diferença de consumo nesta seleção.':'Nenhuma diferença de consumo nesta OP e filtro.') :view==='scrap'?'Nenhum SCRAP ou duplicidade foi encontrado nos filtros atuais.':'Nenhum registro para estes filtros.'}</div>}
      <div className="table-footer"><span>{filtered.length} registros · quantidades por unidade</span><div><button disabled={current===0} onClick={()=>setPage(page-1)}>Anterior</button><span>{current+1} / {pages}</span><button disabled={current+1>=pages} onClick={()=>setPage(page+1)}>Próxima</button></div></div>
     </>}
    </>}
  </div>
 </div>}
  </>}
 </section>;
}
