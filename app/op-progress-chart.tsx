import TableViewport from '@/components/table-viewport';
import {useDeferredValue,useEffect,useMemo,useRef,useState,type ReactNode} from 'react';
import type {Row} from '@/lib/materials';
import {PROGRESS_CLASSES,progressLabel,shortOpLabels,summarizeOpProgress,type ClassProgress} from '@/lib/op-progress';
import {OP_STATUS_LABELS,type OpStatuses} from '@/lib/op-status';
import {OpStatusButton,AllOpsOkButton,type OpStatusControls} from './op-status';

const COLORS={A:'#346775',B:'#d4aa39',C:'#dea077'};
const SIZE=16;
const count=(value:number)=>value.toLocaleString('pt-BR');
export default function OpProgressChart({rows,ops,revision,updatedAt,onSelect,statuses={},control,sourceReady=true,actions}:{rows:Row[];ops:string[];revision:string;updatedAt?:string;onSelect:(op:string)=>void;statuses?:OpStatuses;control:OpStatusControls;sourceReady?:boolean;actions?:ReactNode}){
 const [query,setQuery]=useState(''),[status,setStatus]=useState('all'),[page,setPage]=useState(0),[mode,setMode]=useState<'status'|'consumption'>('status');
 const chartArea=useRef<HTMLDivElement>(null);
 const [chartWidth,setChartWidth]=useState(0);
 const pageSize=chartWidth?Math.min(SIZE,Math.max(3,Math.floor((chartWidth-76)/68))):SIZE;
 const deferredQuery=useDeferredValue(query);
 const summary=useMemo(()=>summarizeOpProgress(rows,ops),[rows,ops]);
 const labels=useMemo(()=>shortOpLabels(summary.map(item=>item.op)),[summary]);
 const filtered=useMemo(()=>summary.filter(item=>item.op.includes(deferredQuery.trim())&&
  (status==='all'||status==='complete'&&item.complete||status==='pending'&&item.pending>0||status==='review'&&(item.review>0||item.unclassified>0)||status==='closed'&&statuses[item.op]?.status==='complete'||status==='waiting'&&statuses[item.op]?.status==='waiting'||status==='not_started'&&(!statuses[item.op]||statuses[item.op].status==='not_started'))),[summary,deferredQuery,status,statuses]);
 const operational=useMemo(()=>({closed:filtered.filter(item=>statuses[item.op]?.status==='complete').length,waiting:filtered.filter(item=>statuses[item.op]?.status==='waiting').length,notStarted:filtered.filter(item=>!statuses[item.op]||statuses[item.op].status==='not_started').length}),[filtered,statuses]);
 const totals=useMemo(()=>PROGRESS_CLASSES.map(name=>{
  const total:ClassProgress={total:0,done:0,pending:0,review:0,percent:null};
  for(const item of filtered)for(const field of ['total','done','pending','review'] as const)total[field]+=item.classes[name][field];
  total.percent=total.total&&total.review!==total.total?total.done/total.total*100:null;
  return {name,...total};
 }),[filtered]);
 const pages=Math.max(1,Math.ceil(filtered.length/pageSize)),current=Math.min(page,pages-1);
 const visible=filtered.slice(current*pageSize,(current+1)*pageSize);
 const unknown=filtered.reduce((sum,item)=>sum+item.review,0),unclassified=filtered.reduce((sum,item)=>sum+item.unclassified,0);
 const width=chartWidth||Math.max(720,visible.length*68+76),left=52,top=70,height=240,bottom=top+height,slot=(width-left-20)/Math.max(visible.length,1);
 const stamp=updatedAt&&Number.isFinite(Date.parse(updatedAt))?new Date(updatedAt).toLocaleString('pt-BR'):'Sem atualização confirmada';
 const hasRows=visible.length>0;
 useEffect(()=>{
  const element=chartArea.current;
  if(!element)return;
  const measure=()=>{const width=Math.floor(element.getBoundingClientRect().width);if(width>0)setChartWidth(width);};
  measure();
  const observer=typeof ResizeObserver==='undefined'?null:new ResizeObserver(measure);
  observer?.observe(element);window.addEventListener('resize',measure);
  return()=>{observer?.disconnect();window.removeEventListener('resize',measure);};
 },[hasRows,mode,control.loading]);
 useEffect(()=>{if(!sourceReady)setMode('status');},[sourceReady]);

 if(control.loading)return <div className="empty" role="status"><h3>Carregando o status das OPs…</h3></div>;
 return <section className="op-progress-panel" aria-label="Gráfico por OP">
  <div className="op-progress-heading"><div><p className="eyebrow">ACOMPANHAMENTO DA PRODUÇÃO</p><h3>Visão das ordens de produção</h3><p>BOM selecionada: {revision} · {mode==='status'?'Marcações compartilhadas do administrador':`MB51 consultada em ${stamp}`}</p></div><div className="op-progress-heading-side"><span className="op-progress-count">{count(filtered.length)} OPs</span>{actions}</div></div>
  <div className="op-progress-mode" role="group" aria-label="Tipo de acompanhamento"><button aria-pressed={mode==='status'} onClick={()=>{setMode('status');setStatus('all');setPage(0);}}>Status das OPs</button><button disabled={!sourceReady} title={!sourceReady?'Clique em Atualizar dados para consultar a MB51':undefined} aria-pressed={mode==='consumption'} onClick={()=>{setMode('consumption');setStatus('all');setPage(0);}}>Consumo por classe</button></div>
  <div className="op-progress-toolbar"><label>Buscar OP<input aria-label="Buscar OP no gráfico" placeholder="Digite o número ou final da OP" value={query} onChange={event=>{setQuery(event.target.value);setPage(0);}}/></label><label>Exibir<select aria-label="Situação das OPs no gráfico" value={status} onChange={event=>{setStatus(event.target.value);setPage(0);}}><option value="all">Todas as OPs</option><optgroup label="Status definido pela equipe"><option value="closed">Concluídas</option><option value="waiting">Aguardando Warehouse</option><option value="not_started">Não iniciadas / sem marcação</option></optgroup>{mode==='consumption'&&<optgroup label="Conferência BOM × MB51"><option value="pending">Com diferenças de consumo</option><option value="complete">Todos os materiais atendidos</option><option value="review">Com dados para conferir</option></optgroup>}</select></label><p>Clique na OP para consultar seus materiais.</p>{control&&<AllOpsOkButton ops={ops} control={control} bomLabel={revision}/>}</div>
  {mode==='status'?<>
   <div className="op-progress-totals operational-totals"><article className="status-complete"><span>Concluídas pela equipe</span><strong>{count(operational.closed)}</strong><small>OPs com conclusão registrada</small></article><article className="status-waiting"><span>Aguardando Warehouse</span><strong>{count(operational.waiting)}</strong><small>OPs marcadas em acompanhamento</small></article><article className="status-not_started"><span>Não iniciadas / sem marcação</span><strong>{count(operational.notStarted)}</strong><small>OPs sem conclusão registrada</small></article></div>
   <p className="op-progress-method">Ao marcar <b>Concluída</b>, a OP fica verde e 100% neste acompanhamento. <b>Aguardando Warehouse</b> fica amarela, sem uma quantidade de falta presumida. As marcações são compartilhadas com os demais usuários a cada 5 segundos com a aba visível, sem reler a planilha.</p>
  </>:<>
   <div className="op-progress-totals">{totals.map(item=><article key={item.name} style={{borderTopColor:COLORS[item.name]}}><span>Classe {item.name} · materiais atendidos</span><strong>{progressLabel(item)}</strong><small>{count(item.done)} de {count(item.total)} pares OP/material · {count(item.pending)} diferenças · {count(item.review)} conferir</small></article>)}</div>
   <p className="op-progress-method"><b>O que este percentual mede:</b> quantos materiais estão totalmente atendidos pela MB51 + SCRAP em relação à BOM selecionada. Ele não mede o fechamento da OP. Se a OP está concluída e o percentual é baixo, confira a revisão da BOM e o período da MB51 nos materiais da ordem.</p>
   {(unknown>0||unclassified>0)&&<p className="op-progress-warning">{count(unknown)} materiais/OP para conferir · {count(unclassified)} sem classe A/B/C. Os registros sem confirmação não são apresentados como 100%.</p>}
  </>}
  {mode==='status'&&visible.length>0&&<div className="op-status-figure">
   <div className="op-status-legend"><span className="status-complete">● Concluída · 100%</span><span className="status-waiting">● Aguardando Warehouse</span><span className="status-not_started">● Não iniciada / sem marcação</span></div>
   <div ref={chartArea} className="op-progress-scroll">
    <svg viewBox={`0 0 ${width} 270`} className="op-status-svg" role="img" aria-label="Conclusão de cada OP conforme marcação do administrador">
     {visible.map((item,index)=>{const state=statuses[item.op]?.status||'not_started',x=left+index*slot+slot/2,complete=state==='complete',color=complete?'#69caa0':state==='waiting'?'#e1c46b':'#d58287';return <g key={item.op} data-op={item.op} data-status={state} role="button" tabIndex={0} aria-label={`Abrir OP ${item.op}: ${OP_STATUS_LABELS[state]}`} onClick={()=>onSelect(item.op)} onKeyDown={event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();onSelect(item.op);}}}>
      <title>OP {item.op}: {OP_STATUS_LABELS[state]}</title>
      <rect x={x-22} y={36} width={44} height={168} rx={5} fill={complete?color:'transparent'} stroke={color} strokeDasharray={complete?undefined:'4 5'}/>
      <text x={x} y={24} textAnchor="middle" fill={color} fontSize={13} fontWeight={700}>{complete?'100%':'—'}</text>
      <text x={x} y={126} textAnchor="middle" fill={complete?'#102a20':color} fontSize={complete?26:12}>{complete?'✓':state==='waiting'?'Espera':'Aberta'}</text>
      <text x={x} y={228} textAnchor="middle" fill="#e4edf5" fontSize={12}>{labels.get(item.op)}</text>
     </g>;})}
     <text x={width/2} y={258} textAnchor="middle" fill="#a5b0be" fontSize={11}>Final da OP · conclusão informada pelo administrador</text>
    </svg>
   </div>
  </div>}
  {mode==='consumption'&&visible.length>0&&<div className="op-progress-paper">
   <div className="op-progress-legend">{PROGRESS_CLASSES.map(name=><span key={name}><i style={{backgroundColor:COLORS[name]}}/>Classe {name}</span>)}<span>Percentual de materiais atendidos</span></div>
   <div ref={chartArea} className="op-progress-scroll">
    <svg xmlns="http://www.w3.org/2000/svg" viewBox={`0 0 ${width} 386`} className="op-progress-svg" aria-label="Percentual de materiais com consumo atendido por ordem e classe" fontFamily="Arial, sans-serif">
     {[0,25,50,75,100].map(tick=>{const y=bottom-height*tick/100;return <g key={tick}><line x1={left} x2={width-20} y1={y} y2={y} stroke="#dce2e7" strokeDasharray={tick?'3 4':undefined}/><text x={left-10} y={y+4} textAnchor="end" fontSize="10" fill="#576573">{tick}%</text></g>;})}
     {visible.map((item,index)=>{const x=left+index*slot+slot/2;return <g className="op-progress-group" key={item.op} role="button" tabIndex={0} aria-label={`Abrir OP ${item.op}: ${item.done} materiais atendidos, ${item.pending} diferenças SAP, ${item.review} para conferir`} onClick={()=>onSelect(item.op)} onKeyDown={event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();onSelect(item.op);}}}>
      <rect className="op-progress-target" x={x-slot/2+2} y={8} width={slot-4} height={350} rx="4" fill="transparent"/>
      {PROGRESS_CLASSES.map((name,i)=>{const group=item.classes[name],barHeight=height*(group.percent??0)/100,barX=x+(i-1)*16-6.5,y=bottom-barHeight;return <g key={name}><title>{`OP ${item.op} · Classe ${name}: ${progressLabel(group)} · ${group.done} de ${group.total} atendidos · ${group.pending} diferenças SAP · ${group.review} conferir`}</title><rect x={barX} y={barHeight?y:bottom-2} width={13} height={Math.max(barHeight,2)} fill={group.percent!==null?COLORS[name]:'#cbd2d9'} opacity={group.percent!==null?1:0.55}/><text transform={`translate(${barX+10},${y-6}) rotate(-90)`} fontSize="10" fill="#364350">{progressLabel(group)}</text>{group.review>0&&<circle cx={barX+6.5} cy={bottom+9} r="2.5" fill="#a45e09"/>}</g>;})}
      <text x={x} y={bottom+28} textAnchor="middle" fontSize="10" fontWeight="600" fill="#24323f">{labels.get(item.op)}</text>
      <text x={x} y={bottom+43} textAnchor="middle" fontSize="9" fill={statuses[item.op]?.status==='complete'?'#267854':'#657481'}>{statuses[item.op]?.status==='complete'?'Concluída*':item.complete?'BOM atendida':item.review>0?'Conferir':item.total?'':'Sem itens'}</text>
     </g>;})}
     <text x={width/2} y={381} textAnchor="middle" fontSize="11" fill="#576573">Final da ordem de produção · clique para abrir a OP</text>
    </svg>
   </div>
   <p className="op-progress-caption">* Concluída = status registrado pela equipe. Barras = conferência dos materiais contra a BOM selecionada.</p>
  </div>}
  {!visible.length&&<div className="empty"><h3>Nenhuma OP neste filtro</h3><p>Altere a busca ou a situação selecionada.</p></div>}
  <div className="table-footer op-progress-pagination"><span>{visible.length?`${current*pageSize+1}–${current*pageSize+visible.length} de ${count(filtered.length)} OPs`:'0 OPs'} · até {pageSize} por página</span><div><button disabled={current===0} onClick={()=>setPage(current-1)} aria-label="OPs anteriores no gráfico">Anterior</button><span>{current+1} / {pages}</span><button disabled={current+1>=pages} onClick={()=>setPage(current+1)} aria-label="Próximas OPs no gráfico">Próxima</button></div></div>
  <div className="op-manual-summary op-status-board" aria-label="Status manual das OPs">{visible.map(item=>{const saved=statuses[item.op],state=saved?.status||'not_started';return <article className={`op-status-tile status-${state}`} key={item.op} data-op={item.op}>
   <button className="op-tile-open" onClick={()=>onSelect(item.op)}><b>OP {item.op}</b><span>{state==='complete'?'✓ 100% · Finalizada':'Abrir materiais →'}</span></button>
   <OpStatusButton op={item.op} control={control}/>
   <small>{saved?'Salvo em '+new Date(saved.updatedAt).toLocaleString('pt-BR'):'Sem marcação salva'}</small>
  </article>;})}</div>
  {mode==='consumption'&&<>
   <p className="op-progress-method"><b>Conferência SAP:</b> Material + Ordem · movimentos 261 − 262 + SCRAP conciliado. Estes percentuais usam os lançamentos, sem alterar as quantidades quando a equipe encerra a OP. Saldo 7000/2000 não aumenta consumo SAP.</p>
   {visible.length>0&&<details className="op-progress-values"><summary>Ver números da conferência SAP</summary><TableViewport className="shortage-scroll" label="Números do gráfico"><table><thead><tr>{['OP','Status manual','Classe','Atendidos','Total previsto','Diferenças SAP','Conferir','Percentual'].map(header=><th key={header}>{header}</th>)}</tr></thead><tbody>{visible.flatMap(item=>PROGRESS_CLASSES.map(name=>{const group=item.classes[name],state=statuses[item.op]?.status||'not_started';return <tr key={item.op+name}><td><button onClick={()=>onSelect(item.op)}>OP {item.op}</button></td><td><span className={`op-status-text status-${state}`}>{OP_STATUS_LABELS[state]}</span></td><td>{name}</td><td>{group.done}</td><td>{group.total}</td><td>{group.pending}</td><td>{group.review}</td><td>{progressLabel(group)}</td></tr>;}))}</tbody></table></TableViewport></details>}
  </>}
 </section>;
}
