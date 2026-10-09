// Acesso e segurança contra o Worker de verdade (D1 local do Miniflare):
// consulta sem senha só lê; alterar exige a senha de ADM; link de consulta;
// modo fechado; CSRF; cabeçalhos; redirecionamento seguro; força bruta.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { createRequire } = require("node:module");
const root = path.resolve(__dirname, "..");
const req = createRequire(root + "/package.json");
const wr = req.resolve("wrangler");
const { Miniflare } = require(require.resolve("miniflare", { paths: [wr] }));
const { build } = require(require.resolve("esbuild", { paths: [wr] }));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "acesso-test-"));
let handler, mf, db;
const ADMIN = crypto.randomBytes(16).toString("hex");
const ANALYST = crypto.randomBytes(16).toString("hex");
const VIEWER = crypto.randomBytes(16).toString("hex");
const ORIGIN = "https://portal.test";
const assets = { async fetch() { return new Response("<!doctype html><html><head></head><body>portal</body></html>", { headers: { "Content-Type": "text/html" } }); } };

before(async () => {
  await build({ entryPoints: [root + "/worker/index.ts"], bundle: true, platform: "node", format: "cjs", outfile: temp + "/worker.cjs", logLevel: "error" });
  handler = require(temp + "/worker.cjs").default;
  mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("x")}}', d1Databases: ["DB"], compatibilityDate: "2026-05-15" });
  db = await mf.getD1Database("DB");
});
after(async () => {
  await mf?.dispose();
  fs.rmSync(temp, { recursive: true, force: true });
});

let ipCounter = 1;
/** Outro objeto de banco = cache de configuração vazio (como um Worker recém-iniciado). */
const freshDb = () => ({ prepare: (sql) => db.prepare(sql), batch: (statements) => db.batch(statements) });
function client(extra = {}) {
  const env = { DB: extra.DB || db, ASSETS: assets, PORTAL_PASSWORD: ADMIN, PORTAL_ANALYST_PASSWORD: ANALYST, PORTAL_VIEWER_PASSWORD: VIEWER, ...extra };
  const call = (p, options = {}) => handler.fetch(new Request(ORIGIN + p, options), env);
  const login = async (password, { ip = "198.51.100." + ipCounter++, headers = { Origin: ORIGIN }, next } = {}) =>
    call("/auth/login", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "CF-Connecting-IP": ip, ...headers }, body: new URLSearchParams({ password, ...(next ? { next } : {}) }).toString() });
  const cookieOf = (response) => response.headers.get("Set-Cookie").split(";")[0];
  const post = (p, body, cookie, method = "POST") => call(p, { method, headers: { Origin: ORIGIN, "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { env, call, login, cookieOf, post };
}
/** Todas as rotas que alteram dados. Nenhuma pode passar sem senha. */
const WRITES = [
  ["/api/data", { id: "1500", rows: [] }],
  ["/api/data?id=consumo:x&version=1", undefined, "DELETE"],
  ["/api/data-meta", { id: "consumo:x", version: "1", name: "x" }],
  ["/api/plan-boms", { action: "save", data: { id: "plano:x" } }],
  ["/api/op-status?id=consumo:bc22x-1268", { id: "consumo:bc22x-1268", op: "19000002315", status: "complete" }],
  ["/api/checks?id=consumo:bc22x-1268", { id: "consumo:bc22x-1268", keys: ["a"], checked: true }],
  ["/api/scrap-forms", { action: "create", data: {} }],
  ["/api/dossies", { action: "create", items: [] }],
  ["/api/ana-notes", { id: crypto.randomUUID(), op: "19000002315", material: "", text: "teste" }],
  ["/api/access", { action: "mode", mode: "open" }],
];

test("sem senha: consulta aberta lê tudo e não altera nada", async () => {
  await db.prepare("DELETE FROM portal_settings").run().catch(() => {});
  const { call, post } = client({ REQUIRE_PASSWORD: "false" });
  const session = await (await call("/api/session")).json();
  assert.equal(session.role, "viewer");
  assert.equal(session.via, "open");
  assert.equal(session.canEdit, false);
  assert.equal(session.adminConfigured, true);
  assert.equal((await call("/api/data")).status, 200);
  assert.equal((await call("/api/data?id=7000")).status, 200);
  assert.equal((await call("/")).status, 200);
  for (const [route, body, method] of WRITES) {
    const response = await post(route, body, undefined, method);
    assert.equal(response.status, 403, `${method || "POST"} ${route} sem senha devia ser bloqueado (veio ${response.status})`);
  }
  assert.equal((await call("/api/access")).status, 403, "configuração de acesso só para ADM");
  assert.equal((await call("/api/sheets?id=" + "a".repeat(30) + "&sheet=x")).status, 404, "proxy genérico de planilhas removido");
});

test("senha de ADM: entra pelo formulário (Origin null + Sec-Fetch-Site) e altera", async () => {
  const { call, login, cookieOf, post } = client({ REQUIRE_PASSWORD: "false" });
  // Formulário com Referrer-Policy no-referrer: o Chromium manda Origin "null".
  const viaForm = await login(ADMIN, { headers: { Origin: "null", "Sec-Fetch-Site": "same-origin" } });
  assert.equal(viaForm.status, 303);
  const cookie = cookieOf(viaForm);
  for (const attribute of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/", "Max-Age=28800"]) assert.ok(viaForm.headers.get("Set-Cookie").includes(attribute), attribute);
  assert.match(cookie, /^__Host-portal_session=[a-f0-9]{64}$/);
  const session = await (await call("/api/session", { headers: { Cookie: cookie } })).json();
  assert.equal(session.role, "admin");
  assert.equal(session.canEdit, true);
  const marked = await post("/api/op-status?id=consumo:bc22x-1268", { id: "consumo:bc22x-1268", op: "19000002315", status: "complete" }, cookie);
  assert.equal(marked.status, 200);
  // CSRF: outro site não consegue nem entrar nem alterar.
  assert.equal((await login(ADMIN, { headers: { Origin: "https://evil.example" } })).status, 403);
  assert.equal((await login(ADMIN, { headers: { Origin: "null", "Sec-Fetch-Site": "cross-site" } })).status, 403);
  assert.equal((await login(ADMIN, { headers: {} })).status, 403, "sem Origin não entra");
  const crossSite = await call("/api/op-status?id=consumo:bc22x-1268", { method: "POST", headers: { Origin: "https://evil.example", "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify({ id: "consumo:bc22x-1268", op: "19000002315", status: "waiting" }) });
  assert.equal(crossSite.status, 403);
  // Sair encerra a sessão: volta a ser só consulta.
  const out = await call("/auth/logout", { method: "POST", headers: { Origin: ORIGIN, Cookie: cookie } });
  assert.equal(out.status, 303);
  assert.equal((await (await call("/api/session", { headers: { Cookie: cookie } })).json()).role, "viewer");
});

test("perfis: Analista escreve notas e formulários, Consulta por senha só lê", async () => {
  const { login, cookieOf, post, call } = client({ REQUIRE_PASSWORD: "false" });
  const analyst = cookieOf(await login(ANALYST));
  assert.equal((await (await call("/api/session", { headers: { Cookie: analyst } })).json()).role, "analyst");
  assert.equal((await post("/api/ana-notes", { id: crypto.randomUUID(), op: "19000002315", material: "", text: "Conferido." }, analyst)).status, 200);
  for (const route of ["/api/checks?id=consumo:bc22x-1268", "/api/op-status?id=consumo:bc22x-1268", "/api/data", "/api/access"])
    assert.equal((await post(route, { id: "consumo:bc22x-1268", op: "19000002315", status: "complete", keys: ["a"], action: "mode", mode: "open" }, analyst)).status, 403, route);
  const viewer = await login(VIEWER);
  assert.match(viewer.headers.get("Set-Cookie"), /Max-Age=2592000/);
  const viewerCookie = cookieOf(viewer);
  for (const [route, body, method] of WRITES) assert.equal((await post(route, body, viewerCookie, method)).status, 403, route);
});

test("modo fechado + link de consulta: só entra quem tem o link; trocar o link derruba o antigo", async () => {
  const { call, login, cookieOf, post } = client({ REQUIRE_PASSWORD: "false" });
  const admin = cookieOf(await login(ADMIN));
  const closed = await (await post("/api/access", { action: "mode", mode: "closed" }, admin)).json();
  assert.equal(closed.mode, "closed");
  // Sem sessão: API pede login e a página mostra o formulário.
  const blocked = await call("/api/data");
  assert.equal(blocked.status, 401);
  assert.equal((await blocked.json()).code, "LOGIN_REQUIRED");
  const page = await call("/?modulo=ana");
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Acesso ao portal/);
  assert.match(html, /name="next" value="\/\?modulo=ana"/);
  // Link de consulta.
  const generated = await (await post("/api/access", { action: "link" }, admin)).json();
  assert.match(generated.link, /^https:\/\/portal\.test\/consulta\/[a-f0-9]{64}$/);
  const linkPath = new URL(generated.link).pathname;
  const opened = await call(linkPath + "?next=" + encodeURIComponent("/?modulo=ana"));
  assert.equal(opened.status, 303);
  assert.equal(opened.headers.get("Location"), "/?modulo=ana");
  assert.match(opened.headers.get("Set-Cookie"), /Max-Age=2592000/);
  const viewer = cookieOf(opened);
  const session = await (await call("/api/session", { headers: { Cookie: viewer } })).json();
  assert.equal(session.role, "viewer");
  assert.equal(session.via, "link");
  assert.equal((await call("/api/data", { headers: { Cookie: viewer } })).status, 200);
  for (const [route, body, method] of WRITES) assert.equal((await post(route, body, viewer, method)).status, 403, route);
  // Trocar o link: o antigo dá erro e a sessão aberta por ele termina.
  const rotated = await (await post("/api/access", { action: "link" }, admin)).json();
  assert.notEqual(rotated.link, generated.link);
  assert.equal((await call("/api/data", { headers: { Cookie: viewer } })).status, 401);
  const stale = await call(linkPath);
  assert.equal(stale.status, 404);
  assert.match(await stale.text(), /Link de consulta inválido/);
  // ADM continua ADM mesmo abrindo o link.
  const adminOpensLink = await call(new URL(rotated.link).pathname, { headers: { Cookie: admin } });
  assert.equal(adminOpensLink.status, 303);
  assert.equal(adminOpensLink.headers.get("Set-Cookie"), null);
  // Encerrar sessões: todas as outras caem, a do ADM continua.
  const other = cookieOf(await call(new URL(rotated.link).pathname));
  assert.equal((await call("/api/data", { headers: { Cookie: other } })).status, 200);
  await post("/api/access", { action: "end-sessions" }, admin);
  assert.equal((await call("/api/data", { headers: { Cookie: other } })).status, 401);
  assert.equal((await call("/api/data", { headers: { Cookie: admin } })).status, 200);
  // Volta ao aberto.
  assert.equal((await (await post("/api/access", { action: "mode", mode: "open" }, admin)).json()).mode, "open");
  assert.equal((await call("/api/data")).status, 200);
});

test("força bruta: senha e link têm limite por endereço", async () => {
  const { login, call } = client({ REQUIRE_PASSWORD: "false" });
  for (let i = 0; i < 10; i++) assert.equal((await login("errada-" + i, { ip: "203.0.113.9" })).status, 401);
  assert.equal((await login(ADMIN, { ip: "203.0.113.9" })).status, 429, "11ª tentativa bloqueada mesmo com a senha certa");
  for (let i = 0; i < 20; i++) assert.equal((await call("/consulta/" + crypto.randomBytes(32).toString("hex"), { headers: { "CF-Connecting-IP": "203.0.113.10" } })).status, 404);
  assert.equal((await call("/consulta/" + "0".repeat(64), { headers: { "CF-Connecting-IP": "203.0.113.10" } })).status, 429);
});

test("redirecionamento só para o próprio portal e página de entrada em inglês", async () => {
  const { call, login } = client({ REQUIRE_PASSWORD: "false" });
  for (const evil of ["//evil.example", "https://evil.example", "/\\evil.example", "javascript:alert(1)", "/%0d%0aSet-Cookie:x"]) {
    const response = await login(ADMIN, { next: evil });
    assert.equal(response.status, 303);
    const location = response.headers.get("Location");
    assert.ok(location === "/" || (location.startsWith("/") && !location.startsWith("//") && !/[\r\n]/.test(location)), evil + " → " + location);
  }
  const good = await login(ADMIN, { next: "/?modulo=ana" });
  assert.equal(good.headers.get("Location"), "/?modulo=ana");
  const english = await call("/entrar?lang=en");
  const text = await english.text();
  assert.match(text, /Sign in as administrator/);
  assert.match(english.headers.get("Set-Cookie"), /^wbyd_lang=en;/);
  assert.match(await (await call("/entrar", { headers: { Cookie: "wbyd_lang=en" } })).text(), /Administrator password/);
  assert.match(await (await call("/entrar")).text(), /Entrar como administrador/);
  // Mensagem do servidor nunca vira HTML.
  assert.doesNotMatch(await (await call("/entrar?next=" + encodeURIComponent('/"><script>alert(1)</script>'))).text(), /<script>alert/);
});

test("cabeçalhos de segurança em páginas, APIs e erros", async () => {
  const { call } = client({ REQUIRE_PASSWORD: "false" });
  const page = await call("/");
  const csp = page.headers.get("Content-Security-Policy");
  for (const part of ["default-src 'self'", "script-src 'self'", "object-src 'self' blob:", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'"]) assert.ok(csp.includes(part), part);
  assert.doesNotMatch(csp, /\*|https?:/, "nenhum site de fora liberado");
  assert.doesNotMatch(csp, /unsafe-eval/);
  assert.doesNotMatch(csp.match(/script-src[^;]*/)[0], /unsafe-inline/);
  for (const [name, value] of [["X-Content-Type-Options", "nosniff"], ["X-Frame-Options", "DENY"], ["Referrer-Policy", "same-origin"], ["Cross-Origin-Opener-Policy", "same-origin"], ["X-Robots-Tag", "noindex, nofollow"]]) assert.equal(page.headers.get(name), value, name);
  assert.match(page.headers.get("Strict-Transport-Security"), /max-age=31536000/);
  assert.match(page.headers.get("Permissions-Policy"), /camera=\(\)/);
  assert.equal(page.headers.get("Cache-Control"), "no-store");
  const api = await call("/api/session");
  assert.equal(api.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(api.headers.get("Cache-Control"), "no-store");
  assert.equal(api.headers.get("Access-Control-Allow-Origin"), null, "sem CORS");
  const login = await call("/entrar");
  assert.match(login.headers.get("Content-Security-Policy"), /default-src 'none'/);
  const missing = await call("/api/nao-existe");
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get("X-Frame-Options"), "DENY");
});

test("sem senha de ADM cadastrada: consulta continua e ninguém consegue alterar", async () => {
  await db.prepare("DELETE FROM portal_settings").run();
  const { call, post, login } = client({ DB: freshDb(), REQUIRE_PASSWORD: "false", PORTAL_PASSWORD: undefined, PORTAL_ANALYST_PASSWORD: undefined, PORTAL_VIEWER_PASSWORD: undefined });
  const session = await (await call("/api/session")).json();
  assert.equal(session.role, "viewer");
  assert.equal(session.adminConfigured, false);
  const entrar = await call("/entrar");
  assert.equal(entrar.status, 503);
  assert.match(await entrar.text(), /PORTAL_PASSWORD/);
  assert.equal((await login("qualquer-coisa-123")).status, 503);
  for (const [route, body, method] of WRITES) assert.equal((await post(route, body, undefined, method)).status, 403, route);
});

test("REQUIRE_PASSWORD=true começa fechado (compatível com a versão anterior)", async () => {
  await db.prepare("DELETE FROM portal_settings").run();
  const { call } = client({ DB: freshDb(), REQUIRE_PASSWORD: "true" });
  assert.equal((await call("/api/data")).status, 401);
  assert.match(await (await call("/")).text(), /Acesso ao portal/);
});

test("consulta aberta tem freio contra robôs; ADM não", async () => {
  const { call, login, cookieOf } = client({ DB: freshDb(), REQUIRE_PASSWORD: "false" });
  const ip = { "CF-Connecting-IP": "203.0.113.50" };
  let limited = 0;
  for (let i = 0; i < 640; i++) if ((await call("/api/session", { headers: ip })).status === 429) limited++;
  assert.ok(limited >= 15, "passou do limite por minuto: " + limited);
  const blocked = await call("/api/session", { headers: ip });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get("Retry-After"), "60");
  const admin = cookieOf(await login(ADMIN, { ip: "203.0.113.50" }));
  for (let i = 0; i < 30; i++) assert.equal((await call("/api/session", { headers: { ...ip, Cookie: admin } })).status, 200);
});
