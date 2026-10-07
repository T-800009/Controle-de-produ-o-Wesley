import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CC_SLOTS, SLOTS, parseBrNumber, signatureProgress, statusFromSignatures, type ScrapForm, type ScrapSignature } from "../lib/scrap-form.ts";
import {
  CC_DEFAULTS,
  MAX_CC_ITEMS,
  ccFileName,
  ccFromScrapForms,
  ccFromSpreadsheet,
  ccItemTotal,
  ccLayout,
  ccProblems,
  ccTotals,
  emptyCcForm,
  emptyCcItem,
  periodLabel,
  sanitizeCcData,
  sheetNumber,
  summarizeCcForms,
  type CcForm,
  type CcFormData,
} from "../lib/cc-form.ts";
import { CC_PAGE, buildCcPdf, compareWithGenerated, readScrapPdf } from "../lib/scrap-pdf.ts";
import { pageText } from "../lib/pdf-text.ts";
import * as XLSX from "xlsx";

const fixture = (name: string) => new Uint8Array(readFileSync(new URL("./fixtures/cc/" + name, import.meta.url)));
const approvers = { requester: "Pessoa Solicitante", manager: "Pessoa Gestor", scm: "Pessoa SCM", finance: "Pessoa Financeiro" };
const item = {
  company: "BR00",
  plant: "BR02",
  wh: "7000",
  material: "11272431-00",
  description: "UNID DE CONTROLE ELETR EBS 5S",
  quantity: -1,
  unitCost: 1054.87,
  costCenter: "BR000411",
  costCenterDescription: "Operational - Chassis",
};
// Mesmos dados do PDF em tests/fixtures/cc (gerado.pdf e as versões assinadas com pyHanko).
const data: CcFormData = {
  period: "2026-09",
  items: [item],
  mainReason: "Scrapped materials approved in Scrap Form SCRAP-2026-0001. Parts damaged or defective in production, not repairable.",
  reason: "Scrap",
  action: "Write off the scrapped quantities from warehouse 7000 through cost center BR000411 - Operational - Chassis.",
  approvers,
  scrapForms: ["SCRAP-2026-0001"],
  sapDocument: "",
  notes: "",
};
const sig = (slot: ScrapSignature["slot"], field: string, signer: string, check: ScrapSignature["check"] = "valid"): ScrapSignature => ({
  field,
  slot,
  signer,
  signedAt: "2026-09-25T10:00:00.000Z",
  check,
  coversWholeFile: false,
  detail: "",
});
const all = [
  sig("requester", "Assinatura_Solicitante", "Pessoa Solicitante"),
  sig("manager", "Assinatura_Gestor", "Pessoa Gestor"),
  sig("scm", "Assinatura_SCM", "Pessoa SCM"),
  sig("finance", "Assinatura_Financeiro", "Pessoa Financeiro"),
];
const ccForm = (patch: Partial<CcForm> = {}): CcForm => ({
  id: "7a2c1b4d-0000-4000-8000-000000000001",
  number: "CC-2026-0001",
  status: "signing",
  data,
  signatures: [],
  fileVersion: 1,
  files: [],
  revision: 2,
  createdAt: "2026-09-24T12:00:00Z",
  updatedAt: "2026-09-24T12:00:00Z",
  createdBy: "admin",
  signedAt: null,
  sentAt: null,
  ...patch,
});

test("FO.FI.C.007: quatro quadros obrigatórios com nomes de campo próprios", () => {
  assert.deepEqual(
    CC_SLOTS.map((slot) => [slot.id, slot.field, slot.role]),
    [
      ["requester", "Assinatura_Solicitante", "Requester"],
      ["manager", "Assinatura_Gestor", "Direct Manager"],
      ["scm", "Assinatura_SCM", "SCM Manager"],
      ["finance", "Assinatura_Financeiro", "Finance Department"],
    ],
  );
  const fresh = emptyCcForm(null, { costCenter: "BR000999" });
  assert.match(fresh.period, /^\d{4}-\d{2}$/);
  assert.deepEqual(Object.keys(fresh.approvers), ["requester", "manager", "scm", "finance"]);
  assert.equal(fresh.items[0].costCenter, "BR000999");
  assert.equal(fresh.items[0].wh, CC_DEFAULTS.wh);
  assert.equal(emptyCcItem({}, { ...item, company: "BR01" }).company, "BR01", "Novo item repete o anterior");
  assert.equal(periodLabel("2026-06"), "Junho/2026");
  assert.equal(periodLabel("2026-13"), "");
});

test("a API limpa a baixa: quantidade negativa = saída, custo nunca negativo, limites", () => {
  const clean = sanitizeCcData({
    ...data,
    period: "junho",
    items: [{ ...item, company: " br00 ", material: " 11272431-00 ", quantity: "-1.000", unitCost: "1.054,87" }],
    approvers: { ...approvers, production: "intruso" },
    scrapForms: ["SCRAP-2026-0001", "SCRAP-2026-0001", "lixo", 7],
  });
  assert.match(clean.period, /^\d{4}-\d{2}$/, "Mês inválido vira o mês atual");
  assert.equal(clean.items[0].company, "BR00");
  assert.equal(clean.items[0].material, "11272431-00");
  assert.equal(clean.items[0].quantity, -1000);
  assert.equal(clean.items[0].unitCost, 1054.87);
  assert.deepEqual(Object.keys(clean.approvers), ["requester", "manager", "scm", "finance"]);
  assert.deepEqual(clean.scrapForms, ["SCRAP-2026-0001"]);
  assert.throws(() => sanitizeCcData({ ...data, items: [{ ...item, unitCost: -1 }] }), /inválido/);
  assert.throws(() => sanitizeCcData({ ...data, items: [{ ...item, quantity: 1e9 }] }), /inválido/);
  assert.throws(() => sanitizeCcData({ ...data, items: Array(MAX_CC_ITEMS + 1).fill(item) }), /no máximo 300/);
  assert.throws(() => sanitizeCcData({ items: "x" }), /inválido/);
  assert.equal(parseBrNumber("-1.000"), -1000);
  assert.equal(parseBrNumber("-2,5"), -2.5);
});

test("totais com sinal e o que falta para gerar o PDF", () => {
  assert.equal(ccItemTotal(item), -1054.87);
  const totals = ccTotals({ items: [item, { ...item, quantity: 3, unitCost: 10.005 }] });
  assert.deepEqual(totals, { quantity: 2, cost: -1024.85 });
  assert.deepEqual(ccProblems(data), []);
  const problems = ccProblems({ ...data, items: [{ ...item, quantity: 0, unitCost: null, costCenter: "" }], reason: "", approvers: { ...approvers, scm: "" } });
  assert.match(problems[0], /Item 1: informe quantidade \(negativa para baixa\), custo unitário, centro de custo/);
  assert.ok(problems.includes("Informe o motivo resumido (REASON)."));
  assert.ok(problems.includes("Informe o nome do responsável: SCM."));
});

test("itens dos Scrap Forms assinados: saída do estoque pelo custo do formulário", () => {
  const scrap = {
    number: "SCRAP-2026-0007",
    data: { items: [{ material: "11272431-00", name: "UNID DE CONTROLE", quantity: 2, unitPrice: 1054.87 }, { material: "17670117-00", name: "SENSOR", quantity: null, unitPrice: null }] },
  } as unknown as ScrapForm;
  const result = ccFromScrapForms([scrap], { costCenter: "BR000777", costCenterDescription: "", wh: "" });
  assert.deepEqual(result.scrapForms, ["SCRAP-2026-0007"]);
  assert.equal(result.items[0].quantity, -2);
  assert.equal(result.items[0].unitCost, 1054.87);
  assert.equal(result.items[0].costCenter, "BR000777");
  assert.equal(result.items[0].costCenterDescription, CC_DEFAULTS.costCenterDescription, "Padrão vazio não apaga o padrão");
  assert.equal(result.items[0].wh, "7000");
  assert.equal(result.items[1].quantity, null);
  assert.equal(result.reason, "Scrap");
  assert.match(result.mainReason, /Scrap Form SCRAP-2026-0007/);
  assert.match(result.action, /warehouse 7000 through cost center BR000777/);
});

test("assinaturas: só os quatro quadros do FO.FI.C.007 contam; quadro do Scrap Form não", () => {
  const partial = signatureProgress(data, all.slice(0, 3), "cc");
  assert.deepEqual(partial.missing.map((entry) => entry.slot.id), ["finance"]);
  assert.equal(statusFromSignatures(data, all.slice(0, 3), "cc"), "signing");
  assert.equal(statusFromSignatures(data, all, "cc"), "signed");
  const foreign = signatureProgress(data, [...all.slice(0, 3), sig("production", "Assinatura_Producao", "Pessoa Produção")], "cc");
  assert.equal(foreign.complete, false);
  assert.ok(foreign.issues.some((issue) => /não é deste formulário/.test(issue)));
  const invalid = signatureProgress(data, [...all.slice(0, 3), sig("finance", "Assinatura_Financeiro", "Pessoa Financeiro", "invalid")], "cc");
  assert.equal(invalid.complete, false, "Assinatura inválida nunca fecha");
  const twice = signatureProgress(data, [...all.slice(0, 3), sig("finance", "Assinatura_Financeiro", "Pessoa SCM")], "cc");
  assert.ok(twice.issues.includes("A mesma pessoa (pessoa scm) assinou SCM e Financeiro. Confira se está certo."));
  // E o contrário: quadro do FO.FI.C.007 num Scrap Form não conta.
  const scrapData = { approvers: Object.fromEntries(SLOTS.map((slot) => [slot.id, slot.defaultName])), items: [{ classification: "B" }] };
  assert.equal(signatureProgress(scrapData, all, "scrap").complete, false);
});

test("nome do arquivo e resumo da lista", () => {
  assert.equal(ccFileName(ccForm({ status: "draft" })), "FO.FI.C.007 CC-2026-0001 Setembro-2026 - rascunho.pdf");
  assert.equal(ccFileName(ccForm()), "FO.FI.C.007 CC-2026-0001 Setembro-2026 - para assinatura.pdf");
  assert.equal(ccFileName(ccForm({ signatures: all.slice(0, 2) })), "FO.FI.C.007 CC-2026-0001 Setembro-2026 - falta assinar Pessoa e Pessoa.pdf");
  assert.equal(ccFileName(ccForm({ status: "signed", signatures: all })), "FO.FI.C.007 CC-2026-0001 Setembro-2026 - ASSINADO.pdf");
  const summary = summarizeCcForms([ccForm(), ccForm({ status: "signed" }), ccForm({ status: "draft" })]);
  assert.deepEqual(summary, { open: 1, signed: 1, drafts: 1, valueOpen: -1054.87 });
});

test("PDF do FO.FI.C.007: A3 paisagem, uma página, número e quatro campos de assinatura vazios", async () => {
  const bytes = await buildCcPdf({ number: "CC-2026-0001", data, generatedAt: new Date("2026-09-24T12:00:00-03:00") });
  assert.ok(bytes.length < 300_000, "Bem abaixo do limite do servidor para o PDF emitido");
  const text = new TextDecoder("latin1").decode(bytes);
  assert.ok(text.includes("(CC-2026-0001)"), "Número em texto simples (conferido pelo servidor)");
  const { PDFDocument } = await import("pdf-lib");
  const doc = await PDFDocument.load(bytes);
  assert.equal(doc.getPageCount(), 1);
  assert.deepEqual(doc.getPage(0).getSize(), { width: CC_PAGE.width, height: CC_PAGE.height });
  const reading = await readScrapPdf(bytes);
  assert.equal(reading.formNumber, "CC-2026-0001");
  assert.deepEqual(
    reading.fields.map((field) => [field.name, field.slot, field.signed]),
    [
      ["Assinatura_Solicitante", "requester", false],
      ["Assinatura_Gestor", "manager", false],
      ["Assinatura_SCM", "scm", false],
      ["Assinatura_Financeiro", "finance", false],
    ],
  );
  assert.deepEqual(reading.signatures, []);
  await assert.rejects(buildCcPdf({ number: "CC-2026-0002", data: { ...data, items: Array(MAX_CC_ITEMS + 1).fill(item) } }), /no máximo 300/);
});

test("PDF devolvido com as quatro assinaturas (pyHanko): confere e mostra a mesma página emitida", async () => {
  const generated = fixture("gerado.pdf");
  for (const [name, count] of [
    ["assinado-parcial.pdf", 2],
    ["assinado-completo.pdf", 4],
  ] as const) {
    const signed = fixture(name);
    const reading = await readScrapPdf(signed);
    assert.equal(reading.formNumber, "CC-2026-0001");
    assert.equal(reading.signatures.length, count, name);
    assert.ok(reading.signatures.every((entry) => entry.check === "valid"), name);
    assert.deepEqual(
      reading.signatures.map((entry) => [entry.slot, entry.signer]),
      Object.entries(approvers).slice(0, count),
    );
    const comparison = await compareWithGenerated(generated, signed);
    assert.equal(comparison.sameContent, true, name);
    assert.deepEqual(comparison.extraAnnotations, []);
  }
  const complete = await readScrapPdf(fixture("assinado-completo.pdf"));
  assert.equal(signatureProgress(data, complete.signatures, "cc").complete, true);
  // Outro conteúdo (quantidade diferente) não passa como o mesmo formulário.
  const other = await buildCcPdf({ number: "CC-2026-0001", data: { ...data, items: [{ ...item, quantity: -2 }] }, generatedAt: new Date("2026-09-24T12:00:00-03:00") });
  assert.equal((await compareWithGenerated(generated, other)).sameContent, false);
});

// Mesmo formato da "LOSS 7000.xlsx" (exportada da MB52): estoque livre e valor total.
const LOSS_HEADER = ["Material", "Texto breve material", "Centro", "Depósito", "UM básica", "Utilização livre", "Val.utiliz.livre", "Comentários"];
const lossRows = (): unknown[][] => [
  LOSS_HEADER,
  ["10000001-00", "PARAFUSO SEXTAVADO M8", "BR02", "7000", "PC", 12, 30.36, "LOSS"],
  ["10000002-00", "ARRUELA LISA 8MM", "BR02", "7000", "PC", 3, 1, "LOSS"],
  [null, null, null, null, null, null, null, null],
  ["10000003-00", "CHICOTE TRASEIRO", "BR02", "7000", "PC", 0, 0, "LOSS"],
  ["10000004-00", "SUPORTE DO PARACHOQUE", "BR02", "7000", "KG", "1.234,5", "R$ 2.469,00", "LOSS"],
  [null, null, null, null, null, 1249.5, 2500.36, null],
];

test("planilha: números do Excel em texto ou número", () => {
  assert.equal(sheetNumber(12), 12);
  assert.equal(sheetNumber("R$ 1.471,23"), 1471.23);
  assert.equal(sheetNumber("1,471.23"), 1471.23);
  assert.equal(sheetNumber("10-"), -10, "Sinal no fim, como o SAP exporta");
  assert.equal(sheetNumber("(5,5)"), -5.5);
  assert.equal(sheetNumber("1.234.567"), 1234567);
  assert.equal(sheetNumber("2,5"), 2.5);
  assert.equal(sheetNumber(""), null);
  assert.equal(sheetNumber("PC"), null);
  assert.equal(sheetNumber(Number.NaN), null);
});

test("planilha LOSS 7000 → itens da baixa: estoque vira saída, custo = valor ÷ quantidade", () => {
  const result = ccFromSpreadsheet(lossRows(), { costCenter: "BR000411", costCenterDescription: "Operational - Chassis" });
  assert.equal(result.items.length, 3, "Linha vazia, estoque zero e linha de total ficam de fora");
  assert.equal(result.skipped, 2, "Estoque zero e total contam como ignoradas; a linha vazia não");
  assert.deepEqual(result.items[0], {
    company: "BR00",
    plant: "BR02",
    wh: "7000",
    material: "10000001-00",
    description: "PARAFUSO SEXTAVADO M8",
    quantity: -12,
    unitCost: 2.53,
    costCenter: "BR000411",
    costCenterDescription: "Operational - Chassis",
  });
  // 1 ÷ 3 não fecha com 2 casas: o custo unitário leva as casas necessárias para o total bater.
  assert.equal(ccItemTotal(result.items[1]), -1);
  assert.equal(result.items[2].quantity, -1234.5);
  assert.equal(result.items[2].unitCost, 2);
  assert.equal(ccTotals(result).cost, -2500.36, "Total igual ao da planilha");
  assert.equal(result.reason, "LOSS");
  assert.equal(result.mainReason, "Materials listed as LOSS in warehouse 7000.");
  assert.equal(result.action, "Write off the quantities from warehouse 7000 through cost center BR000411 - Operational - Chassis.");
  // Passa pela limpeza da API como qualquer baixa.
  assert.equal(sanitizeCcData({ ...data, items: result.items }).items.length, 3);
});

test("planilha: cabeçalho fora da 1ª linha, coluna Quantidade com sinal e erros claros", () => {
  const rows = [["Relatório de perdas"], [], ["Código", "Descrição", "Qtd", "Custo unitário", "Centro de custo", "Motivo"], ["10000009-00", "TAMPA", -2, "10,50", "BR000999", "Avaria"], ["10000010-00", "BUCHA", 1, 4, "", "Sobra"]];
  const result = ccFromSpreadsheet(rows);
  assert.deepEqual(
    result.items.map((entry) => [entry.material, entry.quantity, entry.unitCost, entry.costCenter, entry.wh]),
    [
      ["10000009-00", -2, 10.5, "BR000999", "7000"],
      ["10000010-00", 1, 4, "BR000411", "7000"],
    ],
  );
  assert.equal(result.reason, "", "Motivos diferentes: o texto fica para preencher");
  assert.throws(() => ccFromSpreadsheet([["A", "B"], [1, 2]]), /coluna Material/);
  assert.throws(() => ccFromSpreadsheet([["Material", "Descrição"], ["1", "x"]]), /coluna de quantidade/);
  assert.throws(() => ccFromSpreadsheet([["Material", "Utilização livre"], ["1", 2]]), /custo/);
});

test("planilha de verdade (.xlsx feito pelo SheetJS) lida como no portal", () => {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(lossRows()), "Sheet1");
  const bytes = XLSX.write(book, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
  const read = XLSX.read(bytes, { type: "array", dense: true });
  const rows = XLSX.utils.sheet_to_json(read.Sheets[read.SheetNames[0]], { header: 1, raw: true, defval: null }) as unknown[][];
  const result = ccFromSpreadsheet(rows);
  assert.equal(result.items.length, 3);
  assert.equal(ccTotals(result).cost, -2500.36);
});

test("PDF com muitos itens: 40 por página e as assinaturas embaixo do último item", async () => {
  const { PDFDocument } = await import("pdf-lib");
  const generatedAt = new Date("2026-09-24T12:00:00-03:00");
  const items = Array.from({ length: 75 }, (_, index) => ({ ...item, material: `1000${String(index + 1).padStart(4, "0")}-00`, quantity: -(index + 1), unitCost: 1.2345 }));
  const texts = (doc: Awaited<ReturnType<typeof PDFDocument.load>>) => doc.getPages().map((_, index) => pageText(doc, index).runs.map((run) => run.text).join(" | "));
  const annots = (doc: Awaited<ReturnType<typeof PDFDocument.load>>) => doc.getPages().map((page) => page.node.Annots()?.size() ?? 0);
  assert.deepEqual(ccLayout(20), { chunks: [20], approvalPage: 0, pages: 1 });
  assert.deepEqual(ccLayout(57), { chunks: [40, 17], approvalPage: 1, pages: 2 });
  assert.deepEqual(ccLayout(75), { chunks: [40, 35], approvalPage: 2, pages: 3 });

  // 57 itens (como a LOSS 7000): 40 + 17, TOTAL e assinaturas na página 2.
  const data57 = { ...data, items: items.slice(0, 57) };
  const bytes57 = await buildCcPdf({ number: "CC-2026-0003", data: data57, generatedAt });
  const doc57 = await PDFDocument.load(bytes57);
  assert.equal(doc57.getPageCount(), 2);
  const [first, second] = texts(doc57);
  assert.match(first, /Itens 1 a 40 de 57/);
  assert.match(first, /Continua na página 2/);
  assert.match(first, /10000040-00/);
  assert.doesNotMatch(first, /APPROVAL|TOTAL \(/, "Página 1 só com itens");
  assert.match(first, /Página 1\/2/);
  assert.doesNotMatch(first + second, /Nº CC-/, "Sem o número em vermelho no cabeçalho");
  assert.match(second, /Continuação · itens 41 a 57 de 57/);
  assert.match(second, /TOTAL \(57 itens\)/);
  assert.match(second, /APPROVAL/);
  assert.match(second, /Página 2\/2/);
  assert.match(first, /R\$ 1,2345/, "Custo unitário com 4 casas");
  assert.deepEqual(annots(doc57), [0, 4], "Os quatro campos de assinatura na página 2");
  const reading = await readScrapPdf(bytes57);
  assert.equal(reading.formNumber, "CC-2026-0003", "Número continua no PDF (Info e rodapé)");
  assert.deepEqual(reading.fields.map((field) => field.slot), ["requester", "manager", "scm", "finance"]);
  assert.match(new TextDecoder("latin1").decode(bytes57), /WBYDSignatureBoxes \(requester:[\d.,]+@1;/, "Quadros gravados com a página");

  // 75 itens: 40 + 35 não deixa espaço; as assinaturas ganham a página 3.
  const bytes = await buildCcPdf({ number: "CC-2026-0003", data: { ...data, items }, generatedAt });
  const doc = await PDFDocument.load(bytes);
  const pages = texts(doc);
  assert.equal(pages.length, 3);
  assert.match(pages[1], /TOTAL \(75 itens\)/);
  assert.doesNotMatch(pages[1], /APPROVAL/);
  assert.match(pages[2], /Aprovação · 75 itens nas páginas anteriores/);
  assert.match(pages[2], /APPROVAL/);
  assert.deepEqual(annots(doc), [0, 0, 4]);

  // 22 itens: página única, tudo junto.
  const single = await PDFDocument.load(await buildCcPdf({ number: "CC-2026-0003", data: { ...data, items: items.slice(0, 22) }, generatedAt }));
  assert.equal(single.getPageCount(), 1);
  assert.match(texts(single)[0], /TOTAL \(22 itens\).*APPROVAL/s);

  // Item trocado só na última página: não é o mesmo formulário.
  const same = await buildCcPdf({ number: "CC-2026-0003", data: { ...data, items }, generatedAt });
  assert.equal((await compareWithGenerated(bytes, same)).sameContent, true);
  const changed = await buildCcPdf({ number: "CC-2026-0003", data: { ...data, items: items.map((entry, index) => (index === 74 ? { ...entry, quantity: -1 } : entry)) }, generatedAt });
  const comparison = await compareWithGenerated(bytes, changed);
  assert.equal(comparison.sameContent, false);
  assert.equal(comparison.originalPages, 3);
  // Limite máximo cabe no que o servidor guarda.
  const full = await buildCcPdf({ number: "CC-2026-0004", data: { ...data, items: Array.from({ length: MAX_CC_ITEMS }, (_, index) => ({ ...items[index % items.length] })) }, generatedAt });
  assert.equal((await PDFDocument.load(full)).getPageCount(), 8, "7 × 40 + 20 com as assinaturas");
  assert.ok(full.length < 400_000, `PDF de ${MAX_CC_ITEMS} itens com ${full.length} bytes`);
});
