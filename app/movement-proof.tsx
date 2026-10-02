import type {Dataset,Row} from '@/lib/materials';
import {movementKey} from '@/lib/mb51-evidence';
const fmt=(n:number|null|undefined)=>n===null||n===undefined?'—':n.toLocaleString('pt-BR',{maximumFractionDigits:3});
function date(value:string){const parts=value.match(/^Date\((\d{4}),(\d+),(\d+)/);return parts?`${parts[3].padStart(2,'0')}/${String(Number(parts[2])+1).padStart(2,'0')}/${parts[1]}`:value||'Sem data';}
export default function MovementProof({row,data}:{row:Row;data:Dataset}){
 const evidence=data.mb51Evidence?.[movementKey(row.material,row.op)];
 return <details className="movement-proof"><summary>Ver lançamentos e cálculo</summary><div>
  <p><b>Material {row.material} · OP {row.op}</b></p>
  <p>BOM: {data.name} · {data.revision}. Previsto: <b>{fmt(row.required)} {row.unit}</b>.</p>
  {evidence?<>
   <p>Saídas 261: <b>{fmt(evidence.issued)}</b> − estornos 262: <b>{fmt(evidence.reversed)}</b> = <b>{evidence.issue?'a conferir':fmt(evidence.net)} {row.unit}</b> na MB51.</p>
   {evidence.issue&&<p className="proof-warning">{evidence.issue}</p>}
   {!evidence.units.length&&<p>A MB51 não informou a unidade básica. A unidade exibida é a da BOM; nenhuma conversão foi feita.</p>}
   {evidence.count>0&&evidence.net===0&&!evidence.issue&&<p className="proof-warning">Os lançamentos desta extração se anulam. Confira se existe novo apontamento ou troca de código no SAP.</p>}
   <ul>{evidence.documents.map((doc,index)=><li key={index}><b>{doc.type==='261'?'Consumo 261':'Estorno 262'} · {fmt(doc.quantity)} {row.unit}</b><span>Documento {doc.document||'não informado'} · item {doc.item||'—'} · {date(doc.date)} · depósito {doc.depot||'—'}</span></li>)}</ul>
   <p>{evidence.count} lançamento(s) único(s) para a chave; {evidence.duplicates} cópia(s) ignorada(s). {evidence.count>evidence.documents.length?`Amostra de ${evidence.documents.length} documentos; a soma inclui todos.`:''}</p>
  </>:<p className="proof-warning">Nenhum lançamento 261/262 deste material nesta OP foi localizado na MB51 consultada. Isso não comprova falta física: confira código, revisão da BOM e período da extração.</p>}
  <p>SCRAP: {row.scrapMessage} Ajuste aplicado: <b>{fmt(row.scrapAdjustment??row.scrapApplied??0)} {row.unit}</b>.</p>
  <p>Diferença nesta base: máximo(previsto − consumo efetivo, 0) = <b>{fmt(row.pending)} {row.unit}</b>.</p>
  <p>Fonte consultada: {data.updatedAt?new Date(data.updatedAt).toLocaleString('pt-BR'):'sem data confirmada'}. O saldo dos depósitos não altera os lançamentos SAP.</p>
 </div></details>;
}
