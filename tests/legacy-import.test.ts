import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PDFDocument, PDFName, PDFString } from "pdf-lib";
import { pageText } from "../lib/pdf-text.ts";
import { dateOrder, fileDate, legacyMoney, legacyQuantity, parseLegacyCc, parseLegacyScrap, readLegacyPdf } from "../lib/legacy-import.ts";
import { DATA_KEY, buildCcPdf, buildScrapPdf, legacySlots, readScrapPdf, compareWithGenerated } from "../lib/scrap-pdf.ts";
import { acceptOriginal, importedMatch, keepOriginal, pdfProblems, signatureProgress } from "../lib/scrap-form.ts";
import { ccProblems, ccTotals } from "../lib/cc-form.ts";

// PDFs de teste no formato dos formulários antigos (planilha → PDF), com nomes fictícios.
const fixture = (name: string) => new Uint8Array(readFileSync(new URL("./fixtures/legado/" + name, import.meta.url)));
const load = (bytes: Uint8Array) => PDFDocument.load(bytes, { updateMetadata: false });

test("números e datas como o Excel grava", () => {
  assert.equal(legacyMoney("R$1,233.89"), 1233.89);
  assert.equal(legacyMoney("R$ 4.403,48"), 4403.48);
  assert.equal(legacyMoney("-R$ 27,220.48"), -27220.48);
  assert.equal(legacyMoney("R$ 0,00"), 0);
  assert.equal(legacyMoney("R$"), null);
  // Custo unitário do portal com mais casas.
  assert.equal(legacyMoney("R$ 5,083"), 5.083);
  assert.equal(legacyMoney("R$ 12,7354"), 12.7354);
  assert.equal(legacyMoney("R$ 1.471,23"), 1471.23);
  assert.equal(legacyMoney("-R$ 8.206,68"), -8206.68);
  assert.equal(legacyMoney("R$ 1.234.567,89"), 1234567.89);
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
  // FO.FI.C.007 longo: os campos estão na última página.
  const onPage = (x: number, y: number, page: number) => ({ slot: null, center: { x, y, page } });
  assert.deepEqual(legacySlots([onPage(600, 400, 1), onPage(600, 300, 1)], box, "cc", 1), ["requester", "manager"]);
  assert.deepEqual(legacySlots([onPage(600, 400, 1)], box, "cc"), [null], "Sem dizer a página, vale a primeira");
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

// FO.FI.C.007 já emitido pelo portal (com qualquer número de páginas) volta com os mesmos dados.
const ccApprovers = { requester: "Pessoa Solicitante", manager: "Pessoa Gestor", scm: "Pessoa SCM", finance: "Pessoa Financeiro" };
const longItems = Array.from({ length: 75 }, (_, index) => ({
  company: "BR00",
  plant: "BR02",
  wh: "7000",
  material: `3${String(1000000 + index * 7919).slice(0, 7)}-00`,
  description: index % 7 === 3 ? `CONJUNTO COM DESCRICAO LONGA QUE QUEBRA EM DUAS LINHAS NA CELULA DO FORMULARIO DO PORTAL ${index + 1}` : `PECA DE TESTE ${index + 1}`,
  quantity: -((index * 37) % 400 + 1),
  unitCost: Math.round((0.9 + index * 2.3417) * 10000) / 10000,
  costCenter: "BR000411",
  costCenterDescription: "Operational - Chassis",
}));
const longData = {
  period: "2026-10",
  items: longItems,
  mainReason: "Materials listed as LOSS in warehouse 7000.",
  reason: "LOSS",
  action: "Write off the quantities from warehouse 7000 through cost center BR000411 - Operational - Chassis.",
  approvers: ccApprovers,
  scrapForms: [],
  sapDocument: "",
  notes: "",
};

test("FO.FI.C.007 do portal: dados gravados no PDF voltam exatos; sem eles, a leitura passa por todas as páginas", async () => {
  const generatedAt = new Date("2026-10-07T08:00:00-03:00");
  const bytes = await buildCcPdf({ number: "CC-2026-0008", data: longData, generatedAt });
  const embedded = await readLegacyPdf(bytes, "qualquer.pdf");
  assert.equal(embedded.kind, "cc");
  assert.equal(embedded.embedded, true);
  assert.deepEqual(embedded.kind === "cc" && embedded.data, longData);
  // PDF emitido antes de gravar os dados (ou que perdeu o Info): lê o texto das 3 páginas.
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  (doc.context.lookup(doc.context.trailerInfo.Info) as any).delete(PDFName.of(DATA_KEY));
  const text = await readLegacyPdf(await doc.save(), "FO.FI.C.007 CC-2026-0008 Outubro-2026.pdf");
  assert.equal(text.kind, "cc");
  assert.equal(text.embedded, undefined);
  assert.deepEqual(text.notes, []);
  if (text.kind !== "cc") return;
  assert.equal(text.data.items.length, 75);
  assert.deepEqual(text.data.items, longItems, "Itens das páginas 1 e 2, descrições em duas linhas, custo com 4 casas");
  assert.equal(text.data.period, "2026-10");
  assert.equal(text.data.reason, "LOSS");
  assert.equal(text.data.action, longData.action);
  assert.deepEqual(text.data.approvers, ccApprovers, "Quadro de aprovação na última página");
  // Scrap Form também grava os dados.
  const scrapData = {
    formDate: "2026-09-24",
    items: [{ date: "2026-09-24", material: "11272431-00", quantity: 1, name: "UNID DE CONTROLE ELETR EBS 5S", defect: "Componente queimado.", cause: "F", vin: "1076", op: "19000002673", unitPrice: 1054.87, classification: "B" }],
    approvers: { production: "Pessoa Producao", quality: "Pessoa Qualidade", logistics: "Pessoa Logistica", finance: "Pessoa Financeiro" },
    costCenter: "",
    sapDocument: "",
    pr: "",
    prDate: "",
    po: "",
    notes: "",
  };
  const scrap = await readLegacyPdf(await buildScrapPdf({ number: "SCRAP-2026-0009", data: scrapData, generatedAt }), "x.pdf");
  assert.equal(scrap.kind, "scrap");
  assert.deepEqual(scrap.kind === "scrap" && scrap.data, scrapData);
});

test("FO.FI.C.007 antigo do portal (20 itens e assinaturas na página 1, resto na 2) é lido inteiro", async () => {
  const bytes = new Uint8Array(readFileSync(new URL("./fixtures/cc/portal-antigo-57.pdf", import.meta.url)));
  const result = await readLegacyPdf(bytes, "FO.FI.C.007 CC-2026-0005 Outubro-2026 - para assinatura.pdf");
  assert.equal(result.kind, "cc");
  if (result.kind !== "cc") return;
  assert.deepEqual(result.notes, []);
  assert.equal(result.data.items.length, 57);
  assert.equal(ccTotals(result.data).cost, -948348.81);
  assert.equal(result.data.items[4].description, "CONJUNTO DE TESTE COM DESCRICAO MUITO LONGA PARA QUEBRAR EM DUAS LINHAS NA CELULA DO FORMULARIO 5");
  assert.equal(result.data.items[2].unitCost, 8.9262);
  assert.equal(result.data.items[56].material, "21443464-00");
  assert.equal(result.data.reason, "LOSS");
  assert.deepEqual(result.data.approvers, ccApprovers);
  const reading = await readScrapPdf(bytes, { legacy: true, kind: "cc" });
  assert.equal(reading.formNumber, "CC-2026-0005");
  assert.deepEqual(reading.fields.map((field) => field.slot), ["requester", "manager", "scm", "finance"]);
});
