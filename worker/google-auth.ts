export interface GoogleEnv {GOOGLE_SERVICE_ACCOUNT_JSON?:string;}
const encoder=new TextEncoder();
const b64=(bytes:Uint8Array)=>btoa(String.fromCharCode(...bytes)).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
let cached:{config:string;token:string;until:number}|undefined;
let pending:{config:string;promise:Promise<string>}|undefined;
export async function googleToken(env:GoogleEnv){
 const config=env.GOOGLE_SERVICE_ACCOUNT_JSON;if(!config)return null;
 if(cached?.config===config&&cached.until>Date.now()+60000)return cached.token;
 if(pending?.config===config)return pending.promise;
 const promise=issueToken(config);
 pending={config,promise};
 try{return await promise;}finally{if(pending?.promise===promise)pending=undefined;}
}

async function issueToken(config:string){
 let account:any;try{account=JSON.parse(config);if(typeof account.client_email!=='string'||typeof account.private_key!=='string')throw Error();}catch{throw Error('Configure GOOGLE_SERVICE_ACCOUNT_JSON com a chave JSON da conta de serviço Google.');}
 const now=Math.floor(Date.now()/1000),payload=b64(encoder.encode(JSON.stringify({alg:'RS256',typ:'JWT'})))+'.'+b64(encoder.encode(JSON.stringify({iss:account.client_email,scope:'https://www.googleapis.com/auth/spreadsheets.readonly',aud:'https://oauth2.googleapis.com/token',iat:now,exp:now+3600})));
 let signature:ArrayBuffer;try{const pem=account.private_key.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g,'');const key=await crypto.subtle.importKey('pkcs8',Uint8Array.from(atob(pem),c=>c.charCodeAt(0)),{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['sign']);signature=await crypto.subtle.sign('RSASSA-PKCS1-v1_5',key,encoder.encode(payload));}catch{throw Error('A chave privada da conexão Google é inválida.');}
 const r=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion:payload+'.'+b64(new Uint8Array(signature))}),signal:AbortSignal.timeout(15000)});
 if(!r.ok)throw Error('O Google recusou a credencial da conta de serviço. Confira a chave configurada no servidor.');const d:any=await r.json();if(typeof d.access_token!=='string'||!Number.isFinite(d.expires_in))throw Error('Resposta de autenticação Google inválida.');cached={config,token:d.access_token,until:Date.now()+d.expires_in*1000};return d.access_token;
}
