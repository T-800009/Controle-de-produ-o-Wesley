// Aba DOSSIÊ montada no jsdom contra o Worker de verdade (rotas /api/dossies num
// D1 local do Miniflare). Planilha, Google e SAP são simulados; nada de produção.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const { JSDOM } = require("jsdom");
const React = require("react");
const { act } = React;
const rootDir = path.resolve(__dirname, "..");
const req = createRequire(rootDir + "/package.json");
const wr = req.resolve("wrangler");
const { build } = require(require.resolve("esbuild", { paths: [wr] }));
const { Miniflare } = require(require.resolve("miniflare", { paths: [wr] }));
const temp = fs.mkdtempSync(path.join(rootDir, ".dossie-ui-"));
let Portal, ErrorBoundary, createRoot, handler, mf;

before(async () => {
  await build({
    entryPoints: [rootDir + "/app/portal.tsx", rootDir + "/app/error-boundary.tsx"],
    bundle: true,
    platform: "node",
    format: "cjs",
    outdir: temp,
    outExtension: { ".js": ".cjs" },
    tsconfig: rootDir + "/tsconfig.json",
    jsx: "automatic",
    loader: { ".css": "empty" },
    logLevel: "error",
    external: ["react", "react-dom", "radix-ui", "sonner", "lucide-react", "xlsx", "clsx", "tailwind-merge", "class-variance-authority"],
  });
  await build({ entryPoints: [rootDir + "/worker/index.ts"], bundle: true, platform: "node", format: "cjs", outfile: temp + "/worker.cjs", logLevel: "error" });
  handler = require(temp + "/worker.cjs").default;
  ErrorBoundary = require(temp + "/error-boundary.cjs").default;
  mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("test")}}', d1Databases: ["DB"], compatibilityDate: "2026-05-15" });
});
after(async () => {
  await mf?.dispose();
  fs.rmSync(temp, { recursive: true, force: true });
});

const MB51 = [
  ["Material", "Texto breve material", "Depósito", "Tipo de movimento", "UMP", "Quantidade", "Montante em MI", "Moeda", "Texto cabeçalho documento", "Doc.material", "Item", "Data de lançamento", "Hora de entrada", "Nome do usuário"],
  ["19376997-00", "TKC-3921853_IDENTIFICACAO DA BATERIA", "00ZT", "311", "", "62-", "0.00", "BRL", "00ZT X 2000 ESTOQUE", "4900785063", "1", "2026.09.30", "10:02:11", "WHUSER2"],
  ["19376997-00", "TKC-3921853_IDENTIFICACAO DA BATERIA", "2000", "311", "", "62", "0.00", "BRL", "00ZT X 2000 ESTOQUE", "4900785063", "2", "2026.09.30", "10:02:11", "WHUSER2"],
  ["19376997-00", "TKC-3921853_IDENTIFICACAO DA BATERIA", "2000", "311", "", "168-", "0.00", "BRL", "", "4900337716", "31", "2026.03.12", "14:22:40", "WHUSER1"],
  ["19376997-00", "TKC-3921853_IDENTIFICACAO DA BATERIA", "7000", "311", "", "168", "0.00", "BRL", "", "4900337716", "32", "2026.03.12", "14:22:40", "WHUSER1"],
  ["19376997-00", "TKC-3921853_IDENTIFICACAO DA BATERIA", "00ZT", "311", "", "168-", "0.00", "BRL", "Transferencia zt p/ 2000", "4900306959", "3", "2026.02.27", "09:15:00", "WHUSER1"],
  ["19376997-00", "TKC-3921853_IDENTIFICACAO DA BATERIA", "2000", "311", "", "168", "0.00", "BRL", "Transferencia zt p/ 2000", "4900306959", "4", "2026.02.27", "09:15:00", "WHUSER1"],
  ["19376997-00", "TKC-3921853_IDENTIFICACAO DA BATERIA", "00ZT", "862", "PCS", "150-", "1,573.49-", "BRL", "", "4900304284", "9", "2026.02.20", "16:40:03", "MMUSER"],
  ["19376997-00", "TKC-3921853_IDENTIFICACAO DA BATERIA", "00ZT", "561", "", "380", "3,986.18", "BRL", "", "4900023756", "8", "2025.11.10", "08:00:00", "MMUSER"],
  // Outro material da mesma extração, sem transferência para o 7000.
  ["55500011-00", "PARAFUSO M8", "2000", "261", "", "4-", "0.40-", "BRL", "", "4900999001", "1", "2026.09.01", "07:00:00", "LINHA"],
]
  .map((row) => row.join("\t"))
  .join("\n");

function gviz(headers, rows) {
  return new Response(
    "google.visualization.Query.setResponse(" +
      JSON.stringify({ status: "ok", table: { cols: headers.map((label) => ({ label })), rows: rows.map((values) => ({ c: values.map((v) => ({ v })) })) } }) +
      ");",
    { headers: { "X-Source-Format": "gviz", "X-Source-Read-At": "2026-10-06T17:00:00Z", "Content-Type": "application/javascript" } },
  );
}

async function mount(t, { url = "https://portal.test/?modulo=dossie", viewer = false } = {}) {
  const db = await mf.getD1Database("DB");
  const env = { DB: db, ASSETS: { fetch: async () => new Response("") }, REQUIRE_PASSWORD: "false" };
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url, pretendToBeVisual: true });
  const win = dom.window,
    previous = new Map();
  function install(key, value) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  for (const key of [
    "window", "document", "navigator", "location", "history", "Document", "Element", "Node", "NodeFilter", "DocumentFragment", "MutationObserver",
    "CustomEvent", "Event", "MouseEvent", "KeyboardEvent", "FocusEvent", "HTMLTextAreaElement", "HTMLInputElement", "HTMLSelectElement",
    ...Object.getOwnPropertyNames(win).filter((key) => /^(HTML|SVG).*Element$/.test(key)),
  ])
    install(key, key === "window" ? win : win[key]);
  install("getComputedStyle", win.getComputedStyle.bind(win));
  install("requestAnimationFrame", win.requestAnimationFrame.bind(win));
  install("cancelAnimationFrame", win.cancelAnimationFrame.bind(win));
  install("IS_REACT_ACT_ENVIRONMENT", true);
  win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  win.scrollTo = () => {};
  const copied = [];
  Object.defineProperty(win.navigator, "clipboard", { value: { writeText: async (text) => void copied.push(text) }, configurable: true });
  const downloads = [];
  install("URL", Object.assign(class extends URL {}, { createObjectURL: (blob) => (downloads.push(blob), "blob:teste"), revokeObjectURL() {} }));
  win.HTMLAnchorElement.prototype.click = function () {};
  if (!Portal) {
    createRoot = require("react-dom/client").createRoot;
    Portal = require(temp + "/portal.cjs").default;
  }
  const requests = [],
    errors = [];
  install("fetch", async (input, init = {}) => {
    const parsed = new URL(String(input), url);
    requests.push((init.method || "GET") + " " + parsed.pathname + parsed.search);
    if (parsed.pathname === "/api/session") return Response.json({ role: viewer ? "viewer" : "admin" });
    if (parsed.pathname === "/api/data" && !parsed.searchParams.get("id")) return Response.json([]);
    if (parsed.pathname === "/api/data")
      return Response.json({ id: parsed.searchParams.get("id"), name: "Depósito " + parsed.searchParams.get("id"), revision: "", source: "teste", version: "test", rows: [] });
    if (parsed.pathname === "/api/automatic") {
      const depot = parsed.searchParams.get("id");
      return gviz(["Material", "Texto breve material", "UM básica", "Centro", "Utilização livre", "Val.utiliz.livre"], depot === "7000" ? [["19376997-00", "TKC", "PCS", "BR02", 168, 1762.32]] : [["OUTRO-1", "X", "PCS", "BR02", 1, 1]]);
    }
    if (parsed.pathname === "/api/dossies") {
      const request = new Request(parsed.href, { method: init.method || "GET", headers: { ...(init.headers || {}), Origin: "https://portal.test" }, body: init.body });
      const response = await handler.fetch(request, env);
      if (!viewer || !response.headers.get("content-type")?.includes("json")) return response;
      const body = await response.json();
      return Response.json({ ...body, canEdit: false, canDelete: false, role: "viewer" }, { status: response.status });
    }
    throw Error("Request inesperado: " + parsed.href);
  });
  t.mock.method(console, "error", (...args) => errors.push(args.map(String).join(" ")));
  const container = win.document.getElementById("root"),
    root = createRoot(container);
  t.after(async () => {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  await act(async () => root.render(React.createElement(ErrorBoundary, null, React.createElement(Portal))));
  async function settle(predicate = () => true, what = "") {
    for (let i = 0; i < 200; i++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
      if (predicate()) return;
    }
    assert.fail(`A interface não chegou ao estado esperado ${what}: ` + win.document.body.textContent.slice(0, 900) + "\n" + errors.join("\n"));
  }
  const find = (selector, label) =>
    [...win.document.querySelectorAll(selector)].find((node) => (label instanceof RegExp ? label.test(node.textContent.trim()) : label ? node.textContent.trim() === label : true));
  async function click(selector, label) {
    const button = find(selector, label);
    assert.ok(button, `Botão ausente: ${selector} ${label || ""}`);
    assert.equal(button.disabled, false, `Botão desabilitado: ${selector} ${label || ""}`);
    await act(async () => {
      button.dispatchEvent(new win.MouseEvent("click", { bubbles: true, button: 0 }));
    });
    await settle();
  }
  async function type(selector, value) {
    const element = win.document.querySelector(selector);
    assert.ok(element, "Campo ausente: " + selector);
    const proto = element.tagName === "SELECT" ? win.HTMLSelectElement.prototype : element.tagName === "TEXTAREA" ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
    await act(async () => {
      Object.getOwnPropertyDescriptor(proto, "value").set.call(element, value);
      element.dispatchEvent(new win.Event(element.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
    });
  }
  function assertHealthy() {
    assert.equal(container.querySelector(".app-recovery"), null, "A interface caiu no tratamento de erro");
    assert.equal(errors.filter((message) => /TypeError|ReferenceError|Falha ao exibir|not wrapped in act|unique "key"/.test(message)).length, 0, errors.join("\n"));
  }
  return { win, container, requests, errors, copied, downloads, settle, click, type, find, assertHealthy, db };
}

test("aba DOSSIÊ: colar a MB51, abrir, cobrar, responder e encerrar", async (t) => {
  const ui = await mount(t);
  await ui.settle(() => ui.container.textContent.includes("Nenhum dossiê ainda"), "(lista vazia)");
  assert.equal(ui.container.querySelector("h1").textContent, "DOSSIÊ WAREHOUSE");
  assert.equal(ui.container.querySelector(".main-nav [data-state=active]").textContent, "DOSSIÊ");
  assert.equal(ui.container.querySelector(".context-bar"), null, "sem seletor de BOM nesta aba");

  await ui.click("button", "Novo dossiê (colar MB51)");
  await ui.settle(() => ui.win.document.querySelector(".dossie-dialog"));
  await ui.type('textarea[aria-label="Linhas da MB51"]', MB51);
  await ui.click(".dossie-dialog button", "Ler MB51");
  await ui.settle(() => ui.win.document.querySelectorAll(".dossie-candidate").length === 2, "(prévia)");
  const [first, second] = ui.win.document.querySelectorAll(".dossie-candidate");
  assert.match(first.textContent, /19376997-00/);
  assert.match(first.textContent, /2000 → 7000 · 168 PCS/);
  assert.match(first.textContent, /doc\. 4900337716 \(itens 31\/32\) · 12\/03\/2026 · WHUSER1 · sem consumo depois/);
  assert.match(first.textContent, /168 PCS parado\(s\)/);
  assert.match(first.textContent, /R\$\s?1\.762,31/);
  assert.equal(first.querySelector("input").checked, true);
  assert.match(second.textContent, /Nenhuma transferência para o 7000/);
  assert.equal(second.querySelector("input").disabled, true);
  await ui.click(".dossie-dialog button", "Abrir dossiê");
  await ui.settle(() => ui.container.querySelector(".dossie-detail") && ui.container.textContent.includes("BOM(s) do portal conferida"), "(detalhe aberto)");

  const year = new Intl.DateTimeFormat("en-US", { timeZone: "America/Sao_Paulo", year: "numeric" }).format(new Date());
  const number = `DOS-${year}-0001`;
  const detail = ui.container.querySelector(".dossie-detail");
  assert.match(detail.querySelector(".dossie-head").textContent, new RegExp(number));
  assert.match(ui.win.location.search, new RegExp("dossie=" + number));
  assert.match(detail.querySelector(".dossie-route").textContent, /2000→7000168 PCS/);
  const findings = detail.querySelector(".dossie-findings").textContent;
  assert.match(findings, /não tem texto de cabeçalho/);
  assert.match(findings, /Nenhum consumo \(261\) deste material no 7000/);
  assert.match(findings, /não consta em nenhuma das 1 BOM/);
  assert.match(detail.querySelector(".dossie-letter").textContent, /Prazo para resposta: \d{2}\/\d{2}\/\d{4}\./);
  assert.equal(detail.querySelectorAll(".dossie-movements tbody tr").length, 8);
  assert.equal(detail.querySelectorAll(".dossie-movements tbody tr.questioned").length, 2);

  // Copiar a cobrança
  await ui.click(".dossie-actions button", "Copiar cobrança");
  assert.match(ui.copied.at(-1), /^\[DOS-\d{4}-0001\] Transferência 2000 → 7000 sem justificativa/);
  assert.match(ui.copied.at(-1), /doc\. 4900337716 \(itens 31\/32\) · TMv 311 · 2000 → 7000 · 168 PCS/);

  // Saldo atual da planilha: 7000 e 2000, guardado no dossiê; o preço passa a ser o do estoque.
  await ui.click(".dossie-detail button", "Conferir saldo atual na planilha");
  await ui.settle(() => ui.container.textContent.includes("Saldo atual guardado") || /Saldo na planilha/.test(ui.container.querySelector(".dossie-findings").textContent), "(saldo)");
  assert.ok(ui.requests.some((r) => r === "GET /api/automatic?id=7000"));
  assert.ok(ui.requests.some((r) => r === "GET /api/automatic?id=2000"));
  assert.match(ui.container.querySelector(".dossie-findings").textContent, /Saldo na planilha \(\d{2}\/\d{2}\/\d{4}\): 7000 168 PCS · 2000 sem saldo/);
  assert.match(ui.container.querySelector(".dossie-price").textContent, /valor do estoque 7000 na planilha/);

  // PDF
  await ui.click(".dossie-actions button", "Baixar PDF");
  await ui.settle(() => ui.downloads.length === 1, "(PDF)");
  const pdf = Buffer.from(await ui.downloads[0].arrayBuffer());
  assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
  const { PDFDocument } = require("pdf-lib");
  const loaded = await PDFDocument.load(pdf);
  assert.ok(loaded.getPageCount() >= 2);
  assert.match(loaded.getTitle(), new RegExp(number + " · 19376997-00"));

  // Marcar como cobrado → Cobrado; o próximo texto já é um reforço.
  await ui.click(".dossie-actions button", "Marcar como cobrado");
  await ui.settle(() => /Cobrado/.test(ui.container.querySelector(".dossie-head-status").textContent), "(cobrado)");
  assert.ok(ui.find(".dossie-actions button", "Registrar nova cobrança"));
  assert.match(ui.container.querySelector(".dossie-letter").textContent, /Reforçando a cobrança enviada em \d{2}\/\d{2}\/\d{4} \(2ª cobrança\)/);

  // Lista em andamento: resumo para o Warehouse e planilha.
  await ui.click(".dossie-back", "Todos os dossiês");
  await ui.settle(() => ui.container.querySelectorAll(".dossie-row").length === 1, "(lista em andamento)");
  assert.match(ui.container.querySelector(".dossie-row").textContent, /1ª cobrança em \d{2}\/\d{2}\/\d{4} · prazo/);
  await ui.click("button", "Copiar resumo");
  assert.match(ui.copied.at(-1), /^Dossiês com o Warehouse em andamento \(1\):/);
  assert.match(ui.copied.at(-1), new RegExp(`• ${number} · 19376997-00 TKC-3921853_IDENTIFICACAO DA BATERIA · doc\\. 4900337716 2000 → 7000 em 12\\/03\\/2026 · parado 168 PCS`));
  assert.match(ui.copied.at(-1), /Valor parado somado: R\$\s?1\.762,32\./);
  const xlsx = require("xlsx");
  const exported = [];
  t.mock.method(xlsx, "writeFile", (book, name) => exported.push({ book, name }));
  await ui.click("button", "Baixar planilha");
  await ui.settle(() => exported.length === 1, "(planilha)");
  assert.match(exported[0].name, /^dossie-warehouse-\d{4}-\d{2}-\d{2}\.xlsx$/);
  const sheet = xlsx.utils.sheet_to_json(exported[0].book.Sheets["Dossiês"], { header: 1, defval: "" });
  assert.deepEqual(sheet[3].slice(0, 4), ["Dossiê", "Situação", "Material", "Descrição"]);
  assert.deepEqual(sheet[4].slice(0, 7), [number, "Cobrado", "19376997-00", "TKC-3921853_IDENTIFICACAO DA BATERIA", "4900337716 (31/32)", "2000", "7000"]);
  assert.equal(sheet[4][10], 168);
  assert.equal(sheet[4][13], 1762.32);
  await ui.click(".dossie-row");
  await ui.settle(() => ui.container.querySelector(".dossie-detail .dossie-findings"), "(detalhe de novo)");

  // Resposta e encerramento
  await ui.type('textarea[aria-label="Resposta do Warehouse"]', "Transferido por engano. Vamos devolver ao 2000.");
  await ui.type('input[aria-label="Quem respondeu"]', "Equipe WH");
  await ui.click(".dossie-detail button", "Registrar resposta");
  await ui.settle(() => /Respondido/.test(ui.container.querySelector(".dossie-head-status").textContent), "(respondido)");
  await ui.type('select[aria-label="Como foi resolvido"]', "returned");
  await ui.type('input[aria-label="Documento SAP"]', "4900901234");
  await ui.click(".dossie-detail button", "Encerrar dossiê");
  await ui.settle(() => /Encerrado/.test(ui.container.querySelector(".dossie-head-status").textContent), "(encerrado)");
  assert.match(ui.container.textContent, /Devolvido ao depósito de origem · doc\. 4900901234/);
  const log = ui.container.querySelector(".dossie-log").textContent;
  for (const text of ["Dossiê aberto com 8 lançamento", "Alterado: saldo atual da planilha", "Cobrança enviada ao Warehouse", "Resposta do Warehouse registrada (Equipe WH)", "Encerrado: Devolvido ao depósito de origem"])
    assert.ok(log.includes(text), "histórico: " + text + "\n" + log);
  assert.ok(ui.find(".dossie-actions button", "Reabrir"));

  // Volta para a lista: encerrado sai do filtro "Em andamento" e aparece em "Todos".
  await ui.click(".dossie-back", "Todos os dossiês");
  await ui.settle(() => ui.container.textContent.includes("Nenhum dossiê em andamento"), "(filtro em andamento)");
  assert.match(ui.container.textContent, /1 dossiê\(s\) encerrado\(s\)/);
  await ui.type('select[aria-label="Situação do dossiê"]', "all");
  await ui.settle(() => ui.container.querySelectorAll(".dossie-row").length === 1);
  const row = ui.container.querySelector(".dossie-row");
  assert.match(row.textContent, /Encerrado/);
  assert.match(row.textContent, /2000 → 7000 · doc\. 4900337716 · 12\/03\/2026 · WHUSER1/);
  assert.match(row.textContent, /168 PCS/);

  // Importar de novo a mesma MB51: a transferência já está no dossiê.
  await ui.click("button", "Novo dossiê (colar MB51)");
  await ui.settle(() => ui.win.document.querySelector(".dossie-dialog"));
  await ui.type('textarea[aria-label="Linhas da MB51"]', MB51);
  await ui.click(".dossie-dialog button", "Ler MB51");
  await ui.settle(() => ui.win.document.querySelectorAll(".dossie-candidate").length === 2);
  assert.match(ui.win.document.querySelector(".dossie-candidate").textContent, new RegExp("Já está no " + number));
  assert.equal(ui.find(".dossie-dialog button", "Abrir dossiê").disabled, true);
  await ui.click(".dossie-dialog button", "Cancelar");
  await ui.settle(() => !ui.win.document.querySelector(".dossie-dialog"));
  ui.assertHealthy();
});

test("perfil Consulta vê o dossiê sem botões de alteração", async (t) => {
  const ui = await mount(t, { viewer: true });
  await ui.settle(() => ui.container.textContent.includes("dossiê(s)"), "(lista)");
  assert.equal(ui.find("button", "Novo dossiê (colar MB51)"), undefined);
  await ui.type('select[aria-label="Situação do dossiê"]', "all");
  await ui.settle(() => ui.container.querySelectorAll(".dossie-row").length >= 1);
  await ui.click(".dossie-row");
  await ui.settle(() => ui.container.querySelector(".dossie-detail .dossie-findings"));
  assert.ok(ui.find(".dossie-actions button", "Copiar cobrança"));
  assert.ok(ui.find(".dossie-actions button", "Baixar PDF"));
  for (const label of ["Marcar como cobrado", "Registrar nova cobrança", "Reabrir", "Apagar"]) assert.equal(ui.find(".dossie-actions button", label), undefined, label);
  assert.equal(ui.container.querySelector('textarea[aria-label="Resposta do Warehouse"]'), null);
  ui.assertHealthy();
});
