import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  SLOTS,
  emptyForm,
  emptyItem,
  financeRequired,
  formHistory,
  formTotal,
  itemTotal,
  parseBrNumber,
  pdfFileName,
  pdfProblems,
  sanitizeFormData,
  sanitizeSignatures,
  shareMessage,
  signatureProgress,
  statusFromSignatures,
  strongestClass,
  summarizeForms,
  type ScrapForm,
  type ScrapFormData,
  type ScrapSignature,
} from "../lib/scrap-form.ts";
import { buildScrapPdf, compareWithGenerated, pdfDate, readScrapPdf, slotFromPosition } from "../lib/scrap-pdf.ts";
import { checkCmsSignature, sha256Hex } from "../lib/pdf-signature.ts";

const fixture = (name: string) => new Uint8Array(readFileSync(new URL("./fixtures/scrap/" + name, import.meta.url)));

function complete(): ScrapFormData {
  const data = emptyForm();
  data.formDate = "2026-09-24";
  data.items = [
    { date: "2026-09-24", material: "11272431-00", quantity: 1, name: "UNID DE CONTROLE ELETR EBS 5S", defect: "Componente queimado no debug", cause: "F", vin: "1076", op: "19000002673", unitPrice: 1054.87, classification: "B" },
    { date: "2026-09-24", material: "17670117-00", quantity: 2, name: "CONTROL INTEGRADO SIC 6", defect: "Fuga de tensão", cause: "C", vin: "1076", op: "19000002673", unitPrice: 34471.26, classification: "A" },
  ];
  return data;
}
const signature = (slot: ScrapSignature["slot"], signer: string, extra: Partial<ScrapSignature> = {}): ScrapSignature => ({
  field: slot ? SLOTS.find((entry) => entry.id === slot)!.field : "Signature2",
  slot,
  signer,
  signedAt: "2026-09-25T10:00:00.000Z",
  check: "valid",
  coversWholeFile: false,
  detail: "",
  ...extra,
});

test("total por item e do formulário em centavos; números no formato brasileiro", () => {
  const data = complete();
  assert.equal(itemTotal(data.items[1]), 68942.52);
  assert.equal(formTotal(data), 69997.39);
  assert.equal(parseBrNumber("R$ 1.233,89"), 1233.89);
  assert.equal(parseBrNumber("1233.89"), 1233.89);
  assert.equal(parseBrNumber("34.471"), 34471);
  assert.equal(parseBrNumber(""), null);
});

test("novo item repete data, defeito, causa, VIN e OP do anterior", () => {
  const next = emptyItem(complete().items[0]);
  assert.equal(next.material, "");
  assert.equal(next.vin, "1076");
  assert.equal(next.op, "19000002673");
  assert.equal(next.cause, "F");
  assert.equal(next.quantity, 1);
});

test("a API limpa o formulário e recusa estrutura inválida", () => {
  const raw = complete() as any;
  raw.items[0].material = " 11272431-00 ";
  raw.items[0].cause = "z";
  raw.items[0].classification = "b";
  raw.items[0].unitPrice = "1.054,87";
  raw.items[0].defect = "linha\u0000com\ncontrole";
  const clean = sanitizeFormData(raw);
  assert.equal(clean.items[0].material, "11272431-00");
  assert.equal(clean.items[0].cause, "");
  assert.equal(clean.items[0].classification, "B");
  assert.equal(clean.items[0].unitPrice, 1054.87);
  assert.equal(clean.items[0].defect, "linha com controle");
  const purchase = sanitizeFormData({ ...complete(), pr: " 6000014878 ", prDate: "2026-05-12", po: "9900029259" });
  assert.deepEqual([purchase.pr, purchase.prDate, purchase.po], ["6000014878", "2026-05-12", "9900029259"]);
  assert.equal(sanitizeFormData({ ...complete(), prDate: "12/05/2026" }).prDate, "", "data fora do padrão é descartada");
  assert.throws(() => sanitizeFormData({ items: "x" }), /Formulário inválido/);
  assert.throws(() => sanitizeFormData({ ...complete(), items: Array.from({ length: 19 }, () => emptyItem()) }), /no máximo 18/);
  assert.throws(() => sanitizeFormData({ ...complete(), items: [{ ...complete().items[0], quantity: -1 }] }), /inválid/);
});

test("o PDF só sai com todos os campos de cada item preenchidos", () => {
  const data = complete();
  assert.deepEqual(pdfProblems(data), []);
  data.items[1].cause = "";
  data.items[1].vin = "";
  data.items[0].op = "OP-19";
  data.approvers.finance = "";
  const problems = pdfProblems(data);
  assert.match(problems.join("\n"), /Item 2: informe causa \(A–H\), N° VIN/);
  assert.match(problems.join("\n"), /Item 1: a ordem de produção deve ter só números/);
  assert.match(problems.join("\n"), /responsável: Financeiro/);
});

test("Financeiro só é exigido com item classe A ou B", () => {
  const data = complete();
  assert.equal(financeRequired(data), true);
  data.items.forEach((item) => (item.classification = "C"));
  assert.equal(financeRequired(data), false);
  const progress = signatureProgress(data, [signature("production", "A"), signature("quality", "B"), signature("logistics", "C", { coversWholeFile: true })]);
  assert.equal(progress.complete, true);
  assert.equal(pdfProblems({ ...data, approvers: { ...data.approvers, finance: "" } }).length, 0);
});

test("progresso das assinaturas: quem falta, assinatura inválida e mesma pessoa em dois quadros", () => {
  const data = complete();
  const partial = signatureProgress(data, [signature("production", "André"), signature("quality", "Marcus", { coversWholeFile: true })]);
  assert.equal(partial.complete, false);
  assert.deepEqual(
    partial.missing.map((entry) => entry.slot.id),
    ["logistics", "finance"],
  );
  assert.equal(statusFromSignatures(data, [signature("production", "André")]), "signing");
  const all = [signature("production", "André"), signature("quality", "Marcus"), signature("logistics", "matheus.silva2"), signature("finance", "Rosy", { coversWholeFile: true })];
  assert.equal(signatureProgress(data, all).complete, true);
  assert.equal(statusFromSignatures(data, all), "signed");
  const broken = signatureProgress(data, [...all.slice(0, 3), signature("finance", "Rosy", { check: "invalid", coversWholeFile: true })]);
  assert.equal(broken.complete, false);
  assert.match(broken.issues.join("\n"), /Rosy \(Financeiro\) não confere/);
  // Assinatura que não deu para conferir não preenche o quadro.
  const unchecked = signatureProgress(data, [...all.slice(0, 3), signature("finance", "Rosy", { check: "unchecked", coversWholeFile: true })]);
  assert.equal(unchecked.complete, false);
  assert.match(unchecked.issues.join("\n"), /Não foi possível conferir a assinatura de Rosy/);
  const self = signatureProgress(data, [...all.slice(0, 3), signature("finance", "Rosy", { selfSigned: true, coversWholeFile: true })]);
  assert.equal(self.complete, true);
  assert.match(self.issues.join("\n"), /ID digital próprio \(autoassinado\)/);
  const twice = signatureProgress(data, [signature("production", "André"), signature("quality", "André", { coversWholeFile: true })]);
  assert.match(twice.issues.join("\n"), /mesma pessoa \(andré\) assinou Produção e Qualidade/);
  const changed = signatureProgress(data, all.map((entry) => ({ ...entry, coversWholeFile: false })));
  assert.match(changed.issues.join("\n"), /alterações depois da última assinatura/);
});

test("nome do arquivo segue o padrão da equipe e a mensagem diz quem falta", () => {
  const data = complete();
  const form = { number: "SCRAP-2026-0007", data, status: "signing" as const, signatures: [signature("production", "André")] };
  assert.equal(pdfFileName(form), "Scrap Form SCRAP-2026-0007 24.09.2026 - falta assinar Marcus e Gleiber e Rosymara.pdf");
  assert.equal(pdfFileName({ ...form, status: "draft" }), "Scrap Form SCRAP-2026-0007 24.09.2026 - rascunho.pdf");
  assert.equal(pdfFileName({ ...form, signatures: [] }), "Scrap Form SCRAP-2026-0007 24.09.2026 - para assinatura.pdf");
  const message = shareMessage(form, "https://portal.test/?modulo=baixas");
  assert.match(message.subject, /para assinatura — Qualidade, Logística, Financeiro/);
  assert.match(message.body, /Falta: Marcus Gallo \(Qualidade\)/);
  assert.match(message.body, /11272431-00 — UNID DE CONTROLE ELETR EBS 5S · 1 un · R\$\s1\.054,87/);
  assert.match(message.body, /Total: R\$\s69\.997,39/);
  const done = { ...form, status: "signed" as const, signatures: SLOTS.map((slot) => signature(slot.id, slot.defaultName, { coversWholeFile: slot.id === "finance" })) };
  assert.equal(pdfFileName(done), "Scrap Form SCRAP-2026-0007 24.09.2026 - ASSINADO.pdf");
  assert.match(shareMessage(done).subject, /assinado/);
});

test("histórico sugere descrição, preço e VIN; classe mais alta entre BOMs", () => {
  const older = { data: complete(), updatedAt: "2026-09-01" };
  const newer = { data: { ...complete(), items: [{ ...complete().items[0], unitPrice: 1100 }] }, updatedAt: "2026-09-20" };
  const history = formHistory([newer, older]);
  assert.equal(history.materials.get("11272431-00")!.unitPrice, 1100);
  assert.equal(history.vinByOp.get("19000002673"), "1076");
  assert.equal(strongestClass(["C", "B"]), "B");
  assert.equal(strongestClass(["C", "A", "B"]), "A");
  assert.equal(strongestClass([]), "");
});

test("resumo: abertos, só falta Financeiro, assinados no mês", () => {
  const base = { id: "1", number: "SCRAP-2026-0001", data: complete(), files: [], fileVersion: 1, revision: 1, createdAt: "", updatedAt: "2026-09-25T10:00:00Z", createdBy: "admin", sentAt: null as string | null };
  const forms: ScrapForm[] = [
    { ...base, status: "signing", signatures: SLOTS.filter((slot) => slot.id !== "finance").map((slot) => signature(slot.id, slot.defaultName)), signedAt: null },
    { ...base, id: "2", status: "signed", signatures: [], signedAt: "2026-09-26T10:00:00Z" },
    { ...base, id: "3", status: "draft", signatures: [], signedAt: null },
  ];
  const summary = summarizeForms(forms, "2026-09");
  assert.deepEqual(summary, { open: 1, missingFinance: 1, signedThisMonth: 1, valueOpen: 69997.39, valueThisMonth: 69997.39 });
});

test("leitura das assinaturas vinda da tela é validada", () => {
  const clean = sanitizeSignatures([{ field: "Assinatura_Producao", slot: "production", signer: "André", signedAt: "2026-09-25T10:00:00Z", check: "valid", coversWholeFile: true, detail: "ok" }]);
  assert.equal(clean[0].slot, "production");
  const legacy = sanitizeSignatures([{ field: "x", slot: "boss", check: "intact" }])[0];
  assert.equal(legacy.slot, null);
  assert.equal(legacy.check, "unchecked", "intact nunca vale como conferida");
  assert.throws(() => sanitizeSignatures([{ check: "aprovado" }]), /inválida/);
  assert.throws(() => sanitizeSignatures("x"), /inválida/);
});

test("PDF gerado: uma página, número do formulário e um campo de assinatura vazio por quadro", async () => {
  const bytes = await buildScrapPdf({ number: "SCRAP-2026-0042", data: complete(), generatedAt: new Date("2026-09-24T12:00:00Z") });
  const text = new TextDecoder("latin1").decode(bytes.subarray(0, 8));
  assert.equal(text.slice(0, 5), "%PDF-");
  const reading = await readScrapPdf(bytes);
  assert.equal(reading.pages, 1);
  assert.equal(reading.formNumber, "SCRAP-2026-0042");
  assert.deepEqual(
    reading.fields.map((field) => [field.name, field.slot, field.signed]),
    [
      ["Assinatura_Producao", "production", false],
      ["Assinatura_Qualidade", "quality", false],
      ["Assinatura_Logistica", "logistics", false],
      ["Assinatura_Financeiro", "finance", false],
    ],
  );
  assert.deepEqual(reading.signatures, []);
  // Todos classe C: o quadro do Financeiro fica sem campo.
  const classC = complete();
  classC.items.forEach((item) => (item.classification = "C"));
  const withoutFinance = await readScrapPdf(await buildScrapPdf({ number: "SCRAP-2026-0043", data: classC }));
  assert.deepEqual(
    withoutFinance.fields.map((field) => field.slot),
    ["production", "quality", "logistics"],
  );
  // Texto fora do alfabeto do PDF não derruba a geração.
  const odd = complete();
  odd.items[0].defect = "Curto “elétrico” — 50% ✓ 中文";
  assert.ok((await buildScrapPdf({ number: "SCRAP-2026-0044", data: odd })).length > 1000);
});

test("PDF assinado no Adobe: assinaturas válidas, campo criado à parte vai pelo quadro, adulteração é detectada", async () => {
  const generated = fixture("gerado.pdf");
  const partial = fixture("assinado-parcial.pdf");
  const partialReading = await readScrapPdf(partial);
  assert.equal(partialReading.formNumber, "SCRAP-2026-0001");
  assert.deepEqual(
    partialReading.signatures.map((entry) => [entry.slot, entry.signer, entry.check]),
    [
      ["production", "Pessoa Produção", "valid"],
      ["quality", "Pessoa Qualidade", "valid"],
    ],
  );
  assert.equal(partialReading.signatures.at(-1)!.coversWholeFile, true);
  // As assinaturas entram como atualização incremental: o PDF gerado continua intacto no começo do arquivo.
  assert.equal(await sha256Hex(partial.subarray(0, generated.length)), await sha256Hex(generated));

  const complete4 = await readScrapPdf(fixture("assinado-completo.pdf"));
  const bySlot = Object.fromEntries(complete4.signatures.map((entry) => [entry.slot, entry]));
  assert.equal(bySlot.logistics.field, "Signature2", "campo desenhado à parte no quadro da Logística");
  assert.ok(complete4.signatures.every((entry) => entry.check === "valid"));
  const data = { ...emptyForm(), items: [{ ...emptyItem(), classification: "B" }] };
  assert.equal(signatureProgress(data, complete4.signatures).complete, true);

  const altered = await readScrapPdf(fixture("alterado.pdf"));
  assert.ok(altered.signatures.length === 4 && altered.signatures.every((entry) => entry.check === "invalid"));
  assert.equal(signatureProgress(data, altered.signatures).complete, false);
});

test("arquivo que não é PDF é recusado com mensagem clara", async () => {
  await assert.rejects(() => readScrapPdf(new TextEncoder().encode("planilha")), /não é um PDF/);
  await assert.rejects(() => readScrapPdf(new TextEncoder().encode("%PDF-1.7\nlixo")), /Não consegui abrir este PDF|não é um PDF/);
});

test("datas do PDF e posição dos quadros", () => {
  assert.equal(pdfDate("D:20260506150804-03'00'"), "2026-05-06T18:08:04.000Z");
  assert.equal(pdfDate("D:20260506150804Z"), "2026-05-06T15:08:04.000Z");
  const boxes = [
    { slot: "production" as const, x1: 108, y1: 95, x2: 266, y2: 137 },
    { slot: "logistics" as const, x1: 433, y1: 95, x2: 591, y2: 137 },
  ];
  assert.equal(slotFromPosition({ x: 150, y: 110, page: 0 }, boxes), "production");
  assert.equal(slotFromPosition({ x: 500, y: 120, page: 0 }, boxes), "logistics");
  assert.equal(slotFromPosition({ x: 500, y: 555, page: 0 }, boxes), null, "mesma coluna, mas no cabeçalho");
  assert.equal(slotFromPosition({ x: 500, y: 120, page: 1 }, boxes), null, "outra página");
});

const attack = (name: string) => fixture("ataques/" + name);
const classB = () => ({ ...emptyForm(), items: [{ ...emptyItem(), classification: "B" }] });

test("assinatura forjada, sem certificado ou fora do padrão nunca conta como assinada", async () => {
  for (const name of ["forged-garbage-sig.pdf", "forged-no-cert.pdf", "ber-indef-attrs-garbage.pdf"]) {
    const reading = await readScrapPdf(attack(name));
    const quality = reading.signatures.find((entry) => entry.slot === "quality")!;
    assert.notEqual(quality.check, "valid", name);
    assert.equal(signatureProgress(classB(), reading.signatures).signed.some((entry) => entry.slot.id === "quality"), false, name);
  }
  // Estrutura DER malformada termina na hora (não trava a aba).
  const started = Date.now();
  assert.equal((await checkCmsSignature(new Uint8Array([0x30, 0x80, 0x04, 0x82]), new Uint8Array([1]))).check, "unchecked");
  assert.ok(Date.now() - started < 1000);
});

test("uma assinatura reaproveitada em outro quadro é recusada", async () => {
  const reading = await readScrapPdf(attack("reuse.pdf"));
  const finance = reading.signatures.find((entry) => entry.slot === "finance")!;
  assert.equal(finance.check, "invalid");
  assert.match(finance.detail, /mesma assinatura do campo Assinatura_Producao/);
});

test("campo desenhado fora dos quadros não vale; nome vem do certificado; RSA-PSS e certificado por SKI conferem", async () => {
  assert.equal((await readScrapPdf(attack("adhoc-header.pdf"))).signatures[0].slot, null);
  const spoof = (await readScrapPdf(attack("name-spoof.pdf"))).signatures[0];
  assert.equal(spoof.signer, "pessoa.estagiaria");
  assert.match(spoof.detail, /Nome informado no Adobe: "Pessoa Financeiro"/);
  assert.equal((await readScrapPdf(attack("pss.pdf"))).signatures[0].check, "valid");
  const ski = (await readScrapPdf(attack("ski-ca-first.pdf"))).signatures[0];
  assert.equal(ski.check, "valid");
  assert.equal(ski.signer, "Pessoa Qualidade");
  assert.equal(ski.issuer, "CA de Teste");
  assert.equal(ski.selfSigned, false);
});

test("o PDF devolvido precisa mostrar a mesma página emitida pelo portal", async () => {
  const generated = fixture("gerado.pdf");
  const same = await compareWithGenerated(generated, fixture("assinado-completo.pdf"));
  assert.deepEqual(same, { sameContent: true, pages: 1, originalPages: 1, extraAnnotations: [], notes: [] });
  // Valor alterado entre as assinaturas: cada assinatura confere, mas a página não é a emitida.
  const between = await compareWithGenerated(generated, attack("isa-between.pdf"));
  assert.equal(between.sameContent, false);
  // Outro formulário (outros itens) também não passa.
  const other = await buildScrapPdf({ number: "SCRAP-2026-0001", data: { ...complete() }, generatedAt: new Date("2026-09-24T12:00:00Z") });
  assert.equal((await compareWithGenerated(generated, other)).sameContent, false);
});
