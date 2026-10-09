import type {PortalDatabase} from './database';
/**
 * Acesso ao portal.
 *  - Alterar qualquer coisa exige sessão de Administrador (ou Analista, onde a
 *    rota permite). Isso não depende de REQUIRE_PASSWORD.
 *  - Consulta (só leitura): modo "aberto" (qualquer pessoa com o endereço) ou
 *    "fechado" (só com o link de consulta ou com uma senha). O administrador
 *    escolhe no portal; sem escolha salva, REQUIRE_PASSWORD="true" começa fechado.
 */
export type PortalRole='admin'|'analyst'|'viewer';
export type AccessVia='password'|'link'|'open';
export type AccessMode='open'|'closed';
export interface PasswordEnv {PORTAL_PASSWORD?:string;PORTAL_ADMIN_PASSWORD?:string;PORTAL_ANALYST_PASSWORD?:string;PORTAL_VIEWER_PASSWORD?:string;REQUIRE_PASSWORD?:string;DB:PortalDatabase;}
export type Access={role:PortalRole|null;via:AccessVia|null;mode:AccessMode;adminConfigured:boolean;linkCreatedAt:string|null};
type Lang='pt'|'en';

const COOKIE='__Host-portal_session';
const LANG_COOKIE='wbyd_lang';
const PASSWORD_SESSION=8*3600;
const LINK_SESSION=30*24*3600;
const ready=new WeakMap<PortalDatabase,Promise<void>>();
function adminPassword(env:PasswordEnv){return env.PORTAL_ADMIN_PASSWORD||env.PORTAL_PASSWORD;}
function validPassword(value:unknown):value is string{return typeof value==='string'&&value.length>=12&&value.length<=256;}
export function configured(env:PasswordEnv){return validPassword(adminPassword(env));}
async function schema(db:PortalDatabase){let p=ready.get(db);if(!p){p=db.batch([
 db.prepare('CREATE TABLE IF NOT EXISTS portal_sessions(token_hash TEXT PRIMARY KEY, password_tag TEXT NOT NULL, expires INTEGER NOT NULL)'),
 db.prepare('CREATE TABLE IF NOT EXISTS portal_attempts(ip_hash TEXT PRIMARY KEY, attempts INTEGER NOT NULL, expires INTEGER NOT NULL)'),
 db.prepare('CREATE TABLE IF NOT EXISTS portal_settings(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)')
]).then(()=>{}).catch(e=>{ready.delete(db);throw e});ready.set(db,p);}await p;}
const hex=(b:ArrayBuffer)=>Array.from(new Uint8Array(b),x=>x.toString(16).padStart(2,'0')).join('');
async function hash(s:string){return hex(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)));}
async function tag(secret:string,token:string){const k=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);return hex(await crypto.subtle.sign('HMAC',k,new TextEncoder().encode(token)));}
function equal(a:string,b:string){if(a.length!==b.length)return false;let n=0;for(let i=0;i<a.length;i++)n|=a.charCodeAt(i)^b.charCodeAt(i);return n===0;}
function cookieValue(req:Request,name:string){const values=(req.headers.get('cookie')||'').split(';').map(s=>s.trim()).filter(s=>s.startsWith(name+'='));return values.length===1?values[0].slice(name.length+1):null;}
function sessionToken(req:Request){const t=cookieValue(req,COOKIE);return t&&/^[a-f0-9]{64}$/.test(t)?t:null;}
const cookie=(value:string,age:number)=>`${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${age}`;
/** Link de consulta: a sessão fica presa ao link atual; trocar o link encerra todas. */
const linkSecret=(viewToken:string)=>'view-link:'+viewToken;
const newToken=()=>hex(crypto.getRandomValues(new Uint8Array(32)).buffer);

/** POST só da própria página. Um formulário com Referrer-Policy no-referrer manda "Origin: null";
 * nesse caso vale o Sec-Fetch-Site, que o navegador preenche e uma página de fora não consegue forjar. */
export function sameOrigin(req:Request){
 const origin=req.headers.get('origin'),site=req.headers.get('sec-fetch-site');
 if(site&&site!=='same-origin'&&site!=='none')return false;
 if(origin===new URL(req.url).origin)return true;
 return origin==='null'&&site==='same-origin';
}

/** Volta só para um caminho do próprio portal (nunca //outro-site ou javascript:). */
export function safeNext(value:unknown){
 const next=typeof value==='string'?value:'';
 return /^\/(?![\/\\])[^\s\\]{0,500}$/.test(next)&&!/[\u0000-\u001f]/.test(next)?next:'/';
}

/* ---------------------------------------------------------------------- */
/* Configuração do acesso (tabela portal_settings)                         */
/* ---------------------------------------------------------------------- */
type SettingRow={key:string;value:string;updated_at:string};
let settingsCache:{db:PortalDatabase;at:number;rows:SettingRow[]}|null=null;
const SETTINGS_TTL=10_000;
async function settingRows(db:PortalDatabase){
 if(settingsCache&&settingsCache.db===db&&Date.now()-settingsCache.at<SETTINGS_TTL)return settingsCache.rows;
 await schema(db);
 const rows=(await db.prepare("SELECT key,value,updated_at FROM portal_settings WHERE key IN ('access_mode','view_token')").all<SettingRow>()).results;
 settingsCache={db,at:Date.now(),rows};
 return rows;
}
async function settings(env:PasswordEnv){
 const rows=await settingRows(env.DB),get=(key:string)=>rows.find(row=>row.key===key);
 const saved=get('access_mode')?.value;
 const mode:AccessMode=saved==='open'||saved==='closed'?saved:env.REQUIRE_PASSWORD==='true'?'closed':'open';
 const token=get('view_token');
 return {mode,viewToken:token&&/^[a-f0-9]{64}$/.test(token.value)?token.value:null,linkCreatedAt:token?.updated_at||null};
}
async function saveSetting(db:PortalDatabase,key:string,value:string){
 await schema(db);
 await db.prepare('INSERT INTO portal_settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').bind(key,value,new Date().toISOString()).run();
 settingsCache=null;
}

/* ---------------------------------------------------------------------- */
/* Quem é o visitante                                                      */
/* ---------------------------------------------------------------------- */
async function session(req:Request,env:PasswordEnv,viewToken:string|null):Promise<{role:PortalRole;via:AccessVia}|null>{
 const token=sessionToken(req);if(!token)return null;await schema(env.DB);
 const row=await env.DB.prepare('SELECT password_tag,expires FROM portal_sessions WHERE token_hash=?').bind(await hash(token)).first<{password_tag:string;expires:number}>();
 if(!row||row.expires<=Date.now())return null;
 const admin=adminPassword(env);
 if(validPassword(admin)&&equal(row.password_tag,await tag(admin,token)))return {role:'admin',via:'password'};
 const analyst=env.PORTAL_ANALYST_PASSWORD;
 if(validPassword(analyst)&&equal(row.password_tag,await tag(analyst,token)))return {role:'analyst',via:'password'};
 const viewer=env.PORTAL_VIEWER_PASSWORD;
 if(validPassword(viewer)&&equal(row.password_tag,await tag(viewer,token)))return {role:'viewer',via:'password'};
 if(viewToken&&equal(row.password_tag,await tag(linkSecret(viewToken),token)))return {role:'viewer',via:'link'};
 return null;
}
export async function resolveAccess(req:Request,env:PasswordEnv):Promise<Access>{
 const config=await settings(env),adminConfigured=configured(env);
 const found=await session(req,env,config.viewToken);
 if(found)return {...found,mode:config.mode,adminConfigured,linkCreatedAt:config.linkCreatedAt};
 if(config.mode==='open')return {role:'viewer',via:'open',mode:'open',adminConfigured,linkCreatedAt:config.linkCreatedAt};
 return {role:null,via:null,mode:'closed',adminConfigured,linkCreatedAt:config.linkCreatedAt};
}
/** Compatibilidade: papel da sessão por senha ou link (null sem sessão). */
export async function sessionRole(req:Request,env:PasswordEnv):Promise<PortalRole|null>{
 const config=await settings(env);return (await session(req,env,config.viewToken))?.role??null;
}
export async function authenticated(req:Request,env:PasswordEnv){return !!(await sessionRole(req,env));}

/* ---------------------------------------------------------------------- */
/* Página de entrada (PT/EN)                                               */
/* ---------------------------------------------------------------------- */
const TEXT={
 pt:{brand:'CONTROLE DE PRODUÇÃO',title:'Entrar · WBYD Controle de Produção',adminTitle:'Entrar como administrador',adminText:'Qualquer pessoa com o endereço pode consultar o portal. A senha de administrador libera importar planilhas, marcar, editar e apagar.',closedTitle:'Acesso ao portal',closedText:'Digite a senha. Para só consultar, abra o link de consulta enviado pelo administrador.',setupTitle:'Senha de administrador não cadastrada',setupText:'Cadastre o Secret PORTAL_PASSWORD (mínimo de 12 caracteres) no Cloudflare: Workers & Pages → controlofproduction → Settings → Variables and Secrets.',adminLabel:'Senha de administrador',label:'Senha',button:'Entrar',back:'Voltar para a consulta',footerOpen:'BR02 · Consulta livre · Alterações só com a senha de administrador',footerClosed:'BR02 · Acesso restrito · Para só consultar, use o link do administrador'},
 en:{brand:'PRODUCTION CONTROL',title:'Sign in · WBYD Production Control',adminTitle:'Sign in as administrator',adminText:'Anyone with the address can view the portal. The administrator password unlocks importing spreadsheets, marking, editing and deleting.',closedTitle:'Portal access',closedText:'Enter the password. To view only, open the view-only link sent by the administrator.',setupTitle:'Administrator password not set',setupText:'Add the PORTAL_PASSWORD secret (at least 12 characters) in Cloudflare: Workers & Pages → controlofproduction → Settings → Variables and Secrets.',adminLabel:'Administrator password',label:'Password',button:'Sign in',back:'Back to view-only mode',footerOpen:'BR02 · Open view-only access · Changes only with the administrator password',footerClosed:'BR02 · Restricted access · To view only, use the administrator’s link'}
} as const;
export const LOGIN_MESSAGES={
 wrong:{pt:'Senha incorreta. Tente novamente.',en:'Wrong password. Try again.'},
 tooMany:{pt:'Muitas tentativas. Aguarde 15 minutos antes de tentar novamente.',en:'Too many attempts. Wait 15 minutes before trying again.'},
 badLink:{pt:'Link de consulta inválido ou substituído. Peça o link novo ao administrador.',en:'Invalid or replaced view-only link. Ask the administrator for the new link.'},
 format:{pt:'Formato inválido.',en:'Invalid format.'},
 big:{pt:'Envio muito grande.',en:'Request too large.'},
 empty:{pt:'Informe a senha.',en:'Enter the password.'},
 origin:{pt:'Origem inválida. Abra o portal pelo endereço e tente de novo.',en:'Invalid origin. Open the portal from its address and try again.'},
 method:{pt:'Método não permitido.',en:'Method not allowed.'}
} as const;
export function requestLang(req?:Request):Lang{
 if(!req)return 'pt';
 const asked=new URL(req.url).searchParams.get('lang');if(asked==='en'||asked==='pt')return asked;
 return cookieValue(req,LANG_COOKIE)==='en'?'en':'pt';
}
const esc=(value:string)=>value.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]!);
const MARK='<svg viewBox="0 0 48 48" width="40" height="40" fill="none" aria-hidden="true"><path d="M5 10 13 37 24 18 35 37 43 10" stroke="#fff" stroke-width="5.5" stroke-linecap="square" stroke-linejoin="round"/><path d="M20 7h8l-4 7z" fill="#e32636"/></svg>';
type LoginOptions={lang?:Lang;mode?:AccessMode;next?:string;setup?:boolean;rememberLang?:boolean};
export function loginPage(message='',status=200,setup=false,options:LoginOptions={}){
 const lang=options.lang||'pt',t=TEXT[lang],mode=options.mode||'closed',next=safeNext(options.next||'/'),open=mode==='open';
 const isSetup=setup||!!options.setup;
 const title=isSetup?t.setupTitle:open?t.adminTitle:t.closedTitle;
 const text=isSetup?t.setupText:open?t.adminText:t.closedText;
 const langLink=(code:Lang)=>`<a href="/entrar?lang=${code}&amp;next=${encodeURIComponent(next)}"${code===lang?' aria-current="true"':''}>${code.toUpperCase()}</a>`;
 const form=isSetup?'':`<form method="post" action="/auth/login"><input type="hidden" name="next" value="${esc(next)}"><label for="password">${open?t.adminLabel:t.label}</label><input id="password" name="password" type="password" autocomplete="current-password" required maxlength="256" autofocus><button type="submit">${t.button}</button></form>`;
 const back=open?`<a class="back" href="${esc(next)}">← ${t.back}</a>`:'';
 const html=`<!doctype html><html lang="${lang==='en'?'en':'pt-BR'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${t.title}</title><style>
*{box-sizing:border-box}html,body{margin:0;min-height:100%}body{min-height:100vh;display:grid;place-items:center;background:#0a0b0d;background-image:radial-gradient(ellipse 80% 60% at 50% -10%,#e3263622,transparent 70%);color:#f4f5f7;font:16px/1.5 "Segoe UI",system-ui,-apple-system,Arial,sans-serif;padding:24px}
main{width:min(460px,100%);padding:34px 34px 28px;background:#121418;border:1px solid #ffffff1a;border-top:3px solid #e32636;border-radius:12px;box-shadow:0 30px 80px #0008}
header{display:flex;align-items:center;gap:12px;margin-bottom:26px}header div{flex:1}header b{display:block;font:900 20px/1 Arial,sans-serif;letter-spacing:-.4px}header span{display:block;font-size:10.5px;letter-spacing:2px;color:#a3a8b3;margin-top:5px}
nav{display:flex;gap:2px;border:1px solid #ffffff24;border-radius:6px;padding:2px}nav a{color:#c9ced8;text-decoration:none;font-size:12px;font-weight:700;padding:4px 9px;border-radius:4px}nav a[aria-current]{background:#f4f5f7;color:#0a0b0d}
h1{font-size:26px;line-height:1.2;margin:0 0 10px;letter-spacing:-.4px}p{color:#b8bdc8;margin:0 0 6px;font-size:15px}.error{margin:16px 0 0;padding:10px 12px;border-radius:6px;background:#e3263620;border:1px solid #e3263666;color:#ffd5d9;font-size:14px}
label{display:block;margin:22px 0 8px;font-size:14px;font-weight:600}input{width:100%;padding:13px 14px;border-radius:7px;border:1px solid #4a4f5a;background:#08090b;color:#fff;font:inherit}input:focus{outline:2px solid #e32636;outline-offset:1px;border-color:#e32636}
button{width:100%;margin-top:14px;padding:13px;border:0;border-radius:7px;background:#e32636;color:#fff;font:inherit;font-weight:700;cursor:pointer}button:hover{background:#c81f2e}button:focus-visible{outline:2px solid #fff;outline-offset:2px}
.back{display:inline-block;margin-top:18px;color:#d6dae2;font-size:14px}footer{margin-top:24px;padding-top:16px;border-top:1px solid #ffffff12;color:#8a909c;font-size:12px}
</style></head><body><main><header>${MARK}<div><b>WBYD</b><span>${t.brand}</span></div><nav aria-label="Idioma / Language">${langLink('pt')}${langLink('en')}</nav></header><h1>${title}</h1><p>${text}</p>${message?`<p class="error" role="alert">${esc(message)}</p>`:''}${form}${back}<footer>${open?t.footerOpen:t.footerClosed}</footer></main></body></html>`;
 const headers=new Headers({'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",'X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'same-origin','X-Robots-Tag':'noindex, nofollow'});
 if(options.rememberLang)headers.append('Set-Cookie',`${LANG_COOKIE}=${lang}; Path=/; Secure; SameSite=Lax; Max-Age=31536000`);
 return new Response(html,{status,headers});
}
function redirect(location:string,...cookies:string[]){const headers=new Headers({'Location':location,'Cache-Control':'no-store'});for(const value of cookies)headers.append('Set-Cookie',value);return new Response(null,{status:303,headers});}

/* ---------------------------------------------------------------------- */
/* Rotas: /entrar, /auth/login, /auth/logout, /consulta/<link>             */
/* ---------------------------------------------------------------------- */
async function countAttempt(env:PasswordEnv,key:string){
 const now=Date.now();
 const attempt=await env.DB.prepare('INSERT INTO portal_attempts(ip_hash,attempts,expires) VALUES(?,1,?) ON CONFLICT(ip_hash) DO UPDATE SET attempts=CASE WHEN expires<=? THEN 1 ELSE attempts+1 END, expires=CASE WHEN expires<=? THEN ? ELSE expires END RETURNING attempts').bind(key,now+900000,now,now,now+900000).first<{attempts:number}>();
 return attempt?.attempts??99;
}
async function startSession(env:PasswordEnv,secret:string,age:number){
 const token=newToken(),now=Date.now();
 await env.DB.batch([
  env.DB.prepare('INSERT INTO portal_sessions(token_hash,password_tag,expires) VALUES(?,?,?)').bind(await hash(token),await tag(secret,token),now+age*1000),
  env.DB.prepare('DELETE FROM portal_sessions WHERE expires<=?').bind(now),
  env.DB.prepare('DELETE FROM portal_attempts WHERE expires<=?').bind(now)
 ]);
 return cookie(token,age);
}
export async function authRoute(req:Request,env:PasswordEnv,access?:Access):Promise<Response|null>{
 const url=new URL(req.url),path=url.pathname,lang=requestLang(req);
 const consulta=path.match(/^\/consulta\/([^/]*)$/);
 if(!['/auth/login','/auth/logout','/entrar'].includes(path)&&!consulta)return null;
 const current=access||await resolveAccess(req,env);
 const page=(message:string,status:number,next=url.searchParams.get('next')||'/')=>loginPage(message,status,false,{lang,mode:current.mode,next,setup:!current.adminConfigured,rememberLang:url.searchParams.has('lang')});
 if(path==='/entrar'||(path==='/auth/login'&&req.method==='GET')){
  if(req.method!=='GET'&&req.method!=='HEAD')return new Response(LOGIN_MESSAGES.method[lang],{status:405,headers:{Allow:'GET'}});
  return page('',current.adminConfigured?200:503);
 }
 if(consulta){
  if(req.method!=='GET'&&req.method!=='HEAD')return new Response(LOGIN_MESSAGES.method[lang],{status:405,headers:{Allow:'GET'}});
  const token=consulta[1],config=await settings(env);await schema(env.DB);
  const ip=await hash('link:'+(req.headers.get('CF-Connecting-IP')||'local'));
  if(!/^[a-f0-9]{64}$/.test(token)||!config.viewToken||!equal(token,config.viewToken)){
   const attempts=await countAttempt(env,ip);
   if(attempts>20){const r=page(LOGIN_MESSAGES.tooMany[lang],429,'/');r.headers.set('Retry-After','900');return r;}
   return page(LOGIN_MESSAGES.badLink[lang],404,'/');
  }
  // Quem já entrou como ADM ou Analista continua com o mesmo acesso.
  if(current.role&&current.via==='password'&&current.role!=='viewer')return redirect(safeNext(url.searchParams.get('next')));
  return redirect(safeNext(url.searchParams.get('next')),await startSession(env,linkSecret(config.viewToken),LINK_SESSION));
 }
 if(req.method!=='POST')return new Response(LOGIN_MESSAGES.method[lang],{status:405,headers:{Allow:'POST'}});
 if(!sameOrigin(req))return page(LOGIN_MESSAGES.origin[lang],403);
 await schema(env.DB);
 if(path==='/auth/logout'){const token=sessionToken(req);if(token)await env.DB.prepare('DELETE FROM portal_sessions WHERE token_hash=?').bind(await hash(token)).run();return redirect('/',cookie('',0));}
 if(!current.adminConfigured)return page('',503);
 if(!req.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded'))return page(LOGIN_MESSAGES.format[lang],415);
 const reader=req.body?.getReader();if(!reader)return page(LOGIN_MESSAGES.empty[lang],400);
 let raw='',size=0;const decoder=new TextDecoder();while(true){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>4096){await reader.cancel();return page(LOGIN_MESSAGES.big[lang],413);}raw+=decoder.decode(value,{stream:true});}raw+=decoder.decode();
 const form=new URLSearchParams(raw),password=form.get('password')||'',next=safeNext(form.get('next'));
 if(password.length>256)return page(LOGIN_MESSAGES.wrong[lang],400,next);
 const ip=await hash(req.headers.get('CF-Connecting-IP')||'local');
 if(await countAttempt(env,ip)>10){const response=page(LOGIN_MESSAGES.tooMany[lang],429,next);response.headers.set('Retry-After','900');return response;}
 const typed=await hash(password);
 const candidates:[PortalRole,string|undefined][]=[['admin',adminPassword(env)],['analyst',env.PORTAL_ANALYST_PASSWORD],['viewer',env.PORTAL_VIEWER_PASSWORD]];
 let matched:string|null=null,role:PortalRole|null=null;
 for(const [candidateRole,secret] of candidates){if(!matched&&validPassword(secret)&&equal(typed,await hash(secret))){matched=secret;role=candidateRole;}}
 if(!matched||!role)return page(LOGIN_MESSAGES.wrong[lang],401,next);
 // Entrou certo: zera as tentativas deste endereço.
 await env.DB.prepare('DELETE FROM portal_attempts WHERE ip_hash=?').bind(ip).run();
 return redirect(next,await startSession(env,matched,role==='viewer'?LINK_SESSION:PASSWORD_SESSION));
}

/* ---------------------------------------------------------------------- */
/* /api/access: o administrador escolhe o modo e gera o link de consulta    */
/* ---------------------------------------------------------------------- */
const jsonResponse=(value:unknown,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
async function accessSummary(env:PasswordEnv,origin:string){
 const config=await settings(env);await schema(env.DB);
 const counts=await env.DB.prepare('SELECT COUNT(*) AS total FROM portal_sessions WHERE expires>?').bind(Date.now()).first<{total:number}>();
 return {mode:config.mode,link:config.viewToken?`${origin}/consulta/${config.viewToken}`:null,linkCreatedAt:config.linkCreatedAt,activeSessions:Number(counts?.total||0),analystConfigured:validPassword(env.PORTAL_ANALYST_PASSWORD),viewerPasswordConfigured:validPassword(env.PORTAL_VIEWER_PASSWORD)};
}
export async function accessRoute(req:Request,env:PasswordEnv,access:Access):Promise<Response>{
 const url=new URL(req.url);
 if(access.role!=='admin'||access.via!=='password')return jsonResponse({error:'Somente o administrador gerencia o acesso.'},403);
 if(req.method==='GET')return jsonResponse(await accessSummary(env,url.origin));
 if(req.method!=='POST')return jsonResponse({error:'Método não permitido.'},405);
 if(!sameOrigin(req))return jsonResponse({error:'Origem inválida.'},403);
 if(!req.headers.get('content-type')?.startsWith('application/json'))return jsonResponse({error:'Formato inválido.'},415);
 let body:any;try{const text=await req.text();if(text.length>2000)throw Error();body=JSON.parse(text);}catch{return jsonResponse({error:'Formato inválido.'},400);}
 if(body?.action==='mode'){
  if(body.mode!=='open'&&body.mode!=='closed')return jsonResponse({error:'Escolha aberto ou fechado.'},400);
  await saveSetting(env.DB,'access_mode',body.mode);
  return jsonResponse(await accessSummary(env,url.origin));
 }
 if(body?.action==='link'){
  // Link novo: o antigo para de funcionar e as sessões abertas por ele terminam.
  await saveSetting(env.DB,'view_token',newToken());
  return jsonResponse(await accessSummary(env,url.origin));
 }
 if(body?.action==='end-sessions'){
  const token=sessionToken(req);
  await env.DB.prepare('DELETE FROM portal_sessions WHERE token_hash<>?').bind(token?await hash(token):'').run();
  return jsonResponse(await accessSummary(env,url.origin));
 }
 return jsonResponse({error:'Ação inválida.'},400);
}
