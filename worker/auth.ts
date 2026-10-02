import type {PortalDatabase} from './database';
export type PortalRole='admin'|'analyst'|'viewer';
export interface PasswordEnv {PORTAL_PASSWORD?:string;PORTAL_ADMIN_PASSWORD?:string;PORTAL_ANALYST_PASSWORD?:string;PORTAL_VIEWER_PASSWORD?:string;DB:PortalDatabase;}
const COOKIE='__Host-portal_session';
const ready=new WeakMap<PortalDatabase,Promise<void>>();
function adminPassword(env:PasswordEnv){return env.PORTAL_ADMIN_PASSWORD||env.PORTAL_PASSWORD;}
function validPassword(value:unknown){return typeof value==='string'&&value.length>=12&&value.length<=256;}
export function configured(env:PasswordEnv){return validPassword(adminPassword(env));}
async function schema(db:PortalDatabase){let p=ready.get(db);if(!p){p=db.batch([
 db.prepare('CREATE TABLE IF NOT EXISTS portal_sessions(token_hash TEXT PRIMARY KEY, password_tag TEXT NOT NULL, expires INTEGER NOT NULL)'),
 db.prepare('CREATE TABLE IF NOT EXISTS portal_attempts(ip_hash TEXT PRIMARY KEY, attempts INTEGER NOT NULL, expires INTEGER NOT NULL)')
]).then(()=>{}).catch(e=>{ready.delete(db);throw e});ready.set(db,p);}await p;}
const hex=(b:ArrayBuffer)=>Array.from(new Uint8Array(b),x=>x.toString(16).padStart(2,'0')).join('');
async function hash(s:string){return hex(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)));}
async function tag(password:string,token:string){const k=await crypto.subtle.importKey('raw',new TextEncoder().encode(password),{name:'HMAC',hash:'SHA-256'},false,['sign']);return hex(await crypto.subtle.sign('HMAC',k,new TextEncoder().encode(token)));}
function equal(a:string,b:string){if(a.length!==b.length)return false;let n=0;for(let i=0;i<a.length;i++)n|=a.charCodeAt(i)^b.charCodeAt(i);return n===0;}
function sessionToken(req:Request){const values=(req.headers.get('cookie')||'').split(';').map(s=>s.trim()).filter(s=>s.startsWith(COOKIE+'='));if(values.length!==1)return null;const t=values[0].slice(COOKIE.length+1);return /^[a-f0-9]{64}$/.test(t)?t:null;}
const cookie=(value:string,age:number)=>`${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${age}`;
function redirect(value?:string){const headers=new Headers({'Location':'/','Cache-Control':'no-store'});if(value)headers.set('Set-Cookie',value);return new Response(null,{status:303,headers});}
export function loginPage(message='',status=200,setup=false){return new Response(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Entrar · Controle de Produção</title><style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:radial-gradient(ellipse at top,rgba(255,255,255,.10),#09090b 60%);color:#fff;font:16px system-ui}main{width:min(440px,calc(100% - 32px));padding:36px;background:#151518bb;border:1px solid #ffffff18;border-top:3px solid #f5f7fa;border-radius:12px}small{color:#f5f7fa;letter-spacing:2px}h1{font-size:32px;margin:18px 0 10px}p{color:#b7b7bf;line-height:1.6}label{display:block;margin:24px 0 8px}input,button{width:100%;padding:14px;border-radius:6px;font:inherit}input{background:#08080b;border:1px solid #555;color:white}input:focus{outline:2px solid #f5f7fa}button{margin-top:16px;border:0;background:#f5f7fa;color:#09090b;cursor:pointer;font-weight:700}.error{color:#f5f7fa}footer{margin-top:28px;color:#888;font-size:12px}</style></head><body><main><small>CONTROLE DE PRODUÇÃO</small><h1>${setup?'Configuração inicial':'Bem-vindo'}</h1><p>${setup?'O responsável precisa definir a senha do portal para liberar o acesso.':'Digite a senha para acessar BOM × OP e os depósitos 7000, 2000 e 1500.'}</p>${message?`<p class="error" role="alert">${message}</p>`:''}${setup?'':'<form method="post" action="/auth/login"><label for="password">Senha do portal</label><input id="password" name="password" type="password" autocomplete="current-password" required maxlength="256" autofocus><button type="submit">Entrar</button></form>'}<footer>BOM × OP &nbsp; / &nbsp; 7000 &nbsp; / &nbsp; 2000 &nbsp; / &nbsp; 1500</footer></main></body></html>`,{status,headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'}});}
export async function authenticated(req:Request,env:PasswordEnv){
 return !!(await sessionRole(req,env));
}
/** Returns the role attached to the signed-in password session.
 * PORTAL_PASSWORD is kept as the administrator password for backwards
 * compatibility. Set PORTAL_VIEWER_PASSWORD for a read-only Lougas login. */
export async function sessionRole(req:Request,env:PasswordEnv):Promise<PortalRole|null>{
 if(!configured(env))return null;
 const token=sessionToken(req);if(!token)return null;await schema(env.DB);
 const row=await env.DB.prepare('SELECT password_tag,expires FROM portal_sessions WHERE token_hash=?').bind(await hash(token)).first<{password_tag:string;expires:number}>();
 if(!row||row.expires<=Date.now())return null;
 const admin=adminPassword(env)!;
 if(equal(row.password_tag,await tag(admin,token)))return 'admin';
 const analyst=env.PORTAL_ANALYST_PASSWORD;
 if(typeof analyst==='string'&&validPassword(analyst)&&equal(row.password_tag,await tag(analyst,token)))return 'analyst';
 const viewer=env.PORTAL_VIEWER_PASSWORD;
 if(typeof viewer==='string'&&validPassword(viewer)&&equal(row.password_tag,await tag(viewer,token)))return 'viewer';
 return null;
}
export async function authRoute(req:Request,env:PasswordEnv):Promise<Response|null>{
 const path=new URL(req.url).pathname;if(!['/auth/login','/auth/logout'].includes(path))return null;
 if(req.method!=='POST')return new Response('Método não permitido.',{status:405,headers:{Allow:'POST'}});
 if(req.headers.get('origin')!==new URL(req.url).origin||req.headers.get('sec-fetch-site')==='cross-site')return new Response('Origem inválida.',{status:403});
 if(!configured(env))return loginPage('',503,true);
 await schema(env.DB);
 if(path==='/auth/logout'){const token=sessionToken(req);if(token)await env.DB.prepare('DELETE FROM portal_sessions WHERE token_hash=?').bind(await hash(token)).run();return redirect(cookie('',0));}
 if(!req.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded'))return loginPage('Formato inválido.',415);
 const reader=req.body?.getReader();if(!reader)return loginPage('Informe a senha.',400);
 let raw='',size=0;const decoder=new TextDecoder();while(true){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>4096){await reader.cancel();return loginPage('Envio muito grande.',413);}raw+=decoder.decode(value,{stream:true});}raw+=decoder.decode();
 const password=new URLSearchParams(raw).get('password')||'';if(password.length>256)return loginPage('Senha inválida.',400);
 const now=Date.now(),ip=await hash(req.headers.get('CF-Connecting-IP')||'local');
 const attempt=await env.DB.prepare('INSERT INTO portal_attempts(ip_hash,attempts,expires) VALUES(?,1,?) ON CONFLICT(ip_hash) DO UPDATE SET attempts=CASE WHEN expires<=? THEN 1 ELSE attempts+1 END, expires=CASE WHEN expires<=? THEN ? ELSE expires END RETURNING attempts').bind(ip,now+900000,now,now,now+900000).first<{attempts:number}>();
 if(!attempt||attempt.attempts>10){const response=loginPage('Muitas tentativas. Aguarde 15 minutos antes de tentar novamente.',429);response.headers.set('Retry-After','900');return response;}
 const admin=adminPassword(env)!;
 const isAdmin=equal(await hash(password),await hash(admin));
 const analyst=env.PORTAL_ANALYST_PASSWORD;
 const isAnalyst=!isAdmin&&typeof analyst==='string'&&validPassword(analyst)&&equal(await hash(password),await hash(analyst));
 const viewer=env.PORTAL_VIEWER_PASSWORD;
 const isViewer=!isAdmin&&!isAnalyst&&typeof viewer==='string'&&validPassword(viewer)&&equal(await hash(password),await hash(viewer));
 if(!isAdmin&&!isAnalyst&&!isViewer)return loginPage('Senha incorreta. Tente novamente.',401);
 const sessionPassword=isAdmin?admin:isAnalyst?analyst!:viewer!;
 const token=hex(crypto.getRandomValues(new Uint8Array(32)).buffer);
 await env.DB.batch([
 env.DB.prepare('INSERT INTO portal_sessions(token_hash,password_tag,expires) VALUES(?,?,?)').bind(await hash(token),await tag(sessionPassword,token),now+28800000),
 env.DB.prepare('DELETE FROM portal_sessions WHERE expires<=?').bind(now),
 env.DB.prepare('DELETE FROM portal_attempts WHERE expires<=?').bind(now)
 ]);
 return redirect(cookie(token,28800));
}
