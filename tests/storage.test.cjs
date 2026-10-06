const {createRequire}=require('node:module');
const fs=require('node:fs');const assert=require('node:assert/strict');
const path=require('node:path');const os=require('node:os');
const root=path.resolve(__dirname,'..');const temp=fs.mkdtempSync(path.join(os.tmpdir(),'controle-test-'));
const req=createRequire(root+'/package.json');const wr=req.resolve('wrangler');
const {Miniflare}=require(require.resolve('miniflare',{paths:[wr]}));
const {build}=require(require.resolve('esbuild',{paths:[wr]}));
(async()=>{
await build({entryPoints:[root+'/worker/storage.ts'],bundle:true,platform:'node',format:'cjs',outfile:temp+'/storage.cjs'});
const storage=require(temp+'/storage.cjs');
const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("test")}}',d1Databases:['DB'],compatibilityDate:'2026-05-15'});
try{
let db;
if(process.argv.includes('--turso')){
 await build({entryPoints:[root+'/worker/database.ts'],bundle:true,platform:'node',format:'cjs',outfile:temp+'/database.cjs'});
 const {createClient}=await import('@libsql/client');
 const client=createClient({url:'file:'+temp+'/turso.sqlite'});
 db=new (require(temp+'/database.cjs').TursoDatabase)(client);
 mf.tursoClient=client;
}else db=await mf.getD1Database('DB');
await storage.ensureSchema(db);await storage.ensureSchema(db);
const initial=await storage.read(db,'7000');assert.equal(initial.rows.length,1749);
for(const id of ['2000']){
 const empty=await storage.read(db,id);assert.equal(empty.version,'seed');assert.deepEqual(empty.rows,[]);
 const result=await storage.save(db,{...empty,rows:[{material:'0001-A',unit:'KG',depot:'2000',quantity:15,value:null}]});
 assert.equal(result.id,id);assert.equal((await storage.read(db,id)).rows[0].depot,'2000');
}
const meta=await storage.list(db);assert.equal(meta[0].rows,undefined);
const first=await storage.save(db,{id:'1500',name:'Depósito 1500',revision:'',source:'teste',version:'seed',rows:[{material:'000123-A',quantity:7,value:14,unit:'UN'}]});
assert.equal((await storage.read(db,'1500')).rows[0].material,'000123-A');
await assert.rejects(()=>storage.save(db,{...first,version:'seed'}),/Outra atualização/);
const next={...first,rows:[{material:'000123-A',quantity:9,value:18,unit:'UN'}]};
const results=await Promise.allSettled([storage.save(db,next),storage.save(db,next)]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
const saved=await storage.read(db,'1500');assert.equal(saved.rows[0].quantity,9);
const count=await db.prepare('SELECT COUNT(*) AS n FROM entries WHERE dataset=?').bind('1500').first();assert.equal(count.n,1);
const marked=await storage.updateManualChecks(db,'consumo:test',['19000000123|001-A|PCS'],true,'admin');
assert.equal(marked.count,1);assert.equal(marked.revision,1);assert.equal((await storage.manualChecksStatus(db,'consumo:test')).revision,1);
await storage.clearManualChecks(db,'consumo:test');assert.equal((await storage.listManualChecks(db,'consumo:test')).count,0);assert.equal((await storage.manualChecksStatus(db,'consumo:test')).revision,2);
assert.equal((await storage.read(db,'7000')).rows.length,1749);
await build({entryPoints:[root+'/worker/index.ts'],bundle:true,platform:'node',format:'cjs',outfile:temp+'/worker.cjs'});
const handler=require(temp+'/worker.cjs').default;
const assets={async fetch(){return new Response('<html>portal</html>',{headers:{'Content-Type':'text/html'}});}};
const password=require('node:crypto').randomBytes(24).toString('hex');
const environment={DB:db,ASSETS:assets,PORTAL_PASSWORD:password,REQUIRE_PASSWORD:"true"};
const call=(path,options={},env=environment)=>handler.fetch(new Request('https://portal.test'+path,options),env);
const login=(value,ip='192.0.2.1',origin='https://portal.test')=>call('/auth/login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/x-www-form-urlencoded','CF-Connecting-IP':ip},body:new URLSearchParams({password:value}).toString()});
assert.equal((await call('/api/data')).status,401);
assert.match(await (await call('/')).text(),/Senha do portal/);
assert.equal((await login(password,'192.0.2.1','https://attacker.test')).status,403);
assert.equal((await login('wrong')).status,401);
const logged=await login(password);assert.equal(logged.status,303);
const setCookie=logged.headers.get('Set-Cookie');for(const attribute of ['HttpOnly','Secure','SameSite=Strict','Max-Age=28800'])assert.ok(setCookie.includes(attribute));
const cookie=setCookie.split(';')[0],headers={Cookie:cookie};
for(const id of ['2000']){
 const result=await call('/api/data?id='+id,{headers});assert.equal(result.status,200);assert.equal((await result.json()).rows[0].quantity,15);
}
{
 const originalFetch=globalThis.fetch;
 try{
  const calls=[];
  globalThis.fetch=async input=>{calls.push(new URL(String(input)).searchParams.get('sheet'));return new Response('stock stream',{headers:{'Content-Type':'application/javascript'}});};
  for(const id of ['2000']){
   const result=await call('/api/automatic?id='+id,{headers});assert.equal(result.status,200);assert.equal(await result.text(),'stock stream');
  }
  assert.deepEqual(calls,['2000']);
  assert.equal((await call('/api/automatic?id=unknown',{headers})).status,400);
  assert.equal((await call('/api/automatic?id=aditivos',{headers})).status,400);
  assert.equal((await call('/api/automatic?id=1300',{headers})).status,400,'1300 removido');
  assert.equal((await call('/api/data?id=1300',{headers})).status,400,'1300 removido');
 }finally{globalThis.fetch=originalFetch;}
}
const session=await db.prepare('SELECT token_hash FROM portal_sessions').first();assert.notEqual(session.token_hash,cookie.split('=')[1]);
const checksUrl='/api/checks?id='+encodeURIComponent('consumo:test');
const checksResponse=await call(checksUrl,{headers});assert.equal(checksResponse.status,200);assert.equal((await checksResponse.json()).revision,2);
const unchangedResponse=await call(checksUrl+'&revision=2',{headers});assert.equal(unchangedResponse.status,200);assert.equal((await unchangedResponse.json()).unchanged,true);
const markResponse=await call(checksUrl,{method:'POST',headers:{...headers,Origin:'https://portal.test','Content-Type':'application/json'},body:JSON.stringify({id:'consumo:test',keys:['19000000123|001-A|PCS'],checked:true})});assert.equal(markResponse.status,200);assert.equal((await markResponse.json()).count,1);
// An unchanged poll must read one indexed revision, never count all marks.
{
 const queries=[];
 const traced={prepare(sql){queries.push(sql);return db.prepare(sql);},batch(statements){return db.batch(statements);}};
 const revision=await storage.manualChecksRevision(db,'consumo:test');
 const result=await call(checksUrl+'&revision='+revision,{}, {DB:traced,ASSETS:assets,REQUIRE_PASSWORD:'false'});
 assert.equal(result.status,200);assert.equal((await result.json()).unchanged,true);
 const reads=queries.filter(sql=>/^SELECT/i.test(sql));
 assert.equal(reads.length,1);assert.match(reads[0],/SELECT revision FROM manual_check_state WHERE dataset=/);
 assert.ok(reads.every(sql=>!sql.includes('COUNT(')));
 // Existing legacy marks remain visible without a scan or forced migration.
 await db.prepare('INSERT INTO manual_checks(dataset,row_key,marked_by,updated_at) VALUES(?,?,?,?)').bind('consumo:legacy','row1','admin','2026-09-28').run();
 queries.length=0;assert.equal(await storage.manualChecksRevision(traced,'consumo:legacy'),1);
 assert.equal(queries.length,2);assert.match(queries[1],/LIMIT 1/);assert.ok(queries.every(sql=>!sql.includes('COUNT(')));
 assert.equal(await storage.manualChecksRevision(db,'consumo:never-used'),0);
}
// A failed database now returns its classified cause, not the old blanket message.
{
 const originalError=console.error;const logs=[];console.error=(...args)=>logs.push(args);
 try{
  const broken={prepare(){throw Error("D1_ERROR: Your account has exceeded D1's free tier daily row read limit.");}};
  const response=await call('/api/data',{}, {DB:broken,ASSETS:assets,REQUIRE_PASSWORD:'false'});
  assert.equal(response.status,503);assert.equal((await response.json()).code,'D1_DAILY_READ_LIMIT');assert.equal(logs.length,1);
 }finally{console.error=originalError;}
}
// OP status is saved in D1, isolated by BOM and guarded by admin + origin.
const opId='consumo:bc22x-1268',opUrl='/api/op-status?id='+encodeURIComponent(opId);
const postStatus=(op,status,customHeaders={...headers,Origin:'https://portal.test','Content-Type':'application/json'},env=environment)=>call(opUrl,{method:'POST',headers:customHeaders,body:JSON.stringify({id:opId,op,status})},env);
assert.deepEqual((await (await call(opUrl,{headers})).json()).statuses,{});
for(const status of ['waiting','complete','not_started']){
 const response=await postStatus('19000002315',status);assert.equal(response.status,200);
 assert.equal((await (await call(opUrl,{headers})).json()).statuses['19000002315'].status,status);
}
assert.equal((await postStatus('19000002315','fake')).status,400);
assert.equal((await postStatus('19000009999','complete')).status,400);
assert.equal((await postStatus('19000002315','complete',{...headers,Origin:'https://attacker.test','Content-Type':'application/json'})).status,403);
const revisionBefore=await storage.opStatusRevision(db,opId);
await Promise.all([storage.updateOpStatus(db,opId,'19000002315','complete'),storage.updateOpStatus(db,opId,'19000002316','waiting')]);
const statusSnapshot=await storage.listOpStatuses(db,opId);assert.equal(statusSnapshot.revision,revisionBefore+2);
assert.equal(statusSnapshot.statuses['19000002315'].status,'complete');assert.equal(statusSnapshot.statuses['19000002316'].status,'waiting');
assert.deepEqual((await storage.listOpStatuses(db,'consumo:other-bom')).statuses,{});
assert.equal((await (await call(opUrl+'&revision='+statusSnapshot.revision,{headers})).json()).unchanged,true);
// MB51-60 · Tudo OK: todas as OPs da BOM em uma transação, só admin, só OPs da BOM.
{
 const bulk=(body,customHeaders={...headers,Origin:'https://portal.test','Content-Type':'application/json'})=>call(opUrl,{method:'POST',headers:customHeaders,body:JSON.stringify({id:opId,...body})});
 const seedOps=(await storage.read(db,opId)).ops;assert.ok(seedOps.length>25,'Mais de um bloco de 25');
 const before=await storage.opStatusRevision(db,opId);
 const response=await bulk({ops:seedOps,status:'complete'});assert.equal(response.status,200);
 const snapshot=await response.json();
 assert.equal(Object.values(snapshot.statuses).filter(item=>item.status==='complete').length,seedOps.length);
 assert.equal(snapshot.revision,before+1,'Uma revisão para o lote inteiro');
 assert.equal((await bulk({ops:[...seedOps.slice(0,2),'19000009999'],status:'not_started'})).status,400,'OP de outra BOM recusa o lote todo');
 assert.equal((await storage.listOpStatuses(db,opId)).statuses[seedOps[0]].status,'complete','Nada mudou no lote recusado');
 assert.equal((await bulk({ops:['abc'],status:'complete'})).status,400);
 const reopened=await (await bulk({ops:seedOps,status:'not_started'})).json();
 assert.ok(Object.values(reopened.statuses).every(item=>item.status==='not_started'));
 await storage.updateOpStatus(db,opId,'19000002315','complete');await storage.updateOpStatus(db,opId,'19000002316','waiting');
}
const viewerPassword=require('node:crypto').randomBytes(24).toString('hex');const viewerEnv={...environment,PORTAL_VIEWER_PASSWORD:viewerPassword};
const viewerLogin=await call('/auth/login',{method:'POST',headers:{Origin:'https://portal.test','Content-Type':'application/x-www-form-urlencoded','CF-Connecting-IP':'192.0.2.5'},body:new URLSearchParams({password:viewerPassword}).toString()},viewerEnv);
const viewerCookie=viewerLogin.headers.get('Set-Cookie').split(';')[0],viewerHeaders={Cookie:viewerCookie,Origin:'https://portal.test','Content-Type':'application/json'};
assert.equal((await postStatus('19000002315','waiting',viewerHeaders,viewerEnv)).status,403);
const viewerSnapshot=await (await call(opUrl,{headers:viewerHeaders},viewerEnv)).json();assert.equal(viewerSnapshot.canEdit,false);assert.equal(viewerSnapshot.statuses['19000002315'].status,'complete');
// MB51-57 · apagar BOM cadastrada: admin + origem + versão; só a própria BOM some.
{
 const bomId='consumo:apagar-teste',ops=['19000007001','19000007002'];
 const savedBom=await storage.save(db,{id:bomId,name:'BC99',revision:'BOM errada',source:'teste',version:'new',ops,
  rows:[{id:'1',material:'X-1',description:'Item',unit:'PCS',classification:'C',required:2,consumption:{'19000007001':0,'19000007002':1}}]});
 await storage.updateOpStatus(db,bomId,'19000007001','complete');
 await storage.updateManualChecks(db,bomId,['19000007002|X-1|PCS'],true,'admin');
 const otherBefore=await storage.listOpStatuses(db,opId);
 const rename=(body,customHeaders={...headers,Origin:'https://portal.test','Content-Type':'application/json'},env=environment)=>call('/api/data-meta',{method:'POST',headers:customHeaders,body:JSON.stringify(body)},env);
 assert.equal((await rename({id:bomId,version:savedBom.version,name:'BC22X',revision:'BOM 1339'},viewerHeaders,viewerEnv)).status,403);
 assert.equal((await rename({id:bomId,version:'velha',name:'BC22X',revision:'BOM 1339'})).status,409);
 assert.equal((await rename({id:opId,version:'seed',name:'X',revision:'Y'})).status,400);
 assert.equal((await rename({id:bomId,version:savedBom.version,name:'  ',revision:'BOM 1339'})).status,400);
 const renamed=await rename({id:bomId,version:savedBom.version,name:' BC22X ',revision:'BOM 1339'});assert.equal(renamed.status,200);
 const listed=(await (await call('/api/data',{headers})).json()).find(item=>item.id===bomId);
 assert.equal(listed.name,'BC22X');assert.equal(listed.revision,'BOM 1339');assert.equal(listed.version,savedBom.version,'Renomear não troca as linhas');
 assert.equal((await storage.read(db,bomId)).rows.length,1);
 assert.equal((await rename({id:bomId,version:savedBom.version,name:'BC22X',revision:'BOM 1339',ops:['123']})).status,400,'OP inválida');
 const withOps=await rename({id:bomId,version:savedBom.version,name:'BC22X',revision:'BOM 1339',ops:['19000007001',' 19000007003 ','19000007003']});assert.equal(withOps.status,200);
 assert.deepEqual((await storage.read(db,bomId)).ops,['19000007001','19000007003'],'OPs novas ficam na BOM; repetidas contam uma vez');
 assert.equal((await storage.updateOpStatus(db,bomId,'19000007003','waiting')).statuses['19000007003'].status,'waiting','OP adicionada aceita status');
 const del=(query,customHeaders={...headers,Origin:'https://portal.test'},env=environment)=>call('/api/data?'+new URLSearchParams(query),{method:'DELETE',headers:customHeaders},env);
 assert.equal((await del({id:bomId,version:savedBom.version},viewerHeaders,viewerEnv)).status,403,'Consulta não apaga');
 assert.equal((await del({id:bomId,version:savedBom.version},{...headers,Origin:'https://attacker.test'})).status,403,'Outra origem não apaga');
 assert.equal((await del({id:bomId,version:'outra-versao'})).status,409,'Versão antiga não apaga');
 assert.equal((await del({id:opId,version:'seed'})).status,400,'BOM do pacote é protegida');
 assert.equal((await del({id:'7000',version:'seed'})).status,400,'Depósito não é apagado por esta rota');
 assert.equal((await storage.read(db,bomId)).rows.length,1,'Conflito não apagou nada');
 const ok=await del({id:bomId,version:savedBom.version});assert.equal(ok.status,200);
 const body=await ok.json();assert.equal(body.deleted,bomId);assert.equal(body.rows,1);assert.equal(body.statuses,2);assert.equal(body.checks,1);
 assert.equal((await call('/api/data?id='+encodeURIComponent(bomId),{headers})).status,404);
 assert.ok(!(await (await call('/api/data',{headers})).json()).some(item=>item.id===bomId));
 for(const table of ['entries','manual_checks','manual_check_state','op_statuses','op_status_state'])
  assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE dataset=?`).bind(bomId).first()).n,0,table);
 assert.deepEqual((await storage.listOpStatuses(db,opId)).statuses,otherBefore.statuses,'Outra BOM mantém seus status');
 assert.equal((await storage.read(db,'7000')).rows.length,1749,'Depósitos intactos');
 assert.equal((await del({id:bomId,version:savedBom.version})).status,404,'Segunda exclusão informa que já não existe');
}
// MB51-66 · BOMs do plano (OEBOM): admin cadastra, muda ônibus restantes e apaga; Consulta só lê.
{
 const planUrl='/api/plan-boms',jsonHeaders={...headers,Origin:'https://portal.test','Content-Type':'application/json'};
 const post=(body,h=jsonHeaders,env=environment)=>call(planUrl,{method:'POST',headers:h,body:JSON.stringify(body)},env);
 const data={id:'plano:bc22s02-dwb1363',name:'BC22S02 · DWB1363',revision:'A7_V9',model:'BC22S02',dwb:'1363',units:40,source:'teste.xlsx',version:'new',
  rows:[{id:'1',material:'11911717-00',description:'Tubo',unit:'PCS',required:5,source:'Stats'},{id:'2',material:'17742636-00',description:'Plate',unit:'PCS',required:2,source:'Stats+KD'}]};
 assert.equal((await post({action:'save',data},viewerHeaders,viewerEnv)).status,403,'Consulta não cadastra');
 assert.equal((await post({action:'save',data:{...data,units:-1}})).status,400,'ônibus negativo');
 assert.equal((await post({action:'save',data:{...data,rows:[{material:'X',required:1}]}})).status,400,'SAP inválido');
 assert.equal((await post({action:'save',data:{...data,id:'consumo:x'}})).status,400,'rota não grava BOM × OP');
 const saved=await post({action:'save',data});assert.equal(saved.status,200);const version=(await saved.json()).version;
 assert.equal((await post({action:'save',data})).status,400,'versão velha não sobrescreve');
 const list=await (await call(planUrl,{headers:viewerHeaders},viewerEnv)).json();
 assert.equal(list.canEdit,false);assert.equal(list.plans.length,1);assert.equal(list.plans[0].units,40);assert.equal(list.plans[0].rows,undefined,'lista sem linhas');
 assert.ok(!(await (await call('/api/data',{headers})).json()).some(item=>item.id===data.id),'BOM do plano não aparece no seletor da BOM × OP');
 assert.equal((await post({action:'units',id:data.id,units:13})).status,200);
 assert.equal((await post({action:'units',id:data.id,units:1.5})).status,400);
 const full=await (await call(planUrl+'?id='+encodeURIComponent(data.id),{headers})).json();
 assert.equal(full.units,13);assert.equal(full.rows.length,2);assert.equal(full.version,version,'mudar ônibus não troca as linhas');
 const replaced=await post({action:'save',data:{...data,units:13,version,rows:[data.rows[0]]}});assert.equal(replaced.status,200,'reenviar o OEBOM substitui');
 const v2=(await replaced.json()).version;assert.equal((await storage.read(db,data.id)).rows.length,1);
 const del=(q,h={...headers,Origin:'https://portal.test'},env=environment)=>call(planUrl+'?'+new URLSearchParams(q),{method:'DELETE',headers:h},env);
 assert.equal((await del({id:data.id,version:v2},viewerHeaders,viewerEnv)).status,403);
 assert.equal((await del({id:data.id,version:version})).status,409);
 assert.equal((await del({id:data.id,version:v2})).status,200);
 assert.equal((await (await call(planUrl,{headers})).json()).plans.length,0);
 assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM entries WHERE dataset=?').bind(data.id).first()).n,0);
}
// Shared Ana notes are append-only and analyst access never grants OP marking.
const analystPassword=require('node:crypto').randomBytes(24).toString('hex');
const analystEnv={...viewerEnv,PORTAL_ANALYST_PASSWORD:analystPassword};
const analystLogin=await call('/auth/login',{method:'POST',headers:{Origin:'https://portal.test','Content-Type':'application/x-www-form-urlencoded','CF-Connecting-IP':'192.0.2.6'},body:new URLSearchParams({password:analystPassword}).toString()},analystEnv);
assert.equal(analystLogin.status,303);
const analystHeaders={Cookie:analystLogin.headers.get('Set-Cookie').split(';')[0],Origin:'https://portal.test','Content-Type':'application/json'};
assert.equal((await (await call('/api/session',{headers:analystHeaders},analystEnv)).json()).role,'analyst');
const notesUrl='/api/ana-notes?op=19000002315',note={id:crypto.randomUUID(),op:'19000002315',material:'A-1',text:'Confirmado no SAP.\nConferir na próxima leitura.'};
const postNote=(payload,customHeaders=analystHeaders,env=analystEnv)=>call('/api/ana-notes',{method:'POST',headers:customHeaders,body:JSON.stringify(payload)},env);
assert.equal((await postNote(note,viewerHeaders,viewerEnv)).status,403);
assert.equal((await postNote(note,{...analystHeaders,Origin:'https://attacker.test'})).status,403);
assert.equal((await postNote({...note,text:'x'.repeat(4001)})).status,400);
assert.equal((await postNote({...note,text:'x'.repeat(25000)})).status,413);
assert.equal((await postNote({...note,op:"A' OR 1=1"})).status,400);
assert.equal((await postNote(note)).status,200);
assert.equal((await postNote(note)).status,200,'A repeated save after a network timeout must not duplicate a note');
assert.equal((await postNote({...note,text:'Outro texto'})).status,409);
const notesSnapshot=await (await call(notesUrl,{headers:viewerHeaders},viewerEnv)).json();
assert.equal(notesSnapshot.notes.length,1);assert.equal(notesSnapshot.notes[0].text,note.text);assert.equal(notesSnapshot.canWrite,false);
assert.equal(notesSnapshot.notes[0].author_role,'analyst');
assert.equal((await (await call(notesUrl+'&revision='+notesSnapshot.revision,{headers:analystHeaders},analystEnv)).json()).unchanged,true);
assert.equal((await (await call('/api/ana-notes?op=19000002316',{headers})).json()).notes.length,0);
assert.equal((await (await call(notesUrl+'&material=B-2',{headers})).json()).notes.length,0);
assert.equal((await postStatus('19000002315','waiting',analystHeaders,analystEnv)).status,403);
assert.equal((await call('/api/data',{method:'POST',headers:analystHeaders,body:'{}'},analystEnv)).status,403);
assert.equal((await call(checksUrl,{method:'POST',headers:analystHeaders,body:'{}'},analystEnv)).status,403);
assert.equal((await call(notesUrl,{headers:analystHeaders},{...analystEnv,PORTAL_ANALYST_PASSWORD:analystPassword+'changed'})).status,401);
const otherNote={...note,id:crypto.randomUUID(),material:'B-2',text:'Segunda observação'};
await Promise.all([postNote(otherNote),postNote({...otherNote,id:crypto.randomUUID(),text:'Terceira observação'})]);
assert.equal((await (await call(notesUrl,{headers})).json()).notes.length,3);
await storage.save(db,{...saved,rows:saved.rows});
assert.equal((await (await call(notesUrl,{headers})).json()).notes.length,3,'Updating a dataset must preserve the note history');
for(let i=0;i<52;i++)await postNote({...note,id:crypto.randomUUID(),text:'Nota '+i});
const firstPage=await (await call(notesUrl,{headers})).json();assert.equal(firstPage.notes.length,50);assert.ok(firstPage.nextBefore);
const lastPage=await (await call(notesUrl+'&before='+firstPage.nextBefore,{headers})).json();assert.equal(lastPage.notes.length,5);assert.equal(lastPage.nextBefore,null);
assert.equal(new Set([...firstPage.notes,...lastPage.notes].map(note=>note.id)).size,55);
console.log('Observações Ana: compartilhamento, isolamento OP/material, perfil analista, CSRF, tamanho, idempotência, concorrência, histórico e paginação passaram.');
// MB51-62 · Scrap Form: numeração, rascunho, PDF emitido, versões assinadas, perfis e consulta nas BOMs.
{
 await build({entryPoints:[root+'/lib/scrap-pdf.ts'],bundle:true,platform:'node',format:'cjs',outfile:temp+'/scrap-pdf.cjs'});
 const {buildScrapPdf}=require(temp+'/scrap-pdf.cjs');
 const scrap=(payload,customHeaders=analystHeaders,env=analystEnv)=>call('/api/scrap-forms',{method:'POST',headers:customHeaders,body:JSON.stringify(payload)},env);
 const b64=bytes=>Buffer.from(bytes).toString('base64');
 const item={date:'2026-09-24',material:'11272431-00',quantity:1,name:'UNID DE CONTROLE ELETR EBS 5S',defect:'Queimado no debug',cause:'F',vin:'1076',op:'19000002673',unitPrice:1054.87,classification:'B'};
 const data={formDate:'2026-09-24',items:[item],approvers:{production:'André Ribeiro',quality:'Marcus Gallo',logistics:'Gleiber Souza',finance:'Rosymara Santos'},costCenter:'',sapDocument:'',notes:''};
 const viewerList=await (await call('/api/scrap-forms',{headers:viewerHeaders},viewerEnv)).json();
 assert.deepEqual(viewerList.forms,[]);assert.equal(viewerList.canEdit,false);
 assert.equal((await scrap({action:'create',data},viewerHeaders,viewerEnv)).status,403,'Consulta só lê');
 assert.equal((await scrap({action:'create',data},{...analystHeaders,Origin:'https://attacker.test'})).status,403);
 assert.equal((await scrap({action:'create',data:{items:'x'}})).status,400);
 const first=(await (await scrap({action:'create',data})).json()).form;
 const year=Number(new Intl.DateTimeFormat('en-US',{timeZone:'America/Sao_Paulo',year:'numeric'}).format(new Date()));
 assert.equal(first.number,`SCRAP-${year}-0001`);assert.equal(first.status,'draft');assert.equal(first.createdBy,'analyst');
 const second=(await (await scrap({action:'create',data:{...data,items:[{...item,material:''}]}})).json()).form;
 assert.equal(second.number,`SCRAP-${year}-0002`);
 assert.equal((await scrap({action:'update',id:first.id,revision:first.revision+5,data})).status,409,'Revisão antiga não sobrescreve');
 let form=(await (await scrap({action:'update',id:first.id,revision:first.revision,data:{...data,items:[{...item,quantity:2}]}})).json()).form;
 assert.equal(form.data.items[0].quantity,2);assert.equal(form.revision,2);
 const wrongPdf=await buildScrapPdf({number:second.number,data:form.data});
 const upload=(body,customHeaders,env)=>scrap({action:'upload',id:form.id,revision:form.revision,name:'Scrap.pdf',...body},customHeaders,env);
 assert.match((await (await upload({kind:'generated',pdf:b64(wrongPdf)})).json()).error,/não é do formulário/);
 assert.equal((await upload({kind:'generated',pdf:'%%%'})).status,400);
 assert.equal((await upload({kind:'generated',pdf:b64(Buffer.from('não é pdf'))})).status,400);
 assert.equal((await upload({kind:'signed',pdf:b64(wrongPdf),signatures:[]})).status,409,'Assinado antes de emitir');
 const generated=await buildScrapPdf({number:form.number,data:form.data});
 form=(await (await upload({kind:'generated',pdf:b64(generated)})).json()).form;
 assert.equal(form.status,'signing');assert.equal(form.fileVersion,1);assert.equal(form.files[0].kind,'generated');assert.equal(form.files[0].size,generated.length);
 assert.equal((await scrap({action:'update',id:form.id,revision:form.revision,data})).status,409,'Emitido não muda sem reabrir');
 const file=await call(`/api/scrap-forms?file=${form.id}&version=1`,{headers:viewerHeaders},viewerEnv);
 assert.equal(file.headers.get('Content-Type'),'application/pdf');assert.deepEqual(new Uint8Array(await file.arrayBuffer()),generated);
 assert.equal((await call(`/api/scrap-forms?file=${form.id}&version=9`,{headers})).status,404);
 const sig=(slot,field,signer)=>({field,slot,signer,signedAt:'2026-09-25T10:00:00Z',check:'valid',coversWholeFile:false,detail:'ok'});
 const part=[sig('production','Assinatura_Producao','André Ribeiro'),{...sig('quality','Assinatura_Qualidade','Marcus Gallo'),coversWholeFile:true}];
 assert.equal((await upload({kind:'signed',pdf:b64(generated),signatures:part})).status,409,'Mesmo arquivo da versão atual');
 // PDF maior que uma parte (90 mil caracteres base64): gravado em pedaços e lido inteiro.
 const big=Buffer.concat([Buffer.from(generated),Buffer.from('\n%'+'x'.repeat(300000)+'\n%/ByteRange\n%/ByteRange\n')]);
 assert.equal((await upload({kind:'signed',pdf:b64(Buffer.concat([Buffer.from(generated),Buffer.from('\n%x\n')])),signatures:part})).status,400,'Sem /ByteRange no arquivo');
 assert.equal((await upload({kind:'signed',pdf:b64(big),signatures:[]})).status,400,'Sem assinatura');
 assert.equal((await upload({kind:'signed',pdf:b64(Buffer.concat([big,Buffer.alloc(2_300_000,32)])),signatures:part})).status,413);
 assert.equal((await upload({kind:'signed',pdf:b64(big),signatures:[{check:'aprovado'}]})).status,400);
 form=(await (await upload({kind:'signed',pdf:b64(big),signatures:part})).json()).form;
 assert.equal(form.status,'signing');assert.equal(form.fileVersion,2);assert.equal(form.signatures.length,2);
 const parts=await db.prepare('SELECT COUNT(*) AS n FROM scrap_files WHERE form_id=? AND version=2').bind(form.id).first();assert.ok(parts.n>=3);
 assert.deepEqual(Buffer.from(await (await call(`/api/scrap-forms?file=${form.id}&version=2&download`,{headers})).arrayBuffer()),big);
 const all=[...part.map(entry=>({...entry,coversWholeFile:false})),sig('logistics','Assinatura_Logistica','matheus.silva2'),{...sig('finance','Assinatura_Financeiro','Rosymara Santos'),coversWholeFile:true}];
 const signedPdf=Buffer.concat([big,Buffer.from('%%assinado\n%/ByteRange\n%/ByteRange\n')]);
 assert.equal((await scrap({action:'sent',id:form.id})).status,409,'Só o assinado é marcado como enviado');
 assert.equal((await scrap({action:'upload',id:form.id,revision:form.revision-1,kind:'signed',name:'x.pdf',pdf:b64(signedPdf),signatures:all})).status,409);
 assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM scrap_files WHERE form_id=? AND version=3').bind(form.id).first()).n,0,'Revisão antiga não grava partes');
 form=(await (await upload({kind:'signed',pdf:b64(signedPdf),signatures:all})).json()).form;
 assert.equal(form.status,'signed');assert.ok(form.signedAt);assert.equal(form.files.length,3);
 assert.equal((await scrap({action:'posting',id:second.id,revision:second.revision,pr:'6000014878'})).status,409,'Rascunho não recebe PR/PO');
 assert.equal((await scrap({action:'posting',id:form.id,revision:form.revision,prDate:'12/05/2026'})).status,400,'Data da PR inválida');
 form=(await (await scrap({action:'posting',id:form.id,revision:form.revision,sapDocument:'4900012345',costCenter:'BR02-PROD',pr:'6000014878',prDate:'2026-05-12',po:'9900029259'})).json()).form;
 assert.equal(form.data.sapDocument,'4900012345');assert.equal(form.status,'signed');
 assert.deepEqual([form.data.pr,form.data.prDate,form.data.po],['6000014878','2026-05-12','9900029259']);
 form=(await (await scrap({action:'sent',id:form.id})).json()).form;assert.ok(form.sentAt);
 const list=await (await call('/api/scrap-forms',{headers:viewerHeaders},viewerEnv)).json();
 assert.deepEqual(list.forms.map(entry=>entry.number),[second.number,first.number]);assert.equal(list.forms[1].files.length,3);assert.equal(list.forms[1].sentAt,form.sentAt);
 assert.equal((await scrap({action:'delete',id:form.id,revision:(await (await call('/api/scrap-forms',{headers})).json()).forms[1].revision})).status,403,'Analista não apaga formulário emitido');
 assert.equal((await scrap({action:'reopen',id:form.id,revision:list.forms[1].revision})).status,403,'Assinado por todos: só o administrador reabre');
 const adminJson={...headers,Origin:'https://portal.test','Content-Type':'application/json'};
 const reopened=(await (await scrap({action:'reopen',id:form.id,revision:list.forms[1].revision},adminJson,environment)).json()).form;
 assert.equal(reopened.status,'draft');assert.deepEqual(reopened.signatures,[]);assert.equal(reopened.files.length,3,'PDFs antigos ficam no histórico');assert.equal(reopened.sentAt,null,'Reaberto: o envio anterior não vale');
 assert.equal((await scrap({action:'delete',id:second.id,revision:second.revision})).status,200,'Rascunho sem PDF pode ser apagado pelo analista');
 assert.equal((await scrap({action:'delete',id:reopened.id,revision:reopened.revision},adminJson,environment)).status,200);
 assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM scrap_files').first()).n,0);
 assert.equal((await scrap({action:'delete',id:reopened.id,revision:reopened.revision})).status,404);
 const third=(await (await scrap({action:'create',data})).json()).form;
 assert.equal(third.number,`SCRAP-${year}-0003`,'Número apagado não volta a ser usado');
 const lookup=await (await call('/api/scrap-forms?lookup='+encodeURIComponent('11272431-00, 17670117-00,x;drop,99999999-99'),{headers:viewerHeaders},viewerEnv)).json();
 assert.equal(lookup.materials['11272431-00'].description,'UNID DE CONTROLE ELETR EBS 5S');
 assert.equal(lookup.materials['11272431-00'].boms[0].classification,'B');
 assert.equal(lookup.materials['17670117-00'].boms[0].classification,'A');
 assert.equal(lookup.materials['99999999-99'],undefined);
 console.log('Scrap Form: numeração por ano, rascunho, PDF emitido, versões assinadas em partes, conflito, perfis, reabertura, exclusão e consulta nas BOMs passaram.');
 // MB51-64 · FO.FI.C.007 (baixa em CC): numeração própria, quatro assinaturas obrigatórias, Doc SAP e listas separadas.
 const {buildCcPdf}=require(temp+'/scrap-pdf.cjs');
 const cc=(payload,customHeaders,env)=>scrap({...payload,doc:'cc'},customHeaders,env);
 const ccItem={company:'br00',plant:'BR02',wh:'7000',material:'11272431-00',description:'UNID DE CONTROLE ELETR EBS 5S',quantity:-1,unitCost:1054.87,costCenter:'BR000411',costCenterDescription:'Operational - Chassis'};
 const ccData={period:'2026-09',items:[ccItem],mainReason:'Scrapped materials approved in Scrap Form '+third.number+'.',reason:'Scrap',action:'Write off the scrapped quantities.',approvers:{requester:'Pessoa Solicitante',manager:'Pessoa Gestor',scm:'Pessoa SCM',finance:'Pessoa Financeiro',production:'intruso'},scrapForms:[third.number,'lixo',third.number],sapDocument:'',notes:''};
 assert.equal((await cc({action:'create',data:ccData},viewerHeaders,viewerEnv)).status,403,'Consulta só lê');
 assert.equal((await cc({action:'create',data:{...ccData,items:[{...ccItem,unitCost:-5}]}})).status,400,'Custo negativo é recusado');
 assert.equal((await cc({action:'create',data:{...ccData,items:Array(301).fill(ccItem)}})).status,400,'No máximo 300 itens');
 let ccForm=(await (await cc({action:'create',data:ccData})).json()).form;
 assert.equal(ccForm.number,`CC-${year}-0001`,'Numeração própria, independente do Scrap Form');
 assert.deepEqual(ccForm.data.scrapForms,[third.number],'Só números SCRAP-… válidos, sem repetir');
 assert.equal(ccForm.data.items[0].quantity,-1);assert.equal(ccForm.data.items[0].company,'BR00');
 assert.deepEqual(Object.keys(ccForm.data.approvers),['requester','manager','scm','finance']);
 const ccList=await (await call('/api/scrap-forms?doc=cc',{headers:viewerHeaders},viewerEnv)).json();
 assert.deepEqual(ccList.forms.map(entry=>entry.number),[ccForm.number]);assert.equal(ccList.canEdit,false);
 assert.ok(!(await (await call('/api/scrap-forms',{headers:viewerHeaders},viewerEnv)).json()).forms.some(entry=>entry.id===ccForm.id),'Listas separadas');
 assert.equal((await scrap({action:'update',id:ccForm.id,revision:ccForm.revision,data})).status,404,'A baixa não é alterada como Scrap Form');
 const ccUpload=body=>cc({action:'upload',id:ccForm.id,revision:ccForm.revision,name:'FO.FI.C.007.pdf',...body});
 assert.match((await (await ccUpload({kind:'generated',pdf:b64(generated)})).json()).error,/não é do formulário CC-/,'PDF de Scrap Form não serve');
 const ccPdf=await buildCcPdf({number:ccForm.number,data:ccForm.data});
 ccForm=(await (await ccUpload({kind:'generated',pdf:b64(ccPdf)})).json()).form;
 assert.equal(ccForm.status,'signing');assert.equal(ccForm.files[0].size,ccPdf.length);
 const three=[sig('requester','Assinatura_Solicitante','Pessoa Solicitante'),sig('manager','Assinatura_Gestor','Pessoa Gestor'),sig('scm','Assinatura_SCM','Pessoa SCM')];
 const signedCc=mark=>Buffer.concat([Buffer.from(ccPdf),Buffer.from('\n%'+mark+'\n'+'%/ByteRange\n'.repeat(4))]);
 ccForm=(await (await ccUpload({kind:'signed',pdf:b64(signedCc('a')),signatures:three})).json()).form;
 assert.equal(ccForm.status,'signing','Sem o Financeiro não fecha');
 ccForm=(await (await ccUpload({kind:'signed',pdf:b64(signedCc('b')),signatures:[...three,sig('production','Assinatura_Producao','Pessoa Produção')]})).json()).form;
 assert.equal(ccForm.status,'signing','Quadro do Scrap Form não conta no FO.FI.C.007');
 ccForm=(await (await ccUpload({kind:'signed',pdf:b64(signedCc('c')),signatures:[...three,sig('finance','Assinatura_Financeiro','Pessoa Financeiro')]})).json()).form;
 assert.equal(ccForm.status,'signed');assert.ok(ccForm.signedAt);assert.equal(ccForm.files.length,4);
 assert.deepEqual(Buffer.from(await (await call(`/api/scrap-forms?file=${ccForm.id}&version=4`,{headers:viewerHeaders},viewerEnv)).arrayBuffer()),signedCc('c'));
 ccForm=(await (await cc({action:'posting',id:ccForm.id,revision:ccForm.revision,sapDocument:'4900099999',pr:'ignorado',costCenter:'X'})).json()).form;
 assert.equal(ccForm.data.sapDocument,'4900099999');assert.equal(ccForm.data.pr,undefined,'FO.FI.C.007 não tem PR');assert.equal(ccForm.status,'signed');
 ccForm=(await (await cc({action:'sent',id:ccForm.id})).json()).form;assert.ok(ccForm.sentAt);
 assert.equal((await cc({action:'reopen',id:ccForm.id,revision:ccForm.revision})).status,403,'Assinado por todos: só o administrador reabre');
 const ccReopened=(await (await cc({action:'reopen',id:ccForm.id,revision:ccForm.revision},adminJson,environment)).json()).form;
 assert.equal(ccReopened.status,'draft');assert.deepEqual(ccReopened.signatures,[]);assert.equal(ccReopened.sentAt,null);
 assert.equal((await cc({action:'delete',id:ccReopened.id,revision:ccReopened.revision},adminJson,environment)).status,200);
 assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM scrap_files WHERE form_id=?').bind(ccForm.id).first()).n,0);
 assert.equal((await (await cc({action:'create',data:ccData})).json()).form.number,`CC-${year}-0002`,'Número apagado não volta a ser usado');
 assert.equal((await (await scrap({action:'create',data})).json()).form.number,`SCRAP-${year}-0004`,'A baixa não consome número de Scrap Form');
 console.log('FO.FI.C.007: numeração CC-…, listas separadas, quatro assinaturas obrigatórias, Doc SAP, reabertura e exclusão passaram.');
 // MB51-68 · Baixa vinda de planilha: 300 itens, PDF de 8 páginas guardado em partes e lido de volta igual.
 {
  const big=Array.from({length:300},(_,index)=>({...ccItem,material:`2000${String(index+1).padStart(4,'0')}-00`,description:'PECA PERDIDA NO INVENTARIO '+(index+1),quantity:-(index+1),unitCost:12.3456}));
  let bigForm=(await (await cc({action:'create',data:{...ccData,scrapForms:[],items:big,reason:'LOSS'}})).json()).form;
  assert.equal(bigForm.data.items.length,300);assert.equal(bigForm.data.items[299].unitCost,12.3456);
  const bigPdf=await buildCcPdf({number:bigForm.number,data:bigForm.data});
  bigForm=(await (await cc({action:'upload',id:bigForm.id,revision:bigForm.revision,name:'FO.FI.C.007 grande.pdf',kind:'generated',pdf:b64(bigPdf)})).json()).form;
  assert.equal(bigForm.status,'signing');assert.equal(bigForm.files[0].size,bigPdf.length);
  assert.ok((await db.prepare('SELECT COUNT(*) AS n FROM scrap_files WHERE form_id=?').bind(bigForm.id).first()).n>1,'PDF grande em mais de uma parte');
  assert.deepEqual(new Uint8Array(await (await call(`/api/scrap-forms?file=${bigForm.id}&version=1`,{headers:viewerHeaders},viewerEnv)).arrayBuffer()),bigPdf);
  const bigReopened=(await (await cc({action:'reopen',id:bigForm.id,revision:bigForm.revision},adminJson,environment)).json()).form;
  assert.equal((await cc({action:'delete',id:bigReopened.id,revision:bigReopened.revision},adminJson,environment)).status,200);
  console.log(`FO.FI.C.007 com 300 itens: PDF de ${Math.round(bigPdf.length/1024)} KB guardado e lido de volta.`);
 }
 // MB51-65 · Formulários que já existiam (Excel → PDF assinado): número do portal, PDF original guardado, transcrição corrigível.
 {
  const legacy=fs.readFileSync(path.join(root,'tests/fixtures/legado/legado-scrap-assinado.pdf'));
  const legacyItem={date:'2026-09-22',material:'11272431-00',quantity:2,name:'UNID DE CONTROLE ELETR EBS 5S',defect:'Apresentou fuga de tensão durante a depuração',cause:'A',vin:'901',op:'19000002701',unitPrice:1233.89,classification:'B'};
  const legacyData={formDate:'2026-09-22',items:[legacyItem],approvers:{production:'Pessoa Producao',quality:'Pessoa Qualidade',logistics:'Pessoa Logistica',finance:'Pessoa Financeiro'},costCenter:'',sapDocument:'',notes:'',source:'ignorado'};
  const three=[sig('production','Signature3','Pessoa Producao'),sig('quality','Signature4','Pessoa Qualidade'),{...sig('logistics','Signature2','Pessoa Logistica'),coversWholeFile:true}];
  const importOne=(body,customHeaders,env)=>scrap({action:'import',name:'Formulario de SCRAP A-B 22.09.2026 falta Rosy.pdf',data:legacyData,pdf:b64(legacy),signatures:three,...body},customHeaders,env);
  assert.equal((await importOne({},viewerHeaders,viewerEnv)).status,403,'Consulta não importa');
  assert.equal((await importOne({signatures:[]})).status,400,'PDF sem assinatura vira rascunho, não importação');
  assert.equal((await importOne({pdf:b64(Buffer.from('não é pdf'))})).status,400);
  assert.equal((await importOne({pdf:b64(Buffer.concat([legacy,Buffer.alloc(1_600_000,32)]))})).status,413,'Acima de 1,5 MB não cabe');
  assert.equal((await importOne({signatures:[...three,sig('finance','Assinatura_Financeiro','Pessoa Financeiro')]})).status,400,'Mais assinaturas conferidas do que /ByteRange no arquivo');
  let imported=(await (await importOne({})).json()).form;
  assert.match(imported.number,new RegExp(`^SCRAP-${year}-\\d{4}$`));
  assert.equal(imported.status,'signing','Falta o Financeiro (item classe B)');
  assert.equal(imported.data.source,'Formulario de SCRAP A-B 22.09.2026 falta Rosy.pdf','Origem é o nome do PDF, não o que veio nos dados');
  assert.equal(imported.files.length,1);assert.equal(imported.files[0].kind,'signed');assert.equal(imported.fileVersion,1);
  assert.deepEqual(imported.signatures.map(entry=>entry.check),['imported','imported','imported'],'Quem assinou o PDF antigo conta, sem conferir se foi regravado');
  assert.deepEqual(Buffer.from(await (await call(`/api/scrap-forms?file=${imported.id}&version=1`,{headers:viewerHeaders},viewerEnv)).arrayBuffer()),legacy);
  const again=await importOne({});
  assert.equal(again.status,409);assert.match((await again.json()).error,new RegExp(`já está no portal \\(${imported.number}\\)`),'O mesmo PDF não entra duas vezes');
  assert.equal((await scrap({action:'import',doc:'cc',name:'x.pdf',data:{period:'2026-09',items:[]},pdf:b64(legacy),signatures:three})).status,409,'Nem como outro tipo de formulário');
  // Transcrição: corrigir os dados não mexe nas assinaturas; a situação é recalculada.
  imported=(await (await scrap({action:'update',id:imported.id,revision:imported.revision,data:{...legacyData,items:[{...legacyItem,classification:'C',name:'Corrigido'}],source:'outro.pdf'}})).json()).form;
  assert.equal(imported.data.items[0].name,'Corrigido');assert.equal(imported.data.source,'Formulario de SCRAP A-B 22.09.2026 falta Rosy.pdf');
  assert.equal(imported.status,'signed','Classe C: o Financeiro deixa de ser exigido');assert.ok(imported.signedAt);assert.equal(imported.signatures.length,3);
  imported=(await (await scrap({action:'update',id:imported.id,revision:imported.revision,data:legacyData})).json()).form;
  assert.equal(imported.status,'signing');assert.equal(imported.signedAt,null);
  // Assinatura "importada" que não veio na importação é recusada.
  assert.equal((await scrap({action:'upload',id:imported.id,revision:imported.revision,kind:'signed',name:'x.pdf',pdf:b64(fs.readFileSync(path.join(root,'tests/fixtures/legado/legado-scrap-completo.pdf'))),signatures:[...imported.signatures,{...sig('finance','Assinatura_Financeiro','Pessoa Financeiro'),check:'imported'}]})).status,400);
  // O PDF devolvido com a assinatura do Financeiro entra como nova versão.
  const complete=fs.readFileSync(path.join(root,'tests/fixtures/legado/legado-scrap-completo.pdf'));
  imported=(await (await scrap({action:'upload',id:imported.id,revision:imported.revision,kind:'signed',name:'completo.pdf',pdf:b64(complete),signatures:[...imported.signatures.map(entry=>({...entry,coversWholeFile:false})),{...sig('finance','Assinatura_Financeiro','Pessoa Financeiro'),coversWholeFile:true}]})).json()).form;
  assert.equal(imported.status,'signed');assert.equal(imported.files.length,2);
  // Criar à mão não aceita "source".
  const manual=(await (await scrap({action:'create',data:{...data,source:'falso.pdf'}})).json()).form;
  assert.equal(manual.data.source,undefined);
  assert.equal((await scrap({action:'update',id:manual.id,revision:manual.revision,data})).status,200);
  // Depois de reaberto e emitido pelo portal, deixa de ser transcrição.
  const reopened=(await (await scrap({action:'reopen',id:imported.id,revision:imported.revision},adminJson,environment)).json()).form;
  const portalPdf=await buildScrapPdf({number:reopened.number,data:reopened.data});
  const issued=(await (await scrap({action:'upload',id:reopened.id,revision:reopened.revision,kind:'generated',name:'novo.pdf',pdf:b64(portalPdf)})).json()).form;
  assert.equal(issued.status,'signing');
  assert.equal((await scrap({action:'update',id:issued.id,revision:issued.revision,data:legacyData})).status,409,'Emitido pelo portal: só reabrindo');
  // FO.FI.C.007 antigo.
  const legacyCc=fs.readFileSync(path.join(root,'tests/fixtures/legado/legado-cc-assinado.pdf'));
  const ccImported=(await (await scrap({action:'import',doc:'cc',name:'Ajuste Inventario Agosto 2026.pdf',data:{...ccData,period:'2026-08'},pdf:b64(legacyCc),signatures:[sig('requester','Signature1','Pessoa Solicitante'),{...sig('manager','Signature2','Pessoa Gestor'),coversWholeFile:true}]})).json()).form;
  assert.match(ccImported.number,new RegExp(`^CC-${year}-\\d{4}$`));assert.equal(ccImported.status,'signing');assert.equal(ccImported.data.source,'Ajuste Inventario Agosto 2026.pdf');
  console.log('Importação de formulários antigos: número, PDF original, duplicado, transcrição corrigível, assinatura nova e FO.FI.C.007 passaram.');
 }
}
console.log('Status das OPs: três cores persistidas, isolamento por BOM, concorrência, leitura compartilhada e bloqueio de consulta passaram.');
assert.equal((await call('/api/data?id=1500',{}, {...environment,REQUIRE_PASSWORD:undefined,PORTAL_PASSWORD:undefined})).status,200);
const publicHtml=await call('/',{}, {...environment,REQUIRE_PASSWORD:undefined,PORTAL_PASSWORD:undefined});assert.equal(publicHtml.status,200);
const api=await call('/api/data?id=1500',{headers});assert.equal(api.status,200);assert.equal((await api.json()).rows[0].quantity,9);
const html=await call('/',{headers});assert.equal(await html.text(),'<html>portal</html>');assert.equal(html.headers.get('Cache-Control'),'no-store');
assert.equal((await call('/api/data',{method:'POST',headers:{...headers,Origin:'https://attacker.test','Content-Type':'application/json'},body:'{}'})).status,403);
assert.equal((await call('/api/data',{headers:{Cookie:'__Host-portal_session='+'a'.repeat(64),'Cf-Access-Authenticated-User-Email':'spoof@example.com'}})).status,401);
assert.equal((await call('/api/data',{headers},{...environment,PORTAL_PASSWORD:password+'changed'})).status,401);
assert.equal((await call('/auth/logout',{method:'POST',headers:{...headers,Origin:'https://portal.test'}})).status,303);
assert.equal((await call('/api/data',{headers})).status,401);
const again=await login(password);const expiredHeaders={Cookie:again.headers.get('Set-Cookie').split(';')[0]};
await db.prepare('UPDATE portal_sessions SET expires=1').run();assert.equal((await call('/api/data',{headers:expiredHeaders})).status,401);
for(let i=0;i<10;i++)assert.equal((await login('wrong','192.0.2.2')).status,401);
assert.equal((await login(password,'192.0.2.2')).status,429);
console.log('Senha: login, cookie seguro, CSRF, logout, expiração, troca da senha, sessão falsa e limite de tentativas passaram.');
console.log((process.argv.includes('--turso')?'Turso/libSQL local':'D1')+': esquema idempotente, base original, SAP textual, gravação/leitura, conflito concorrente, limpeza e isolamento passaram.');
}finally{mf.tursoClient?.close();await mf.dispose();}
await build({entryPoints:[root+'/worker/index.ts'],bundle:true,platform:'browser',format:'esm',outfile:temp+'/worker.mjs'});
const mf2=new Miniflare({modules:true,modulesRoot:temp,scriptPath:temp+'/worker.mjs',compatibilityDate:'2026-05-15',compatibilityFlags:['nodejs_compat'],d1Databases:['DB'],bindings:{REQUIRE_PASSWORD:'true'}});
try{for(const path of ['/','/api/data','/api/sheets','/assets/test.js']){const r=await mf2.dispatchFetch('https://portal.test'+path,{headers:{'oai-authenticated-user-id':'spoof','oai-authenticated-user-email':'spoof@example.com'}});assert.equal(r.status,503);}console.log('Worker: portal, APIs e assets bloqueados sem configuração; cabeçalhos antigos não liberam acesso.');}finally{await mf2.dispose();fs.rmSync(temp,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1});
