import {buildAnaCheck,type AnaSummary} from './ana-check.ts';
import {anaReader,type AnaSource} from './ana-columns.ts';

type SourcePayload={text:string;format:string|null;readAt:string;ok:boolean;status:number};
const cache=new Map<string,{at:number;promise:Promise<SourcePayload>}>();
const CACHE_MS=5_000;

async function fetchSource(sheet:string):Promise<SourcePayload>{
 const url='/api/ana-source?sheet='+encodeURIComponent(sheet),now=Date.now(),cached=cache.get(url);
 if(cached&&now-cached.at<CACHE_MS)return cached.promise;
 const promise=(async()=>{const response=await fetch(url,{signal:AbortSignal.timeout(sheet==='MM60'||sheet==='COOIS'?15_000:45_000)});const text=await response.text();return {text,format:response.headers.get('X-Source-Format'),readAt:response.headers.get('X-Source-Read-At')||new Date().toISOString(),ok:response.ok,status:response.status};})();
 cache.set(url,{at:now,promise});
 try{return await promise;}catch(e){if(cache.get(url)?.promise===promise)cache.delete(url);throw e;}
}

export function clearAnaCache(){cache.clear();}

export function decodeAnaSource(text:string,format:string|null,sheet:string):any[]{
 if(format==='sheets-api'){
  const body=JSON.parse(text),ranges=Array.isArray(body.valueRanges)?body.valueRanges:[];
  if(!ranges.length)throw Error(`A aba ${sheet} retornou vazia.`);
  const columns=ranges.map((range:any)=>Array.isArray(range.values)?range.values:[]),headers=columns.map((column:any[],index:number)=>String(column[0]?.[0]??`coluna_${index+1}`));
  const length=Math.max(0,...columns.map((column:any[])=>column.length));
  return Array.from({length:Math.max(0,length-1)},(_,rowIndex)=>Object.fromEntries(headers.map((header:string,columnIndex:number)=>[header,columns[columnIndex]?.[rowIndex+1]?.[0]??null])));
 }
 if(format==='gviz'){
  const match=text.match(/setResponse\(([\s\S]*)\);?\s*$/);if(!match)throw Error(`O Google não retornou dados válidos para ${sheet}.`);
  const body=JSON.parse(match[1]);if(body.status==='error'||!body.table)throw Error(`A aba ${sheet} retornou um erro do Google.`);
  const headers=body.table.cols.map((column:any,index:number)=>String(column.label||column.id||`coluna_${index+1}`));
  return body.table.rows.map((row:any)=>Object.fromEntries(headers.map((header:string,index:number)=>[header,row.c?.[index]?.v??null])));
 }
 throw Error(`Formato de leitura desconhecido para ${sheet}.`);
}

export async function readAnaCheck():Promise<AnaSummary&{warnings:string[]}>{
 const sheets=['KOB1','ZPP009','MM60','COOIS'];
 const sources=await Promise.allSettled(sheets.map(fetchSource));
 const warnings:string[]=[];
 const rows:any[][]=[],readAt:string[]=[];
 for(const [index,source] of sources.entries()){
  const sheet=sheets[index];
  try{
   if(source.status==='rejected')throw Error(`A leitura da aba ${sheet} falhou ou excedeu o tempo de espera.`);
   const payload=source.value;
   if(!payload.ok){let message=`Falha na leitura da aba ${sheet}.`;try{message=JSON.parse(payload.text).error||message;}catch{}throw Error(message);}
   const decoded=decodeAnaSource(payload.text,payload.format,sheet);
   if(!decoded.some(row=>Object.values(row).some(value=>value!==null&&String(value).trim()!=='')))throw Error(`A aba ${sheet} está vazia.`);
   // Validate optional headers here too, so a bad MM60 cannot block quantities.
   anaReader(decoded,sheet as AnaSource);
   rows[index]=decoded;readAt.push(payload.readAt);
  }catch(e){
   if(index<2)throw e;
   rows[index]=[];
   warnings.push(sheet==='MM60'?'MM60 indisponível: o valor da diferença usa o custo por unidade da KOB1 ou ZPP009, quando calculável, identificado como estimativa.':'COOIS indisponível: as quantidades foram conferidas sem o status da ordem.');
  }
 }
 // Let the loading state paint before the indexed, local reconciliation.
 await new Promise(resolve=>setTimeout(resolve,0));
 const result=buildAnaCheck(rows[0],rows[1],rows[2],rows[3]);
 if(!result.rows.length)throw Error('Não foram encontrados materiais com OP nas abas KOB1 e ZPP009. Confira se o export contém os componentes.');
 const d=result.diagnostics;
 if(d.kobWithoutOrder||d.zppWithoutOrder)warnings.push(`${d.kobWithoutOrder+d.zppWithoutOrder} linhas com material ficaram sem OP e não entraram no cálculo. Inclua o início de cada grupo no export.`);
 if(d.invalidQuantities)warnings.push(`${d.invalidQuantities} quantidades vazias ou inválidas: os materiais afetados aparecem em Conferir dados, sem cálculo de falta.`);
 if(d.zppWithoutMaterial)warnings.push(`${d.zppWithoutMaterial} linhas da ZPP009 não têm código de material e não entraram no cálculo.`);
 return {...result,readAt:readAt.sort().at(-1),warnings};
}
