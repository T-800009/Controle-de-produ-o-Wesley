import { test } from "node:test";
import assert from "node:assert/strict";
import { CHART_WIDTH, EMAIL_MATERIALS, classTotals, consumoChart, graficoEmail, graficoFileName, materialsToSend, statusChart, type ChartImage } from "../lib/grafico-email.ts";
import { buildEml } from "../lib/form-email.ts";
import type { OpProgress } from "../lib/op-progress.ts";
import type { OpStatuses } from "../lib/op-status.ts";
import type { WarehouseItem } from "../lib/warehouse.ts";

const ops = Array.from({ length: 17 }, (_, i) => String(19000005101 + i * 7));
const group = (total: number, done: number, review = 0) => ({ total, done, pending: total - done - review, review, percent: total && review !== total ? (done / total) * 100 : null });
const summary: OpProgress[] = ops.map((op, i) => ({
  op,
  classes: { A: group(3, 3), B: group(5, i === 9 ? 4 : 5), C: i === 10 ? group(0, 0) : group(10, i < 8 ? 10 : 9) },
  total: 18,
  done: 17,
  pending: 1,
  review: i === 11 ? 1 : 0,
  unclassified: 0,
  ignored: 0,
  complete: i < 8,
}));
const statuses: OpStatuses = Object.fromEntries(ops.map((op, i) => [op, { status: i < 5 ? "complete" : i < 8 ? "waiting" : "not_started", updatedAt: "2026-10-08" }])) as OpStatuses;
const item = (patch: Partial<WarehouseItem>): WarehouseItem => ({
  key: patch.material || "x",
  material: "10000000-00",
  description: "PEÇA <TESTE> & CIA",
  unit: "PC",
  classes: ["C"],
  ops: [ops[9]],
  demand: 2,
  s7000: 0,
  s2000: 10,
  s1500: null,
  covered: 0,
  request: 2,
  transfer: 2,
  uncovered: 0,
  state: "transfer",
  details: [],
  ...patch,
});
const items = [
  item({ material: "30000000-00", classes: ["C"] }),
  item({ material: "20000000-00", classes: ["A"], state: "short", s2000: 0, transfer: 0, uncovered: 1, request: 1 }),
  item({ material: "25000000-00", classes: ["B"], state: "review", s2000: null, transfer: null, uncovered: null, request: 3, ops: ops.slice(8, 15) }),
  item({ material: "40000000-00", request: 0, covered: 2, state: "covered" }),
];
const bom = { name: "BC22S02", revision: "BOM 1339", updatedAt: "2026-10-08T12:02:57Z" };
const morning = new Date(2026, 9, 8, 9, 10);
const image = (id: "status" | "consumo", title: string): ChartImage => ({ id, title, alt: title, src: `cid:grafico-${id}@wbyd`, width: CHART_WIDTH, height: 300 });

test("gráfico de status: todas as OPs, em linhas equilibradas, com a contagem na legenda", () => {
  const chart = statusChart(summary, statuses, "BC22S02 · BOM 1339");
  assert.equal(chart.width, CHART_WIDTH);
  assert.match(chart.svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="720" height="\d+" viewBox="0 0 720 \d+"/);
  assert.match(chart.svg, /<rect width="720" height="\d+" fill="#ffffff"\/>/, "fundo branco para o e-mail");
  assert.match(chart.svg, />Concluída \(5\)</);
  assert.match(chart.svg, />Aguardando Warehouse \(3\)</);
  assert.match(chart.svg, />Não iniciada \(9\)</);
  assert.equal((chart.svg.match(/<title>OP /g) || []).length, 17, "uma marca por OP, sem paginar");
  // 17 OPs, até 16 por linha → 2 linhas de 9 e 8
  const ys = [...chart.svg.matchAll(/<rect x="[\d.]+" y="(\d+)" width="44" height="56"/g)].map((m) => Number(m[1]));
  assert.deepEqual([...new Set(ys)].map((y) => ys.filter((v) => v === y).length), [9, 8]);
  assert.match(chart.alt, /17 OPs: 5 concluídas, 3 aguardando Warehouse, 9 não iniciadas/);
});

test("gráfico de consumo: três barras por OP com o mesmo rótulo da tela (sem arredondar para 100%)", () => {
  const chart = consumoChart(summary, statuses, "BC22S02 · BOM 1339");
  assert.equal((chart.svg.match(/<rect x="[\d.]+" y="[\d.]+" width="[\d.]+" height="[\d.]+" fill="#(346775|d4aa39|dea077|cbd2d9)"/g) || []).length, 17 * 3);
  assert.match(chart.svg, />90%</, "9 de 10 na classe C");
  assert.match(chart.svg, />80%</, "4 de 5 na classe B da OP 10");
  assert.match(chart.svg, />—</, "classe sem itens aparece como —");
  assert.match(chart.svg, /Concluída\*/);
  assert.match(chart.svg, /BOM atendida/);
  assert.match(chart.svg, /Conferir/);
  assert.doesNotMatch(chart.svg, /<script/i);
});

test("materiais a enviar: só o que o 7000 não cobre, classe A primeiro", () => {
  assert.deepEqual(materialsToSend(items).map((i) => i.material), ["20000000-00", "25000000-00", "30000000-00"]);
  assert.deepEqual(classTotals(summary).map((c) => [c.name, c.total, c.done]), [["A", 51, 51], ["B", 85, 84], ["C", 160, 152]]);
});

test("e-mail formal: resumo, gráficos, lista dos materiais e pedido ao Warehouse", () => {
  const mail = graficoEmail({
    bom,
    summary,
    statuses,
    items,
    consumption: true,
    materials: true,
    charts: [image("status", "Status das OPs"), image("consumo", "Materiais atendidos por OP e classe")],
    attachment: "Materiais a enviar.xlsx",
    sender: "Wesley Teste",
    link: "https://portal.test/?modulo=grafico",
    now: morning,
  });
  assert.equal(mail.subject, "Acompanhamento das OPs BC22S02 · BOM 1339 – materiais a enviar pelo Warehouse (08/10/2026)");
  assert.match(mail.text, /^Prezados, bom dia\.\n\nSegue o acompanhamento das ordens de produção da BC22S02 · BOM 1339, com a MB51 consultada em \d\d\/\d\d\/2026 às \d\d:\d\d, e a lista dos materiais que ainda precisam ser enviados pelo Warehouse/);
  assert.match(mail.text, /• Ordens de produção: 17 \(5 concluídas, 3 aguardando Warehouse, 9 não iniciadas\)/);
  assert.match(mail.text, /• Classe B: 98,8% dos materiais atendidos \(84 de 85; 1 com diferença\)/);
  assert.match(mail.text, /• Materiais a enviar: 3 \(1 com saldo no 2000 para transferir; 1 precisa de reposição; 1 com o saldo do 2000 a conferir\)/);
  assert.match(mail.text, /Materiais a enviar pelo Warehouse:\n• 20000000-00 · PEÇA <TESTE> & CIA · Classe A · enviar 1 PC · saldo 2000: 0 PC · Reposição: falta 1 PC além do 2000 · OPs 5164/);
  assert.match(mail.text, /• 25000000-00 · .* · Conferir o saldo do 2000 · OPs 5157, 5164, 5171, 5178 \+3/);
  assert.match(mail.text, /As quantidades por OP estão na planilha em anexo\./);
  assert.match(mail.text, /Solicito, por gentileza, a transferência do depósito 2000 para o 7000 dos materiais com saldo e, para os itens sem saldo suficiente, o retorno com a previsão de reposição\./);
  assert.match(mail.text, /Atenciosamente,\nWesley Teste$/);
  // HTML: imagens pelo cid, descrição escapada, código do material sem quebrar
  assert.match(mail.html, /<img src="cid:grafico-status@wbyd" width="720" height="300"/);
  assert.match(mail.html, /<img src="cid:grafico-consumo@wbyd"/);
  assert.match(mail.html, /PEÇA &lt;TESTE&gt; &amp; CIA/);
  assert.match(mail.html, /white-space:nowrap">20000000-00</);
  assert.doesNotMatch(mail.html, /<p style="margin:18px 0 6px;font-weight:bold;color:#1f1f1f">Status das OPs<\/p>/, "o título já está dentro da imagem");
  // mailto: sem gráficos e sem a tabela
  assert.doesNotMatch(mail.short, /20000000-00|gráfico/);
  assert.match(mail.short, /A lista dos materiais, com as quantidades por OP, segue na planilha em anexo\./);
});

test("e-mail: lista longa vai até o limite; sem MB51 vai só o status; sem faltas, informa", () => {
  const many = Array.from({ length: EMAIL_MATERIALS + 5 }, (_, i) => item({ material: `5${String(i).padStart(7, "0")}-00` }));
  const long = graficoEmail({ bom, summary, statuses, items: many, consumption: true, materials: true, charts: [], attachment: "x.xlsx", now: morning });
  assert.match(long.text, /… e mais 5 materiais\. A lista completa, com as quantidades por OP, está na planilha em anexo\./);
  assert.match(long.text, /Solicito, por gentileza, a transferência dos materiais listados do depósito 2000 para o 7000\./);
  const noFile = graficoEmail({ bom, summary, statuses, items: many, consumption: true, materials: true, charts: [], now: morning });
  assert.match(noFile.text, /A lista completa está na aba WAREHOUSE do portal\./);

  const statusOnly = graficoEmail({ bom, summary, statuses, items, consumption: false, materials: true, charts: [image("status", "Status das OPs")], now: new Date(2026, 9, 8, 15) });
  assert.equal(statusOnly.subject, "Acompanhamento das OPs BC22S02 · BOM 1339 (08/10/2026)");
  assert.match(statusOnly.text, /^Prezados, boa tarde\.\n\nSegue o acompanhamento das ordens de produção da BC22S02 · BOM 1339\./);
  assert.doesNotMatch(statusOnly.text, /Classe A|Materiais a enviar|Solicito/);

  const covered = graficoEmail({ bom, summary, statuses, items: [items[3]], consumption: true, materials: true, charts: [], now: morning });
  assert.match(covered.text, /• Materiais a enviar: nenhum/);
  assert.match(covered.text, /No momento não há materiais pendentes de envio pelo Warehouse nesta BOM/);
  const shortOnly = graficoEmail({ bom, summary, statuses, items: [items[1]], consumption: true, materials: true, charts: [], now: morning });
  assert.match(shortOnly.text, /Solicito, por gentileza, o retorno com a previsão de reposição dos materiais listados/);
  assert.equal(graficoFileName(bom, morning), "Acompanhamento OPs BC22S02 BOM 1339 08-10-2026 - e-mail.eml");
});

test(".eml com gráficos no corpo (multipart/related), Cc e planilha anexada", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const xlsx = new TextEncoder().encode("PK planilha de teste");
  const eml = buildEml({
    to: "warehouse@empresa.test; inválido",
    cc: "pcp@empresa.test",
    subject: "Acompanhamento das OPs BC22S02 · BOM 1339",
    text: "texto",
    html: '<p><img src="cid:grafico-status@wbyd"></p>',
    images: [{ cid: "grafico-status@wbyd", name: "Status das OPs.png", bytes: png, type: "image/png" }],
    attachments: [{ name: "Materiais a enviar.xlsx", bytes: xlsx, type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }],
  });
  assert.match(eml, /^X-Unsent: 1\r\nTo: warehouse@empresa\.test\r\nCc: pcp@empresa\.test\r\nSubject: =\?UTF-8\?B\?/);
  const order = [...eml.matchAll(/Content-Type: ([a-z/.-]+)/g)].map((m) => m[1]);
  assert.deepEqual(order, ["multipart/mixed", "multipart/related", "multipart/alternative", "text/plain", "text/html", "image/png", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"]);
  assert.match(eml, /Content-ID: <grafico-status@wbyd>\r\nContent-Disposition: inline; filename="Status das OPs\.png"/);
  const body = (type: string) => {
    const match = new RegExp(`Content-Type: ${type.replace(/[/.]/g, "\\$&")}[^\\r]*\\r\\n(?:[^\\r]+\\r\\n)*\\r\\n([A-Za-z0-9+/=\\r\\n]+?)\\r\\n(?:\\r\\n)?--`).exec(eml);
    assert.ok(match, type);
    return new Uint8Array(Buffer.from(match[1].replace(/\r\n/g, ""), "base64"));
  };
  assert.deepEqual(body("image/png"), png);
  assert.deepEqual(body("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"), xlsx);
  assert.ok(eml.indexOf("--" + "----=_WBYD_related--") < eml.indexOf("Materiais a enviar.xlsx"), "planilha fora do bloco das imagens");
  // sem imagens: o mesmo formato de antes (sem multipart/related)
  assert.doesNotMatch(buildEml({ to: "", subject: "x", text: "a", html: "<p>a</p>" }), /multipart\/related/);
});
