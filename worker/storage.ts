import type {PortalDatabase} from './database';
import seed from '../data/seed.json';
import {type Dataset,validateRows} from '../lib/materials';
import {stockModule} from '../lib/stock-modules';
import {isOpStatus,type OpStatus,type OpStatuses} from '../lib/op-status';
import {validatePlanRows,validPlanUnits} from '../lib/oebom';
const ready=new WeakMap<PortalDatabase,Promise<void>>();
export async function ensureSchema(db:PortalDatabase){
 let promise=ready.get(db);
 if(!promise){promise=db.batch([
  db.prepare('CREATE TABLE IF NOT EXISTS datasets (id TEXT PRIMARY KEY NOT NULL,generation TEXT NOT NULL,metadata TEXT NOT NULL,updated_at TEXT NOT NULL)'),
  db.prepare('CREATE TABLE IF NOT EXISTS entries (dataset TEXT NOT NULL,generation TEXT NOT NULL,id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(dataset,generation,id))'),
  db.prepare('CREATE INDEX IF NOT EXISTS entries_generation ON entries(dataset,generation)'),
  db.prepare('CREATE TABLE IF NOT EXISTS manual_checks (dataset TEXT NOT NULL,row_key TEXT NOT NULL,marked_by TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(dataset,row_key))'),
  db.prepare('CREATE INDEX IF NOT EXISTS manual_checks_dataset ON manual_checks(dataset)'),
  // Keep a tiny revision for each dataset so viewers can poll for a change
  // without downloading every marked row repeatedly.
  db.prepare('CREATE TABLE IF NOT EXISTS manual_check_state (dataset TEXT PRIMARY KEY NOT NULL,revision INTEGER NOT NULL,updated_at TEXT NOT NULL)'),
  db.prepare("CREATE TABLE IF NOT EXISTS op_statuses (dataset TEXT NOT NULL,op TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('not_started','waiting','complete')),updated_at TEXT NOT NULL,PRIMARY KEY(dataset,op))"),
  db.prepare('CREATE TABLE IF NOT EXISTS op_status_state (dataset TEXT PRIMARY KEY NOT NULL,revision INTEGER NOT NULL,updated_at TEXT NOT NULL)')
 ]).then(()=>{}).catch(e=>{ready.delete(db);throw e;});ready.set(db,promise);}
 await promise;
}

async function manualCheckState(db:PortalDatabase,dataset:string){
 const state=await db.prepare('SELECT revision,updated_at FROM manual_check_state WHERE dataset=?').bind(dataset).first<{revision:number;updated_at:string}>();
 if(state)return {revision:Number(state.revision)||0,updatedAt:state.updated_at||''};
 // Preserve marks made by a previous version that did not have the revision
 // table. They are visible on the first read and migrated on the next write.
 const legacy=await db.prepare('SELECT COUNT(*) AS count,MAX(updated_at) AS updatedAt FROM manual_checks WHERE dataset=?').bind(dataset).first<{count:number;updatedAt:string|null}>();
 return {revision:Number(legacy?.count||0)>0?1:0,updatedAt:legacy?.updatedAt||''};
}

export async function listManualChecks(db:PortalDatabase,dataset:string){
 const result=await db.prepare('SELECT row_key,marked_by,updated_at FROM manual_checks WHERE dataset=? ORDER BY row_key').bind(dataset).all<{row_key:string;marked_by:string;updated_at:string}>();
 const checks:Record<string,true>={};
 const metadata:Record<string,{markedBy:string;updatedAt:string}>={};
 for(const row of result.results){checks[row.row_key]=true;metadata[row.row_key]={markedBy:row.marked_by,updatedAt:row.updated_at};}
 const state=await manualCheckState(db,dataset);
 return {checks,metadata,count:result.results.length,revision:state.revision,updatedAt:state.updatedAt};
}

export async function manualChecksStatus(db:PortalDatabase,dataset:string){
 const current=await db.prepare('SELECT s.revision,s.updated_at,(SELECT COUNT(*) FROM manual_checks m WHERE m.dataset=s.dataset) AS count FROM manual_check_state s WHERE s.dataset=?').bind(dataset).first<{revision:number;updated_at:string;count:number}>();
 if(current)return {revision:Number(current.revision)||0,updatedAt:current.updated_at||'',count:Number(current.count||0)};
 const state=await manualCheckState(db,dataset);
 const legacyCount=await db.prepare('SELECT COUNT(*) AS count FROM manual_checks WHERE dataset=?').bind(dataset).first<{count:number}>();
 return {revision:state.revision,updatedAt:state.updatedAt,count:Number(legacyCount?.count||0)};
}

/** Polling only needs the revision. Never count all marked rows on each tick. */
export async function manualChecksRevision(db:PortalDatabase,dataset:string){
 const state=await db.prepare('SELECT revision FROM manual_check_state WHERE dataset=?').bind(dataset).first<{revision:number}>();
 if(state)return Number(state.revision)||0;
 // Older datasets may have marks but no revision row. An indexed existence
 // lookup preserves that initial snapshot without scanning/counting it.
 const legacy=await db.prepare('SELECT 1 AS present FROM manual_checks WHERE dataset=? LIMIT 1').bind(dataset).first();
 return legacy?1:0;
}

async function bumpManualChecks(db:PortalDatabase,dataset:string,now:string,legacyRowsBeforeChange=false){
 const state=await db.prepare('SELECT revision FROM manual_check_state WHERE dataset=?').bind(dataset).first<{revision:number}>();
 if(state){
  await db.prepare('UPDATE manual_check_state SET revision=?,updated_at=? WHERE dataset=?').bind(Number(state.revision||0)+1,now,dataset).run();
 }else{
  await db.prepare('INSERT INTO manual_check_state(dataset,revision,updated_at) VALUES(?,?,?)').bind(dataset,legacyRowsBeforeChange?2:1,now).run();
 }
}

export async function updateManualChecks(db:PortalDatabase,dataset:string,keys:string[],checked:boolean,markedBy:'admin'|'viewer'='admin'){
 const unique=[...new Set(keys.map(key=>String(key).trim()).filter(key=>key.length>0&&key.length<=500))];
 if(unique.length>5000)throw Error('Marque no máximo 5.000 itens por vez.');
 const now=new Date().toISOString();
 const hasState=await db.prepare('SELECT 1 AS present FROM manual_check_state WHERE dataset=?').bind(dataset).first();
 const legacyRows=hasState?false:Boolean((await db.prepare('SELECT 1 AS present FROM manual_checks WHERE dataset=? LIMIT 1').bind(dataset).first()));
 for(let i=0;i<unique.length;i+=100){
  const batch=unique.slice(i,i+100).map(key=>checked
   ?db.prepare('INSERT INTO manual_checks(dataset,row_key,marked_by,updated_at) VALUES(?,?,?,?) ON CONFLICT(dataset,row_key) DO UPDATE SET marked_by=excluded.marked_by,updated_at=excluded.updated_at').bind(dataset,key,markedBy,now)
   :db.prepare('DELETE FROM manual_checks WHERE dataset=? AND row_key=?').bind(dataset,key));
  if(batch.length)await db.batch(batch);
 }
 await bumpManualChecks(db,dataset,now,legacyRows);
 // A write response only needs the new revision. Returning every marked row
 // here made one checkbox click grow with the whole history of the dataset.
 return {...await manualChecksStatus(db,dataset),changed:unique.length,checked};
}
export async function clearManualChecks(db:PortalDatabase,dataset:string){
 const now=new Date().toISOString();
 const hasState=await db.prepare('SELECT 1 AS present FROM manual_check_state WHERE dataset=?').bind(dataset).first();
 const legacyRows=hasState?false:Boolean((await db.prepare('SELECT 1 AS present FROM manual_checks WHERE dataset=? LIMIT 1').bind(dataset).first()));
 await db.prepare('DELETE FROM manual_checks WHERE dataset=?').bind(dataset).run();
 await bumpManualChecks(db,dataset,now,legacyRows);
}
export async function opStatusRevision(db:PortalDatabase,dataset:string){
 const row=await db.prepare('SELECT revision FROM op_status_state WHERE dataset=?').bind(dataset).first<{revision:number}>();
 return Number(row?.revision||0);
}
export async function listOpStatuses(db:PortalDatabase,dataset:string){
 const [rows,state]=await db.batch([
  db.prepare('SELECT op,status,updated_at FROM op_statuses WHERE dataset=? ORDER BY op').bind(dataset),
  db.prepare('SELECT revision FROM op_status_state WHERE dataset=?').bind(dataset)
 ]);
 const statuses:OpStatuses={};
 for(const row of rows.results as {op:string;status:OpStatus;updated_at:string}[])statuses[row.op]={status:row.status,updatedAt:row.updated_at};
 return {statuses,revision:Number((state.results[0] as any)?.revision||0)};
}
/** "Tudo OK": muda o status de várias OPs da mesma BOM numa única transação
 * (uma revisão só), sem gravar uma marcação por material. */
export async function updateOpStatuses(db:PortalDatabase,dataset:string,ops:unknown,status:OpStatus){
 if(!isOpStatus(status)||!Array.isArray(ops)||!ops.length||ops.length>1000||ops.some(op=>typeof op!=='string'||!/^\d{8,18}$/.test(op)))throw Error('Status ou OPs inválidos.');
 const source=await read(db,dataset);
 const unique=[...new Set(ops as string[])];
 const foreign=unique.filter(op=>!source?.ops?.includes(op));
 if(foreign.length)throw Error(`${foreign.length} OP(s) não pertencem à BOM selecionada.`);
 const now=new Date().toISOString();
 // Multi-row statements (25 OPs = 100 parameters, the D1 per-query limit) keep
 // the whole change in a handful of statements and one transaction.
 const statements=[];
 for(let i=0;i<unique.length;i+=25){
  const chunk=unique.slice(i,i+25);
  statements.push(db.prepare(`INSERT INTO op_statuses(dataset,op,status,updated_at) VALUES ${chunk.map(()=>'(?,?,?,?)').join(',')} ON CONFLICT(dataset,op) DO UPDATE SET status=excluded.status,updated_at=excluded.updated_at`).bind(...chunk.flatMap(op=>[dataset,op,status,now])));
 }
 statements.push(db.prepare('INSERT INTO op_status_state(dataset,revision,updated_at) VALUES(?,1,?) ON CONFLICT(dataset) DO UPDATE SET revision=op_status_state.revision+1,updated_at=excluded.updated_at').bind(dataset,now));
 await db.batch(statements);
 return listOpStatuses(db,dataset);
}
export async function updateOpStatus(db:PortalDatabase,dataset:string,op:string,status:OpStatus){
 if(!isOpStatus(status)||!/^\d{8,18}$/.test(op))throw Error('Status ou OP inválidos.');
 const source=await read(db,dataset);
 if(!source?.ops?.includes(op))throw Error('Esta OP não pertence à BOM selecionada.');
 const now=new Date().toISOString();
 await db.batch([
  db.prepare('INSERT INTO op_statuses(dataset,op,status,updated_at) VALUES(?,?,?,?) ON CONFLICT(dataset,op) DO UPDATE SET status=excluded.status,updated_at=excluded.updated_at').bind(dataset,op,status,now),
  db.prepare('INSERT INTO op_status_state(dataset,revision,updated_at) VALUES(?,1,?) ON CONFLICT(dataset) DO UPDATE SET revision=op_status_state.revision+1,updated_at=excluded.updated_at').bind(dataset,now)
 ]);
 return listOpStatuses(db,dataset);
}
export function initial(id:string):Dataset|null{
 if(id==='consumo:bc22x-1268')return {...seed.models[0],id,version:'seed',updatedAt:'2026-09-02'};
 if(id==='7000')return {id,name:'Depósito 7000',revision:'',source:'BOM BC22X · aba 7000',updatedAt:'2026-09-02',version:'seed',rows:seed.stock};
 const stock=stockModule(id);
 if(stock)return {id,name:stock.name,revision:'',source:'Aguardando primeira leitura',rows:[],version:'seed'};
 return null;
}
export async function list(db:PortalDatabase){
 const result=await db.prepare('SELECT id,metadata,updated_at,generation FROM datasets WHERE id LIKE ?').bind('consumo:%').all<any>();
 const {rows,...base}=seed.models[0];const map=new Map<string,any>([['consumo:bc22x-1268',{...base,id:'consumo:bc22x-1268',version:'seed'}]]);
 for(const r of result.results)map.set(r.id,{...JSON.parse(r.metadata),id:r.id,version:r.generation,updatedAt:r.updated_at});return [...map.values()];
}
/** BOMs do plano (OEBOM): só os metadados, sem as linhas. */
export async function listPlans(db:PortalDatabase){
 const result=await db.prepare('SELECT id,metadata,updated_at,generation FROM datasets WHERE id LIKE ?').bind('plano:%').all<any>();
 return result.results.map(r=>({...JSON.parse(r.metadata),id:r.id,version:r.generation,updatedAt:r.updated_at})).sort((a,b)=>String(a.name).localeCompare(String(b.name)));
}
/** Muda só os ônibus restantes de uma BOM do plano, sem reenviar as linhas. */
export async function updatePlanUnits(db:PortalDatabase,id:string,units:unknown){
 if(!/^plano:[a-z0-9-]{1,120}$/.test(id))throw new DatasetRemovalError('BOM do plano inválida.',400);
 if(!validPlanUnits(units))throw new DatasetRemovalError('Informe os ônibus restantes (número inteiro, 0 ou mais).',400);
 const old=await db.prepare('SELECT generation,metadata FROM datasets WHERE id=?').bind(id).first<{generation:string;metadata:string}>();
 if(!old)throw new DatasetRemovalError('BOM do plano não encontrada. Atualize a lista.',404);
 let meta:Record<string,unknown>={};try{meta=JSON.parse(old.metadata);}catch{}
 const now=new Date().toISOString();
 const result=await db.prepare('UPDATE datasets SET metadata=?,updated_at=? WHERE id=? AND generation=?').bind(JSON.stringify({...meta,units}),now,id,old.generation).run();
 if(!result.meta?.changes)throw new DatasetRemovalError('Esta BOM foi alterada durante a gravação. Recarregue a página.',409);
 return {...meta,id,units,version:old.generation,updatedAt:now};
}
export async function read(db:PortalDatabase,id:string):Promise<Dataset|null>{
 // One SQL statement reads metadata and rows from the same committed generation.
 const result=await db.prepare('SELECT d.metadata,d.generation,d.updated_at,e.payload FROM datasets d LEFT JOIN entries e ON e.dataset=d.id AND e.generation=d.generation WHERE d.id=? ORDER BY CAST(e.id AS INTEGER)').bind(id).all<any>();
 if(!result.results.length)return initial(id);const d=result.results[0];
 const saved={...JSON.parse(d.metadata),id,version:d.generation,updatedAt:d.updated_at,rows:result.results.filter(r=>r.payload!==null).map(r=>JSON.parse(r.payload))};
 if(id==='consumo:bc22x-1268'){try{validateRows(saved.rows,'consumo');}catch{const fallback=initial(id)!;return {...fallback,version:d.generation,source:fallback.source+' · estrutura recuperada do Excel enviado'};}}
 return saved;
}
export async function save(db:PortalDatabase,d:Dataset){
 const kind=d.id?.startsWith('consumo:')?'consumo':d.id?.startsWith('plano:')?'plano':d.id;
 if((kind!=='consumo'&&kind!=='plano'&&!stockModule(kind))||d.id.length>200||typeof d.name!=='string'||!d.name.trim()||d.name.length>200||!Array.isArray(d.rows))throw Error('Dados incompletos ou módulo inválido.');
 if(kind==='plano'){
  // BOM do plano (OEBOM): quantidade por ônibus × ônibus restantes, sem OPs.
  if(!/^plano:[a-z0-9-]{1,120}$/.test(d.id))throw Error('Identificador da BOM do plano inválido.');
  if(!validPlanUnits(d.units))throw Error('Informe os ônibus restantes (número inteiro, 0 ou mais).');
  validatePlanRows(d.rows);
 }else validateRows(d.rows,kind);
 const rows=d.rows,meta={id:d.id,name:d.name,revision:d.revision||'',ops:kind==='plano'?[]:d.ops||[],source:d.source||'',reviewRequired:!!d.reviewRequired,sheetId:d.sheetId,sheetName:d.sheetName,...(kind==='plano'?{units:d.units,model:String(d.model||''),dwb:String(d.dwb||'')}:{})};
 const old=await db.prepare('SELECT generation FROM datasets WHERE id=?').bind(d.id).first<{generation:string}>();
 if((old?.generation??(initial(d.id)?'seed':'new'))!==(d.version??'new'))throw Error('Outra atualização foi salva. Atualize a página antes de importar novamente.');
 const generation=crypto.randomUUID(),now=new Date().toISOString();
 try {
  for(let i=0;i<rows.length;i+=100)await db.batch(rows.slice(i,i+100).map((r,j)=>db.prepare('INSERT INTO entries(dataset,generation,id,payload) VALUES(?,?,?,?)').bind(d.id,generation,String(i+j),JSON.stringify(r))));
  const result=old?await db.prepare('UPDATE datasets SET generation=?,metadata=?,updated_at=? WHERE id=? AND generation=?').bind(generation,JSON.stringify(meta),now,d.id,old.generation).run():await db.prepare('INSERT OR IGNORE INTO datasets(id,generation,metadata,updated_at) VALUES(?,?,?,?)').bind(d.id,generation,JSON.stringify(meta),now).run();
  if(!result.meta.changes)throw Error('Outra atualização foi salva. Recarregue antes de continuar.');
 }catch(e){
  // Never delete a generation that may already have been committed.
  await db.prepare('DELETE FROM entries WHERE dataset=? AND generation=? AND NOT EXISTS(SELECT 1 FROM datasets WHERE id=? AND generation=?)').bind(d.id,generation,d.id,generation).run().catch(()=>{});throw e;
 }
 // Remove only the exact previous snapshot; concurrent writers stay intact.
 if(old)await db.prepare('DELETE FROM entries WHERE dataset=? AND generation=?').bind(d.id,old.generation).run().catch(()=>{});
 return {...meta,rows,version:generation,updatedAt:now};
}
/** BOM embutida no pacote: sempre volta pelo seed, então não é apagada. */
export const PROTECTED_BOMS=new Set(['consumo:bc22x-1268']);
export class DatasetRemovalError extends Error{constructor(message:string,readonly status:number){super(message);}}
/** Apaga uma BOM cadastrada e tudo o que pertence somente a ela (linhas, status
 * das OPs e marcações OK), numa única transação. Depósitos, outras BOMs, notas
 * da Ana e o SAP não são alterados. A versão impede apagar uma BOM que outra
 * pessoa acabou de substituir. */
export async function removeDataset(db:PortalDatabase,id:string,version:string){
 if(!/^consumo:.{1,190}$/.test(id)&&!/^plano:[a-z0-9-]{1,120}$/.test(id))throw new DatasetRemovalError('Somente BOMs cadastradas podem ser apagadas.',400);
 if(PROTECTED_BOMS.has(id))throw new DatasetRemovalError('A BOM de referência do pacote (BC22X OP1268) não pode ser apagada. Cadastre a revisão correta e use o seletor.',400);
 const old=await db.prepare('SELECT generation,metadata FROM datasets WHERE id=?').bind(id).first<{generation:string;metadata:string}>();
 if(!old)throw new DatasetRemovalError('BOM não encontrada. Ela pode ter sido apagada por outra pessoa; atualize a lista.',404);
 if(!version||old.generation!==version)throw new DatasetRemovalError('Esta BOM foi alterada depois que você a abriu. Recarregue a página antes de apagar.',409);
 // Dependent rows are removed only if the dataset row itself was removed in this
 // same transaction (NOT EXISTS), so a version conflict deletes nothing.
 const gone='NOT EXISTS(SELECT 1 FROM datasets WHERE id=?)';
 const results=await db.batch([
  db.prepare('DELETE FROM datasets WHERE id=? AND generation=?').bind(id,old.generation),
  db.prepare(`DELETE FROM entries WHERE dataset=? AND ${gone}`).bind(id,id),
  db.prepare(`DELETE FROM manual_checks WHERE dataset=? AND ${gone}`).bind(id,id),
  db.prepare(`DELETE FROM manual_check_state WHERE dataset=? AND ${gone}`).bind(id,id),
  db.prepare(`DELETE FROM op_statuses WHERE dataset=? AND ${gone}`).bind(id,id),
  db.prepare(`DELETE FROM op_status_state WHERE dataset=? AND ${gone}`).bind(id,id),
 ]);
 if(!results[0]?.meta?.changes)throw new DatasetRemovalError('Esta BOM foi alterada durante a exclusão. Recarregue a página.',409);
 let meta:{name?:string;revision?:string}={};try{meta=JSON.parse(old.metadata);}catch{}
 return {deleted:id,name:meta.name||'',revision:meta.revision||'',rows:Number(results[1]?.meta?.changes||0),checks:Number(results[2]?.meta?.changes||0),statuses:Number(results[4]?.meta?.changes||0)};
}
/** Corrige nome/revisão de uma BOM cadastrada sem reenviar as linhas. */
export async function updateDatasetMeta(db:PortalDatabase,id:string,version:string,changes:{name?:unknown;revision?:unknown;ops?:unknown}){
 if(!/^consumo:.{1,190}$/.test(id))throw new DatasetRemovalError('Somente BOMs cadastradas podem ser renomeadas.',400);
 if(PROTECTED_BOMS.has(id))throw new DatasetRemovalError('A BOM de referência do pacote não pode ser renomeada.',400);
 const name=String(changes.name??'').trim(),revision=String(changes.revision??'').trim();
 if(!name||name.length>120||revision.length>120)throw new DatasetRemovalError('Informe o modelo (até 120 caracteres) e a revisão (até 120 caracteres).',400);
 let ops:string[]|undefined;
 if(changes.ops!==undefined){
  if(!Array.isArray(changes.ops)||changes.ops.some(op=>typeof op!=='string'||!/^\d{8,18}$/.test(op.trim())))throw new DatasetRemovalError('Informe as OPs com 8 a 18 dígitos.',400);
  ops=[...new Set((changes.ops as string[]).map(op=>op.trim()))];
  if(!ops.length||ops.length>1000)throw new DatasetRemovalError('A BOM precisa ter entre 1 e 1.000 OPs.',400);
 }
 const old=await db.prepare('SELECT generation,metadata FROM datasets WHERE id=?').bind(id).first<{generation:string;metadata:string}>();
 if(!old)throw new DatasetRemovalError('BOM não encontrada. Ela pode ter sido apagada; atualize a lista.',404);
 if(!version||old.generation!==version)throw new DatasetRemovalError('Esta BOM foi alterada depois que você a abriu. Recarregue a página.',409);
 let meta:Record<string,unknown>={};try{meta=JSON.parse(old.metadata);}catch{}
 const next={...meta,name,revision,...(ops?{ops}:{})},now=new Date().toISOString();
 const result=await db.prepare('UPDATE datasets SET metadata=?,updated_at=? WHERE id=? AND generation=?').bind(JSON.stringify(next),now,id,old.generation).run();
 if(!result.meta?.changes)throw new DatasetRemovalError('Esta BOM foi alterada durante a gravação. Recarregue a página.',409);
 return {id,name,revision,ops:(next as {ops?:string[]}).ops||[],version:old.generation,updatedAt:now};
}
