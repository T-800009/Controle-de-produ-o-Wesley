import {useDeferredValue,useMemo,useState} from 'react';
import {Download,PackageCheck,Truck,ClipboardList} from 'lucide-react';
import TableViewport from '@/components/table-viewport';
import type {Dataset,Row} from '@/lib/materials';
import {warehouseReport,warehouseExportRows,WAREHOUSE_LABELS,type WarehouseItem} from '@/lib/warehouse';
import type {OpStatuses} from '@/lib/op-status';

const fmt=(value:number|null)=>value===null?'—':value.toLocaleString('pt-BR',{maximumFractionDigits:3});
const stamp=(value?:string)=>value&&Number.isFinite(Date.parse(value))?new Date(value).toLocaleString('pt-BR'):'Sem leitura confirmada';

export default function Warehouse({rows,data,stocks,statuses,checks,ready,onSelect}:{rows:Row[];data:Dataset;stocks:(Dataset|null)[];statuses:OpStatuses;checks:Record<string,boolean>;ready:boolean;onSelect:(op:string)=>void}){
 const [query,setQuery]=useState(''),[filter,setFilter]=useState('all'),[selectedClass,setSelectedClass]=useState('all'),[page,setPage]=useState(0),[exporting,setExporting]=useState(false),[error,setError]=useState('');
 const deferredQuery=useDeferredValue(query);
 const classLabel=selectedClass==='all'?'Todas as classes':selectedClass==='AB'?'Classes A + B':`Classe ${selectedClass}`;
 const report=useMemo(()=>warehouseReport(rows,statuses,checks),[rows,statuses,checks]);
 const filtered=useMemo(()=>{
  const text=deferredQuery.trim().toLowerCase();
  return report.items.filter(item=>(selectedClass==='all'||(selectedClass==='AB'?item.classes.some(cls=>cls==='A'||cls==='B'):item.classes.includes(selectedClass)))&&(filter==='all'||filter==='request'&&item.request!==null&&item.request>0||filter===item.state)&&`${item.material} ${item.description} ${item.ops.join(' ')}`.toLowerCase().includes(text));
 },[report,deferredQuery,filter,selectedClass]);
 const countRequest=filtered.filter(item=>item.request!==null&&item.request>0).length;
 const countCovered=filtered.filter(item=>item.state==='covered').length;
 const countReview=filtered.filter(item=>item.state==='review').length;
 const openOps=useMemo(()=>new Set(filtered.flatMap(item=>item.ops)).size,[filtered]);
 const hasFilters=!!query.trim()||filter!=='all'||selectedClass!=='all';
 function clearFilters(){setQuery('');setFilter('all');setSelectedClass('all');setPage(0);}
 const pages=Math.max(1,Math.ceil(filtered.length/25)),current=Math.min(page,pages-1);
 async function exportExcel(){
  setExporting(true);setError('');
  try{
   const x=await import('xlsx'),book=x.utils.book_new(),output=warehouseExportRows(filtered,statuses);
   const totals=x.utils.json_to_sheet(output.totals),detail=x.utils.json_to_sheet(output.details);
   totals['!cols']=[18,42,8,10,22,16,18,25,16,24,25,22,55,45].map(wch=>({wch}));
   detail['!cols']=[20,18,42,10,9,16,19,19,20,30,28].map(wch=>({wch}));
   for(const sheet of [totals,detail])if(sheet['!ref'])sheet['!autofilter']={ref:sheet['!ref']};
   x.utils.book_append_sheet(book,totals,'Total_por_Item');
   x.utils.book_append_sheet(book,detail,'Falta_por_OP');
   const criteria=x.utils.aoa_to_sheet([
    ['Resumo para o Warehouse / Lougas','MB51-61'],['BOM ativa',data.name+' · '+data.revision],['Gerado em',new Date().toLocaleString('pt-BR')],
    ['MB51',data.source,stamp(data.updatedAt)],['7000',stocks[0]?.source||'Indisponível',stamp(stocks[0]?.updatedAt)],
    ['2000',stocks[1]?.source||'Indisponível',stamp(stocks[1]?.updatedAt)],['1500 (referência)',stocks[2]?.source||'Indisponível',stamp(stocks[2]?.updatedAt)],
    ['Escopo','Todas as OPs da BOM ativa. Não inclui outras revisões.'],
    ['Consolidação','Material + unidade; saldos contados uma única vez para o total das OPs abertas.'],
    ['Falta SAP','BOM − consumo efetivo MB51/SCRAP, mínimo zero. Diferença de apontamento não comprova falta física.'],
    ['Solicitar do 2000','Máximo(demanda consolidada − disponível 7000, 0).'],
    ['Pode transferir','Mínimo(solicitação, disponível 2000). Reposição = solicitação − pode transferir.'],
    ['1500','Informativo; não abate a solicitação.'],['Sem leitura','Célula vazia/— = saldo desconhecido, nunca zero presumido.'],
    ['Marcações','OP concluída e item OK pelo administrador não entram na solicitação. Os lançamentos SAP não são alterados.'],
    ['Excluídos',`${report.closedOps} OPs concluídas; ${report.checkedItems} itens OK; ${report.reviewItems} itens sem conciliação confiável.`],
    ['Filtros',filter,query],['Classe selecionada',classLabel],['Filtro de OP','Localiza materiais; os totais mantêm a demanda de todas as OPs abertas da BOM.'],
    ['Detalhe por OP','A quantidade é a diferença SAP da OP. Veja o saldo compartilhado e a solicitação somente em Total_por_Item.'],
    ['Reserva','Esta consulta não reserva nem movimenta estoque.'],
   ]);
   criteria['!cols']=[{wch:26},{wch:110},{wch:26}];x.utils.book_append_sheet(book,criteria,'Criterios');
   x.writeFile(book,`Resumo_Warehouse_${data.revision.replace(/[^a-z0-9-]/gi,'_')}.xlsx`);
  }catch(e){setError('Não foi possível exportar o resumo. '+(e as Error).message);}
  finally{setExporting(false);}
 }
 if(!ready)return <div className="empty warehouse-wait" role="status"><h3>Conferindo as marcações compartilhadas…</h3><p>O resumo aguarda os status das OPs e os itens OK para evitar solicitações já encerradas.</p></div>;
 return <section className="warehouse-panel" aria-label="Resumo consolidado para o Warehouse">
  <div className="warehouse-heading"><div><p className="eyebrow">TODAS AS OPs DA BOM ATIVA</p><h3>Uma lista para o Warehouse</h3><p>Materiais, quantidades e ordens reunidos para o Lougas.</p></div><button className="primary" disabled={exporting||!filtered.length} onClick={exportExcel}><Download size={16}/>{exporting?'Exportando…':'Baixar planilha para o Lougas'}</button></div>
  {error&&<p className="notice" role="alert">{error}</p>}
  <div className="warehouse-filter-panel" role="search" aria-label="Filtros do Warehouse">
   <div className="warehouse-filter-heading"><b>Encontre os materiais</b><button className="warehouse-clear-filters" disabled={!hasFilters} onClick={clearFilters}>Limpar filtros</button></div>
   <div className="warehouse-filters">
    <label>Material ou OP<input aria-label="Buscar no resumo Warehouse" placeholder="Código SAP, descrição ou ordem" value={query} onChange={e=>{setQuery(e.target.value);setPage(0);}}/></label>
    <label>Classe<select aria-label="Classe no Warehouse" value={selectedClass} onChange={e=>{setSelectedClass(e.target.value);setPage(0);}}><option value="all">Todas as classes</option>{['A','B','C','AB'].map(value=><option key={value} value={value}>{value==='AB'?'Classes A + B':`Classe ${value}`}</option>)}</select></label>
    <label>Situação<select aria-label="Situação no Warehouse" value={filter} onChange={e=>{setFilter(e.target.value);setPage(0);}}><option value="all">Todos os materiais</option><option value="request">Solicitar ao Warehouse</option><option value="covered">Já tem no 7000</option><option value="review">Conferir saldos</option></select></label>
   </div>
   <div className="warehouse-filter-summary" aria-live="polite"><span><b>{fmt(filtered.length)}</b> materiais encontrados</span><span>{classLabel} · indicadores e Excel acompanham o filtro</span></div>
  </div>
  <div className="warehouse-metrics">
   <article><Truck size={19}/><span>Materiais para solicitar</span><strong>{fmt(countRequest)}</strong><small>somente o restante após consultar o 7000</small></article>
   <article><PackageCheck size={19}/><span>Materiais cobertos no 7000</span><strong>{fmt(countCovered)}</strong><small>não precisam de transferência do 2000</small></article>
   <article><ClipboardList size={19}/><span>OPs no filtro</span><strong>{fmt(openOps)}</strong><small>ordens abertas com diferença de consumo</small></article>
   <article><span>Saldos para conferir</span><strong>{fmt(countReview)}</strong><small>quantidade de solicitação ainda não confirmada</small></article>
  </div>
  <details className="warehouse-criteria"><summary>Fontes e critérios do resumo<span>7000 primeiro → 2000 para o restante</span></summary><div><p><b>7000 primeiro.</b> O saldo de cada material é contado uma vez para todas as OPs desta BOM. Do 2000, solicitar apenas o restante. O 1500 é referência.</p><p>{report.closedOps} OPs concluídas e {report.checkedItems} itens OK retirados da solicitação. {report.reviewItems>0?`${report.reviewItems} itens sem conciliação confiável estão em Conferir dados.`:'As diferenças de consumo continuam disponíveis na conferência SAP.'}</p><small>MB51: {stamp(data.updatedAt)} · 7000: {stamp(stocks[0]?.updatedAt)} · 2000: {stamp(stocks[1]?.updatedAt)}</small></div></details>

  {query.trim()&&<p className="warehouse-filter-note">A busca localiza materiais. Cada total continua incluindo todas as OPs abertas da BOM, inclusive as ordens listadas no detalhe.</p>}
  {selectedClass!=='all'&&filtered.some(item=>item.classes.length>1)&&<p className="warehouse-filter-note">Materiais presentes em mais de uma classe mantêm o total consolidado das OPs. Confira as classes indicadas na linha.</p>}
  <div className="warehouse-list-heading"><div><h4>Materiais e ordens</h4><p>Abra o detalhe do material para consultar as quantidades por OP.</p></div><span>{classLabel}</span></div>
  {!filtered.length?<div className="empty"><h3>{hasFilters?'Nenhum material neste filtro':'Nenhuma solicitação nesta BOM'}</h3><p>{report.reviewItems?'Confira os dados pendentes antes de concluir que não existe falta.':'OPs concluídas e itens marcados como OK ficam fora desta lista.'}</p></div>:<TableViewport className="warehouse-table" label="Faltas consolidadas para o Warehouse"><table><thead><tr>{['Material / OPs','Classe · UM','Falta apontar SAP','Saldo 7000','Solicitar ao Warehouse','Saldo 2000','Situação'].map(label=><th key={label}>{label}</th>)}</tr></thead><tbody>{filtered.slice(current*25,current*25+25).map(item=><WarehouseRow key={item.key} item={item} onSelect={onSelect}/>)}</tbody></table></TableViewport>}
  <div className="table-footer"><span>O Excel inclui todos os {filtered.length} materiais deste filtro, não apenas esta página.</span><div><button disabled={current===0} onClick={()=>setPage(current-1)}>Anterior</button><span>{current+1} / {pages}</span><button disabled={current+1>=pages} onClick={()=>setPage(current+1)}>Próxima</button></div></div>
 </section>;
}

function WarehouseRow({item,onSelect}:{item:WarehouseItem;onSelect:(op:string)=>void}){
 const [open,setOpen]=useState(false);
 return <tr className={'warehouse-'+item.state}>
  <td><b className="code">{item.material}</b><span className="description">{item.description||'Sem descrição'}</span><details open={open} onToggle={event=>setOpen(event.currentTarget.open)}><summary>{item.ops.length} OP(s) · ver quantidades</summary>{open&&<ul>{item.details.map(row=><li key={String(row.op)}><button onClick={()=>onSelect(String(row.op))}>OP {row.op}</button><span>{fmt(row.pending)} {item.unit} a apontar</span></li>)}</ul>}</details></td>
  <td><span className="warehouse-class-tags">{item.classes.map(cls=><b key={cls} className={'warehouse-class-tag class-'+cls}>{cls}</b>)}</span><small>{item.unit}</small></td><td className="num">{fmt(item.demand)}<small>{item.unit}</small></td>
  <td className="num">{fmt(item.s7000)}<small>Cobre {fmt(item.covered)} {item.unit}</small></td>
  <td className="num warehouse-request"><b className="warehouse-quantity">{fmt(item.request)}</b><small>{item.unit}</small></td>
  <td className="num">{fmt(item.s2000)}<small>Transfere {fmt(item.transfer)} {item.unit}</small></td>
  <td><span className="warehouse-badge">{WAREHOUSE_LABELS[item.state]}</span>{item.uncovered!==null&&item.uncovered>0&&<small>Reposição: {fmt(item.uncovered)} {item.unit} além do saldo 2000.</small>}<small>1500: {fmt(item.s1500)} {item.unit} · referência</small></td>
 </tr>;
}
