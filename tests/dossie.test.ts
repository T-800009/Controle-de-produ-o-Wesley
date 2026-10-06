import test from "node:test";
import assert from "node:assert/strict";
import {
  analyzeDossie,
  balancesOf,
  cobranca,
  decimalStyle,
  dossieSummary,
  groupByMaterial,
  inboundTransfers,
  MAX_DATA_CHARS,
  MAX_MOVEMENTS,
  mergeMovements,
  packData,
  parseDate,
  parseMb51Rows,
  parseMb51Text,
  sanitizeDossieData,
  sanitizeTrack,
  sapNumber,
  tableFromText,
  transfersOf,
  unpackData,
  type DossieData,
  type Movement,
} from "../lib/dossie.ts";

// Caso da tela da MB51 (TKC-3921853 IDENTIFICACAO DA BATERIA). O código completo
// do material, as datas e os usuários abaixo são de teste: a tela cortou essas colunas.
const MATERIAL = "19376997-00";
const header = [
  "Empresa", "Centro", "Ordem", "Centro custo", "Elemento PEP", "Material", "Texto breve material", "Depósito", "Tipo de movimento",
  "Estoque especial", "UMP", "Quantidade", "Montante em MI", "Moeda", "Texto cabeçalho documento", "Nome 1", "Doc.material", "Item",
  "Data de lançamento", "Hora de entrada", "Nome do usuário",
];
const line = (depot: string, type: string, unit: string, qty: string, amount: string, text: string, doc: string, item: string, date: string, time: string, user: string) => [
  "BR00", "BR02", "", "", "", MATERIAL, "TKC-3921853_IDENTIFICACAO DA BATERIA", depot, type, "", unit, qty, amount, "BRL", text, "BR - Bus", doc, item, date, time, user,
];
const screen = [
  line("00ZT", "311", "", "62-", "0.00", "00ZT X 2000 ESTOQUE", "4900785063", "1", "2026.09.30", "10:02:11", "WHUSER2"),
  line("2000", "311", "", "62", "0.00", "00ZT X 2000 ESTOQUE", "4900785063", "2", "2026.09.30", "10:02:11", "WHUSER2"),
  line("2000", "311", "", "168-", "0.00", "", "4900337716", "31", "2026.03.12", "14:22:40", "WHUSER1"),
  line("7000", "311", "", "168", "0.00", "", "4900337716", "32", "2026.03.12", "14:22:40", "WHUSER1"),
  line("00ZT", "311", "", "168-", "0.00", "Transferencia zt p/ 2000", "4900306959", "3", "2026.02.27", "09:15:00", "WHUSER1"),
  line("2000", "311", "", "168", "0.00", "Transferencia zt p/ 2000", "4900306959", "4", "2026.02.27", "09:15:00", "WHUSER1"),
  line("00ZT", "862", "PCS", "150-", "1,573.49-", "", "4900304284", "9", "2026.02.20", "16:40:03", "MMUSER"),
  line("00ZT", "561", "", "380", "3,986.18", "", "4900023756", "8", "2025.11.10", "08:00:00", "MMUSER"),
];
const asTabs = (rows: string[][]) => rows.map((row) => row.join("\t")).join("\r\n");
const asSapList = (rows: string[][]) =>
  [
    "06.10.2026                 Lista de documentos de material                 1",
    "-".repeat(80),
    "|" + header.join("|") + "|",
    "-".repeat(80),
    ...rows.map((row) => "|" + row.join("|") + "|"),
    "-".repeat(80),
  ].join("\n");

function dossieFrom(text: string, target = "7000"): DossieData {
  const parsed = parseMb51Text(text);
  const [group] = groupByMaterial(parsed.movements);
  const questioned = inboundTransfers(transfersOf(group.movements), target).map((t) => t.key);
  return sanitizeDossieData({ ...group, target, questioned, manualPrice: null, request: "", deadline: "2026-10-09", recipients: "", notes: "", stockCheck: null, source: "teste", importedAt: "2026-10-06T17:40:00.000Z" });
}

test("lê a MB51 colada do Excel (tabulação) e da lista do SAP (|)", () => {
  for (const text of [asTabs([header, ...screen]), asSapList(screen)]) {
    const parsed = parseMb51Text(text);
    assert.equal(parsed.movements.length, 8);
    assert.equal(parsed.decimal, "dot", "1,573.49- é o formato americano");
    const issue = parsed.movements.find((m) => m.type === "862")!;
    assert.equal(issue.quantity, -150);
    assert.equal(issue.amount, -1573.49);
    assert.equal(issue.unit, "PCS");
    const toLine = parsed.movements.find((m) => m.document === "4900337716" && m.item === "32")!;
    assert.equal(toLine.depot, "7000");
    assert.equal(toLine.quantity, 168);
    assert.equal(toLine.postingDate, "2026-03-12");
    assert.equal(toLine.entryTime, "14:22:40");
    assert.equal(toLine.user, "WHUSER1");
    assert.equal(toLine.year, "2026");
    assert.deepEqual(parsed.missing, []);
  }
});

test("transferências pareadas, saldo por depósito e a transferência para o 7000", () => {
  const data = dossieFrom(asTabs([header, ...screen]));
  const transfers = transfersOf(data.movements);
  assert.deepEqual(
    transfers.map((t) => [t.document, t.items.join("/"), t.from, t.to, t.quantity]),
    [
      ["4900306959", "3/4", "00ZT", "2000", 168],
      ["4900337716", "31/32", "2000", "7000", 168],
      ["4900785063", "1/2", "00ZT", "2000", 62],
    ],
  );
  assert.deepEqual(balancesOf(data.movements), [
    { depot: "00ZT", quantity: 0 },
    { depot: "2000", quantity: 62 },
    { depot: "7000", quantity: 168 },
  ]);
  assert.deepEqual(data.questioned, ["4900337716/2026/31"]);
});

test("análise: nada consumido, 168 parados, valor pela média dos lançamentos com valor", () => {
  const data = dossieFrom(asTabs([header, ...screen]));
  const analysis = analyzeDossie(data, { today: "2026-10-06", bom: { materials: {}, checked: 12 } });
  const [t] = analysis.questioned;
  assert.equal(t.consumed, 0);
  assert.equal(t.transferredOut, 0);
  assert.equal(t.idle, 168);
  assert.equal(t.days, 208);
  assert.equal(analysis.unit, "PCS");
  assert.equal(analysis.priceSource, "mb51");
  assert.equal(Math.round(analysis.unitPrice! * 100) / 100, 10.49);
  assert.equal(analysis.idleValue, 1762.31); // 168 × (3.986,18 + 1.573,49) ÷ 530
  const texts = analysis.findings.map((f) => f.text);
  assert.ok(texts.some((text) => /2000 → 7000 de 168 PCS \(doc\. 4900337716, itens 31\/32, TMv 311\) em 12\/03\/2026 às 14:22 por WHUSER1/.test(text)), texts.join("\n"));
  assert.ok(texts.some((text) => /não tem texto de cabeçalho/.test(text)));
  assert.ok(texts.some((text) => /Nenhum consumo \(261\)/.test(text)));
  assert.ok(texts.some((text) => /parado no 7000 .*168 PCS · R\$\s?1\.762,31 · há 208 dia/.test(text)), texts.join("\n"));
  assert.match(analysis.bomText, /não consta em nenhuma das 12 BOM/);
  const summary = dossieSummary(data);
  assert.equal(summary.idle, 168);
  assert.equal(summary.value, 1762.31);
  assert.equal(summary.firstDate, "2026-03-12");
  assert.deepEqual(summary.transfers[0].items, ["31", "32"]);
});

test("consumo, devolução e sucata depois da transferência abatem o lote (FIFO)", () => {
  const more = [
    ...screen,
    line("7000", "261", "", "50-", "524.50-", "", "4900400001", "1", "2026.04.01", "07:00:00", "LINHA"),
    line("7000", "262", "", "10", "104.90", "", "4900400002", "1", "2026.04.02", "07:00:00", "LINHA"),
    line("7000", "311", "", "100-", "0.00", "devolução", "4900500001", "1", "2026.05.05", "11:00:00", "WHUSER1"),
    line("2000", "311", "", "100", "0.00", "devolução", "4900500001", "2", "2026.05.05", "11:00:00", "WHUSER1"),
  ];
  const data = dossieFrom(asTabs([header, ...more]));
  const [t] = analyzeDossie(data, { today: "2026-10-06" }).questioned;
  // 168 entram; 50 consumidos; 10 voltam (262) para o mesmo lote; 100 saem para o 2000.
  assert.equal(t.consumed, 40);
  assert.equal(t.transferredOut, 100);
  assert.deepEqual(t.outTo, { "2000": 100 });
  assert.equal(t.idle, 28);
});

test("duas transferências para o 7000: as saídas abatem a mais antiga primeiro", () => {
  const rows = [
    line("2000", "311", "", "40-", "0.00", "", "4900000010", "1", "2026.01.05", "", "A"),
    line("7000", "311", "", "40", "0.00", "", "4900000010", "2", "2026.01.05", "", "A"),
    line("2000", "311", "", "30-", "0.00", "", "4900000020", "1", "2026.01.10", "", "B"),
    line("7000", "311", "", "30", "0.00", "", "4900000020", "2", "2026.01.10", "", "B"),
    line("7000", "261", "", "50-", "0.00", "", "4900000030", "1", "2026.01.20", "", "C"),
  ];
  const data = dossieFrom(asTabs([header, ...rows]));
  const [first, second] = analyzeDossie(data, { today: "2026-02-01" }).questioned;
  assert.equal(first.consumed, 40);
  assert.equal(first.idle, 0);
  assert.equal(first.days, null);
  assert.equal(second.consumed, 10);
  assert.equal(second.idle, 20);
});

test("números e datas do SAP", () => {
  assert.equal(sapNumber("1,573.49-", "dot"), -1573.49);
  assert.equal(sapNumber("1.573,49-", "comma"), -1573.49);
  assert.equal(sapNumber("62-"), -62);
  assert.equal(sapNumber(" 380 "), 380);
  assert.equal(sapNumber("abc"), null);
  assert.equal(sapNumber(-12.5), -12.5);
  assert.equal(decimalStyle(["0.00", "1,573.49-"]), "dot");
  assert.equal(decimalStyle(["0,00", "1.573,49-"]), "comma");
  assert.equal(decimalStyle(["168,000"]), null, "uma vírgula com 3 casas é ambíguo");
  assert.equal(decimalStyle(["1,234,567"]), "dot");
  assert.equal(parseDate("06.10.2026"), "2026-10-06");
  assert.equal(parseDate("2026.10.06"), "2026-10-06");
  assert.equal(parseDate("2026-10-06"), "2026-10-06");
  assert.equal(parseDate("06/10/2026", "dmy"), "2026-10-06");
  assert.equal(parseDate("10/06/2026", "mdy"), "2026-10-06");
  assert.equal(parseDate(46301), "2026-10-06", "número de série do Excel");
  assert.equal(parseDate("31/02/2026"), "");
});

test("datas ambíguas seguem a ordem dos documentos; dia > 12 decide sozinho", () => {
  const head = ["Material", "Depósito", "Tipo de movimento", "Quantidade", "Doc.material", "Item", "Data de lançamento"];
  const rows = (dates: string[]) => [head, ...dates.map((date, i) => ["X1", "2000", "311", "1", String(4900000001 + i), "1", date])];
  // Documentos 1 e 2: "02/01" e depois "01/02". Lendo dia/mês o tempo cresce (2 jan → 1 fev).
  const dmy = parseMb51Rows(rows(["02/01/2026", "01/02/2026"]));
  assert.equal(dmy.dateOrder, "dmy");
  assert.equal(dmy.dateAmbiguous, true);
  assert.equal(dmy.movements[1].postingDate, "2026-02-01");
  // "01/02" e depois "02/01": só cresce lendo mês/dia (2 jan → 1 fev).
  const guessed = parseMb51Rows(rows(["01/02/2026", "02/01/2026"]));
  assert.equal(guessed.dateOrder, "mdy");
  assert.equal(guessed.dateAmbiguous, true);
  const mdy = parseMb51Rows(rows(["02/01/2026", "03/01/2026", "04/01/2026", "02/13/2026"]));
  assert.equal(mdy.dateOrder, "mdy");
  assert.equal(mdy.dateAmbiguous, false);
  assert.equal(mdy.movements[0].postingDate, "2026-02-01");
  const forced = parseMb51Rows(rows(["01/02/2026"]), { dateOrder: "mdy" });
  assert.equal(forced.movements[0].postingDate, "2026-01-02");
  assert.equal(forced.dateAmbiguous, false);
});

test("planilha do Excel: números, data de série, hora em fração e coluna D/C", () => {
  const rows: unknown[][] = [
    ["Lista de documentos de material"],
    ["Material", "Depósito", "Tipo de movimento", "Quantidade", "Código débito/crédito", "Doc.material", "Item", "Data de lançamento", "Hora de entrada", "Nome do usuário"],
    [19376997, "2000", 311, 168, "H", 4900337716, 31, 46093, 0.5, "wh1"],
    [19376997, "7000", 311, 168, "S", 4900337716, 32, 46093, 0.5, "wh1"],
    ["", "", "", 0, "", "", "", "", "", ""],
  ];
  const parsed = parseMb51Rows(rows);
  assert.equal(parsed.movements.length, 2);
  assert.equal(parsed.movements[0].material, "19376997");
  assert.equal(parsed.movements[0].quantity, -168, "H = crédito/saída");
  assert.equal(parsed.movements[0].document, "4900337716");
  assert.equal(parsed.movements[0].postingDate, "2026-03-12");
  assert.equal(parsed.movements[0].entryTime, "12:00:00");
  assert.equal(parsed.movements[0].user, "WH1");
  assert.deepEqual(transfersOf(groupByMaterial(parsed.movements)[0].movements).map((t) => [t.from, t.to]), [["2000", "7000"]]);
});

test("títulos cortados como na tela do SAP (Quan…, Centro …)", () => {
  const head = ["Em...", "Cen.", "Centro ...", "Material", "Dep.", "TMv", "E", "UMP", "Quan...", "Montante MI", "Moeda", "Doc.material", "Item", "Da..."];
  const parsed = parseMb51Rows([head, ["BR00", "BR02", "", "19376997-00", "7000", "311", "", "", "168", "0.00", "BRL", "4900337716", "32", "2026.03.12"]]);
  const [m] = parsed.movements;
  assert.equal(m.quantity, 168);
  assert.equal(m.plant, "BR02", "Centro … é ambíguo (centro ou centro de custo) e fica de fora");
  assert.equal(m.costCenter, "");
  assert.equal(m.depot, "7000");
  assert.equal(m.postingDate, "2026-03-12", "Da… só pode ser Data de lançamento");
});

test("cabeçalho ausente ou coluna obrigatória faltando dá instrução clara", () => {
  assert.throws(() => parseMb51Text("BR00\tBR02\t19376997\t2000\t311\t168"), /cabeçalho da MB51/);
  assert.throws(() => parseMb51Text("Material\tTipo de movimento\tQuantidade\tDoc.material\nX\t311\t1\t49"), /coluna Depósito/);
  const semicolon = parseMb51Text("Material;Depósito;Tipo de movimento;Quantidade;Doc.material;Item\nX1;2000;311;-5;4900000001;1\nX1;7000;311;5;4900000001;2");
  assert.equal(semicolon.movements.length, 2);
  assert.deepEqual(semicolon.missing, ["Data de lançamento", "Nome do usuário", "Hora de entrada"]);
});

test("cobrança: texto para e-mail/Teams e reforço depois da 1ª", () => {
  const data = dossieFrom(asTabs([header, ...screen]));
  const analysis = analyzeDossie(data, { today: "2026-10-06", bom: { materials: {}, checked: 12 } });
  const first = cobranca({ number: "DOS-2026-0001", data, analysis, status: "open" });
  assert.match(first.subject, /^\[DOS-2026-0001\] Transferência 2000 → 7000 sem justificativa · 19376997-00 TKC-3921853/);
  assert.match(first.text, /doc\. 4900337716 \(itens 31\/32\) · TMv 311 · 2000 → 7000 · 168 PCS/);
  assert.match(first.text, /Lançada: 12\/03\/2026 às 14:22 por WHUSER1/);
  assert.match(first.text, /Texto no documento: nenhum/);
  assert.match(first.text, /• Parado: 168 PCS · R\$\s?1\.762,31 \(R\$\s?10,49\/PCS\) · há 208 dia/);
  assert.match(first.text, /Prazo para resposta: 09\/10\/2026\./);
  assert.doesNotMatch(first.text, /Reforçando/);
  const track = sanitizeTrack({ sentAt: "2026-10-06T18:00:00Z", reminders: ["2026-10-08T12:00:00Z"] });
  const third = cobranca({ number: "DOS-2026-0001", data, analysis, track, status: "sent" });
  assert.match(third.text, /Reforçando a cobrança enviada em 06\/10\/2026 \(3ª cobrança\)/);
});

test("validação: transferência marcada, limites e gravação compacta", () => {
  const data = dossieFrom(asTabs([header, ...screen]));
  assert.throws(() => sanitizeDossieData({ ...data, questioned: ["9999/2026/1"] }), /Marque pelo menos uma transferência/);
  assert.throws(() => sanitizeDossieData({ ...data, material: "<script>" }), /Material inválido/);
  assert.throws(() => sanitizeDossieData({ ...data, deadline: "09/10/2026" }), /Prazo inválido/);
  assert.throws(() => sanitizeDossieData({ ...data, manualPrice: -1 }), /Preço unitário inválido/);
  assert.deepEqual(unpackData(packData(data)), data);
  // O dossiê cheio (300 lançamentos) cabe numa linha do banco.
  const many: Movement[] = Array.from({ length: MAX_MOVEMENTS }, (_, i) => ({
    ...data.movements[2],
    document: String(4900900000 + i),
    item: "1",
    headerText: "Transferência de teste com texto de cabeçalho comprido para medir o espaço",
    itemText: "Texto do item com algumas palavras",
  }));
  const big = sanitizeDossieData({ ...data, movements: [...data.movements, ...many.slice(0, MAX_MOVEMENTS - data.movements.length)] });
  assert.ok(packData(big).length < MAX_DATA_CHARS, String(packData(big).length));
  assert.throws(() => sanitizeDossieData({ ...data, movements: [...data.movements, ...many] }), /guarda até 300/);
});

test("lançamentos novos entram sem repetir documento/item", () => {
  const data = dossieFrom(asTabs([header, ...screen]));
  const extra = parseMb51Text(asTabs([header, screen[0], line("7000", "261", "", "8-", "0.00", "", "4900800000", "1", "2026.10.01", "", "LINHA")]));
  const merged = mergeMovements(data.movements, groupByMaterial(extra.movements)[0].movements);
  assert.equal(merged.added, 1);
  assert.equal(merged.movements.length, 9);
});
