// API do DOSSIÊ WAREHOUSE contra um D1 local (Miniflare) e um banco Turso local
// (libSQL em arquivo). Nenhum banco, planilha ou sessão de produção é usado.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createRequire } = require("node:module");
const root = path.resolve(__dirname, "..");
const req = createRequire(root + "/package.json");
const wr = req.resolve("wrangler");
const { Miniflare } = require(require.resolve("miniflare", { paths: [wr] }));
const { build } = require(require.resolve("esbuild", { paths: [wr] }));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "dossie-api-"));
let handler, storage, TursoDatabase, mf;

before(async () => {
  await build({ entryPoints: [root + "/worker/index.ts"], bundle: true, platform: "node", format: "cjs", outfile: temp + "/worker.cjs", logLevel: "error" });
  await build({ entryPoints: [root + "/worker/storage.ts"], bundle: true, platform: "node", format: "cjs", outfile: temp + "/storage.cjs", logLevel: "error" });
  await build({ entryPoints: [root + "/worker/database.ts"], bundle: true, platform: "node", format: "cjs", outfile: temp + "/database.cjs", logLevel: "error" });
  handler = require(temp + "/worker.cjs").default;
  storage = require(temp + "/storage.cjs");
  TursoDatabase = require(temp + "/database.cjs").TursoDatabase;
  mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("test")}}', d1Databases: ["DB"], compatibilityDate: "2026-05-15" });
});
after(async () => {
  await mf?.dispose();
  fs.rmSync(temp, { recursive: true, force: true });
});

const ADMIN = "senha-admin-de-teste-123",
  ANALYST = "senha-analista-de-teste",
  VIEWER = "senha-consulta-de-teste";
const MATERIAL = "19376997-00";
const movement = (depot, type, quantity, amount, headerText, document, item, postingDate, user) => ({
  document, year: "2026", item, postingDate, entryDate: "", entryTime: "", depot, counterDepot: "", plant: "BR02", type, typeText: "", special: "",
  quantity, unit: type === "862" ? "PCS" : "", amount, currency: "BRL", user, headerText, itemText: "", order: "", costCenter: "", reference: "", receiver: "", batch: "",
});
const screen = [
  movement("00ZT", "311", -62, 0, "00ZT X 2000 ESTOQUE", "4900785063", "1", "2026-09-30", "WH2"),
  movement("2000", "311", 62, 0, "00ZT X 2000 ESTOQUE", "4900785063", "2", "2026-09-30", "WH2"),
  movement("2000", "311", -168, 0, "", "4900337716", "31", "2026-03-12", "WH1"),
  movement("7000", "311", 168, 0, "", "4900337716", "32", "2026-03-12", "WH1"),
  movement("00ZT", "311", -168, 0, "Transferencia zt p/ 2000", "4900306959", "3", "2026-02-27", "WH1"),
  movement("2000", "311", 168, 0, "Transferencia zt p/ 2000", "4900306959", "4", "2026-02-27", "WH1"),
  movement("00ZT", "862", -150, -1573.49, "", "4900304284", "9", "2026-02-20", "MM"),
  movement("00ZT", "561", 380, 3986.18, "", "4900023756", "8", "2025-11-10", "MM"),
];
const data = (overrides = {}) => ({
  material: MATERIAL,
  description: "TKC-3921853_IDENTIFICACAO DA BATERIA",
  plant: "BR02",
  target: "7000",
  movements: screen,
  questioned: ["4900337716/2026/31"],
  manualPrice: null,
  request: "",
  deadline: "2026-10-09",
  recipients: "warehouse@exemplo.test",
  notes: "",
  stockCheck: null,
  source: "MB51 colada",
  importedAt: "2026-10-06T17:40:00.000Z",
  ...overrides,
});
// PNG 1×1 válido.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

async function scenario(db) {
  const assets = { async fetch() { return new Response("<html>portal</html>", { headers: { "Content-Type": "text/html" } }); } };
  const env = { DB: db, ASSETS: assets, PORTAL_PASSWORD: ADMIN, PORTAL_ANALYST_PASSWORD: ANALYST, PORTAL_VIEWER_PASSWORD: VIEWER, REQUIRE_PASSWORD: "true" };
  const call = (p, options = {}) => handler.fetch(new Request("https://portal.test" + p, options), env);
  let ip = 10;
  const login = async (password) => {
    const response = await call("/auth/login", {
      method: "POST",
      headers: { Origin: "https://portal.test", "Content-Type": "application/x-www-form-urlencoded", "CF-Connecting-IP": "192.0.2." + ip++ },
      body: new URLSearchParams({ password }).toString(),
    });
    assert.equal(response.status, 303);
    return { Cookie: response.headers.get("Set-Cookie").split(";")[0] };
  };
  const admin = await login(ADMIN),
    analyst = await login(ANALYST),
    viewer = await login(VIEWER);
  const get = async (p, headers = admin) => {
    const response = await call(p, { headers });
    return { status: response.status, body: response.headers.get("content-type")?.includes("json") ? await response.json() : await response.arrayBuffer(), headers: response.headers };
  };
  const post = async (body, headers = admin, origin = "https://portal.test") => {
    const response = await call("/api/dossies", { method: "POST", headers: { ...headers, Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };

  assert.equal((await call("/api/dossies")).status, 401, "sem login");
  let list = await get("/api/dossies");
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.dossies, []);
  assert.equal(list.body.canEdit, true);
  assert.equal((await get("/api/dossies", viewer)).body.canEdit, false);

  // Criar: consulta não cria; origem de outro site é recusada.
  assert.equal((await post({ action: "create", items: [data()] }, viewer)).status, 403);
  assert.equal((await post({ action: "create", items: [data()] }, admin, "https://outro.test")).status, 403);
  assert.equal((await post({ action: "create", items: [data({ questioned: [] })] })).status, 400);
  const created = await post({ action: "create", items: [data(), data({ material: "X-2", movements: screen.slice(2, 4), questioned: ["4900337716/2026/31"] })] }, analyst);
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const year = new Intl.DateTimeFormat("en-US", { timeZone: "America/Sao_Paulo", year: "numeric" }).format(new Date());
  assert.deepEqual(created.body.dossies.map((d) => d.number), [`DOS-${year}-0001`, `DOS-${year}-0002`]);
  const [first, second] = created.body.dossies;
  assert.equal(first.status, "open");
  assert.equal(first.summary.idle, 168);
  assert.equal(first.summary.value, 1762.31);
  assert.equal(first.track.log.length, 1);
  assert.match(first.track.log[0].text, /Dossiê aberto com 8 lançamento/);
  assert.equal(first.track.log[0].role, "Analista");

  // A mesma transferência não abre outro dossiê.
  const duplicate = await post({ action: "create", items: [data()] });
  assert.equal(duplicate.status, 409);
  assert.match(duplicate.body.error, new RegExp(`já está no DOS-${year}-0001`));

  // Lista: resumo sem lançamentos nem histórico.
  list = await get("/api/dossies");
  assert.equal(list.body.dossies.length, 2);
  assert.equal(list.body.dossies[0].number, `DOS-${year}-0002`);
  assert.equal(list.body.dossies[1].data, undefined);
  assert.equal(list.body.dossies[1].track.log, undefined);
  assert.equal(list.body.dossies[1].track.logCount, 1);

  // Alterar com revisão velha falha; com a certa grava e registra no histórico.
  const extra = movement("7000", "261", -8, -83.92, "", "4900800000", "1", "2026-10-01", "LINHA");
  const stale = await post({ action: "update", id: first.id, revision: 99, data: { deadline: "2026-10-10" } });
  assert.equal(stale.status, 409);
  let updated = await post({ action: "update", id: first.id, revision: first.revision, data: { deadline: "2026-10-10", movements: [...screen, extra] } });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  let dossie = updated.body.dossie;
  assert.equal(dossie.revision, 2);
  assert.equal(dossie.data.deadline, "2026-10-10");
  assert.equal(dossie.summary.idle, 160);
  assert.match(dossie.track.log.at(-1).text, /Alterado: lançamentos \(\+1\), prazo\./);
  const unchanged = await post({ action: "update", id: dossie.id, revision: dossie.revision, data: { deadline: "2026-10-10" } });
  assert.equal(unchanged.body.dossie.revision, 2, "sem mudança não gera revisão");

  // Cobrança, reforço, resposta, encerramento e reabertura.
  dossie = (await post({ action: "send", id: dossie.id, revision: dossie.revision })).body.dossie;
  assert.equal(dossie.status, "sent");
  assert.ok(dossie.track.sentAt);
  dossie = (await post({ action: "send", id: dossie.id, revision: dossie.revision })).body.dossie;
  assert.equal(dossie.track.reminders.length, 1);
  assert.match(dossie.track.log.at(-1).text, /2ª cobrança/);
  assert.equal((await post({ action: "answer", id: dossie.id, revision: dossie.revision, response: "" })).status, 400);
  dossie = (await post({ action: "answer", id: dossie.id, revision: dossie.revision, response: "Pedido da linha para o lote 12.", responseBy: "Fulano (WH)", respondedAt: "2026-10-07" })).body.dossie;
  assert.equal(dossie.status, "answered");
  assert.equal(dossie.track.respondedAt, "2026-10-07");
  assert.equal((await post({ action: "close", id: dossie.id, revision: dossie.revision, outcome: "x" })).status, 400);
  dossie = (await post({ action: "close", id: dossie.id, revision: dossie.revision, outcome: "returned", returnDocument: "4900900001", outcomeNote: "Voltou para o 2000." })).body.dossie;
  assert.equal(dossie.status, "closed");
  assert.match(dossie.track.log.at(-1).text, /Encerrado: Devolvido ao depósito de origem \(doc\. 4900900001\)/);
  assert.equal((await post({ action: "update", id: dossie.id, revision: dossie.revision, data: { notes: "x" } })).status, 409);
  assert.equal((await post({ action: "send", id: dossie.id, revision: dossie.revision })).status, 409);
  dossie = (await post({ action: "reopen", id: dossie.id, revision: dossie.revision })).body.dossie;
  assert.equal(dossie.status, "answered");
  assert.equal(dossie.track.closedAt, "");

  // Prints: só PNG/JPG, sem repetir; leitura devolve os mesmos bytes.
  assert.equal((await post({ action: "file", id: dossie.id, revision: dossie.revision, name: "x.png", data: Buffer.from("texto").toString("base64") })).status, 400);
  const withFile = await post({ action: "file", id: dossie.id, revision: dossie.revision, name: "MB51 tela.png", data: PNG.toString("base64") });
  assert.equal(withFile.status, 200, JSON.stringify(withFile.body));
  dossie = withFile.body.dossie;
  assert.equal(dossie.files.length, 1);
  assert.equal(dossie.files[0].type, "image/png");
  assert.equal((await post({ action: "file", id: dossie.id, revision: dossie.revision, name: "de novo.png", data: PNG.toString("base64") })).status, 409);
  const image = await get(`/api/dossies?file=${dossie.files[0].id}&dossie=${dossie.id}`, viewer);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get("content-type"), "image/png");
  assert.equal(image.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(Buffer.from(image.body), PNG);
  dossie = (await post({ action: "file-delete", id: dossie.id, revision: dossie.revision, fileId: dossie.files[0].id })).body.dossie;
  assert.equal(dossie.files.length, 0);
  assert.equal((await get(`/api/dossies?id=${dossie.id}`, viewer)).body.dossie.track.log.at(-1).text, "Print removido: MB51 tela.png.");

  // Apagar: analista não apaga dossiê já cobrado; administrador apaga. Número não volta.
  assert.equal((await post({ action: "delete", id: dossie.id, revision: dossie.revision }, analyst)).status, 403);
  const secondFull = (await get(`/api/dossies?id=${second.id}`)).body.dossie;
  assert.equal((await post({ action: "delete", id: second.id, revision: secondFull.revision }, analyst)).status, 200, "aberto e nunca cobrado: analista apaga");
  assert.equal((await post({ action: "delete", id: dossie.id, revision: dossie.revision }, admin)).status, 200);
  const again = await post({ action: "create", items: [data()] });
  assert.equal(again.status, 200);
  assert.equal(again.body.dossies[0].number, `DOS-${year}-0003`);

  // Dados grandes demais e limites de criação.
  const huge = Array.from({ length: 300 }, (_, i) => ({ ...screen[2], document: String(4910000000 + i), headerText: "x".repeat(120), itemText: "y".repeat(120), typeText: "z".repeat(60) }));
  const big = await post({ action: "create", items: [data({ material: "BIG-1", movements: [...huge.slice(0, 295), screen[2], screen[3]], questioned: ["4900337716/2026/31"] })] });
  assert.equal(big.status, 413, JSON.stringify(big.body));
  assert.match(big.body.error, /grande demais/);
  assert.equal((await post({ action: "create", items: Array.from({ length: 11 }, () => data()) })).status, 400);

  // Em quais BOMs o material aparece.
  await storage.ensureSchema(db);
  await storage.save(db, {
    id: "consumo:teste-dossie", name: "BC22X", revision: "OP 9", source: "teste", version: "new", ops: ["19000000001", "19000000002"],
    rows: [{ id: "1", material: MATERIAL, description: "Etiqueta", unit: "PCS", classification: "C", required: 2, consumption: { "19000000001": 0, "19000000002": 0 } }],
  });
  const lookup = await get(`/api/dossies?lookup=${encodeURIComponent(MATERIAL + ",NADA-1,<x>")}`, viewer);
  assert.equal(lookup.status, 200);
  assert.ok(lookup.body.checked >= 2);
  assert.deepEqual(lookup.body.materials[MATERIAL].map((use) => [use.name, use.kind, use.required, use.ops]), [["BC22X", "op", 2, 2]]);
  assert.equal(lookup.body.materials["NADA-1"], undefined);
}

test("API do dossiê no D1", async () => {
  const db = await mf.getD1Database("DB");
  await scenario(db);
});

test("API do dossiê no Turso (libSQL local)", async () => {
  const { createClient } = await import("@libsql/client");
  const client = createClient({ url: "file:" + temp + "/turso.sqlite" });
  try {
    await scenario(new TursoDatabase(client));
  } finally {
    client.close();
  }
});
