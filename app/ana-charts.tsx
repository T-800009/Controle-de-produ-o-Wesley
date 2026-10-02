import {useMemo,useState} from 'react';
import {ArrowUpRight,ChevronLeft,ChevronRight} from 'lucide-react';
import {orderFlagLabels,orderFlagColors,orderFlagOrder,type AnaOrderFlag,type AnaOrderOverview} from '@/lib/ana-overview';
const fmt=(n:number)=>n.toLocaleString('pt-BR');
const parts=['complete','shortage','excess','review','incomplete'] as const;
const partLabels={complete:'Sem diferenças',shortage:'Abaixo da BOM',excess:'Acima da BOM',review:'Conferir dados',incomplete:'Base incompleta'};
type Props={orders:AnaOrderOverview[];selected:string;flag:AnaOrderFlag|'all';onSelect:(op:string)=>void;onFlag:(flag:AnaOrderFlag|'all')=>void};

export default function AnaCharts({orders,selected,flag,onSelect,onFlag}:Props){
 const [page,setPage]=useState(0);
 const counts=useMemo(()=>Object.fromEntries(orderFlagOrder.map(key=>[key,orders.filter(op=>op.flag===key).length])) as Record<AnaOrderFlag,number>,[orders]);
 const list=useMemo(()=>orders.filter(op=>(flag==='all'||op.flag===flag)&&(selected==='all'||selected===op.op)),[orders,flag,selected]);
 const pages=Math.max(1,Math.ceil(list.length/6)),current=Math.min(page,pages-1),visible=list.slice(current*6,current*6+6);
 let offset=0;
 const selectedOrder=orders.find(op=>op.op===selected);
 return <section className="ana-charts" id="ana-panorama" aria-label="Gráficos do Check Ana">
  <article className="panel ana-order-chart"><header><p className="eyebrow">PANORAMA DAS ORDENS</p><h3>O que precisa de atenção?</h3><p>Visão de todas as OPs da leitura. Clique na legenda para filtrar.</p></header>
   <div className="ana-donut-layout"><svg viewBox="0 0 180 180" role="img" aria-label={orderFlagOrder.map(key=>`${orderFlagLabels[key]}: ${counts[key]} ordens`).join('. ')}>
    <circle cx="90" cy="90" r="68" fill="none" stroke="#ffffff10" strokeWidth="18"/>
    {orderFlagOrder.map(key=>{const length=counts[key]/Math.max(orders.length,1)*100,start=offset;offset+=length;return length>0?<circle key={key} cx="90" cy="90" r="68" pathLength="100" fill="none" stroke={orderFlagColors[key]} strokeWidth="18" strokeDasharray={`${length} ${100-length}`} strokeDashoffset={-start} transform="rotate(-90 90 90)"><title>{orderFlagLabels[key]}: {counts[key]} OPs</title></circle>:null;})}
    <text x="90" y="87" textAnchor="middle" className="ana-donut-number">{fmt(orders.length)}</text><text x="90" y="109" textAnchor="middle" className="ana-donut-label">ORDENS</text>
   </svg><div className="ana-chart-legend">{orderFlagOrder.map(key=><button key={key} type="button" aria-pressed={flag===key} onClick={()=>{setPage(0);onFlag(flag===key?'all':key);}}><i style={{background:orderFlagColors[key]}}/><span>{orderFlagLabels[key]}</span><b>{fmt(counts[key])}</b></button>)}</div></div>
   <div className="ana-chart-explanation"><i/>Amarelo: há apontamento na COOIS, mas o consumo na KOB1 está abaixo da BOM. O check não altera as quantidades.</div>
  </article>
  <article className="panel ana-components-chart"><header><div><p className="eyebrow">CONFERÊNCIA DOS COMPONENTES</p><h3>Materiais por ordem</h3><p>Selecione uma OP para abrir os materiais e as observações. As barras mostram a comparação documental.</p></div>{selected!=='all'&&<button onClick={()=>onSelect('all')}>Todas as OPs</button>}</header>
   <div className="ana-component-legend">{parts.map(key=><span key={key}><i className={'ana-part '+key}/>{partLabels[key]}</span>)}</div>
   <div className="ana-op-bars">{visible.map(op=><button type="button" key={op.op} className={'ana-op-bar '+op.flag} aria-pressed={selected===op.op} onClick={()=>onSelect(op.op)} aria-label={`OP ${op.op}. ${orderFlagLabels[op.flag]}. ${op.complete} sem diferenças de ${op.total} materiais. Abrir conferência e observações.`}>
    <span className="ana-op-card-top"><span className="ana-op-bar-label"><b>OP {op.op}</b><small>{orderFlagLabels[op.flag]}</small></span><span className="ana-op-card-total"><b>{fmt(op.total)}</b><small>materiais</small></span><ArrowUpRight size={17} aria-hidden="true"/></span>
    <span className="ana-bar-content"><span className="ana-bar-track" aria-hidden="true">{parts.map(key=>op[key]>0&&<i key={key} className={'ana-part '+key} style={{width:op[key]/Math.max(op.total,1)*100+'%'}} title={`${partLabels[key]}: ${op[key]}`}/>)}</span><span className="ana-bar-values">{parts.filter(key=>op[key]>0).map(key=><span className={'ana-count '+key} key={key}><i className={'ana-part '+key} aria-hidden="true"/><b>{fmt(op[key])}</b><span>{partLabels[key]}</span></span>)}</span></span>
   </button>)}{!visible.length&&<p>Nenhuma OP nesta situação.</p>}</div>
   <div className="ana-chart-pagination"><span>{list.length?`${current*6+1}–${Math.min((current+1)*6,list.length)} de ${fmt(list.length)} OPs`:'Nenhuma OP no filtro'}</span><div><button disabled={current===0} onClick={()=>setPage(current-1)} aria-label="OPs anteriores"><ChevronLeft size={16}/></button><span>{current+1} / {pages}</span><button disabled={current+1>=pages} onClick={()=>setPage(current+1)} aria-label="Próximas OPs"><ChevronRight size={16}/></button></div></div>
  </article>
  {selectedOrder&&<div className={'ana-selected-order panel '+selectedOrder.flag}><div><span>OP {selectedOrder.op}</span><b>{orderFlagLabels[selectedOrder.flag]}</b><p>{selectedOrder.confirmation||'Sem evidência de apontamento nesta leitura da COOIS'}</p></div><div><b>{fmt(selectedOrder.complete)} / {fmt(selectedOrder.total)}</b><span>materiais sem diferenças</span></div><p>{selectedOrder.incomplete?'Base incompleta: conclusão suspensa.':`${fmt(selectedOrder.shortage)} abaixo da BOM · ${fmt(selectedOrder.excess)} acima · ${fmt(selectedOrder.review)} a conferir.`}</p></div>}
 </section>;
}
