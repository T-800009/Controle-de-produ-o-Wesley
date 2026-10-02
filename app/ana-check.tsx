import TableViewport from '@/components/table-viewport';
import {useDeferredValue,useMemo,useRef,useState} from 'react';
import {Download,FileSpreadsheet,RefreshCw,Search,TriangleAlert,Package,CheckCircle2} from 'lucide-react';
import {toast} from 'sonner';
import {clearAnaCache,readAnaCheck} from '@/lib/ana-client';
import type {AnaRecord} from '@/lib/ana-check';
import {summarizeAnaAudit} from '@/lib/ana-audit';
import {anaOrderOverview,orderFlagLabels,type AnaOrderFlag} from '@/lib/ana-overview';
import AnaCharts from './ana-charts';
import AnaNotes from './ana-notes';

const fmt=(value:number|null|undefined)=>value===null||value===undefined?'—':Number(value).toLocaleString('pt-BR',{maximumFractionDigits:3});
const money=(value:number|null|undefined,currency:string|null)=>value===null||value===undefined?'—':Number(value).toLocaleString('pt-BR',currency?{style:'currency',currency}:{minimumFractionDigits:2,maximumFractionDigits:2});
const date=(value?:string)=>value?new Date(value).toLocaleString('pt-BR'):'—';
const rank:Record<AnaRecord['status'],number>={shortage:0,excess:1,review:2,complete:3,incomplete:4};
const coverageLabel=(coverage:string)=>coverage==='both'?'Presente nas duas fontes':coverage==='missing_kob'?'Sem materiais na KOB1':'Sem componentes na ZPP009';

function CostReference({row}:{row:AnaRecord}){
 return <td className="num ana-price">
  {money(row.price,row.priceCurrency)}
  {row.priceSource?<details><summary>{row.priceSource}{row.priceEstimated?' · estimativa':''}</summary><div>
   <p>{row.priceMethod}</p><p>{money(row.priceAmount,row.priceCurrency)} ÷ {fmt(row.priceQuantity)}</p><p>{row.priceNote}</p>
  </div></details>:<small className="ana-unit" title={row.priceNote}>Sem referência calculável</small>}
  {row.price!==null&&!row.priceCurrency&&<small className="ana-unit">Moeda não informada</small>}
 </td>;
}

function Formula({row}:{row:AnaRecord}){
 return <details className="ana-formula"><summary>Ver conta e origem</summary><div>
  <p><b>Chave:</b> OP {row.op} + material {row.material}</p>
  <p><b>KOB1:</b> {row.actualSeen?fmt(row.actual):'Nenhum lançamento deste material na extração'}</p>
  <p><b>ZPP009:</b> {row.bomSeen?fmt(row.bom):'Nenhuma linha deste material na extração'}</p>
  <p><b>SOMASES:</b> {row.actualSeen?fmt(row.actual):'0'} − {row.bomSeen?fmt(row.bom):'0'} = {fmt(row.difference)} {row.unit}</p>
  {row.coverage!=='both'&&<p>Conta entre os arquivos disponíveis, sem conclusão sobre falta: a OP não tem materiais em uma das fontes. Este resultado não entra no total financeiro.</p>}
  {row.status==='review'&&<p>Resultado suspenso por quantidade ou unidade incompatível.</p>}
 </div></details>;
}

export default function AnaCheck(){
 const [result,setResult]=useState<Awaited<ReturnType<typeof readAnaCheck>>|null>(null);
 const [loading,setLoading]=useState(false),[error,setError]=useState(''),[query,setQuery]=useState(''),[order,setOrder]=useState('all'),[status,setStatus]=useState('all'),[page,setPage]=useState(0);
 const [notesOpen,setNotesOpen]=useState(true);
 const [orderFlag,setOrderFlag]=useState<AnaOrderFlag|'all'>('all'),[noteMaterial,setNoteMaterial]=useState('');
 const inFlight=useRef(false),deferred=useDeferredValue(query);
 async function refresh(){
  if(inFlight.current)return;
  inFlight.current=true;setLoading(true);setError('');clearAnaCache();
  try{const next=await readAnaCheck();setResult(next);setPage(0);setOrder(current=>current==='all'||next.orders.includes(current)?current:'all');toast.success('Conferência da Ana atualizada.');}
  catch(e){const message=(e as Error).message||'Não foi possível ler as abas da Ana.';setError(message);toast.error(message);}
  finally{inFlight.current=false;setLoading(false);}
 }
 const orderSummaries=useMemo(()=>anaOrderOverview(result?.rows||[]),[result]);
 const orderMap=useMemo(()=>new Map(orderSummaries.map(item=>[item.op,item])),[orderSummaries]);
 function chooseOrder(op:string){setOrder(op);setNoteMaterial('');setPage(0);setStatus('all');setQuery('');setOrderFlag('all');}
 function openOrder(op:string){chooseOrder(op);if(op!=='all'){setNotesOpen(true);requestAnimationFrame(()=>document.getElementById('ana-review')?.scrollIntoView?.({behavior:'smooth',block:'start'}));}}
 function chooseFlag(flag:AnaOrderFlag|'all'){setOrderFlag(flag);setOrder('all');setNoteMaterial('');setStatus('all');setPage(0);setQuery('');}
 const filtered=useMemo(()=>{
  const q=deferred.trim().toLowerCase();
  return (result?.rows||[]).filter(row=>(order==='all'||row.op===order)&&
   (orderFlag==='all'||orderMap.get(row.op)?.flag===orderFlag)&&
   (status==='all'||row.status===status||status==='divergent'&&(row.status==='shortage'||row.status==='excess'))&&
   (!q||[row.op,row.material,row.description,row.displayDescription.text,row.costClass,row.cooisStatus].join(' ').toLowerCase().includes(q)))
   .sort((a,b)=>rank[a.status]-rank[b.status]||a.op.localeCompare(b.op)||a.material.localeCompare(b.material));
 },[result,deferred,order,status,orderFlag,orderMap]);
 const totals=useMemo(()=>summarizeAnaAudit(filtered),[filtered]);
 const coverage=useMemo(()=>{
  const rows=result?.orderCoverage||[];
  return {both:rows.filter(row=>row.coverage==='both').length,missingKob:rows.filter(row=>row.coverage==='missing_kob').length,missingZpp:rows.filter(row=>row.coverage==='missing_zpp').length};
 },[result]);
 const pages=Math.max(1,Math.ceil(filtered.length/50)),current=Math.min(page,pages-1),visible=filtered.slice(current*50,current*50+50);
 function filterStatus(value:string){setStatus(value);setPage(0);}
 function exportCsv(){
  if(!filtered.length)return;
  const escape=(value:unknown)=>{const raw=typeof value==='number'?String(value).replace('.',','):String(value??''),safe=typeof value==='string'&&/^[=+\-@\t\r]/.test(raw)?"'"+raw:raw;return `"${safe.replaceAll('"','""')}"`;};
  const lines=[['OP','Material','Descrição em português','Descrição original','Origem da descrição','Classe custo','Unidade','KOB1 · Qtd.total entrada','ZPP009 · BOM QTY','Diferença comparável','Referência unitária','Valor da diferença comparável','Moeda','Fonte do preço','Estimativa','Cálculo da referência','Nota financeira','COOIS','Apontamento COOIS','Situação da OP','Situação','Conferência','Cobertura da OP','SOMASES bruto entre arquivos','Última leitura'],
   ...filtered.map(row=>[row.op,row.material,row.displayDescription.text,row.description,row.displayDescription.source,row.costClass,row.unit,row.actual,row.bom,row.coverage==='both'?row.difference:null,row.price,row.coverage==='both'?row.differenceValue:null,row.priceCurrency||'Não informada',row.priceSource,row.priceEstimated?'SIM':'NÃO',row.priceMethod,row.priceNote,row.cooisStatus,row.cooisConfirmation,orderFlagLabels[orderMap.get(row.op)!.flag],row.statusLabel,row.issues.join(' · '),coverageLabel(row.coverage),row.difference,result?.readAt])].map(row=>row.map(escape).join(';')).join('\r\n');
  const url=URL.createObjectURL(new Blob(['\ufeff'+lines],{type:'text/csv;charset=utf-8'})),a=document.createElement('a');a.href=url;a.download='check-ana-auditado.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
 }
 return <section className="ana-check" aria-busy={loading}>
  <div className="ana-header panel"><div><p className="eyebrow">05 / CONFERÊNCIA SAP</p><h2>Check Ana <span>ZPP009 × KOB1</span></h2><p>Consumo, previsto e diferença por ordem e material. Confira a cobertura dos relatórios antes de avaliar as divergências.</p></div><div className="ana-actions"><button className="primary" onClick={refresh} disabled={loading}><RefreshCw size={16} className={loading?'spin':''}/>{loading?'Lendo SAP…':'Atualizar conferência'}</button>{result&&<button className="text-button" onClick={exportCsv} disabled={!filtered.length||loading}><Download size={16}/>Exportar CSV</button>}</div></div>
  {error&&<div className="notice danger" role="alert"><TriangleAlert size={18}/><div><b>Não foi possível atualizar o check.</b><br/>{error}{result&&<p>Exibindo a leitura anterior de {date(result.readAt)}. Os resultados abaixo não foram atualizados.</p>}</div></div>}
  {!result&&!loading&&!error&&<div className="ana-empty panel"><FileSpreadsheet size={38}/><h3>Check da Ana ainda não foi carregado</h3><p>Clique em <b>Atualizar conferência</b> para ler ZPP009 e KOB1 no formato original do SAP. MM60 (preços) e COOIS (status) são opcionais.</p></div>}
  {loading&&!result&&<div className="ana-empty panel" role="status"><RefreshCw size={38} className="spin"/><h3>Conferindo as bases do SAP…</h3><p>A leitura é manual. Os dados aparecerão ao concluir a conferência.</p></div>}
  {result&&<>
   <div className="ana-meta"><span><CheckCircle2 size={15}/>{loading?'Atualizando · leitura anterior: ':'Última leitura: '}{date(result.readAt)}</span><span><Package size={15}/>Linhas recebidas · KOB1 {fmt(result.sourceCounts.KOB1)} · ZPP009 {fmt(result.sourceCounts.ZPP009)} · MM60 {fmt(result.sourceCounts.MM60)}</span></div>
   <nav className="ana-quick-nav" aria-label="Seções do Check Ana"><a href="#ana-panorama">Panorama das OPs</a><a href="#ana-review">Conferência e observações <span>↓</span></a><span>Atualização manual · filtros sem nova leitura</span></nav>
   <AnaCharts orders={orderSummaries} selected={order} flag={orderFlag} onSelect={openOrder} onFlag={chooseFlag}/>
   <section className="ana-coverage panel" aria-label="Cobertura das fontes">
    <div className="ana-coverage-title"><div><p className="eyebrow">QUALIDADE DA BASE</p><h3>{coverage.missingKob+coverage.missingZpp?'As fontes têm OPs diferentes':'OPs presentes nas duas fontes'}</h3><p>Presença em ambas permite comparar. Confirme também o mesmo período e escopo dos exports.</p></div><span className={`ana-coverage-score ${coverage.missingKob+coverage.missingZpp?'partial':''}`}>{coverage.both} / {result.orders.length}<small>OPs nas duas fontes</small></span></div>
    {(coverage.missingKob+coverage.missingZpp)>0&&<div className="ana-coverage-alert"><TriangleAlert size={18}/><p><b>{fmt(coverage.missingKob)} OPs sem materiais na KOB1 · {fmt(coverage.missingZpp)} sem componentes na ZPP009.</b> Essas OPs ficam em Base incompleta e não são contadas como falta. Inclua a extração completa e clique em Atualizar conferência.</p><button onClick={()=>{chooseOrder('all');filterStatus('incomplete');}}>Ver base incompleta</button></div>}
    <details><summary>Ver cobertura por OP</summary><div className="ana-coverage-list">{result.orderCoverage.map(item=><button key={item.op} onClick={()=>{chooseOrder(item.op);}}><b>OP {item.op}</b><span>{item.kobMaterials} materiais KOB1 / {item.zppMaterials} ZPP009</span><small>{coverageLabel(item.coverage)}</small></button>)}</div></details>
   </section>
   {result.warnings.length>0&&<details className="ana-source-notes panel"><summary>Observações das fontes ({result.warnings.length})</summary>{result.warnings.map((warning,index)=><p key={index}>{warning}</p>)}</details>}
   <div className="ana-stats">
    <article className="stat"><span>Ordens no filtro</span><strong>{fmt(totals.orders)}</strong><small>{fmt(totals.all)} pares OP/material · {fmt(totals.materials)} códigos únicos</small></article>
    <article className="stat featured"><span>Divergências entre fontes</span><strong>{fmt(totals.divergentPairs)}</strong><small>{fmt(totals.divergentMaterials)} códigos únicos · {fmt(totals.shortage)} abaixo / {fmt(totals.excess)} acima</small></article>
    <article className="stat"><span>Sem diferenças</span><strong className="ana-positive">{fmt(totals.complete)}</strong><small>Pares OP/material com quantidades iguais</small></article>
    <article className="stat"><span>Aguardando conferência</span><strong className="ana-amber">{fmt(totals.incomplete+totals.review)}</strong><small>{fmt(totals.incomplete)} base incompleta · {fmt(totals.review)} quantidade/unidade a conferir</small></article>
    <article className="stat ana-financial"><span>{totals.financial.estimated?'Diferença líquida estimada':'Diferença financeira líquida'}</span>
     {totals.financial.groups.length?totals.financial.groups.map(group=><div className="ana-currency-total" key={group.currency}><strong className={group.value<0?'ana-negative':'ana-positive'}>{money(group.value,group.currency)}</strong><small>{fmt(group.lines)} pares · {group.currency}{group.estimated?` · ${fmt(group.estimated)} estimados`:''}</small><details><summary>Abaixo / acima da BOM</summary><p>Abaixo: {money(group.below,group.currency)}</p><p>Acima: {money(group.above,group.currency)}</p></details></div>):<strong>—</strong>}
     <small>{totals.financial.incomplete>0&&<span>{fmt(totals.financial.incomplete)} pares com base incompleta fora do total. </span>}{totals.financial.unavailable>0&&<span>{fmt(totals.financial.unavailable)} sem valor calculável. </span>}{totals.financial.unknownCurrency>0&&<span>{fmt(totals.financial.unknownCurrency)} com moeda não informada: fora dos totais. </span>}Totais por moeda no filtro atual.</small>
    </article>
   </div>
   <div className="ana-toolbar panel" id="ana-review"><label className="search"><Search size={18}/><input aria-label="Buscar na conferência" placeholder="Buscar OP, material ou descrição…" value={query} onChange={event=>{setQuery(event.target.value);setPage(0)}}/></label><label className="ana-select"><span>Ordem</span><select value={order} onChange={event=>chooseOrder(event.target.value)}><option value="all">Todas as ordens</option>{result.orders.map(value=><option key={value} value={value}>{value}</option>)}</select></label><label className="ana-select"><span>Situação do material</span><select value={status} onChange={event=>filterStatus(event.target.value)}><option value="all">Todas</option><option value="divergent">Divergências entre fontes</option><option value="shortage">Abaixo da BOM</option><option value="excess">Acima da BOM</option><option value="complete">Sem diferenças</option><option value="incomplete">Base incompleta</option><option value="review">Conferir quantidade / unidade</option></select></label><span className="result-count">{fmt(filtered.length)} pares OP/material</span>{orderFlag!=='all'&&<button className="ana-clear-flag" onClick={()=>chooseFlag('all')}>Limpar filtro do gráfico</button>}</div>
   <div className={`ana-review-workspace${notesOpen?'':' notes-collapsed'}`}><div className="panel ana-table-panel"><div className="panel-head"><div><h2>Conferência por material</h2><p>KOB1 − ZPP009. Uma divergência documental não comprova falta física de peça.</p></div><button className="ana-notes-toggle" aria-expanded={notesOpen} aria-controls="ana-notes-panel" onClick={()=>setNotesOpen(value=>!value)}>{notesOpen?'Recolher observações':'Abrir observações'}</button></div><TableViewport className="ana-table-scroll" label="Conferência ZPP009 e KOB1"><table className="ana-table"><thead><tr><th>OP / Material</th><th>Descrição</th><th>Consumido<br/>KOB1</th><th>Previsto<br/>ZPP009</th><th>Diferença</th><th>Referência unitária</th><th>Valor da diferença</th><th>COOIS · contexto</th><th>Situação</th></tr></thead><tbody>{visible.map(row=>{
    const comparable=row.coverage==='both',diff=comparable?row.difference:null,value=comparable?row.differenceValue:null;
    const postedPending=row.cooisReported&&row.status==='shortage';
    return <tr key={row.id} className={`ana-row ${row.status}${postedPending?' posted-pending':''}`}><td><b>{row.op}</b><span>{row.material}</span><button className="ana-add-note" onClick={()=>{setOrder(row.op);setNoteMaterial(row.material);setPage(0);setNotesOpen(true);}}>Anotar material</button></td><td className="ana-description">{row.displayDescription.text}{row.displayDescription.translated&&<details><summary>Ver descrição original</summary><p>{row.displayDescription.original}</p><small>{row.displayDescription.source}</small></details>}{row.displayDescription.untranslated&&<small className="ana-issue">Tradução ainda não cadastrada</small>}</td><td className="num">{fmt(row.actual)}{row.unit&&<small className="ana-unit">{row.unit}</small>}</td><td className="num">{fmt(row.bom)}</td><td className={'num '+(diff!==null&&diff<0?'ana-negative':diff!==null&&diff>0?'ana-amber':'')}>{fmt(diff)}<Formula row={row}/></td><CostReference row={row}/><td className={'num '+(value!==null&&value<0?'ana-negative':value!==null&&value>0?'ana-amber':'')}>{money(value,row.priceCurrency)}{value!==null&&<small className="ana-unit">{row.priceEstimated?'Estimativa · ':''}{row.priceCurrency||'Moeda não informada'}</small>}</td><td className="ana-coois">{row.cooisConfirmation||'Sem confirmação identificada'}<details><summary>Status do export</summary><p>{row.cooisStatus}</p></details></td><td>{postedPending&&<span className="ana-badge posted-pending">Apontada · consumo pendente</span>}<span className={`ana-badge ${row.status}`}>{row.statusLabel}</span>{row.issues.map(issue=><small className="ana-issue" key={issue}>{issue}</small>)}</td></tr>;
   })}{!visible.length&&<tr><td colSpan={9}>Nenhum material neste filtro.</td></tr>}</tbody></table></TableViewport><div className="table-footer"><span>{filtered.length?`${current*50+1}–${Math.min((current+1)*50,filtered.length)} de ${fmt(filtered.length)} pares`:'0 pares'}</span><div><button disabled={current===0} onClick={()=>setPage(current-1)}>Anterior</button><span>{current+1} / {pages}</span><button disabled={current+1>=pages} onClick={()=>setPage(current+1)}>Próxima</button></div></div></div><div id="ana-notes-panel" className="ana-notes-container" hidden={!notesOpen}><AnaNotes op={order} material={noteMaterial} orders={result.orders} onOrder={chooseOrder} onClearMaterial={()=>setNoteMaterial('')}/></div></div>
   <details className="ana-reading panel"><summary>Como o check calcula</summary><p>{fmt(result.diagnostics.inheritedOrders)} componentes associados à OP do grupo · {fmt(result.diagnostics.productHeaders)} cabeçalhos de produto separados · {fmt(result.diagnostics.kobWithoutMaterial)} lançamentos KOB1 sem material fora da comparação de peças.</p><p>Para cada OP + material: soma Qtd.total entrada da KOB1 − soma BOM QTY da ZPP009. Estornos mantêm o sinal. Dentro de uma OP presente nas duas fontes, um material sem lançamento tem soma zero. Quando a OP inteira não tem materiais em uma fonte, a conclusão fica suspensa.</p><p>Planning QTY e Issued QTY não substituem BOM QTY. O status da COOIS não altera quantidades. Peças fisicamente montadas, OPs finalizadas e documentos de consumo são informações diferentes.</p><p>Valor da diferença = diferença × referência unitária. A MM60 tem prioridade; custo ÷ quantidade da KOB1/ZPP009 é identificado como estimativa. Bases incompletas não entram nos totais financeiros.</p></details>
  </>}
 </section>;
}
