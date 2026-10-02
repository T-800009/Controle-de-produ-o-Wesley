import {createClient,type Client,type InValue,type ResultSet} from '@libsql/client/web';

/** The subset used by this portal, shared by D1 and Turso. */
export interface DatabaseResult<T=unknown>{results:T[];success:boolean;meta:{changes:number};}
export interface DatabaseStatement{
 bind(...values:unknown[]):DatabaseStatement;
 first<T=unknown>():Promise<T|null>;
 all<T=unknown>():Promise<DatabaseResult<T>>;
 run<T=unknown>():Promise<DatabaseResult<T>>;
}
export interface PortalDatabase{
 prepare(sql:string):DatabaseStatement;
 batch<T=unknown>(statements:DatabaseStatement[]):Promise<DatabaseResult<T>[]>;
}
export interface DatabaseEnv{
 DB?:PortalDatabase;
 DATABASE_PROVIDER?:string;
 TURSO_DATABASE_URL?:string;
 TURSO_AUTH_TOKEN?:string;
}
export class DatabaseError extends Error{
 readonly code:string;
 readonly retryAfter:number;
 constructor(code:string,message:string,retryAfter=60){super(message);this.name='DatabaseError';this.code=code;this.retryAfter=retryAfter;}
}
function tursoFailure(error:unknown):DatabaseError{
 if(error instanceof DatabaseError)return error;
 const code=typeof error==='object'&&error!==null&&'code' in error?String(error.code):'';
 if(/AUTH|UNAUTHORIZED|FORBIDDEN|TOKEN_EXPIRED/i.test(code))return new DatabaseError('TURSO_AUTH_FAILED','O acesso ao Turso foi recusado. Confira o token nas configurações do servidor.',300);
 if(/BLOCKED|LIMIT|QUOTA|FULL/i.test(code))return new DatabaseError('TURSO_LIMIT','O Turso recusou a operação por um limite de uso. Confira a franquia no painel do Turso.',300);
 return new DatabaseError('TURSO_QUERY_FAILED','A consulta ao Turso não foi concluída. Confira a conexão e tente novamente.');
}
function result<T>(value:ResultSet):DatabaseResult<T>{
 // libSQL rows have numeric and named keys. Only named columns belong in JSON.
 return {success:true,meta:{changes:value.rowsAffected},results:value.rows.map(row=>Object.fromEntries(value.columns.map((name,index)=>[name,row[index]])) as T)};
}
function argument(value:unknown):InValue{
 if(value===null||typeof value==='string'||typeof value==='bigint'||typeof value==='boolean')return value;
 if(typeof value==='number'&&Number.isFinite(value))return value;
 if(value instanceof ArrayBuffer||value instanceof Uint8Array||value instanceof Date)return value;
 throw new DatabaseError('TURSO_INVALID_VALUE','Um valor enviado ao banco está em formato inválido.',300);
}
class TursoStatement implements DatabaseStatement{
 readonly owner:TursoDatabase;
 readonly sql:string;
 readonly args:InValue[];
 constructor(owner:TursoDatabase,sql:string,args:InValue[]=[]){this.owner=owner;this.sql=sql;this.args=args;}
 bind(...values:unknown[]){return new TursoStatement(this.owner,this.sql,values.map(argument));}
 async first<T=unknown>():Promise<T|null>{return (await this.all<T>()).results[0]??null;}
 async all<T=unknown>():Promise<DatabaseResult<T>>{return this.owner.execute<T>(this);}
 async run<T=unknown>():Promise<DatabaseResult<T>>{return this.owner.execute<T>(this);}
}
export class TursoDatabase implements PortalDatabase{
 private readonly client:Pick<Client,'execute'|'batch'>;
 constructor(client:Pick<Client,'execute'|'batch'>){this.client=client;}
 prepare(sql:string):DatabaseStatement{return new TursoStatement(this,sql);}
 async execute<T>(statement:TursoStatement):Promise<DatabaseResult<T>>{
  try{return result<T>(await this.client.execute({sql:statement.sql,args:statement.args}));}catch(error){throw tursoFailure(error);}
 }
 async batch<T=unknown>(statements:DatabaseStatement[]):Promise<DatabaseResult<T>[]>{
  if(!statements.length)return [];
  const inputs=statements.map(statement=>{
   if(!(statement instanceof TursoStatement)||statement.owner!==this)throw new DatabaseError('TURSO_INVALID_BATCH','Operação de banco incompatível.',300);
   return {sql:statement.sql,args:statement.args};
  });
  // The SDK wraps the batch in one transaction and rolls back on any failure.
  try{return (await this.client.batch(inputs,'write')).map(value=>result<T>(value));}catch(error){throw tursoFailure(error);}
 }
}
/** Only a Turso-hosted HTTPS endpoint may receive the database secret. */
export function tursoUrl(raw:string){
 let url:URL;
 try{url=new URL(raw.trim().replace(/^(?:libsql|turso):\/\//i,'https://'));}catch{throw new DatabaseError('TURSO_CONFIG','Informe a URL do banco Turso nas configurações do servidor.',300);}
 if(url.protocol!=='https:'||!url.hostname.endsWith('.turso.io')||url.username||url.password||url.port||url.search||url.hash||!['','/'].includes(url.pathname))throw new DatabaseError('TURSO_CONFIG','A URL deve ser o endereço oficial do banco, terminado em .turso.io, sem token ou parâmetros.',300);
 return url.origin;
}
export function databaseProvider(env:DatabaseEnv){
 const provider=(env.DATABASE_PROVIDER||'d1').trim().toLowerCase();
 if(provider!=='d1'&&provider!=='turso')throw new DatabaseError('DATABASE_CONFIG','Configure DATABASE_PROVIDER como d1 ou turso.',300);
 return provider;
}
const clients=new WeakMap<object,{url:string;token:string;db:TursoDatabase}>();
const checked=new WeakMap<PortalDatabase,Promise<void>>();
export async function resolveDatabase(env:DatabaseEnv):Promise<PortalDatabase>{
 if(databaseProvider(env)==='d1'){
  if(!env.DB)throw new DatabaseError('DATABASE_CONFIG','Banco de dados não configurado. Confira o vínculo DB no servidor.',300);
  return env.DB;
 }
 const token=env.TURSO_AUTH_TOKEN?.trim(),raw=env.TURSO_DATABASE_URL;
 if(!token||!raw)throw new DatabaseError('TURSO_CONFIG','Configure TURSO_DATABASE_URL e o Secret TURSO_AUTH_TOKEN no servidor.',300);
 const url=tursoUrl(raw);
 let cached=clients.get(env);
 if(!cached||cached.url!==url||cached.token!==token){
  cached={url,token,db:new TursoDatabase(createClient({url,authToken:token,intMode:'number'}))};clients.set(env,cached);
 }
 const db=cached.db;
 let ready=checked.get(db);
 if(!ready){ready=(async()=>{
  // Refuse an empty/wrong database rather than displaying the embedded seed.
  const table=await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='_portal_migration'").first();
  if(!table)throw new DatabaseError('TURSO_NOT_MIGRATED','O banco Turso ainda não recebeu a cópia validada do portal. Conclua a importação antes de ativar a troca.',300);
  const marker=await db.prepare("SELECT version FROM _portal_migration WHERE id='d1-import'").first<{version:number}>();
  if(marker?.version!==1)throw new DatabaseError('TURSO_NOT_MIGRATED','A cópia do banco Turso não foi validada para este portal.',300);
 })().catch(error=>{checked.delete(db);throw error;});checked.set(db,ready);}
 await ready;
 return db;
}
