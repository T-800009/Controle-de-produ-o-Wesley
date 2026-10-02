import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CC_SLOTS, SLOTS, parseBrNumber, signatureProgress, statusFromSignatures, type ScrapForm, type ScrapSignature } from "../lib/scrap-form.ts";
import {
  CC_DEFAULTS,
  MAX_CC_ITEMS,
  ccFileName,
  ccFromScrapForms,
  ccItemTotal,
  ccProblems,
  ccShareMessage,
  ccTotals,
  emptyCcForm,
  emptyCcItem,
  periodLabel,
  sanitizeCcData,
  summarizeCcForms,
  type CcForm,
  type CcFormData,
} from "../lib/cc-form.ts";
import { CC_PAGE, buildCcPdf, compareWithGenerated, readScrapPdf } from "../lib/scrap-pdf.ts";

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
  assert.throws(() => sanitizeCcData({ ...data, items: Array(MAX_CC_ITEMS + 1).fill(item) }), /no máximo 20/);
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

test("nome do arquivo, mensagem e resumo da lista", () => {
  assert.equal(ccFileName(ccForm({ status: "draft" })), "FO.FI.C.007 CC-2026-0001 Setembro-2026 - rascunho.pdf");
  assert.equal(ccFileName(ccForm()), "FO.FI.C.007 CC-2026-0001 Setembro-2026 - para assinatura.pdf");
  assert.equal(ccFileName(ccForm({ signatures: all.slice(0, 2) })), "FO.FI.C.007 CC-2026-0001 Setembro-2026 - falta assinar Pessoa e Pessoa.pdf");
  assert.equal(ccFileName(ccForm({ status: "signed", signatures: all })), "FO.FI.C.007 CC-2026-0001 Setembro-2026 - ASSINADO.pdf");
  const open = ccShareMessage(ccForm({ signatures: all.slice(0, 3) }), "https://portal.test/?modulo=baixas&cc=x");
  assert.equal(open.subject, "FO.FI.C.007 CC-2026-0001 (Setembro/2026) para assinatura — Financeiro");
  assert.match(open.body, /Falta: Pessoa Financeiro \(Financeiro\)/);
  assert.match(open.body, /11272431-00 — UNID DE CONTROLE ELETR EBS 5S · -1 · -R\$\s1\.054,87 · CC BR000411/);
  assert.match(open.body, /Origem: SCRAP-2026-0001\./);
  assert.match(open.body, /https:\/\/portal\.test\/\?modulo=baixas&cc=x$/);
  const done = ccShareMessage(ccForm({ status: "signed", signatures: all }));
  assert.match(done.subject, /assinado — -R\$\s1\.054,87$/);
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
  await assert.rejects(buildCcPdf({ number: "CC-2026-0002", data: { ...data, items: Array(MAX_CC_ITEMS + 1).fill(item) } }), /no máximo 20/);
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
