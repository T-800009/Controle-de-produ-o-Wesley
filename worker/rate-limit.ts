/**
 * Freio contra robôs na consulta sem senha: limite por endereço IP, guardado na
 * memória do Worker. Cada instância do Cloudflare conta separado, então é um
 * freio (não uma contagem exata) e não gasta leitura nem gravação do D1.
 */
const buckets=new Map<string,{count:number;reset:number}>();
export function allowRequest(key:string,limit:number,windowMs=60_000,now=Date.now()){
 if(buckets.size>5000){for(const [entry,bucket] of buckets)if(bucket.reset<=now)buckets.delete(entry);if(buckets.size>5000)buckets.clear();}
 const bucket=buckets.get(key);
 if(!bucket||bucket.reset<=now){buckets.set(key,{count:1,reset:now+windowMs});return true;}
 bucket.count++;
 return bucket.count<=limit;
}
/** Pedidos por minuto: consulta aberta (sem sessão) e consulta por link/senha. ADM e Analista não têm freio. */
export const VIEW_LIMITS={open:600,session:1200};
