import type {PortalDatabase} from './database';
import type {PortalRole} from './auth';
const ready=new WeakMap<PortalDatabase,Promise<void>>();
async function schema(db:PortalDatabase){
 let promise=ready.get(db);
 if(!promise){promise=db.batch([
  db.prepare("CREATE TABLE IF NOT EXISTS ana_notes(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,op TEXT NOT NULL,material TEXT NOT NULL DEFAULT '',text TEXT NOT NULL,author_role TEXT NOT NULL,created_at TEXT NOT NULL)"),
  db.prepare('CREATE INDEX IF NOT EXISTS ana_notes_op_seq ON ana_notes(op,seq)')
 ]).then(()=>{}).catch(error=>{ready.delete(db);throw error;});ready.set(db,promise);}
 await promise;
}
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
const validOp=(value:unknown):value is string=>typeof value==='string'&&/^[A-Z0-9][A-Z0-9._-]{0,39}$/.test(value);
const validMaterial=(value:unknown):value is string=>typeof value==='string'&&/^[A-Z0-9._/-]{0,80}$/.test(value);
type Note={seq:number;id:string;op:string;material:string;text:string;author_role:string;created_at:string};
/** Append-only, idempotent notes. No last-writer overwrite of another analyst. */
export async function anaNotesRoute(req:Request,db:PortalDatabase,role:PortalRole){
 if(!db)return json({error:'Banco de dados não configurado.'},503);
 const url=new URL(req.url),canWrite=role==='admin'||role==='analyst';
 if(req.method!=='GET'&&req.method!=='POST')return json({error:'Método não permitido.'},405);
 if(req.method==='POST'&&!canWrite)return json({error:'O perfil Consulta pode ler observações. Use o acesso de Analista ou Administrador para escrever.'},403);
 if(req.method==='POST'&&(req.headers.get('origin')!==url.origin||req.headers.get('sec-fetch-site')==='cross-site'))return json({error:'Origem inválida.'},403);
 await schema(db);
 if(req.method==='GET'){
  const op=url.searchParams.get('op')||'',material=url.searchParams.get('material')||'';
  if(!validOp(op)||!validMaterial(material))return json({error:'Informe uma OP e material válidos.'},400);
  const before=Number(url.searchParams.get('before')||0);
  if(!Number.isSafeInteger(before)||before<0)return json({error:'Página inválida.'},400);
  const scope="op=? AND (?='' OR material=?)";
  const current=await db.prepare('SELECT COALESCE(MAX(seq),0) AS revision FROM ana_notes WHERE '+scope).bind(op,material,material).first<{revision:number}>();
  const revision=current?.revision||0;
  if(!before&&url.searchParams.has('revision')&&Number(url.searchParams.get('revision'))===revision)return json({unchanged:true,revision,canWrite});
  const result=await db.prepare('SELECT * FROM ana_notes WHERE '+scope+' AND (?=0 OR seq<?) ORDER BY seq DESC LIMIT 51').bind(op,material,material,before,before).all<Note>();
  const notes=result.results.slice(0,50);
  return json({notes,revision,canWrite,nextBefore:result.results.length>50?notes.at(-1)!.seq:null});
 }
 if(!req.headers.get('content-type')?.startsWith('application/json'))return json({error:'Formato inválido.'},415);
 if(Number(req.headers.get('content-length')||0)>24000)return json({error:'Observação muito grande.'},413);
 const reader=req.body?.getReader();if(!reader)return json({error:'Envio vazio.'},400);
 const chunks:string[]=[],decoder=new TextDecoder();let size=0;
 while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>24000){await reader.cancel();return json({error:'Observação muito grande.'},413);}chunks.push(decoder.decode(value,{stream:true}));}
 chunks.push(decoder.decode());
 let data:Record<string,unknown>;try{data=JSON.parse(chunks.join(''));}catch{return json({error:'Formato inválido.'},400);}
 if(!data||!validOp(data.op)||!validMaterial(data.material)||typeof data.text!=='string'||!data.text.trim()||data.text.length>4000||typeof data.id!=='string'||!/^[a-f0-9-]{36}$/i.test(data.id))return json({error:'Informe a OP e uma observação de até 4.000 caracteres.'},400);
 await db.prepare('INSERT INTO ana_notes(id,op,material,text,author_role,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING').bind(data.id,data.op,data.material,data.text.trim(),role,new Date().toISOString()).run();
 const note=await db.prepare('SELECT * FROM ana_notes WHERE id=?').bind(data.id).first<Note>();
 if(!note||note.op!==data.op||note.material!==data.material||note.text!==data.text.trim())return json({error:'Este envio já foi usado para outra observação. Reabra o formulário.'},409);
 return json({note,canWrite},200);
}
