import * as XLSX from 'xlsx';
import {convert,pick,type Dataset,type Row} from './materials.ts';
import {joinExcelMB51} from './excel-mb51.ts';
import {joinMB51,isOrderHeader} from './mb51.ts';
import {addFixedBomItems} from './bom-additions.ts';
export function table(book:XLSX.WorkBook,name:string,order=false){const matrix=XLSX.utils.sheet_to_json<any[]>(book.Sheets[name],{header:1,raw:true,defval:null});const index=matrix.findIndex(r=>r.some(c=>order?isOrderHeader(c):/^(material|sap|código|part number)$/i.test(String(c??'').trim())));if(index<0||index>20)return [];const keys=matrix[index].map(v=>String(v??'').trim());return matrix.slice(index+1).filter(r=>r.some(v=>v!==null&&v!=='')).map(r=>Object.fromEntries(keys.map((k,i)=>[k,r[i]])));}
export function assembleWorkbook(book:XLSX.WorkBook,base:Dataset){
 const mb=book.SheetNames.filter(n=>/mb\s*51/i.test(n));if(!mb.length)return null;if(mb.length!==1)throw Error('Mais de uma aba MB51 encontrada. Mantenha uma extração consolidada.');
 const boms=book.SheetNames.filter(n=>!/mb\s*51/i.test(n)&&(/bom/i.test(n)||/^consumo$/i.test(n.trim())||n.toUpperCase().includes(base.name.toUpperCase()))).map(name=>({name,data:convert(table(book,name),'consumo')})).filter(x=>x.data.rows.some(r=>r.required!==null)&&x.data.rows.some(r=>r.unit));
 const specific=boms.filter(x=>x.name.toUpperCase().includes(base.name.toUpperCase()));const candidates=specific.length?specific:boms.filter(x=>/^(bom|consumo)$/i.test(x.name.trim()));
 if(candidates.length!==1)throw Error('Para cruzar a MB51, falta identificar uma única aba BOM com SAP, quantidade prevista e unidade para '+base.name+'.');
 const chosen=candidates[0];let ops=chosen.data.ops;
 if(!ops.length){
  const orderSheets=book.SheetNames.filter(n=>/^(ordens|ops)(\b|[_ -])/i.test(n));const found=new Set<string>();
  for(const name of orderSheets)for(const r of table(book,name,true)){
   const model=String(pick(r,['Modelo','Model'])).trim();
   if(model?model.toUpperCase()!==base.name.toUpperCase():!name.toUpperCase().includes(base.name.toUpperCase()))continue;
   const op=String(pick(r,['Ordem','Ordem de produção','OP','Order'])).trim();if(/^\d{8,}$/.test(op))found.add(op);
  }
  ops=[...found];
 }
 if(!ops.length)throw Error('Falta a aba Ordens com colunas Modelo e Ordem, ou OPs no cabeçalho da BOM. Não é seguro usar ordens de outros modelos.');
 const result=joinExcelMB51(addFixedBomItems(chosen.data.rows,ops),ops,table(book,mb[0]));
 return {name:`${chosen.name} + ${mb[0]} · ${result.matched} movimentos`,rows:{rows:result.rows,ops:result.ops}};
}
