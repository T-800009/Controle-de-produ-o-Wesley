import {convert,validateRows,type Dataset,type Row} from './materials.ts';
import {mb51Columns} from './mb51-columns.ts';
import {joinExcelMB51} from './excel-mb51.ts';
import {convertScrap,auditScrapAgainstMB51} from './scrap.ts';
import {addFixedBomItems} from './bom-additions.ts';
import {stockColumns} from './stock-columns.ts';
import {stockModule} from './stock-modules.ts';

type SourcePayload={text:string;format:string|null;readAt:string;ok:boolean;status:number};
const sourceCache=new Map<string,{at:number;promise:Promise<SourcePayload>}>();
const SOURCE_CACHE_MS=30_000;

/** Deduplicates simultaneous reads and puts a hard upper bound on a stalled
 * browser request. The short cache only covers duplicate reads caused by two
 * visible panels during the same manual refresh. */
async function fetchSource(url:string):Promise<SourcePayload>{
 const now=Date.now(),cached=sourceCache.get(url);
 if(cached&&now-cached.at<SOURCE_CACHE_MS)return cached.promise;
 const promise=(async()=>{
  const response=await fetch(url,{signal:AbortSignal.timeout(30_000)});
  const text=await response.text();
  return {text,format:response.headers.get('X-Source-Format'),readAt:response.headers.get('X-Source-Read-At')||new Date().toISOString(),ok:response.ok,status:response.status};
 })();
 sourceCache.set(url,{at:now,promise});
 try{return await promise;}catch(error){if(sourceCache.get(url)?.promise===promise)sourceCache.delete(url);throw error;}
}

export function clearAutomaticCache(){sourceCache.clear();}
export function decodeSource(text:string,format:string|null,kind:string):Row[]{
 let matrix:any[][];
 if(format==='sheets-api'){
  const data=JSON.parse(text);if(!Array.isArray(data.valueRanges))throw Error('Resposta da planilha inválida.');
  if(kind==='consumo'||(stockModule(kind)&&data.valueRanges.length>1)){
   if(kind==='consumo'&&data.valueRanges.length<3)throw Error('Colunas da MB51 incompletas.');const cols=data.valueRanges.map((v:any)=>v.values||[]);
   matrix=Array.from({length:Math.max(...cols.map((c:any[])=>c.length))},(_,i)=>cols.map((c:any[])=>c[i]?.[0]??null));
  }else matrix=data.valueRanges[0]?.values||[];
 }else if(format==='gviz'){
  const match=text.match(/setResponse\(([\s\S]*)\);?\s*$/);if(!match)throw Error('O Google não retornou dados válidos. Confira a autorização da fonte.');const data=JSON.parse(match[1]);if(data.status==='error'||!data.table)throw Error(`Aba ou colunas indisponíveis (${kind}): ${(data.errors||[]).map((e:any)=>e.detailed_message||e.message||e.reason).join('; ')||'confira o nome da aba e seu cabeçalho'}.`);
  matrix=[data.table.cols.map((c:any)=>c.label||c.id),...data.table.rows.map((r:any)=>data.table.cols.map((_:any,i:number)=>r.c[i]?.v??null))];
 }else throw Error('Servidor e interface estão em versões diferentes. Publique o pacote completo MB51-61.');
 const [headers,...values]=matrix;if(!headers)throw Error('Fonte sem cabeçalho.');
 if(kind==='consumo'){const columns=mb51Columns(headers);return values.filter(r=>r.some(v=>v!==null&&v!=='' )).map(r=>Object.fromEntries(columns.map(c=>[c.name,r[c.index]??null])));}
 const stock=stockModule(kind);
 if(stock){
  const columns=stockColumns(headers,stock.sheet),hasDepot=columns.some(column=>column.name==='Depósito');
  return values.filter(row=>row.some(value=>value!==null&&value!==''))
   .map(row=>Object.fromEntries(columns.map(column=>[column.name,row[column.index]??null])))
   .filter(row=>!stock.depot||!hasDepot||String(row['Depósito']??'').trim().replace(/\.0+$/,'').replace(/^0+/,'')===stock.depot);
 }
 return values.filter(r=>r.some(v=>v!==null&&v!=='')).map(r=>Object.fromEntries(headers.map((h,i)=>[String(h),r[i]??null])));
}
function sourceError(response:SourcePayload){
 let message='Falha na atualização manual.';
 try{message=JSON.parse(response.text).error||message;}catch{if(response.text.includes('1102'))message='O servidor excedeu os recursos. Confira se a versão MB51-61 foi publicada.';}
 return Error(message);
}
/** Joins one BOM with MB51 movements already decoded. Same rules for every BOM. */
function joinConsumption(base:Dataset,movements:Row[]){
 const bomRows=addFixedBomItems(base.rows,base.ops||[]);
 const joined=joinExcelMB51(bomRows,base.ops||[],movements);
 const source=joined.formulaKey
  ?`Google Sheets · MB51 · Material + Ordem do SAP · ${joined.matched} movimentos 261/262 · ${joined.ignored} ignorados · ${joined.formulaFallbacks} chaves auxiliares corrigidas pelas colunas SAP · Tirreno 15 KG/OP`
  :`Google Sheets · MB51 · ${joined.matched} movimentos 261/262 · ${joined.ignored} ignorados · ${joined.duplicates} duplicatas removidas · ${joined.duplicateConflicts} conflitos · Tirreno 15 KG/OP`;
 validateRows(joined.rows,'consumo');
 return {joined,source};
}
/** SCRAP is optional: an absent tab is reported, never invented. */
async function readScrap(movements:Row[]):Promise<{scrap:Row[]|undefined;scrapSource:string}>{
 const scrapResponse=await fetchSource('/api/automatic?id=scrap');
 const scrapText=scrapResponse.text;
 if(!scrapResponse.ok){
  let message='A aba SCRAP não está disponível.';try{message=JSON.parse(scrapText).error||message;}catch{}
  if(scrapResponse.status===422||/aba scrap|scrap não está disponível/i.test(message))return {scrap:undefined,scrapSource:'SCRAP não configurada · duplicidades sem lançamento ficam em Conferir dados'};
  throw Error(message);
 }
 try{
  const scrapRows=decodeSource(scrapText,scrapResponse.format,'scrap');
  const scrap=convertScrap(auditScrapAgainstMB51(scrapRows,movements));
  return {scrap,scrapSource:`Google Sheets · SCRAP · ${scrap.length} lançamentos material/OP`};
 }catch(e){
  return {scrap:undefined,scrapSource:`SCRAP não configurada · ${(e as Error).message}`};
 }
}
function consumptionDataset(base:Dataset,part:ReturnType<typeof joinConsumption>,scrap:{scrap:Row[]|undefined;scrapSource:string},readAt:string):Dataset{
 const {joined,source}=part;
 return {...base,rows:joined.rows,ops:joined.ops,source,coois:undefined,cooisSource:undefined,scrap:scrap.scrap,scrapSource:scrap.scrapSource,mb51Mode:'movement-type',mb51OrderCoverage:joined.mb51OrderCoverage,mb51Evidence:joined.mb51Evidence,updatedAt:readAt||new Date().toISOString(),sheetId:undefined,sheetName:undefined};
}
export async function readAutomatic(base:Dataset):Promise<Dataset>{
 const kind=base.id.startsWith('consumo:')?'consumo':base.id;
 const response=await fetchSource('/api/automatic?id='+encodeURIComponent(base.id));
 if(!response.ok)throw sourceError(response);
 const rows=decodeSource(response.text,response.format,kind);
 if(kind==='consumo'){
  const part=joinConsumption(base,rows);
  return consumptionDataset(base,part,await readScrap(rows),response.readAt);
 }
 const result=convert(rows,kind);
 validateRows(result.rows,kind);
 return {...base,rows:result.rows,ops:result.ops,source:'Google Sheets · '+(stockModule(kind)?.sheet||kind),coois:undefined,cooisSource:undefined,scrap:undefined,scrapSource:'',mb51Mode:undefined,mb51OrderCoverage:undefined,mb51Evidence:undefined,updatedAt:response.readAt||new Date().toISOString(),sheetId:undefined,sheetName:undefined};
}
export type ConsumptionResult={id:string;data?:Dataset;error?:string};
/** 7000 × PROJETOS: one MB51 + SCRAP read reconciled with every BOM. The MB51
 * tab is the same for all BOMs; each BOM keeps its own OPs and errors. */
export async function readConsumptionMany(bases:Dataset[]):Promise<ConsumptionResult[]>{
 const boms=bases.filter(base=>base.id.startsWith('consumo:'));
 if(!boms.length)return [];
 const response=await fetchSource('/api/automatic?id='+encodeURIComponent(boms[0].id));
 if(!response.ok)throw sourceError(response);
 const movements=decodeSource(response.text,response.format,'consumo');
 const parts=boms.map(base=>{try{return {base,part:joinConsumption(base,movements)};}catch(e){return {base,error:(e as Error).message};}});
 const scrap=parts.some(item=>'part' in item)?await readScrap(movements):{scrap:undefined,scrapSource:''};
 return parts.map(item=>'part' in item&&item.part?{id:item.base.id,data:consumptionDataset(item.base,item.part,scrap,response.readAt)}:{id:item.base.id,error:(item as {error:string}).error});
}
