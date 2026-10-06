import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PDFDocument, PDFName, PDFString } from "pdf-lib";
import { pageText } from "../lib/pdf-text.ts";
import { dateOrder, fileDate, legacyMoney, legacyQuantity, parseLegacyCc, parseLegacyScrap, readLegacyPdf } from "../lib/legacy-import.ts";
import { legacySlots, readScrapPdf, compareWithGenerated } from "../lib/scrap-pdf.ts";
import { acceptOriginal, importedMatch, keepOriginal, pdfProblems, signatureProgress } from "../lib/scrap-form.ts";
import { ccProblems } from "../lib/cc-form.ts";

// PDFs de teste no formato dos formulários antigos (planilha → PDF), com nomes fictícios.
const fixture = (name: string) => new Uint8Array(readFileSync(new URL("./fixtures/legado/" + name, import.meta.url)));
const load = (bytes: Uint8Array) => PDFDocument.load(bytes, { updateMetadata: false });

test("números e datas como o Excel grava", () => {
  assert.equal(legacyMoney("R$1,233.89"), 1233.89);
  assert.equal(legacyMoney("R$ 4.403,48"), 4403.48);
  assert.equal(legacyMoney("-R$ 27,220.48"), -27220.48);
  assert.equal(legacyMoney("R$ 0,00"), 0);
  assert.equal(legacyMoney("R$"), null);
  assert.equal(legacyQuantity("-5386"), -5386);
  assert.equal(legacyQuantity("1.000"), 1000);
  assert.equal(legacyQuantity("1,5"), 1.5);
  assert.equal(legacyQuantity("abc"), null);
  assert.equal(fileDate("Formulario de SCRAP A-B 05.05.2026 Falta assinar rosy2.pdf"), "2026-05-05");
  assert.equal(fileDate("sem data.pdf"), "");
  assert.equal(dateOrder(["16/04/2026"]), "dmy", "Dia acima de 12");
  assert.equal(dateOrder(["5/15/2026"]), "mdy", "Mês/dia do Excel em inglês");
  assert.equal(dateOrder(["5/6/2026"], "2026-05-05"), "mdy", "Ambígua: vale a mais perto da data do arquivo");
  assert.equal(dateOrder(["5/6/2026"], "2026-06-04"), "dmy");
});

test("texto da página: fonte Type0 Identity-H com ToUnicode, larguras, TJ e matrizes", async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 300]);
  const cmap =
    "/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /T def 1 begincodespacerange <0000> <FFFF> endcodespacerange " +
    "2 beginbfchar <0027> <0044> <0024> <0041> endbfchar 1 beginbfrange <0030> <0032> <0031> endbfrange endcmap end end";
  const cid = doc.context.obj({
    Type: "Font",
    Subtype: "CIDFontType2",
    BaseFont: "Teste",
    CIDSystemInfo: { Registry: PDFString.of("Adobe"), Ordering: PDFString.of("Identity"), Supplement: 0 },
    DW: 500,
    W: [0x27, [700], 0x30, 0x32, 600],
  });
  const font = doc.context.obj({ Type: "Font", Subtype: "Type0", BaseFont: "Teste", Encoding: "Identity-H", DescendantFonts: [doc.context.register(cid)], ToUnicode: doc.context.register(doc.context.flateStream(cmap)) });
  page.node.setFontDictionary(PDFName.of("F1"), doc.context.register(font));
  const content = "q 1 0 0 1 10 20 cm BT /F1 10 Tf 1 0 0 1 30 200 Tm [<0027>-100<0024>]TJ 0 -20 Td <003000310032> Tj ET Q BT /F1 10 Tf 0 1 -1 0 300 50 Tm (x) Tj ET";
  page.node.set(PDFName.of("Contents"), doc.context.register(doc.context.flateStream(content)));
  const text = pageText(await load(await doc.save()));
  const [first, second] = text.runs;
  assert.deepEqual([first.text, first.x, first.y, first.width, first.size], ["DA", 40, 220, 13, 10]);
  assert.deepEqual([second.text, second.x, second.y, second.width], ["123", 40, 200, 18]);
  assert.equal(text.runs.length, 2, "Código sem tradução no ToUnicode não vira texto");
});

test("Scrap Form antigo: itens, causa, classe, preço, data e responsáveis pela posição das colunas", async () => {
  const doc = await load(fixture("legado-scrap.pdf"));
  const { data, notes } = parseLegacyScrap(pageText(doc), "Formulario de SCRAP A-B 22.09.2026 Falta assinar Rosy.pdf");
  assert.deepEqual(notes, []);
  assert.equal(data.formDate, "2026-09-22");
  assert.deepEqual(data.items, [
    { date: "2026-09-22", material: "11272431-00", quantity: 2, name: "UNID DE CONTROLE ELETR EBS 5S", defect: "Apresentou fuga de tensão durante a depuração", cause: "A", vin: "901", op: "19000002701", unitPrice: 1233.89, classification: "B" },
    { date: "2026-09-22", material: "17120732-00", quantity: 1, name: "CONTROL DE GERENCIAMENTO DE BATERIA", defect: "Não passa corrente do chicote para o modulo", cause: "C", vin: "901", op: "19000002701", unitPrice: 1000.19, classification: "B" },
  ]);
  assert.deepEqual(data.approvers, { production: "Pessoa Producao", quality: "Pessoa Qualidade", logistics: "Pessoa Logistica", finance: "Pessoa Financeiro" });
  assert.deepEqual(pdfProblems(data), [], "Pronto para o portal");
});

test("FO.FI.C.007 antigo: mês, itens com sinal, REMARKS e nomes do quadro", async () => {
  const doc = await load(fixture("legado-cc-assinado.pdf"));
  const { data, notes } = parseLegacyCc(pageText(doc), "Ajuste Inventario Agosto 2026.pdf");
  assert.deepEqual(notes, []);
  assert.equal(data.period, "2026-08");
  assert.deepEqual(
    data.items.map((item) => [item.material, item.quantity, item.unitCost, item.costCenter, item.costCenterDescription]),
    [
      ["11272431-00", -2, 1233.89, "BR000411", "Operational - Chassis"],
      ["17120732-00", 5, 1000.19, "BR000411", "Operational - Chassis"],
    ],
  );
  assert.equal(data.mainReason, "Differences found in the monthly count.");
  assert.equal(data.reason, "Inventory difference");
  assert.equal(data.action, "Adjust SAP stock through cost center BR000411.");
  assert.deepEqual(data.approvers, { requester: "Pessoa Solicitante", manager: "Pessoa Gestor", scm: "Pessoa SCM", finance: "Pessoa Financeiro" });
  assert.deepEqual(ccProblems(data), []);
});

test("tipo pelo texto; PDF sem texto vai pelo nome do arquivo e avisa", async () => {
  assert.equal((await readLegacyPdf(fixture("legado-scrap.pdf"), "qualquer.pdf")).kind, "scrap");
  assert.equal((await readLegacyPdf(fixture("legado-cc-assinado.pdf"), "qualquer.pdf")).kind, "cc");
  const blank = await PDFDocument.create();
  blank.addPage([600, 400]);
  const bytes = await blank.save();
  const scanned = await readLegacyPdf(bytes, "Formulario_de_SCRAP_AB 07.05.2026 FALTA ASSINAR.pdf");
  assert.equal(scanned.kind, "scrap");
  assert.equal(scanned.hasText, false);
  assert.match(scanned.notes.join(" "), /sem texto/);
  assert.equal(scanned.kind === "scrap" && scanned.data.formDate, "2026-05-07");
  const unknown = await readLegacyPdf(bytes, "documento.pdf");
  assert.equal(unknown.kind, null);
  assert.equal((await readLegacyPdf(bytes, "documento.pdf", "cc")).kind, "cc", "Tipo escolhido na tela");
});

test("assinaturas de PDF antigo valem pela posição na linha (Scrap) ou na coluna (FO.FI.C.007)", async () => {
  const scrap = await readScrapPdf(fixture("legado-scrap-assinado.pdf"), { legacy: true, kind: "scrap" });
  assert.equal(scrap.formNumber, null);
  assert.deepEqual(
    scrap.signatures.map((entry) => [entry.field, entry.slot, entry.signer, entry.check]),
    [
      ["Signature3", "production", "Pessoa Producao", "valid"],
      ["Signature4", "quality", "Pessoa Qualidade", "valid"],
      ["Signature2", "logistics", "Pessoa Logistica", "valid"],
    ],
  );
  assert.ok(scrap.fields.some((field) => field.name === "Assinatura_Financeiro" && field.slot === "finance" && !field.signed));
  const plain = await readScrapPdf(fixture("legado-scrap-assinado.pdf"));
  assert.ok(plain.signatures.every((entry) => entry.slot === null), "Sem a opção, campo criado à parte não vale");
  const complete = await readScrapPdf(fixture("legado-scrap-completo.pdf"), { legacy: true, kind: "scrap" });
  const data = { approvers: { production: "Pessoa Producao", quality: "Pessoa Qualidade", logistics: "Pessoa Logistica", finance: "Pessoa Financeiro" }, items: [{ classification: "B" }] };
  assert.equal(signatureProgress(data, scrap.signatures, "scrap").complete, false);
  assert.equal(signatureProgress(data, complete.signatures, "scrap").complete, true);
  assert.equal((await compareWithGenerated(fixture("legado-scrap-assinado.pdf"), fixture("legado-scrap-completo.pdf"))).sameContent, true, "Assinar não muda a página");
  const cc = await readScrapPdf(fixture("legado-cc-assinado.pdf"), { legacy: true, kind: "cc" });
  assert.deepEqual(
    cc.signatures.map((entry) => [entry.slot, entry.signer]),
    [
      ["requester", "Pessoa Solicitante"],
      ["manager", "Pessoa Gestor"],
    ],
  );
  const guessed = await readScrapPdf(fixture("legado-cc-assinado.pdf"), { legacy: true });
  assert.deepEqual(guessed.signatures.map((entry) => entry.slot), ["requester", "manager"], "Sem o tipo: colunas na vertical = FO.FI.C.007");
});

test("posição dos campos: referência pelo nome do portal, fora da página ou da linha não vale", () => {
  const box = { x: 0, y: 0, width: 800, height: 600 };
  const at = (x: number, y: number, slot: any = null) => ({ slot, center: { x, y, page: 0 } });
  // Logística já tem o campo do portal: os outros dois ficam em Produção e Qualidade.
  assert.deepEqual(legacySlots([at(100, 150), at(250, 150), at(420, 150, "logistics"), at(640, 150, "finance")], box, "scrap"), ["production", "quality", "logistics", "finance"]);
  // Qualidade com nome do portal no meio: o campo à direita dele é Logística.
  assert.deepEqual(legacySlots([at(70, 150), at(160, 150, "quality"), at(250, 150), at(380, 150, "finance")], box, "scrap"), ["production", "quality", "logistics", "finance"]);
  // Campo desenhado no cabeçalho (fora da linha) e fora da página não valem; quinto campo sobra.
  assert.deepEqual(legacySlots([at(100, 150), at(470, 560), at(200, 152), at(300, 148), at(400, 150), at(500, 151), at(100, -90)], box, "scrap"), ["production", null, "quality", "logistics", "finance", null, null]);
  // FO.FI.C.007: de cima para baixo.
  assert.deepEqual(legacySlots([at(600, 300), at(600, 400), at(602, 200)], box, "cc"), ["manager", "requester", "scm"]);
  assert.deepEqual(legacySlots([{ slot: null, center: null }], box, "scrap"), [null]);
});

test("PDF antigo regravado: quem assinou conta como assinado, sem aviso de arquivo alterado", async () => {
  const data = { approvers: { production: "Pessoa Producao", quality: "Pessoa Qualidade", logistics: "Pessoa Logistica", finance: "Pessoa Financeiro" }, items: [{ classification: "B" }] };
  const rewritten = await readScrapPdf(fixture("legado-scrap-regravado.pdf"), { legacy: true, kind: "scrap" });
  assert.deepEqual(
    rewritten.signatures.map((entry) => [entry.slot, entry.signer, entry.check]),
    [
      ["production", "Pessoa Producao", "invalid"],
      ["quality", "Pessoa Qualidade", "invalid"],
      ["logistics", "Pessoa Logistica", "invalid"],
    ],
    "O nome vem do certificado mesmo com o arquivo regravado",
  );
  const imported = acceptOriginal(rewritten.signatures);
  const progress = signatureProgress(data, imported, "scrap");
  assert.deepEqual(progress.missing.map((entry) => entry.slot.id), ["finance"]);
  assert.deepEqual(progress.issues, [], "Nada de regravado, autoassinado ou alterado depois");
  // A Rosy assina depois: as assinaturas da importação continuam; a nova é conferida.
  const later = [...rewritten.signatures, { ...rewritten.signatures[0], field: "Assinatura_Financeiro", slot: "finance" as const, signer: "Pessoa Financeiro", check: "valid" as const, signedAt: "2026-10-06T12:00:00.000Z", coversWholeFile: true }];
  const kept = keepOriginal(later, imported);
  assert.deepEqual(kept.map((entry) => entry.check), ["imported", "imported", "imported", "valid"]);
  assert.equal(signatureProgress(data, kept, "scrap").complete, true);
  const bad = keepOriginal([{ ...later[3], check: "invalid" }], imported);
  assert.equal(bad[0].check, "invalid", "Assinatura nova inválida não vira importada");
  assert.equal(importedMatch(kept, imported), true);
  assert.equal(importedMatch([{ ...later[3], check: "imported" }], imported), false, "Só as que vieram na importação");
});
