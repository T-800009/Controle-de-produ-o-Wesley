export function responseError(response:Response,payload:any,fallback='Não foi possível concluir.'){
 const error=Object.assign(new Error(payload?.error||fallback),{code:String(payload?.code||''),retryAfter:Number(response.headers.get('Retry-After')||payload?.retryAfter)||0});
 return error;
}
export function pollRetryMs(error:unknown,failures:number){
 const seconds=Number((error as {retryAfter?:number})?.retryAfter);
 if(Number.isFinite(seconds)&&seconds>0)return Math.min(86_400_000,Math.max(30_000,seconds*1000));
 return Math.min(300_000,30_000*2**Math.min(4,Math.max(0,failures-1)));
}
/** Bound the entire request, including the response body, so a stalled API
 * produces an actionable message instead of a permanently disabled screen. */
export async function requestJson(url:string,body?:unknown,timeoutMs=30_000,method?:'DELETE'):Promise<any>{
 const controller=new AbortController();
 const timer=setTimeout(()=>controller.abort(),timeoutMs);
 try{
  const response=await fetch(url,{
   signal:controller.signal,
   ...(method?{method}:body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
  });
  if(response.status===401)throw Error('Sessão expirada. Recarregue a página para entrar novamente.');
  if(!response.headers.get('content-type')?.includes('application/json'))throw Error('O servidor retornou uma página em vez dos dados. Publique também worker/index.ts e wrangler.jsonc da mesma versão da interface.');
  const data:any=await response.json();
  if(!response.ok)throw responseError(response,data);
  return data;
 }catch(error){
  if(controller.signal.aborted)throw Error('A consulta demorou mais de 30 segundos. Confira a conexão e clique em Tentar novamente.');
  throw error;
 }finally{
  clearTimeout(timer);
 }
}
