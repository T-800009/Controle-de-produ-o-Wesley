import {authRoute,accessRoute,loginPage,resolveAccess,requestLang,sameOrigin,type PortalRole,type PasswordEnv} from './auth';
import {automaticSource,automaticCoois,automaticAnaSource} from './automatic';
import {ensureSchema,list,listPlans,updatePlanUnits,read,save,removeDataset,updateDatasetMeta,DatasetRemovalError,listManualChecks,manualChecksRevision,updateManualChecks,clearManualChecks,opStatusRevision,listOpStatuses,updateOpStatus,updateOpStatuses} from './storage';
import {isOpStatus} from '../lib/op-status';
import {anaNotesRoute} from './ana-notes';
import {STOCK_MODULES,stockModule} from '../lib/stock-modules';
import {PORTAL_VERSION} from '../lib/version';
import {serverFailure} from './server-errors';
import {secured} from './security-headers';
import {allowRequest,VIEW_LIMITS} from './rate-limit';
import {resolveDatabase,databaseProvider,type DatabaseEnv} from './database';
import {DossieError,listDossies,getDossie,createDossies,updateDossie,sendDossie,answerDossie,closeDossie,reopenDossie,deleteDossie,addDossieFile,deleteDossieFile,readDossieFile,bomLookup} from './dossies';
import {ScrapError,docKind,listScrapForms,lookupMaterials,readScrapFile,createScrapForm,importScrapForm,updateScrapDraft,uploadScrapPdf,reopenScrapForm,updateScrapPosting,markScrapSent,deleteScrapForm} from './scrap-forms';
interface Env extends Omit<PasswordEnv,'DB'>,DatabaseEnv {GOOGLE_SERVICE_ACCOUNT_JSON?:string;REQUIRE_PASSWORD?:string;ASSETS:Fetcher;}
function json(value:unknown,status=200){return Response.json(value,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});}
async function bodyLimited(req:Request){
 if(Number(req.headers.get('content-length')||0)>15000000)throw Error('Use até 15 MB por envio.');
 const reader=req.body?.getReader();if(!reader)throw Error('Envio vazio.');let size=0;const chunks:string[]=[];const decoder=new TextDecoder();
 while(true){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>15000000){await reader.cancel();throw Error('Use até 15 MB por envio.');}chunks.push(decoder.decode(value,{stream:true}));}
 chunks.push(decoder.decode());return JSON.parse(chunks.join(''));
}
export default {
 async fetch(req:Request,bindings:Env):Promise<Response>{return secured(await handle(req,bindings));}
};
async function handle(req:Request,bindings:Env):Promise<Response>{
  const url=new URL(req.url),path=url.pathname;
  try{
   const env={...bindings,DB:await resolveDatabase(bindings)};
   // Quem não entrou com senha é Consulta: vê, mas não altera. Alterar exige a senha de ADM.
   const access=await resolveAccess(req,env);
   const route=await authRoute(req,env,access);if(route)return route;
   if(!access.role){
    if(path.startsWith('/api/'))return json({error:access.adminConfigured?'Acesso de consulta fechado. Abra o link de consulta ou entre com a senha.':'O responsável precisa configurar a senha do portal.',code:'LOGIN_REQUIRED'},access.adminConfigured?401:503);
    return loginPage('',access.adminConfigured?200:503,!access.adminConfigured,{lang:requestLang(req),mode:'closed',next:path+url.search});
   }
   const role:PortalRole=access.role;
   const isAdmin=role==='admin';
   if(role==='viewer'&&path.startsWith('/api/')&&!allowRequest((access.via==='open'?'open:':'view:')+(req.headers.get('CF-Connecting-IP')||'local'),access.via==='open'?VIEW_LIMITS.open:VIEW_LIMITS.session)){
    return Response.json({error:'Muitas consultas seguidas deste endereço. Aguarde um minuto e tente de novo.',code:'RATE_LIMITED',retryAfter:60},{status:429,headers:{'Cache-Control':'no-store','Retry-After':'60'}});
   }
   if(path==='/api/version')return json({version:PORTAL_VERSION,readOnlyWithoutPassword:true,adminPasswordForChanges:true,accessModes:['open','closed'],viewLink:true,securityHeaders:true,loginOriginFix:true,viewerRateLimit:true,anyPdfImport:true,formalEmail:true,staleTabGuard:true,attachAnyPdf:true,ccApprovalOnLastPage:true,dossies:true,scrapForms:true,costCenterForms:true,costCenterFromSpreadsheet:true,costCenterMaxItems:300,legacyImport:true,scrapFormSignatureCheck:true,costCenterSheetRead:false,allOpsOk:true,stock7000Projects:true,planBoms:true,bomDelete:true,bomImportWithoutOpColumns:true,bomEditOps:true,stock7000SingleMb51Read:true,databaseProvider:databaseProvider(bindings),tursoSupported:true,databaseErrorCodes:true,revisionOnlyPolling:true,mb51Trace:true,scrapDocumentReconciliation:true,backgroundSourceProcessing:true,stockSources:STOCK_MODULES.map(stock=>({id:stock.id,sheet:stock.sheet})),warehouseClassFilter:true,spacedNavigation:true,operationalStatusChart:true,warehouseConsolidated:true,warehouseSharedBalance:true,opCardsWithoutSapCounts:true,responsiveLayout:true,anaNotesSingleColumn:true,anaOrderCards:true,production7000First:true,warehouse2000Comparison:true,mb51OrderCoverage:true,automaticSource:true,coois:true,cooisOptional:true,anaCheck:true,anaVisualOverview:true,anaPortugueseDescriptions:true,anaSharedNotes:true,anaAnalystRole:true,anaCooisPendingFlag:true,anaNativeSap:true,anaCostReferences:true,anaCurrencyTotals:true,anaCoverageAudit:true,opStatusAndConsumptionViews:true,anaOptionalMm60:true,anaSources:['KOB1','ZPP009','MM60','COOIS'],physicalFinalization:false,manualOpStatus:true,stockSingleRead:true,stock2000:true,stockHeaderMapping:true,opClassChart:true,mainChartNavigation:true,fullWidthLayout:true,topTableScroll:true,sapOnlyPending:false,neutralTheme:true,excelFormula:false,formulaKeyFallback:true,footerBomUpload:true,multipleBoms:true,autoBomRevision:true,scrap:true,scrapDiagnostics:true,scrapConsumption:true,scrapNetting:true,overageNotShortage:true,sharedAdminChecks:true,viewerReadOnly:true,bulkManualChecks:true,instantSharedChecks:true,refreshIntervalMinutes:0,manualRefreshOnly:true,fixedBomItems:true,performanceOptimized:true});
   if(path==='/api/session')return json({role,via:access.via,mode:access.mode,adminConfigured:access.adminConfigured,canEdit:role!=='viewer',canMark:isAdmin,canWriteAna:isAdmin||role==='analyst'});
   if(path==='/api/access')return await accessRoute(req,env,access);
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
     if(!isAdmin)return json({error:'Somente o administrador pode apagar uma BOM.'},403);
     if(!sameOrigin(req))return json({error:'Origem inválida.'},403);
     try{return json(await removeDataset(env.DB,url.searchParams.get('id')||'',url.searchParams.get('version')||''));}
     catch(e){if(e instanceof DatasetRemovalError)return json({error:e.message},e.status);throw e;}
    }
    if(req.method==='POST'){
     if(!isAdmin)return json({error:'Somente o administrador pode importar ou alterar bases.'},403);
     if(!sameOrigin(req))return json({error:'Origem inválida.'},403);
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
      return json({forms:await listScrapForms(env.DB,docKind(url.searchParams.get('doc'))),canEdit,canDelete:role==='admin',role});
     }
     if(req.method!=='POST')return json({error:'Método não permitido.'},405);
     if(!canEdit)return json({error:'O perfil Consulta pode ver e baixar os formulários. Use o acesso de Analista ou Administrador para preencher e anexar PDFs.'},403);
     if(!sameOrigin(req))return json({error:'Origem inválida.'},403);
     if(!req.headers.get('content-type')?.startsWith('application/json'))return json({error:'Formato inválido.'},415);
     let body:any;
     try{body=await bodyLimited(req);}catch(e){return json({error:e instanceof SyntaxError?'Formato inválido.':(e as Error).message},400);}
     if(!body||typeof body!=='object')return json({error:'Formato inválido.'},400);
     const revision=body.revision,kind=docKind(body.doc);
     switch(body.action){
      case 'create':return json({form:await createScrapForm(env.DB,body.data,role,new Date(),kind)});
      case 'update':return json({form:await updateScrapDraft(env.DB,body.id,revision,body.data,kind)});
      case 'import':return json({form:await importScrapForm(env.DB,body,role,kind)});
      case 'upload':return json({form:await uploadScrapPdf(env.DB,body,role,kind)});
      case 'reopen':return json({form:await reopenScrapForm(env.DB,body.id,revision,role,kind)});
      case 'posting':return json({form:await updateScrapPosting(env.DB,body.id,revision,{costCenter:body.costCenter,sapDocument:body.sapDocument,pr:body.pr,prDate:body.prDate,po:body.po},kind)});
      case 'sent':return json({form:await markScrapSent(env.DB,body.id,kind)});
      case 'delete':return json(await deleteScrapForm(env.DB,body.id,revision,role,kind));
      default:return json({error:'Ação inválida.'},400);
     }
    }catch(e){if(e instanceof ScrapError)return json({error:e.message},e.status);throw e;}
   }
   if(path==='/api/dossies'){
    // DOSSIÊ WAREHOUSE: todos veem; Analista e Administrador abrem, cobram e encerram.
    if(!env.DB)return json({error:'Banco de dados não configurado.'},503);
    const canEdit=role==='admin'||role==='analyst';
    try{
     if(req.method==='GET'){
      const file=url.searchParams.get('file');
      if(file!==null){
       const found=await readDossieFile(env.DB,url.searchParams.get('dossie'),file);
       return new Response(found.bytes,{headers:{'Content-Type':found.type,'Content-Disposition':`inline; filename*=UTF-8''${encodeURIComponent(found.name)}`,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','X-Frame-Options':'SAMEORIGIN','Content-Security-Policy':"default-src 'none'; sandbox"}});
      }
      const lookup=url.searchParams.get('lookup');
      if(lookup!==null)return json(await bomLookup(env.DB,lookup.slice(0,1000)));
      const id=url.searchParams.get('id');
      if(id!==null){
       const found=/^[a-f0-9-]{36}$/i.test(id)?await getDossie(env.DB,id):null;
       return found?json({dossie:found,canEdit,canDelete:role==='admin',role}):json({error:'Dossiê não encontrado. Ele pode ter sido apagado; atualize a lista.',code:'DOSSIE_NOT_FOUND'},404);
      }
      return json({dossies:await listDossies(env.DB),canEdit,canDelete:role==='admin',role});
     }
     if(req.method!=='POST')return json({error:'Método não permitido.'},405);
     if(!canEdit)return json({error:'O perfil Consulta vê os dossiês. Use o acesso de Analista ou Administrador para abrir, cobrar e encerrar.'},403);
     if(!sameOrigin(req))return json({error:'Origem inválida.'},403);
     if(!req.headers.get('content-type')?.startsWith('application/json'))return json({error:'Formato inválido.'},415);
     let body:any;
     try{body=await bodyLimited(req);}catch(e){return json({error:e instanceof SyntaxError?'Formato inválido.':(e as Error).message},400);}
     if(!body||typeof body!=='object')return json({error:'Formato inválido.'},400);
     switch(body.action){
      case 'create':return json({dossies:await createDossies(env.DB,body.items,role)});
      case 'update':return json({dossie:await updateDossie(env.DB,body.id,body.revision,body.data,role)});
      case 'send':return json({dossie:await sendDossie(env.DB,body.id,body.revision,role)});
      case 'answer':return json({dossie:await answerDossie(env.DB,body.id,body.revision,{response:body.response,responseBy:body.responseBy,respondedAt:body.respondedAt},role)});
      case 'close':return json({dossie:await closeDossie(env.DB,body.id,body.revision,{outcome:body.outcome,outcomeNote:body.outcomeNote,returnDocument:body.returnDocument},role)});
      case 'reopen':return json({dossie:await reopenDossie(env.DB,body.id,body.revision,role)});
      case 'delete':return json(await deleteDossie(env.DB,body.id,body.revision,role));
      case 'file':return json({dossie:await addDossieFile(env.DB,{id:body.id,revision:body.revision,name:body.name,data:body.data},role)});
      case 'file-delete':return json({dossie:await deleteDossieFile(env.DB,{id:body.id,revision:body.revision,fileId:body.fileId},role)});
      default:return json({error:'Ação inválida.'},400);
     }
    }catch(e){if(e instanceof DossieError)return json({error:e.message},e.status);throw e;}
   }
   if(path==='/api/plan-boms'){
    // BOMs do plano (OEBOM): consulta para todos; cadastrar, mudar ônibus restantes e apagar só o administrador.
    if(!env.DB)return json({error:'Banco de dados não configurado.'},503);
    await ensureSchema(env.DB);
    if(req.method==='GET'){
     const id=url.searchParams.get('id');
     if(!id)return json({plans:await listPlans(env.DB),canEdit:isAdmin});
     if(!/^plano:[a-z0-9-]{1,120}$/.test(id))return json({error:'BOM do plano inválida.'},400);
     const found=await read(env.DB,id);
     return found?json(found):json({error:'BOM do plano não encontrada.',code:'DATASET_NOT_FOUND'},404);
    }
    if(!isAdmin)return json({error:'Somente o administrador pode cadastrar ou alterar BOMs do plano.'},403);
    if(!sameOrigin(req))return json({error:'Origem inválida.'},403);
    try{
     if(req.method==='DELETE')return json(await removeDataset(env.DB,url.searchParams.get('id')||'',url.searchParams.get('version')||''));
     if(req.method!=='POST')return json({error:'Método não permitido.'},405);
     if(!req.headers.get('content-type')?.startsWith('application/json'))return json({error:'Formato inválido.'},415);
     const body=await bodyLimited(req);
     if(body?.action==='units')return json(await updatePlanUnits(env.DB,String(body.id||''),body.units));
     if(body?.action==='save'){if(!String(body.data?.id||'').startsWith('plano:'))return json({error:'BOM do plano inválida.'},400);return json(await save(env.DB,body.data));}
     return json({error:'Ação inválida.'},400);
    }catch(e){
     if(e instanceof DatasetRemovalError)return json({error:e.message},e.status);
     if(e instanceof SyntaxError)return json({error:'Formato inválido.'},400);
     return json({error:(e as Error).message},400);
    }
   }
   if(path==='/api/data-meta'){
    if(!env.DB)return json({error:'Banco de dados não configurado.'},503);
    if(req.method!=='POST')return json({error:'Método não permitido.'},405);
    if(!isAdmin)return json({error:'Somente o administrador pode renomear uma BOM.'},403);
    if(!sameOrigin(req))return json({error:'Origem inválida.'},403);
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
    if(!sameOrigin(req))return json({error:'Origem inválida.'},403);
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
    if(!sameOrigin(req))return json({error:'Origem inválida.'},403);
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
   if(path.startsWith('/api/'))return json({error:'Rota não encontrada.'},404);
   const response=await env.ASSETS.fetch(req),headers=new Headers(response.headers);
   headers.set('Cache-Control',path.startsWith('/assets/')?'private, max-age=31536000, immutable':'no-store');
   return new Response(response.body,{status:response.status,headers});
  }catch(error){return serverFailure(error,path);}
}
