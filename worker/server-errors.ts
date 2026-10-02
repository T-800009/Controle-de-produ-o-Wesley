import {DatabaseError} from './database.ts';
/** Public errors are classified, not raw SQL/server exceptions. Details stay
 * in the Worker log, correlated by a reference that contains no user data. */
function reason(error:unknown){
 const parts:string[]=[];const seen=new Set<unknown>();let current=error;
 for(let i=0;i<4&&current&&!seen.has(current);i++){
  seen.add(current);parts.push(current instanceof Error?current.message:String(current));
  current=typeof current==='object'&&current!==null&&'cause' in current?current.cause:null;
 }
 return parts.join(' | ');
}
export function classifyFailure(error:unknown,now=Date.now()){
 if(error instanceof DatabaseError)return {code:error.code,message:error.message,retryAfter:error.retryAfter};
 const text=reason(error);
 const reset=new Date(now);reset.setUTCHours(24,0,0,0);
 const tomorrow=Math.max(1,Math.ceil((reset.getTime()-now)/1000));
 if(/daily row read limit|daily.{0,30}read.{0,30}limit/i.test(text))return {code:'D1_DAILY_READ_LIMIT',message:'O banco atingiu a cota diária de leitura do Cloudflare D1. A consulta fica bloqueada até a renovação da cota às 00:00 UTC ou alteração do plano. Os dados continuam armazenados.',retryAfter:tomorrow};
 if(/daily row write limit|daily.{0,30}writ.{0,30}limit/i.test(text))return {code:'D1_DAILY_WRITE_LIMIT',message:'O banco atingiu a cota diária de gravação do Cloudflare D1. Aguarde a renovação da cota às 00:00 UTC ou confira o plano no painel Cloudflare.',retryAfter:tomorrow};
 if(/SQLITE_FULL|database or disk is full|storage.{0,60}limit|database.{0,30}(?:size limit|maximum size)/i.test(text))return {code:'D1_STORAGE_LIMIT',message:'O banco D1 atingiu o limite de armazenamento. Confira o uso do banco no Cloudflare antes de importar outra base.',retryAfter:300};
 if(/no such table|no such column|has no column named|SQLITE_SCHEMA/i.test(text))return {code:'D1_SCHEMA_MISMATCH',message:'A estrutura do banco não corresponde à versão do portal. Confira o banco vinculado como DB; a correção precisa preservar as BOMs e marcações existentes.',retryAfter:300};
 if(/(?:database.{0,50}(?:not found|does not exist)|invalid database id)/i.test(text))return {code:'D1_NOT_FOUND',message:'O banco vinculado ao portal não foi encontrado. Confira o vínculo D1 chamado DB nas configurações do Worker.',retryAfter:300};
 if(/(?:DB|db)\.(?:prepare|batch).{0,30}not a function/i.test(text))return {code:'D1_BINDING_INVALID',message:'O vínculo DB não está configurado como banco D1. Confira Bindings no Worker do Controle de Produção.',retryAfter:300};
 if(/overloaded|too many requests|rate.?limit|too many api requests/i.test(text))return {code:'SERVER_BUSY',message:'O servidor está temporariamente sobrecarregado. As tentativas automáticas foram espaçadas; tente novamente em alguns instantes.',retryAfter:60};
 if(/D1_ERROR|D1_EXEC_ERROR|D1_TYPE_ERROR/i.test(text))return {code:'D1_QUERY_FAILED',message:'A consulta ao banco D1 falhou. O motivo técnico foi registrado no log do Worker com a referência abaixo.',retryAfter:60};
 if(error instanceof SyntaxError)return {code:'INVALID_SAVED_DATA',message:'Um registro salvo não pôde ser interpretado. O motivo foi registrado no log; a base não foi substituída por dados de exemplo.',retryAfter:300};
 return {code:'SERVER_ERROR',message:'O servidor não conseguiu carregar os dados. O motivo foi registrado no log do Worker com a referência abaixo.',retryAfter:30};
}
export function serverFailure(error:unknown,path:string){
 const failure=classifyFailure(error),reference=crypto.randomUUID();
 console.error('portal_request_failed',JSON.stringify({reference,path,code:failure.code,reason:reason(error).slice(0,1600)}));
 return Response.json({error:`${failure.message} Código: ${failure.code} · referência ${reference}.`,code:failure.code,reference,retryAfter:failure.retryAfter},{status:503,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Retry-After':String(failure.retryAfter)}});
}
