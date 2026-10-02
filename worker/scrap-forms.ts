import type {PortalDatabase} from './database';
import type {PortalRole} from './auth';
import {initial,ensureSchema} from './storage';
import {MAX_PDF_BYTES,isIsoDate,sanitizeFormData,sanitizeSignatures,statusFromSignatures,type DocKind,type ScrapFileMeta,type ScrapForm,type ScrapSignature,type ScrapStatus} from '../lib/scrap-form';
import {sanitizeCcData,type CcForm} from '../lib/cc-form';

/**
 * Scrap Form e FO.FI.C.007 (baixa em centro de custo): formulários, versões do
 * PDF (gerado e devolvido com assinaturas) e consulta de descrição/classe nas
 * BOMs cadastradas. Cada tipo tem sua tabela e sua numeração (SCRAP-… / CC-…);
 * os PDFs dos dois ficam em scrap_files.
 * O PDF é guardado em partes de texto base64 (limite de linha do D1/Turso).
 * A conferência criptográfica das assinaturas é feita no navegador; aqui só se
 * guarda o resultado validado e o status calculado pela mesma regra.
 */
const ready=new WeakMap<PortalDatabase,Promise<void>>();
export async function scrapSchema(db:PortalDatabase){
 let promise=ready.get(db);
 if(!promise){promise=db.batch([
  db.prepare("CREATE TABLE IF NOT EXISTS scrap_forms(id TEXT PRIMARY KEY NOT NULL,number TEXT NOT NULL UNIQUE,year INTEGER NOT NULL,seq INTEGER NOT NULL,status TEXT NOT NULL CHECK(status IN ('draft','signing','signed')),data TEXT NOT NULL,signatures TEXT NOT NULL DEFAULT '[]',file_version INTEGER NOT NULL DEFAULT 0,revision INTEGER NOT NULL DEFAULT 1,created_by TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,signed_at TEXT,sent_at TEXT,UNIQUE(year,seq))"),
  // Contador por ano: um número apagado nunca volta a ser usado.
  db.prepare('CREATE TABLE IF NOT EXISTS scrap_counters(year INTEGER PRIMARY KEY NOT NULL,seq INTEGER NOT NULL)'),
  db.prepare("CREATE TABLE IF NOT EXISTS cc_forms(id TEXT PRIMARY KEY NOT NULL,number TEXT NOT NULL UNIQUE,year INTEGER NOT NULL,seq INTEGER NOT NULL,status TEXT NOT NULL CHECK(status IN ('draft','signing','signed')),data TEXT NOT NULL,signatures TEXT NOT NULL DEFAULT '[]',file_version INTEGER NOT NULL DEFAULT 0,revision INTEGER NOT NULL DEFAULT 1,created_by TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,signed_at TEXT,sent_at TEXT,UNIQUE(year,seq))"),
  db.prepare('CREATE TABLE IF NOT EXISTS cc_counters(year INTEGER PRIMARY KEY NOT NULL,seq INTEGER NOT NULL)'),
  db.prepare("CREATE TABLE IF NOT EXISTS scrap_files(form_id TEXT NOT NULL,version INTEGER NOT NULL,part INTEGER NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('generated','signed')),name TEXT NOT NULL,size INTEGER NOT NULL,sha256 TEXT NOT NULL,data TEXT NOT NULL,created_at TEXT NOT NULL,created_by TEXT NOT NULL,PRIMARY KEY(form_id,version,part))")
 ]).then(()=>{}).catch(error=>{ready.delete(db);throw error;});ready.set(db,promise);}
 await promise;
}

/** Tabelas e regra de cada tipo de documento (nomes fixos, nunca vindos do usuário). */
const KINDS={
 scrap:{forms:'scrap_forms',counters:'scrap_counters',prefix:'SCRAP',sanitize:sanitizeFormData},
 cc:{forms:'cc_forms',counters:'cc_counters',prefix:'CC',sanitize:sanitizeCcData}
} as const;
export const docKind=(value:unknown):DocKind=>value==='cc'?'cc':'scrap';
type DocForm=ScrapForm|CcForm;
export class ScrapError extends Error{constructor(message:string,readonly status=400){super(message);}}
/** Erros de validação da regra viram 400 com a mensagem para o usuário. */
function valid<T>(read:()=>T):T{try{return read();}catch(error){throw new ScrapError((error as Error).message||'Dados inválidos.');}}
// Cada parte cabe num comando SQL de até 100 KB (limite do D1 em importação/cópia do banco).
const PART=90_000;
type Row={id:string;number:string;status:ScrapStatus;data:string;signatures:string;file_version:number;revision:number;created_by:string;created_at:string;updated_at:string;signed_at:string|null;sent_at:string|null};
type FileRow={form_id:string;version:number;kind:'generated'|'signed';name:string;size:number;sha256:string;created_at:string;created_by:string};
const validId=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9-]{36}$/i.test(value);
const validRevision=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>0;
function toForm(row:Row,files:ScrapFileMeta[],kind:DocKind):DocForm{
 const sanitize=KINDS[kind].sanitize as (input:unknown)=>any;
 let data:any,signatures:ScrapSignature[]=[];
 try{data=sanitize(JSON.parse(row.data));}catch{data=sanitize({items:[]});}
 try{signatures=sanitizeSignatures(JSON.parse(row.signatures));}catch{}
 return {id:row.id,number:row.number,status:row.status,data,signatures,fileVersion:Number(row.file_version)||0,files,revision:Number(row.revision)||1,createdAt:row.created_at,updatedAt:row.updated_at,createdBy:row.created_by,signedAt:row.signed_at,sentAt:row.sent_at};
}
const fileMeta=(row:FileRow):ScrapFileMeta=>({version:Number(row.version),kind:row.kind,name:row.name,size:Number(row.size),sha256:row.sha256,createdAt:row.created_at,createdBy:row.created_by});

const COLUMNS='id,number,status,data,signatures,file_version,revision,created_by,created_at,updated_at,signed_at,sent_at';
export async function listScrapForms(db:PortalDatabase,kind:DocKind='scrap'){
 await scrapSchema(db);
 const table=KINDS[kind].forms;
 const [forms,files]=await db.batch([
  db.prepare(`SELECT ${COLUMNS} FROM ${table} ORDER BY year DESC,seq DESC`),
  db.prepare(`SELECT f.form_id,f.version,f.kind,f.name,f.size,f.sha256,f.created_at,f.created_by FROM scrap_files f JOIN ${table} t ON t.id=f.form_id WHERE f.part=0 ORDER BY f.form_id,f.version`)
 ]);
 const byForm=new Map<string,ScrapFileMeta[]>();
 for(const row of files.results as FileRow[])byForm.set(row.form_id,[...(byForm.get(row.form_id)||[]),fileMeta(row)]);
 return (forms.results as Row[]).map(row=>toForm(row,byForm.get(row.id)||[],kind));
}
export async function getScrapForm(db:PortalDatabase,id:string,kind:DocKind='scrap'){
 await scrapSchema(db);
 const row=await db.prepare(`SELECT ${COLUMNS} FROM ${KINDS[kind].forms} WHERE id=?`).bind(id).first<Row>();
 if(!row)return null;
 const files=await db.prepare('SELECT form_id,version,kind,name,size,sha256,created_at,created_by FROM scrap_files WHERE form_id=? AND part=0 ORDER BY version').bind(id).all<FileRow>();
 return toForm(row,files.results.map(fileMeta),kind);
}
async function current(db:PortalDatabase,id:unknown,revision:unknown,kind:DocKind){
 if(!validId(id))throw new ScrapError('Formulário inválido.');
 const form=await getScrapForm(db,id,kind);
 if(!form)throw new ScrapError('Formulário não encontrado. Ele pode ter sido apagado; atualize a lista.',404);
 if(revision!==undefined&&form.revision!==revision)throw new ScrapError('Outra pessoa alterou este formulário. Atualize a lista antes de continuar.',409);
 return form;
}
function changed(result:{meta?:{changes?:number}}|undefined){
 if(!result?.meta?.changes)throw new ScrapError('Outra pessoa alterou este formulário. Atualize a lista antes de continuar.',409);
}

/** Ano no horário de Brasília (o formulário de 31/12 à noite ainda é do ano). */
export function brazilYear(now:Date){
 const year=Number(new Intl.DateTimeFormat('en-US',{timeZone:'America/Sao_Paulo',year:'numeric'}).format(now));
 return Number.isInteger(year)?year:now.getUTCFullYear();
}
export async function createScrapForm(db:PortalDatabase,input:unknown,role:PortalRole,now=new Date(),kind:DocKind='scrap'){
 await scrapSchema(db);
 const {forms,counters,prefix,sanitize}=KINDS[kind];
 const data=valid(()=>(sanitize as (input:unknown)=>unknown)(input));
 const year=brazilYear(now),stamp=now.toISOString(),id=crypto.randomUUID();
 // Numeração sequencial por ano numa transação: contador (iniciado pelo maior número já usado) + formulário.
 await db.batch([
  db.prepare(`INSERT INTO ${counters}(year,seq) VALUES(?,(SELECT COALESCE(MAX(seq),0)+1 FROM ${forms} WHERE year=?)) ON CONFLICT(year) DO UPDATE SET seq=${counters}.seq+1`).bind(year,year),
  db.prepare(`INSERT INTO ${forms}(id,number,year,seq,status,data,signatures,file_version,revision,created_by,created_at,updated_at) SELECT ?,'${prefix}-'||?||'-'||CASE WHEN seq<10000 THEN substr('0000'||seq,-4) ELSE seq END,?,seq,'draft',?,'[]',0,1,?,?,? FROM ${counters} WHERE year=?`).bind(id,String(year),year,JSON.stringify(data),role,stamp,stamp,year)
 ]);
 return (await getScrapForm(db,id,kind))!;
}
export async function updateScrapDraft(db:PortalDatabase,id:unknown,revision:unknown,input:unknown,kind:DocKind='scrap'){
 await scrapSchema(db);
 const form=await current(db,id,revision,kind);
 if(form.status!=='draft')throw new ScrapError('Este formulário já foi emitido para assinatura. Use Reabrir para corrigir.',409);
 const data=valid(()=>(KINDS[kind].sanitize as (input:unknown)=>unknown)(input));
 changed(await db.prepare(`UPDATE ${KINDS[kind].forms} SET data=?,revision=revision+1,updated_at=? WHERE id=? AND revision=? AND status='draft'`).bind(JSON.stringify(data),new Date().toISOString(),form.id,form.revision).run());
 return (await getScrapForm(db,form.id,kind))!;
}
/** Volta para rascunho: as assinaturas coletadas deixam de valer; os PDFs antigos ficam no histórico. */
export async function reopenScrapForm(db:PortalDatabase,id:unknown,revision:unknown,role:PortalRole='admin',kind:DocKind='scrap'){
 await scrapSchema(db);
 const form=await current(db,id,revision,kind);
 if(form.status==='draft')return form;
 if(form.status==='signed'&&role!=='admin')throw new ScrapError('Formulário já assinado por todos: somente o administrador pode reabrir.',403);
 changed(await db.prepare(`UPDATE ${KINDS[kind].forms} SET status='draft',signatures='[]',signed_at=NULL,sent_at=NULL,revision=revision+1,updated_at=? WHERE id=? AND revision=?`).bind(new Date().toISOString(),form.id,form.revision).run());
 return (await getScrapForm(db,form.id,kind))!;
}
/** Reposição (PR, data da PR, PO), centro de custo e documento SAP da baixa:
 * não vão no PDF e podem ser anotados depois que o formulário é emitido. */
export async function updateScrapPosting(db:PortalDatabase,id:unknown,revision:unknown,input:{costCenter?:unknown;sapDocument?:unknown;pr?:unknown;prDate?:unknown;po?:unknown},kind:DocKind='scrap'){
 await scrapSchema(db);
 const form=await current(db,id,revision,kind);
 if(form.status==='draft')throw new ScrapError('Gere o PDF do formulário antes de anotar PR, PO e baixa.',409);
 let data:unknown;
 if(kind==='cc'){
  data=valid(()=>sanitizeCcData({...form.data,sapDocument:input.sapDocument??form.data.sapDocument}));
 }else{
  const scrap=form.data as ScrapForm['data'];
  if(input.prDate!==undefined&&input.prDate!==''&&!isIsoDate(input.prDate))throw new ScrapError('Data da PR inválida.');
  const pick=(key:'costCenter'|'sapDocument'|'pr'|'prDate'|'po')=>input[key]??scrap[key];
  data=valid(()=>sanitizeFormData({...scrap,costCenter:pick('costCenter'),sapDocument:pick('sapDocument'),pr:pick('pr'),prDate:pick('prDate'),po:pick('po')}));
 }
 changed(await db.prepare(`UPDATE ${KINDS[kind].forms} SET data=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?`).bind(JSON.stringify(data),new Date().toISOString(),form.id,form.revision).run());
 return (await getScrapForm(db,form.id,kind))!;
}
export async function markScrapSent(db:PortalDatabase,id:unknown,kind:DocKind='scrap'){
 await scrapSchema(db);
 const form=await current(db,id,undefined,kind);
 if(form.status!=='signed')throw new ScrapError('Só o PDF assinado por todos é marcado como enviado.',409);
 const now=new Date().toISOString();
 await db.prepare(`UPDATE ${KINDS[kind].forms} SET sent_at=? WHERE id=?`).bind(now,form.id).run();
 return {...form,sentAt:now};
}
export async function deleteScrapForm(db:PortalDatabase,id:unknown,revision:unknown,role:PortalRole,kind:DocKind='scrap'){
 await scrapSchema(db);
 const form=await current(db,id,revision,kind);
 const table=KINDS[kind].forms;
 if(role!=='admin'&&(form.status!=='draft'||form.files.length))throw new ScrapError('Somente o administrador pode apagar um formulário que já foi emitido.',403);
 const results=await db.batch([
  db.prepare(`DELETE FROM scrap_files WHERE form_id=? AND EXISTS(SELECT 1 FROM ${table} WHERE id=? AND revision=?)`).bind(form.id,form.id,form.revision),
  db.prepare(`DELETE FROM ${table} WHERE id=? AND revision=?`).bind(form.id,form.revision)
 ]);
 changed(results[1]);
 return {deleted:form.id,number:form.number};
}

function decodeBase64(value:string){
 let binary:string;
 // atob recusa qualquer caractere fora do base64.
 try{binary=atob(value);}catch{throw new ScrapError('Arquivo PDF inválido.');}
 if(!binary.length)throw new ScrapError('Arquivo PDF inválido.');
 const bytes=new Uint8Array(binary.length);
 for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);
 return {clean:value,bytes};
}
/** Quantas vezes um trecho de texto aparece nos bytes (sem converter o arquivo inteiro). */
function countBytes(bytes:Uint8Array,text:string){
 const needle=Array.from(text,char=>char.charCodeAt(0));let count=0;
 outer:for(let i=0;i+needle.length<=bytes.length;i++){
  for(let j=0;j<needle.length;j++)if(bytes[i+j]!==needle[j])continue outer;
  count++;i+=needle.length-1;
 }
 return count;
}
async function sha256(bytes:Uint8Array){
 const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',bytes.slice().buffer as ArrayBuffer));
 return Array.from(digest,byte=>byte.toString(16).padStart(2,'0')).join('');
}
const safeName=(value:unknown,fallback:string)=>{const name=String(value??'').replace(/[\u0000-\u001f\u007f\\/:*?"<>|]+/g,'-').replace(/\s+/g,' ').trim().slice(0,160);return /\.pdf$/i.test(name)?name:fallback;};

/** Grava uma nova versão do PDF. "generated": emitido pelo portal (rascunho → assinatura).
 * "signed": devolvido com assinaturas; o status vem da mesma regra usada na tela. */
export async function uploadScrapPdf(db:PortalDatabase,payload:{id?:unknown;revision?:unknown;kind?:unknown;name?:unknown;pdf?:unknown;signatures?:unknown},role:PortalRole,docType:DocKind='scrap'){
 await scrapSchema(db);
 const form=await current(db,payload.id,payload.revision,docType);
 const table=KINDS[docType].forms;
 const kind=payload.kind;
 if(kind!=='generated'&&kind!=='signed')throw new ScrapError('Tipo de arquivo inválido.');
 if(typeof payload.pdf!=='string')throw new ScrapError('Envie o PDF.');
 if(payload.pdf.length>Math.ceil(MAX_PDF_BYTES/3)*4+8)throw new ScrapError('O PDF passa de 1,5 MB. O formulário gerado pelo portal fica bem abaixo disso: confira se é o arquivo certo (não regrave o PDF assinado em outro programa, isso invalida as assinaturas).',413);
 const {clean,bytes}=decodeBase64(payload.pdf);
 if(bytes.length>MAX_PDF_BYTES)throw new ScrapError('O PDF passa de 1,5 MB. O formulário gerado pelo portal fica bem abaixo disso: confira se é o arquivo certo (não regrave o PDF assinado em outro programa, isso invalida as assinaturas).',413);
 if(!countBytes(bytes.subarray(0,1024),'%PDF-'))throw new ScrapError('O arquivo enviado não é um PDF.');
 const hash=await sha256(bytes);
 const latest=form.files.at(-1);
 let status:ScrapStatus,signatures:ScrapSignature[]=[];
 if(kind==='generated'){
  if(form.status!=='draft')throw new ScrapError('Este formulário já foi emitido. Use Reabrir para gerar outro PDF.',409);
  if(bytes.length>300_000)throw new ScrapError('O PDF emitido pelo portal tem poucos KB: este arquivo não é o gerado aqui.');
  // O PDF emitido pelo portal grava o número do formulário em texto simples.
  if(!countBytes(bytes,`(${form.number})`))throw new ScrapError('Este PDF não é do formulário '+form.number+'.');
  status='signing';
 }else{
  if(form.status==='draft')throw new ScrapError('Gere o PDF para assinatura antes de anexar a versão assinada.',409);
  if(latest&&latest.sha256===hash)throw new ScrapError('Este PDF é igual à versão atual. Anexe o arquivo devolvido com a nova assinatura.',409);
  signatures=valid(()=>sanitizeSignatures(payload.signatures));
  if(!signatures.length)throw new ScrapError('Este PDF não tem nenhuma assinatura digital.');
  // Conferência barata: cada assinatura conferida no navegador tem um /ByteRange no arquivo.
  const checked=signatures.filter(signature=>signature.check==='valid').length;
  if(countBytes(bytes,'/ByteRange')<checked)throw new ScrapError('O arquivo não tem as assinaturas informadas. Anexe de novo o PDF assinado.');
  status=statusFromSignatures(form.data,signatures,docType);
 }
 const version=(form.files.reduce((max,file)=>Math.max(max,file.version),0))+1;
 const now=new Date().toISOString();
 const name=safeName(payload.name,`${form.number}-v${version}.pdf`);
 const guard=`EXISTS(SELECT 1 FROM ${table} WHERE id=? AND revision=?)`;
 const statements=[];
 for(let part=0;part*PART<clean.length;part++)
  statements.push(db.prepare(`INSERT INTO scrap_files(form_id,version,part,kind,name,size,sha256,data,created_at,created_by) SELECT ?,?,?,?,?,?,?,?,?,? WHERE ${guard}`).bind(form.id,version,part,kind,name,bytes.length,hash,clean.slice(part*PART,(part+1)*PART),now,role,form.id,form.revision));
 const signedAt=status==='signed'?(form.status==='signed'&&form.signedAt?form.signedAt:now):null;
 statements.push(db.prepare(`UPDATE ${table} SET status=?,signatures=?,file_version=?,signed_at=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?`).bind(status,JSON.stringify(signatures),version,signedAt,now,form.id,form.revision));
 const results=await db.batch(statements);
 changed(results.at(-1));
 return (await getScrapForm(db,form.id,docType))!;
}
export async function readScrapFile(db:PortalDatabase,id:unknown,version:unknown){
 await scrapSchema(db);
 if(!validId(id)||!Number.isSafeInteger(version)||Number(version)<1)throw new ScrapError('Arquivo inválido.');
 const rows=await db.prepare('SELECT part,data,name,size,sha256,kind FROM scrap_files WHERE form_id=? AND version=? ORDER BY part').bind(id,version).all<{part:number;data:string;name:string;size:number;sha256:string;kind:string}>();
 if(!rows.results.length)throw new ScrapError('Arquivo não encontrado.',404);
 const {bytes}=decodeBase64(rows.results.map(row=>row.data).join(''));
 if(bytes.length!==Number(rows.results[0].size))throw new ScrapError('O arquivo guardado está incompleto.',500);
 return {bytes,name:rows.results[0].name,sha256:rows.results[0].sha256,kind:rows.results[0].kind};
}

/** Descrição, classe (A/B/C) e unidade de cada P/N nas BOMs cadastradas. */
export async function lookupMaterials(db:PortalDatabase,raw:string){
 await ensureSchema(db);
 const codes=[...new Set(raw.split(',').map(code=>code.trim().toUpperCase()).filter(code=>/^[A-Z0-9.\-/]{3,40}$/.test(code)))].slice(0,20);
 const found:Record<string,{description:string;unit:string;boms:{bom:string;classification:string;description:string}[]}>={};
 if(!codes.length)return {materials:found};
 const add=(code:string,bom:string,row:any)=>{
  const entry=found[code]||(found[code]={description:'',unit:'',boms:[]});
  const description=String(row.description||'').trim(),classification=String(row.classification||'').trim().toUpperCase();
  if(!entry.description&&description)entry.description=description;
  if(!entry.unit&&row.unit)entry.unit=String(row.unit).trim();
  if(!entry.boms.some(item=>item.bom===bom))entry.boms.push({bom,classification:['A','B','C'].includes(classification)?classification:'',description});
 };
 const result=await db.prepare(`SELECT d.id,d.metadata,e.payload FROM entries e JOIN datasets d ON d.id=e.dataset AND d.generation=e.generation WHERE e.dataset LIKE 'consumo:%' AND (${codes.map(()=>'e.payload LIKE ?').join(' OR ')}) LIMIT 2000`).bind(...codes.map(code=>`%"material":${JSON.stringify(code)}%`)).all<{id:string;metadata:string;payload:string}>();
 for(const row of result.results){
  let meta:any={},payload:any={};try{meta=JSON.parse(row.metadata);payload=JSON.parse(row.payload);}catch{continue;}
  const code=String(payload.material||'').trim().toUpperCase();
  if(codes.includes(code))add(code,[meta.name,meta.revision].filter(Boolean).join(' — ')||row.id,payload);
 }
 const seedId='consumo:bc22x-1268';
 if(!(await db.prepare('SELECT 1 AS present FROM datasets WHERE id=?').bind(seedId).first())){
  const seed=initial(seedId);
  for(const row of seed?.rows||[]){const code=String(row.material||'').trim().toUpperCase();if(codes.includes(code))add(code,`${seed!.name} — ${seed!.revision}`,row);}
 }
 return {materials:found};
}
