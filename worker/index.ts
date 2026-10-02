import {configured,authRoute,loginPage,sessionRole,type PortalRole,type PasswordEnv} from './auth';
import {automaticSource,automaticCoois,automaticAnaSource} from './automatic';
import {ensureSchema,list,read,save,removeDataset,updateDatasetMeta,DatasetRemovalError,listManualChecks,manualChecksRevision,updateManualChecks,clearManualChecks,opStatusRevision,listOpStatuses,updateOpStatus,updateOpStatuses} from './storage';
import {isOpStatus} from '../lib/op-status';
import {anaNotesRoute} from './ana-notes';
import {STOCK_MODULES,stockModule} from '../lib/stock-modules';
import {serverFailure} from './server-errors';
import {resolveDatabase,databaseProvider,type DatabaseEnv} from './database';
import {ScrapError,listScrapForms,lookupMaterials,readScrapFile,createScrapForm,updateScrapDraft,uploadScrapPdf,reopenScrapForm,updateScrapPosting,markScrapSent,deleteScrapForm} from './scrap-forms';
interface Env extends Omit<PasswordEnv,'DB'>,DatabaseEnv {GOOGLE_SERVICE_ACCOUNT_JSON?:string;REQUIRE_PASSWORD?:string;ASSETS:Fetcher;}
function json(value:unknown,status=200){return Response.json(value,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});}
async function bodyLimited(req:Request){
 if(Number(req.headers.get('content-length')||0)>15000000)throw Error('Use até 15 MB por envio.');
 const reader=req.body?.getReader();if(!reader)throw Error('Envio vazio.');let size=0;const chunks:string[]=[];const decoder=new TextDecoder();
 while(true){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>15000000){await reader.cancel();throw Error('Use até 15 MB por envio.');}chunks.push(decoder.decode(value,{stream:true}));}
 chunks.push(decoder.decode());return JSON.parse(chunks.join(''));
}
export default {
 async fetch(req:Request,bindings:Env):Promise<Response>{
  const url=new URL(req.url),path=url.pathname;
  try{
   const env={...bindings,DB:await resolveDatabase(bindings)};
   const requirePassword=env.REQUIRE_PASSWORD==='true';
   let role:PortalRole='admin';
   if(requirePassword){const route=await authRoute(req,env);if(route)return route;}
   else if(path==='/auth/login'||path==='/auth/logout')return new Response(null,{status:303,headers:{Location:'/', 'Cache-Control':'no-store'}});
   if(requirePassword){
    const authenticatedRole=await sessionRole(req,env);
    if(!authenticatedRole)return path.startsWith('/api/')?json({error:configured(env)?'Sessão expirada. Recarregue a página e entre novamente.':'O responsável precisa configurar a senha do portal.'},configured(env)?401:503):loginPage('',configured(env)?200:503,!configured(env));
    role=authenticatedRole;
   }
   if(path==='/api/version')return json({version:'MB51-63',scrapForms:true,scrapFormSignatureCheck:true,costCenterSheetRead:false,allOpsOk:true,stock7000Projects:true,bomDelete:true,bomImportWithoutOpColumns:true,bomEditOps:true,stock7000SingleMb51Read:true,databaseProvider:databaseProvider(bindings),tursoSupported:true,databaseErrorCodes:true,revisionOnlyPolling:true,mb51Trace:true,scrapDocumentReconciliation:true,backgroundSourceProcessing:true,stockSources:STOCK_MODULES.map(stock=>({id:stock.id,sheet:stock.sheet})),warehouseClassFilter:true,spacedNavigation:true,operationalStatusChart:true,warehouseConsolidated:true,warehouseSharedBalance:true,opCardsWithoutSapCounts:true,responsiveLayout:true,anaNotesSingleColumn:true,anaOrderCards:true,production7000First:true,warehouse2000Comparison:true,mb51OrderCoverage:true,automaticSource:true,coois:true,cooisOptional:true,anaCheck:true,anaVisualOverview:true,anaPortugueseDescriptions:true,anaSharedNotes:true,anaAnalystRole:true,anaCooisPendingFlag:true,anaNativeSap:true,anaCostReferences:true,anaCurrencyTotals:true,anaCoverageAudit:true,opStatusAndConsumptionViews:true,anaOptionalMm60:true,anaSources:['KOB1','ZPP009','MM60','COOIS'],physicalFinalization:false,manualOpStatus:true,stockSingleRead:true,stock2000:true,stockHeaderMapping:true,opClassChart:true,mainChartNavigation:true,fullWidthLayout:true,topTableScroll:true,sapOnlyPending:false,neutralTheme:true,excelFormula:false,formulaKeyFallback:true,footerBomUpload:true,multipleBoms:true,autoBomRevision:true,scrap:true,scrapDiagnostics:true,scrapConsumption:true,scrapNetting:true,overageNotShortage:true,sharedAdminChecks:true,viewerReadOnly:true,bulkManualChecks:true,instantSharedChecks:true,refreshIntervalMinutes:0,manualRefreshOnly:true,fixedBomItems:true,performanceOptimized:true});
   if(path==='/api/session')return json({role,canMark:role==='admin',canWriteAna:role==='admin'||role==='analyst'});
   if(path==='/api/ana-notes')return await anaNotesRoute(req,env.DB,role);
   if(path==='/api/data'){
    if(!env.DB)return json({error:'Banco de dados não configurado.'},503);
    await ensureSchema(env.DB);
    if(req.method==='GET'){
     const id=url.searchParams.get('id');if(id&&!/^consumo:.{1,190}$/.test(id)&&!stockModule(id))return json({error:'Módulo inválido.'},400);
     if(!id)return json(await list(env.DB));
     const found=await read(env.DB,id);
     if(!found)return json({error:'BOM não encontrada. Ela pode ter sido apagada; escolha outra BOM ativa.',code:'DATASET_NOT_FOUND'},404);
     return json(found);
    }
    if(req.method==='DELETE'){
     if(requirePassword&&role!=='admin')return json({error:'Somente o administrador pode apagar uma BOM.'},403);
     if(req.headers.get('origin')!==url.origin||req.headers.get('sec-fetch-site')==='cross-site')return json({error:'Origem inválida.'},403);
     try{return json(await removeDataset(env.DB,url.searchParams.get('id')||'',url.searchParams.get('version')||''));}
     catch(e){if(e instanceof DatasetRemovalError)return json({error:e.message},e.status);throw e;}
    }
    if(req.method==='POST'){
     if(requirePassword&&role!=='admin')return json({error:'Somente o administrador pode importar ou alterar bases.'},403);
     if(req.headers.get('origin')!==url.origin||req.headers.get('sec-fetch-site')==='cross-site')return json({error:'Origem inválida.'},403);
     if(!req.headers.get('content-type')?.startsWith('application/json'))return json({error:'Formato inválido.'},415);
     try{const saved=await save(env.DB,await bodyLimited(req));if(saved.id.startsWith('consumo:'))await clearManualChecks(env.DB,saved.id);return json(saved);}catch(e){return json({error:(e as Error).message},400);}
    }
    return json({error:'Método não permitido.'},405);
   }
   if(path==='/api/scrap-forms'){
    if(!env.DB)return json({error:'Banco de dados não configurado.'},503);
    const canEdit=role==='admin'||role==='analyst';
    try{
     if(req.method==='GET'){
      const file=url.searchParams.get('file');
      if(file!==null){
       const found=await readScrapFile(env.DB,file,Number(url.searchParams.get('version')));
       return new Response(found.bytes,{headers:{'Content-Type':'application/pdf','Content-Disposition':`${url.searchParams.has('download')?'attachment':'inline'}; filename*=UTF-8''${encodeURIComponent(found.name)}`,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','X-Frame-Options':'SAMEORIGIN','X-File-Sha256':found.sha256,'X-File-Kind':found.kind}});
      }
      const lookup=url.searchParams.get('lookup');
      if(lookup!==null)return json(await lookupMaterials(env.DB,lookup.slice(0,1000)));
      return json({forms:await listScrapForms(env.DB),canEdit,canDelete:role==='admin',role});
     }
     if(req.method!=='POST')return json({error:'Método não permitido.'},405);
     if(!canEdit)return json({error:'O perfil Consulta pode ver e baixar os formulários. Use o acesso de Analista ou Administrador para preencher e anexar PDFs.'},403);
     if(req.headers.get('origin')!==url.origin||req.headers.get('sec-fetch-site')==='cross-site')return json({error:'Origem inválida.'},403);
     if(!req.headers.get('content-type')?.startsWith('application/json'))return json({error:'Formato inválido.'},415);
     let body:any;
     try{body=await bodyLimited(req);}catch(e){return json({error:e instanceof SyntaxError?'Formato inválido.':(e as Error).message},400);}
     if(!body||typeof body!=='object')return json({error:'Formato inválido.'},400);
     const revision=body.revision;
     switch(body.action){
      case 'create':return json({form:await createScrapForm(env.DB,body.data,role)});
      case 'update':return json({form:await updateScrapDraft(env.DB,body.id,revision,body.data)});
      case 'upload':return json({form:await uploadScrapPdf(env.DB,body,role)});
      case 'reopen':return json({form:await reopenScrapForm(env.DB,body.id,revision,role)});
      case 'posting':return json({form:await updateScrapPosting(env.DB,body.id,revision,{costCenter:body.costCenter,sapDocument:body.sapDocument})});
      case 'sent':return json({form:await markScrapSent(env.DB,body.id)});
      case 'delete':return json(await deleteScrapForm(env.DB,body.id,revision,role));
      default:return json({error:'Ação inválida.'},400);
     }
    }catch(e){if(e instanceof ScrapError)return json({error:e.message},e.status);throw e;}
   }
   if(path==='/api/data-meta'){
    if(!env.DB)return json({error:'Banco de dados não configurado.'},503);
    if(req.method!=='POST')return json({error:'Método não permitido.'},405);
    if(requirePassword&&role!=='admin')return json({error:'Somente o administrador pode renomear uma BOM.'},403);
    if(req.headers.get('origin')!==url.origin||req.headers.get('sec-fetch-site')==='cross-site')return json({error:'Origem inválida.'},403);
    if(!req.headers.get('content-type')?.startsWith('application/json'))return json({error:'Formato inválido.'},415);
    await ensureSchema(env.DB);
    try{const body=await bodyLimited(req);return json(await updateDatasetMeta(env.DB,String(body?.id||''),String(body?.version||''),body||{}));}
    catch(e){if(e instanceof DatasetRemovalError)return json({error:e.message},e.status);if(e instanceof SyntaxError)return json({error:'Formato inválido.'},400);throw e;}
   }
   if(path==='/api/op-status'){
    if(!env.DB)return json({error:'Banco de dados não configurado.'},503);
    const id=url.searchParams.get('id')||'';
    if(!/^consumo:.{1,190}$/.test(id))return json({error:'BOM inválida.'},400);
    await ensureSchema(env.DB);
    if(req.method==='GET'){
     const revision=await opStatusRevision(env.DB,id);
     if(url.searchParams.has('revision')&&Number(url.searchParams.get('revision'))===revision)return json({unchanged:true,revision,canEdit:role==='admin'});
     return json({...await listOpStatuses(env.DB,id),canEdit:role==='admin'});
    }
    if(req.method!=='POST')return json({error:'Método não permitido.'},405);
    if(role!=='admin')return json({error:'Somente o administrador pode alterar o status das OPs.'},403);
    if(req.headers.get('origin')!==url.origin||req.headers.get('sec-fetch-site')==='cross-site')return json({error:'Origem inválida.'},403);
    if(!req.headers.get('content-type')?.startsWith('application/json'))return json({error:'Formato inválido.'},415);
    try{
     const payload=await bodyLimited(req);
     if(payload.id===id&&Array.isArray(payload.ops)&&isOpStatus(payload.status))return json({...await updateOpStatuses(env.DB,id,payload.ops,payload.status),canEdit:true});
     if(payload.id!==id||typeof payload.op!=='string'||!isOpStatus(payload.status))return json({error:'Status ou OP inválidos.'},400);
     return json({...await updateOpStatus(env.DB,id,payload.op,payload.status),canEdit:true});
    }catch(e){return json({error:(e as Error).message},400);}
   }
   if(path==='/api/checks'){
    if(!env.DB)return json({error:'Banco de dados não configurado.'},503);
    const id=url.searchParams.get('id')||'';
    if(!/^consumo:.{1,190}$/.test(id))return json({error:'BOM inválida.'},400);
    await ensureSchema(env.DB);
    if(req.method==='GET'){
     // Viewers poll this endpoint frequently. Return only a revision when
     // nothing changed; the complete mark list is sent only after a change.
     const revision=Number(url.searchParams.get('revision'));
     if(url.searchParams.has('revision')&&Number.isSafeInteger(revision)&&revision>=0){
      const current=await manualChecksRevision(env.DB,id);
      if(revision===current)return json({unchanged:true,revision:current,role,canMark:role==='admin'});
     }
     return json({...await listManualChecks(env.DB,id),role,canMark:role==='admin'});
    }
    if(role!=='admin')return json({error:'Somente o administrador pode marcar itens como OK.'},403);
    if(req.headers.get('origin')!==url.origin||req.headers.get('sec-fetch-site')==='cross-site')return json({error:'Origem inválida.'},403);
    if(!req.headers.get('content-type')?.startsWith('application/json'))return json({error:'Formato inválido.'},415);
    try{
     const payload=await bodyLimited(req) as {id?:string;keys?:unknown;checked?:unknown};
     if(payload.id!==id)return json({error:'BOM inválida.'},400);
     if(!Array.isArray(payload.keys)||payload.keys.some(key=>typeof key!=='string'))return json({error:'Informe as marcações em formato válido.'},400);
     const result=await updateManualChecks(env.DB,id,payload.keys as string[],payload.checked!==false,'admin');
     return json({...result,role,canMark:true});
    }catch(e){return json({error:(e as Error).message||'Não foi possível salvar as marcações.'},400);}
   }
   if(path==='/api/automatic'){
    if(req.method!=='GET')return json({error:'Método não permitido.'},405);
    if(!env.DB)return json({error:'Banco de dados não configurado.'},503);
    const id=url.searchParams.get('id')||'';
    if(!/^consumo:.{1,190}$/.test(id)&&!stockModule(id)&&id!=='scrap')return json({error:'Módulo inválido.'},400);
    try{return await automaticSource(id,env);}catch{return json({error:'Falha na leitura Google. Confira a conexão e tente novamente.'},502);}
   }
   if(path==='/api/coois'){
    if(req.method!=='GET')return json({error:'Método não permitido.'},405);
    if(!env.DB)return json({error:'Banco de dados não configurado.'},503);
    const id=url.searchParams.get('id')||'';
    if(!/^consumo:.{1,190}$/.test(id))return json({error:'Módulo inválido.'},400);
    try{return await automaticCoois(env);}catch(e){return json({error:(e as Error).message||'Falha na leitura da COOIS.'},502);}
   }
   if(path==='/api/ana-source'){
    if(req.method!=='GET')return json({error:'Método não permitido.'},405);
    if(!env.DB)return json({error:'Banco de dados não configurado.'},503);
    const sheet=(url.searchParams.get('sheet')||'').toUpperCase();
    if(!['KOB1','ZPP009','MM60','COOIS'].includes(sheet))return json({error:'Fonte Ana inválida.'},400);
    try{return await automaticAnaSource(sheet,env);}catch(e){return json({error:(e as Error).message||'Falha na leitura da fonte da Ana.'},502);}
   }
   if(path==='/api/sheets'){
    if(req.method!=='GET')return json({error:'Método não permitido.'},405);
    const id=url.searchParams.get('id')||'',sheet=url.searchParams.get('sheet')||'';
    if(!/^[A-Za-z0-9_-]{20,200}$/.test(id)||!sheet||sheet.length>200)return json({error:'Informe uma planilha e uma aba válidas.'},400);
    const response=await fetch(`https://docs.google.com/spreadsheets/d/${id}/gviz/tq?${new URLSearchParams({tqx:'out:json',sheet,headers:'1'})}`,{signal:AbortSignal.timeout(15000)});
    if(!response.ok)return json({error:'Não foi possível acessar a planilha. Confira as permissões.'},400);
    const raw=await response.text(),match=raw.match(/setResponse\(([\s\S]*)\);?\s*$/);
    if(!match)return json({error:'Esta planilha exige autenticação Google. Essa conexão ainda não foi configurada.'},400);
    const d=JSON.parse(match[1]);if(d.status==='error'||!d.table)return json({error:'Aba indisponível. Confira o nome e o acesso.'},400);
    const keys=d.table.cols.map((c:any)=>c.label||c.id);
    return json({rows:d.table.rows.map((r:any)=>Object.fromEntries(keys.map((k:string,i:number)=>[k,r.c[i]?.v??null]))),readAt:new Date().toISOString()});
   }
   if(path.startsWith('/api/'))return json({error:'Rota não encontrada.'},404);
   const response=await env.ASSETS.fetch(req),headers=new Headers(response.headers);
   headers.set('X-Content-Type-Options','nosniff');headers.set('X-Frame-Options','DENY');headers.set('Referrer-Policy','same-origin');headers.set('Cache-Control',path.startsWith('/assets/')?'private, max-age=31536000, immutable':'no-store');
   if(!requirePassword&&headers.get('Content-Type')?.includes('text/html')){
    const html=(await response.text()).replace('</head>','<style>form[action="/auth/logout"]{display:none!important}</style></head>');
    headers.delete('Content-Length');headers.delete('ETag');
    return new Response(html,{status:response.status,headers});
   }
   return new Response(response.body,{status:response.status,headers});
  }catch(error){return serverFailure(error,path);}
 }
};
