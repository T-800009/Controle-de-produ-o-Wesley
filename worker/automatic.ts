import {googleToken,type GoogleEnv} from './google-auth.ts';
import {mb51Columns,columnLetter} from '../lib/mb51-columns.ts';
import {cooisHeaders} from '../lib/coois.ts';
import {SHEET_ID} from '../lib/materials.ts';
import {anaColumns,type AnaSource} from '../lib/ana-columns.ts';
import {stockColumns} from '../lib/stock-columns.ts';
import {stockModule} from '../lib/stock-modules.ts';
import {WRITE_OFF_SHEETS,isWriteOffHeader} from '../lib/write-offs.ts';
const HEADER_CACHE_MS=5*60*1000;
const mb51HeaderCache=new Map<string,{at:number;columns:string[]}>();
const scrapHeaderCache=new Map<string,number>();
const cooisHeaderCache=new Map<string,{at:number;sheet:string;columns:{name:string;index:number}[]}>();
const cacheKey=(token:string,sheet:string)=>`${sheet}:${token.slice(-24)}`;

/** Stream only selected columns; no Excel parser, workbook or BOM matrix in the Worker. */
export async function automaticSource(id:string,env:GoogleEnv):Promise<Response>{
 const consumption=id.startsWith('consumo:');const scrap=id==='scrap';const sheet=consumption?'MB51':scrap?'SCRAP':stockModule(id)?.sheet||id;
 const token=await googleToken(env);let url:string;
 let columns:string[]=[];
 if(!consumption&&!scrap&&!token){
  // Stock tabs are compact. Stream the actual table with its own labels in a
  // single read; no hard-coded H, no header/data race after a pasted export.
  const source=`https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?${new URLSearchParams({tqx:'out:json',sheet,headers:'1',tq:'select *'})}`;
  const response=await fetch(source,{signal:AbortSignal.timeout(25000)});
  if(!response.ok){await response.body?.cancel();return Response.json({error:`Não foi possível ler a aba ${sheet} (HTTP ${response.status}). Confira o nome da aba e o acesso à planilha.`},{status:502});}
  if(response.headers.get('content-type')?.includes('text/html')){await response.body?.cancel();return Response.json({error:`A aba ${sheet} exige autorização da planilha.`},{status:502});}
  return new Response(response.body,{headers:responseHeaders('gviz')});
 }
 if(consumption){
  const key=token?cacheKey(token,'MB51'):'';
  const cached=key?mb51HeaderCache.get(key):undefined;
  if(cached&&Date.now()-cached.at<HEADER_CACHE_MS)columns=cached.columns;
  else{
  // Only the header row is parsed in the Worker. Movement rows remain streamed.
  const probe=token
   ? `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent("'MB51'!1:1")}`
   : `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?${new URLSearchParams({tqx:'out:json',sheet,headers:'0',range:'1:1',tq:'select *'})}`;
  const headerResponse=await fetch(probe,{headers:token?{Authorization:'Bearer '+token}:undefined,signal:AbortSignal.timeout(20000)});
  if(!headerResponse.ok){await headerResponse.body?.cancel();return Response.json({error:'Não foi possível ler os cabeçalhos da MB51. Confira o acesso à planilha.'},{status:502});}
  try{
   const text=await headerResponse.text();
   const match=token?null:text.match(/setResponse\(([\s\S]*)\);?\s*$/);
   if(!token&&!match)throw Error('O Google não retornou os cabeçalhos. Confira a autorização da planilha.');
   const body=JSON.parse(token?text:match![1]);
   const headers=token?body.values?.[0]:body.table?.rows?.[0]?.c?.map((c:any)=>c?.v??'');
   if(!Array.isArray(headers))throw Error('Cabeçalho da MB51 indisponível. Confira a aba MB51 e a primeira linha.');
   columns=mb51Columns(headers).map(c=>columnLetter(c.index));
   if(key)mb51HeaderCache.set(key,{at:Date.now(),columns});
  }catch(e){return Response.json({error:(e as Error).message},{status:422});}
  }
 }
 if(scrap){
  const key=token?cacheKey(token,'SCRAP'):'';
  const cached=key? [...scrapHeaderCache.entries()].find(([cacheKeyValue,at])=>cacheKeyValue===key&&Date.now()-at<HEADER_CACHE_MS):undefined;
  if(cached){
   // A cached header only proves that the tab exists; the data request below
   // still reads the current rows.
  }else{
  // SCRAP is optional, but when present it must have a readable header. A
  // small probe lets the browser distinguish an absent tab from a bad MB51.
  const probe=token
   ?`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent("'SCRAP'!1:1")}`
   :`https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?${new URLSearchParams({tqx:'out:json',sheet:'SCRAP',headers:'0',range:'1:1',tq:'select *'})}`;
  const headerResponse=await fetch(probe,{headers:token?{Authorization:'Bearer '+token}:undefined,signal:AbortSignal.timeout(20000)});
  if(!headerResponse.ok){await headerResponse.body?.cancel();return Response.json({error:'A aba SCRAP não está disponível na planilha.'},{status:422,headers:{'Cache-Control':'no-store'}});}
  try{
   const text=await headerResponse.text();const match=token?null:text.match(/setResponse\(([\s\S]*)\);?\s*$/);if(!token&&!match)throw Error('A aba SCRAP não retornou cabeçalho.');
   const body=JSON.parse(token?text:match![1]);const headers=token?body.values?.[0]:body.table?.rows?.[0]?.c?.map((c:any)=>c?.v??'');
   if(!Array.isArray(headers)||!headers.some((value:any)=>String(value??'').trim()))throw Error('A aba SCRAP está sem cabeçalho.');
   }catch{return Response.json({error:'A aba SCRAP não está disponível na planilha.'},{status:422,headers:{'Cache-Control':'no-store'}});}
   if(key)scrapHeaderCache.set(key,Date.now());
  }
 }
 if(!consumption&&!scrap){
  // Stock exports may have seven columns, or be rearranged by SAP. Discover
  // the small header on each manual refresh, then stream only needed columns.
  const probe=token
   ?`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(`'${sheet}'!1:1`)}`
   :`https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?${new URLSearchParams({tqx:'out:json',sheet,headers:'0',range:'1:1',tq:'select *'})}`;
  const headerResponse=await fetch(probe,{headers:token?{Authorization:'Bearer '+token}:undefined,signal:AbortSignal.timeout(20000)});
  if(!headerResponse.ok){await headerResponse.body?.cancel();return Response.json({error:`Não foi possível ler a aba ${sheet}. Confira o nome da aba e o acesso à planilha.`},{status:502,headers:{'Cache-Control':'no-store'}});}
  try{
   const text=await headerResponse.text(),match=token?null:text.match(/setResponse\(([\s\S]*)\);?\s*$/);
   if(!token&&!match)throw Error(`A aba ${sheet} não retornou cabeçalhos. Confira o acesso à planilha.`);
   const body=JSON.parse(token?text:match![1]);
   const headers=token?body.values?.[0]:body.table?.rows?.[0]?.c?.map((c:any)=>c?.v??'');
   if(body.status==='error'||!Array.isArray(headers))throw Error(`A aba ${sheet} está indisponível ou sem cabeçalho na primeira linha.`);
   columns=stockColumns(headers,sheet).map(column=>columnLetter(column.index));
  }catch(e){return Response.json({error:(e as Error).message},{status:422,headers:{'Cache-Control':'no-store'}});}
 }
 if(token){const params=new URLSearchParams({majorDimension:'ROWS',valueRenderOption:'UNFORMATTED_VALUE'});for(const range of scrap?[`'${sheet}'!A:Z`]:columns.map(c=>`'${sheet}'!${c}:${c}`))params.append('ranges',range);url=`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values:batchGet?${params}`;}
 else url=`https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?${new URLSearchParams({tqx:'out:json',sheet,headers:'1',tq:scrap?'select *':'select '+columns.join(',')})}`;
 const response=await fetch(url,{headers:token?{Authorization:'Bearer '+token}:undefined,signal:AbortSignal.timeout(20000)});
 if(!response.ok){await response.body?.cancel();return Response.json({error:token?'Não foi possível ler a fonte. Habilite a Google Sheets API e confira o acesso da conta de serviço.':'Google não autorizou a leitura automática. Configure a conta de serviço no servidor.'},{status:502});}
 const content=response.headers.get('content-type')||'';if(content.includes('text/html')){await response.body?.cancel();return Response.json({error:'A fonte exige autorização Google.'},{status:502});}
 return new Response(response.body,{headers:{'Content-Type':content||'application/json','Cache-Control':'no-store','X-Source-Format':token?'sheets-api':'gviz','X-Source-Read-At':new Date().toISOString()}});
}

function responseHeaders(format:'sheets-api'|'gviz'){
 return {'Content-Type':format==='sheets-api'?'application/json':'text/javascript;charset=utf-8','Cache-Control':'no-store','X-Source-Format':format,'X-Source-Read-At':new Date().toISOString()};
}

/** Reads the small COOIS order-status table separately from the streamed MB51. */
export async function automaticCoois(env:GoogleEnv):Promise<Response>{
 const token=await googleToken(env);const sheets=['COOIS','Data'];let selected='';let columns:{name:string;index:number}[]=[];
 const key=token?cacheKey(token,'COOIS'):'';
 const cached=key?cooisHeaderCache.get(key):undefined;
 if(cached&&Date.now()-cached.at<HEADER_CACHE_MS){selected=cached.sheet;columns=cached.columns;}
 else{
 for(const sheet of sheets){
  const probe=token
   ?`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(`'${sheet}'!1:1`)}`
   :`https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?${new URLSearchParams({tqx:'out:json',sheet,headers:'0',range:'1:1',tq:'select *'})}`;
  const response=await fetch(probe,{headers:token?{Authorization:'Bearer '+token}:undefined,signal:AbortSignal.timeout(20000)});
  if(!response.ok){await response.body?.cancel();continue;}
  try{
   const text=await response.text(),match=token?null:text.match(/setResponse\(([\s\S]*)\);?\s*$/);if(!token&&!match)continue;
   const body=JSON.parse(token?text:match![1]);
   const headers=token?body.values?.[0]:body.table?.rows?.[0]?.c?.map((c:any)=>c?.v??'');
   if(!Array.isArray(headers))continue;
   columns=cooisHeaders(headers);selected=sheet;break;
  }catch{continue;}
 }
 }
 if(key&&selected)cooisHeaderCache.set(key,{at:Date.now(),sheet:selected,columns});
 if(!selected)return Response.json({error:'A planilha precisa ter uma aba COOIS com Ordem, Quantidade da ordem, Qtd.fornecida e Quantidade boa confirmada.'},{status:422,headers:{'Cache-Control':'no-store'}});
 const selectedColumns=columns.map(c=>columnLetter(c.index));
 if(token){
  const params=new URLSearchParams({majorDimension:'ROWS',valueRenderOption:'UNFORMATTED_VALUE'});for(const column of selectedColumns)params.append('ranges',`'${selected}'!${column}:${column}`);
  const response=await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values:batchGet?${params}`,{headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(20000)});
  if(!response.ok){await response.body?.cancel();return Response.json({error:'Não foi possível ler a aba COOIS. Confira o acesso da conta de serviço.'},{status:502,headers:{'Cache-Control':'no-store'}});}
  const body=await response.json() as any;const cols=(body.valueRanges||[]).map((value:any)=>value.values||[]);const length=Math.max(0,...cols.map((value:any[])=>value.length));
  const values=Array.from({length},(_,row)=>cols.map((column:any[])=>column[row]?.[0]??null));
  return Response.json({valueRanges:[{values}]},{headers:responseHeaders('sheets-api')});
 }
 const query=`select ${selectedColumns.join(',')}`;
 const response=await fetch(`https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?${new URLSearchParams({tqx:'out:json',sheet:selected,headers:'1',tq:query})}`,{signal:AbortSignal.timeout(20000)});
 if(!response.ok){await response.body?.cancel();return Response.json({error:'Não foi possível ler a aba COOIS. Confira se a planilha está compartilhada para leitura.'},{status:502,headers:{'Cache-Control':'no-store'}});}
 const content=response.headers.get('content-type')||'';if(content.includes('text/html')){await response.body?.cancel();return Response.json({error:'A aba COOIS exige autorização Google. Configure a conta de serviço no servidor.'},{status:502,headers:{'Cache-Control':'no-store'}});}
 return new Response(response.body,{headers:{...responseHeaders('gviz'),'Content-Type':content||'text/javascript;charset=utf-8'}});
}

/**
 * Reads only the columns required by Ana's ZPP009 × KOB1 check.  Keeping the
 * four sources separate lets the browser process each stream without making
 * the Worker assemble a 100k-row JSON object (the old implementation could
 * hit Cloudflare's resource limit on large SAP exports).
 */
export async function automaticAnaSource(requested:string,env:GoogleEnv):Promise<Response>{
 const name=String(requested||'').toUpperCase() as AnaSource;
 if(!['KOB1','ZPP009','MM60','COOIS'].includes(name))return Response.json({error:'Fonte Ana inválida. Use KOB1, ZPP009, MM60 ou COOIS.'},{status:400});
 const token=await googleToken(env);
 let selected:string=name,columns:{name:string;index:number}[]=[];
 // Recheck the small header on every manual refresh: the SAP layout can change.
 {
  const candidates=name==='COOIS'?['COOIS','Data']:[name];
  for(const sheet of candidates){
   const probe=token
    ?`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(`'${sheet}'!1:1`)}`
    :`https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?${new URLSearchParams({tqx:'out:json',sheet,headers:'0',range:'1:1',tq:'select *'})}`;
   const response=await fetch(probe,{headers:token?{Authorization:'Bearer '+token}:undefined,signal:AbortSignal.timeout(20000)});
   if(!response.ok){await response.body?.cancel();continue;}
   try{
    const text=await response.text(),match=token?null:text.match(/setResponse\(([\s\S]*)\);?\s*$/);if(!token&&!match)continue;
    const body=JSON.parse(token?text:match![1]);
    const headers:unknown[]=token?body.values?.[0]:body.table?.rows?.[0]?.c?.map((c:any)=>c?.v??'');
    if(!Array.isArray(headers))continue;
    columns=anaColumns(headers,name);selected=sheet;break;
   }catch(e){
    if(/precisa ter|repetida/.test(String((e as Error).message||'')))return Response.json({error:(e as Error).message},{status:422,headers:{'Cache-Control':'no-store'}});
   }
  }
  if(!columns.length)return Response.json({error:`A aba ${name} não está disponível na planilha Google.`},{status:422,headers:{'Cache-Control':'no-store'}});
 }
 const selectedColumns=columns.map(column=>columnLetter(column.index));
 if(token){
  const params=new URLSearchParams({majorDimension:'ROWS',valueRenderOption:'UNFORMATTED_VALUE'});for(const column of selectedColumns)params.append('ranges',`'${selected}'!${column}:${column}`);
  const response=await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values:batchGet?${params}`,{headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(30000)});
  if(!response.ok){await response.body?.cancel();return Response.json({error:`Não foi possível ler a aba ${selected}. Confira o acesso da conta de serviço.`},{status:502,headers:{'Cache-Control':'no-store'}});}
  return new Response(response.body,{headers:{'Content-Type':'application/json','Cache-Control':'no-store','X-Source-Format':'sheets-api','X-Source-Read-At':new Date().toISOString(),'X-Source-Sheet':selected}});
 }
 const query=`select ${selectedColumns.join(',')}`;
 const response=await fetch(`https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?${new URLSearchParams({tqx:'out:json',sheet:selected,headers:'1',tq:query})}`,{signal:AbortSignal.timeout(30000)});
 if(!response.ok){await response.body?.cancel();return Response.json({error:`Não foi possível ler a aba ${selected}. Confira se a planilha está compartilhada para leitura.`},{status:502,headers:{'Cache-Control':'no-store'}});}
 const content=response.headers.get('content-type')||'';if(content.includes('text/html')){await response.body?.cancel();return Response.json({error:`A aba ${selected} exige autorização Google.`},{status:502,headers:{'Cache-Control':'no-store'}});}
 return new Response(response.body,{headers:{...responseHeaders('gviz'),'Content-Type':content||'text/javascript;charset=utf-8','X-Source-Sheet':selected}});
}

/** BAIXA CC: lê a aba inteira (A:Z). Com a conta de serviço, usa FORMULA para
 * também receber links feitos com =HYPERLINK(). O cabeçalho é conferido antes,
 * porque o gviz devolve a primeira aba quando o nome não existe. */
export async function automaticWriteOffs(env:GoogleEnv):Promise<Response>{
 const token=await googleToken(env);
 for(const sheet of WRITE_OFF_SHEETS){
  const probe=token
   ?`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(`'${sheet}'!1:1`)}`
   :`https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?${new URLSearchParams({tqx:'out:json',sheet,headers:'0',range:'1:1',tq:'select *'})}`;
  const head=await fetch(probe,{headers:token?{Authorization:'Bearer '+token}:undefined,signal:AbortSignal.timeout(20000)});
  if(!head.ok){await head.body?.cancel();continue;}
  let headers:unknown[]|undefined;
  try{
   const text=await head.text(),match=token?null:text.match(/setResponse\(([\s\S]*)\);?\s*$/);
   if(!token&&!match)continue;
   const body=JSON.parse(token?text:match![1]);
   headers=token?body.values?.[0]:body.table?.rows?.[0]?.c?.map((c:any)=>c?.v??'');
  }catch{continue;}
  if(!Array.isArray(headers)||!isWriteOffHeader(headers))continue;
  const url=token
   ?`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(`'${sheet}'!A:Z`)}?${new URLSearchParams({majorDimension:'ROWS',valueRenderOption:'FORMULA'})}`
   :`https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?${new URLSearchParams({tqx:'out:json',sheet,headers:'1',tq:'select *'})}`;
  const response=await fetch(url,{headers:token?{Authorization:'Bearer '+token}:undefined,signal:AbortSignal.timeout(25000)});
  if(!response.ok||(response.headers.get('content-type')||'').includes('text/html')){
   await response.body?.cancel();
   return Response.json({error:`Não foi possível ler a aba ${sheet}. Confira o acesso à planilha.`},{status:502,headers:{'Cache-Control':'no-store'}});
  }
  return new Response(response.body,{headers:{...responseHeaders(token?'sheets-api':'gviz'),'Content-Type':response.headers.get('content-type')||'application/json','X-Source-Sheet':encodeURIComponent(sheet)}});
 }
 return Response.json({error:'Crie na planilha uma aba chamada BAIXA CC com as colunas Data, Documento, Centro de custo, Material, Quantidade, Valor, Motivo e PDF (link do Drive).',code:'WRITE_OFF_SHEET_MISSING'},{status:422,headers:{'Cache-Control':'no-store'}});
}
