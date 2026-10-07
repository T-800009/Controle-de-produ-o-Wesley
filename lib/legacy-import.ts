/**
 * Qualquer PDF de Scrap Form ou FO.FI.C.007 (do Excel, do portal, assinado ou
 * não): monta os dados para cadastrar o formulário com o PDF guardado.
 * PDF emitido pelo portal traz os dados no Info (WBYDData): voltam exatos.
 * Sem isso, a leitura é pelo texto (Scrap Form: página 1; FO.FI.C.007: todas
 * as páginas, com o quadro REMARKS/APPROVAL onde estiver).
 *
 * A leitura é pela posição do texto: cada valor vai para a coluna cujo título
 * (DATE, P/N SAP, QTD, …) está mais perto. Datas no formato do Excel americano
 * (5/15/2026) ou brasileiro (16/04/2026) e valores R$1,233.89 ou R$ 4.403,48.
 * O que não der para ler fica vazio e aparece como aviso na importação.
 */
import { PDFDict, PDFDocument, PDFHexString, PDFName, PDFString } from "pdf-lib";
import { base64ToBytes } from "./base64.ts";
import { pageText, type PageText, type TextRun } from "./pdf-text.ts";
import { CAUSES, CC_SLOTS, cents, defaultApprovers, materialCode, todayIso, type DocKind, type ScrapFormData, type ScrapItem } from "./scrap-form.ts";
import { CC_DEFAULTS, isPeriod, unitFromTotal, type CcFormData, type CcItem } from "./cc-form.ts";

export type LegacyDocument =
  | { kind: "scrap"; data: ScrapFormData; notes: string[]; hasText: boolean; embedded?: boolean }
  | { kind: "cc"; data: CcFormData; notes: string[]; hasText: boolean; embedded?: boolean }
  | { kind: null; notes: string[]; hasText: boolean; embedded?: boolean };

/* ------------------------------------------------------------------------ */
/* Números e datas                                                           */
/* ------------------------------------------------------------------------ */

/**
 * "R$1,233.89", "R$ 4.403,48", "-R$ 27,220.48", "1.054,87" e custo unitário do
 * portal com mais casas ("R$ 5,083", "R$ 12,7354") → número.
 * Com vírgula e ponto, o último é o decimal; com um separador só (sem repetir), ele é o decimal.
 */
export function legacyMoney(raw: string): number | null {
  const text = raw.replace(/R\$|\s/g, "");
  const negative = /^-|^\(.*\)$/.test(text) || raw.trim().startsWith("-");
  const digits = text.replace(/[^0-9.,]/g, "");
  if (!/\d/.test(digits)) return null;
  const comma = digits.lastIndexOf(","),
    dot = digits.lastIndexOf(".");
  let value: number;
  if (comma >= 0 && dot >= 0) value = comma > dot ? Number(digits.replace(/\./g, "").replace(",", ".")) : Number(digits.replace(/,/g, ""));
  else if (comma >= 0 || dot >= 0) {
    const separator = comma >= 0 ? "," : ".";
    const parts = digits.split(separator);
    value = parts.length === 2 && parts[1].length >= 1 && parts[1].length <= 6 ? Number(`${parts[0]}.${parts[1]}`) : Number(parts.join(""));
  } else value = Number(digits);
  if (!Number.isFinite(value)) return null;
  return Math.round((negative ? -value : value) * 1e6) / 1e6;
}
/** Quantidade: "2", "-5386", "1,5", "1.000". */
export function legacyQuantity(raw: string): number | null {
  const text = raw.replace(/\s/g, "");
  if (!/^-?[\d.,]+$/.test(text)) return null;
  let normalized = text;
  if (/^-?\d{1,3}([.,]\d{3})+$/.test(text)) normalized = text.replace(/[.,]/g, "");
  else normalized = text.replace(",", ".");
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

const DATE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
const pad = (value: number) => String(value).padStart(2, "0");
const iso = (year: number, month: number, day: number) => {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? `${year}-${pad(month)}-${pad(day)}` : "";
};
const days = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000;
/** Data no nome do arquivo: "… 18.05.2026 …" ou "… 18-05-2026 …". */
export function fileDate(fileName: string) {
  const match = /(\d{1,2})[.\-_](\d{1,2})[.\-_](\d{4})/.exec(fileName);
  return match ? iso(Number(match[3]), Number(match[2]), Number(match[1])) : "";
}
/**
 * O Excel grava 5/15/2026 (mês/dia) ou 16/04/2026 (dia/mês). Decide pelo
 * documento inteiro: um número acima de 12 resolve; senão, vale a leitura mais
 * próxima da data do nome do arquivo; sem nada, mês/dia (padrão do Excel em inglês).
 */
export function dateOrder(values: string[], reference = ""): "mdy" | "dmy" {
  const parts = values.map((value) => DATE.exec(value)).filter((match): match is RegExpExecArray => !!match);
  if (parts.some((match) => Number(match[1]) > 12)) return "dmy";
  if (parts.some((match) => Number(match[2]) > 12)) return "mdy";
  if (reference && parts.length) {
    const distance = (order: "mdy" | "dmy") =>
      parts.reduce((sum, match) => {
        const [a, b, year] = [Number(match[1]), Number(match[2]), Number(match[3])];
        const value = order === "mdy" ? iso(year, a, b) : iso(year, b, a);
        return sum + (value ? days(value, reference) : 999);
      }, 0);
    return distance("dmy") < distance("mdy") ? "dmy" : "mdy";
  }
  return "mdy";
}
const readDate = (value: string, order: "mdy" | "dmy") => {
  const match = DATE.exec(value.trim());
  if (!match) return "";
  const [a, b, year] = [Number(match[1]), Number(match[2]), Number(match[3])];
  return order === "mdy" ? iso(year, a, b) : iso(year, b, a);
};

/* ------------------------------------------------------------------------ */
/* Colunas e linhas                                                          */
/* ------------------------------------------------------------------------ */

const center = (run: TextRun) => run.x + run.width / 2;
type Column = { key: string; x: number };
/** Agrupa os trechos em linhas (mesma altura, com folga para o "R$" desalinhado). */
function lines(runs: TextRun[]) {
  const sorted = [...runs].sort((a, b) => b.y - a.y || a.x - b.x);
  const out: { y: number; runs: TextRun[] }[] = [];
  for (const run of sorted) {
    const last = out.at(-1);
    if (last && Math.abs(last.y - run.y) <= Math.max(1.2, run.size * 0.45)) last.runs.push(run);
    else out.push({ y: run.y, runs: [run] });
  }
  for (const line of out) line.runs.sort((a, b) => a.x - b.x);
  return out;
}
/** Valores de uma linha por coluna (o mais perto do centro do título; padrões fortes mandam). */
function cells(line: TextRun[], columns: Column[], strong: (run: TextRun) => string | null) {
  const out: Record<string, string> = {};
  for (const run of line) {
    const forced = strong(run);
    const key = forced && columns.some((column) => column.key === forced) ? forced : columns.reduce((best, column) => (Math.abs(column.x - center(run)) < Math.abs(best.x - center(run)) ? column : best)).key;
    out[key] = out[key] ? `${out[key]} ${run.text}` : run.text;
  }
  return out;
}
function header(runs: TextRun[], labels: [string, RegExp][], anchor: RegExp) {
  const top = runs.filter((run) => !run.rotated && anchor.test(run.text.trim())).sort((a, b) => b.y - a.y)[0];
  if (!top) return null;
  const near = runs.filter((run) => !run.rotated && Math.abs(run.y - top.y) <= top.size * 1.15);
  const columns: Column[] = [];
  for (const [key, pattern] of labels) {
    const found = near.filter((run) => pattern.test(run.text.trim()));
    if (found.length) columns.push({ key, x: found.reduce((sum, run) => sum + center(run), 0) / found.length });
  }
  return { y: Math.min(...near.map((run) => run.y)), size: top.size, columns };
}

/* ------------------------------------------------------------------------ */
/* Scrap Form                                                                */
/* ------------------------------------------------------------------------ */

const SCRAP_LABELS: [string, RegExp][] = [
  ["date", /^DATE$/i],
  ["material", /P\/N/i],
  ["quantity", /^QT[DY]\.?$/i],
  ["name", /^Name$/i],
  ["defect", /DESCRIPTION/i],
  ["cause", /^CAUSE$/i],
  ["vin", /VIN$/i],
  ["op", /^(Production|Order|Production Order)$/i],
  ["unitPrice", /^(UNIT|PRICE|UNIT PRICE)$/i],
  ["total", /^(TOTAL|VALUE|TOTAL VALUE)$/i],
  ["classification", /^CLASS$/i],
];
const CAUSE_CODES = new Set<string>(CAUSES.map((cause) => cause.code));

export function parseLegacyScrap(page: PageText, fileName = ""): { data: ScrapFormData; notes: string[] } {
  const notes: string[] = [];
  const runs = page.runs;
  const head = header(runs, SCRAP_LABELS, /^DATE$/i);
  const reference = fileDate(fileName);
  const items: ScrapItem[] = [];
  let approvers = defaultApprovers(null);
  if (!head) notes.push("Não achei a tabela de itens: confira e preencha os itens depois de importar.");
  else {
    const stop = runs.filter((run) => /^(CAPTION|Approval|Responsible)$/i.test(run.text.trim()) && run.y < head.y).sort((a, b) => b.y - a.y)[0];
    const body = runs.filter((run) => !run.rotated && run.y < head.y - head.size * 0.3 && (!stop || run.y > stop.y + stop.size * 0.5));
    const strong = (run: TextRun) => {
      const text = run.text.trim();
      if (DATE.test(text)) return "date";
      if (/^\d{8}(-\d{2})?$/.test(text)) return "material";
      if (/^\d{10,14}$/.test(text)) return "op";
      return null;
    };
    const rows = lines(body).map((line) => cells(line.runs, head.columns, strong));
    const order = dateOrder(
      rows.map((row) => row.date || "").filter(Boolean),
      reference,
    );
    const raw: Record<string, string>[] = [];
    for (const row of rows) {
      if (row.date || row.material) raw.push({ ...row });
      else if (raw.length && (row.name || row.defect) && !row.unitPrice && !row.total) {
        // Texto quebrado em duas linhas na mesma célula.
        const last = raw.at(-1)!;
        if (row.name) last.name = `${last.name || ""} ${row.name}`.trim();
        if (row.defect) last.defect = `${last.defect || ""} ${row.defect}`.trim();
      }
    }
    for (const row of raw) {
      const quantity = row.quantity ? legacyQuantity(row.quantity) : null;
      let unitPrice = row.unitPrice ? legacyMoney(row.unitPrice) : null;
      const total = row.total ? legacyMoney(row.total) : null;
      if (unitPrice === null && total !== null && quantity) unitPrice = Math.round((total / quantity) * 100) / 100;
      const cause = (/\b([A-H])\b/.exec(row.cause || "") || [])[1] || "";
      const classification = (/\b([ABC])\b/.exec(row.classification || "") || [])[1] || "";
      if (!row.material && !quantity && !unitPrice) continue;
      items.push({
        date: readDate(row.date || "", order),
        material: materialCode(row.material || "").slice(0, 40),
        quantity: quantity !== null && quantity > 0 ? quantity : null,
        name: (row.name || "").slice(0, 120),
        defect: (row.defect || "").slice(0, 300),
        cause: CAUSE_CODES.has(cause) ? cause : "",
        vin: (row.vin || "").replace(/\s+/g, "").slice(0, 30),
        op: (row.op || "").replace(/\D+/g, "").slice(0, 20),
        unitPrice: unitPrice !== null && unitPrice >= 0 ? unitPrice : null,
        classification,
      });
    }
    if (!items.length) notes.push("Nenhum item lido na tabela: preencha os itens depois de importar.");
    approvers = scrapApprovers(runs, approvers);
  }
  const latest = items.map((item) => item.date).filter(Boolean).sort().at(-1) || "";
  // Data do formulário: a do nome do arquivo, se for logo depois dos itens; senão a do último item.
  const formDate = reference && (!latest || (reference >= latest && days(reference, latest) <= 30)) ? reference : latest || reference || todayIso();
  return {
    data: { formDate, items, approvers, costCenter: "", sapDocument: "", pr: "", prDate: "", po: "", notes: "" },
    notes,
  };
}

/** Linha "Name" do quadro Approval: cada nome vai para o cargo mais perto. */
function scrapApprovers(runs: TextRun[], fallback: Record<string, string>) {
  const roles: { slot: string; x: number; y: number }[] = [];
  const patterns: [string, RegExp][] = [
    ["production", /Production Supervisor/i],
    ["quality", /Quality/i],
    ["logistics", /Logistics/i],
    ["finance", /Finance/i],
  ];
  for (const [slot, pattern] of patterns) {
    const run = runs.filter((entry) => pattern.test(entry.text) && /\d\s*ª|Supervisor|Responsible|Department/i.test(entry.text)).sort((a, b) => a.y - b.y)[0];
    if (run) roles.push({ slot, x: center(run), y: run.y });
  }
  if (roles.length < 2) return fallback;
  const roleY = Math.min(...roles.map((role) => role.y));
  const label = runs.filter((run) => /^Name$/i.test(run.text.trim()) && run.y < roleY).sort((a, b) => b.y - a.y)[0];
  const lineY = label?.y ?? roleY - 12;
  const names = runs.filter((run) => !run.rotated && run !== label && Math.abs(run.y - lineY) <= Math.max(2, run.size * 0.6) && /[A-Za-zÀ-ú]{2}/.test(run.text) && !/^Name$/i.test(run.text.trim()));
  const out = { ...fallback };
  for (const name of names) {
    const role = roles.reduce((best, entry) => (Math.abs(entry.x - center(name)) < Math.abs(best.x - center(name)) ? entry : best));
    out[role.slot] = name.text.trim().slice(0, 80);
  }
  return out;
}

/* ------------------------------------------------------------------------ */
/* FO.FI.C.007                                                               */
/* ------------------------------------------------------------------------ */

const CC_LABELS: [string, RegExp][] = [
  ["item", /^ITEM$/i],
  ["company", /^COMPANY$/i],
  ["plant", /^PLANT$/i],
  ["wh", /^WH$/i],
  ["material", /^MATERIAL( CODE)?$/i],
  ["description", /^DESCRIPTION( OF MATERIAL)?$/i],
  ["quantity", /^QT[YD]\.?$/i],
  ["unitCost", /^UNIT COST$/i],
  ["total", /^TOTAL COST$/i],
  ["costCenter", /^COST CENTER$/i],
  ["costCenterDescription", /^COST CENTER DESCRIPTION$/i],
];
const MONTHS = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
const monthIndex = (name: string) => MONTHS.indexOf(name.toLowerCase().replace("marco", "março")) + 1;

/** Linhas que não são itens: rodapé, número de página e títulos das páginas do portal. */
const NOT_ITEM = /gerado no Controle de Produ|^Página \d+\/\d+$|^Continua na página|^Continuação|^Itens \d+ a \d+ de \d+$|^Aprovação ·/i;
const nearest = (run: TextRun, columns: Column[]) =>
  columns.reduce((best, column) => (Math.abs(column.x - center(run)) < Math.abs(best.x - center(run)) ? column : best)).key;

/**
 * Itens de uma página: cada item começa no número da coluna ITEM (sem ela, no
 * código do material); o texto que está na faixa dele é dele — assim a
 * descrição quebrada em duas linhas vem inteira.
 */
function ccRows(runs: TextRun[], columns: Column[], top: number) {
  const stop = runs.filter((run) => /^(TOTAL\b|REMARKS:?$)/i.test(run.text.trim()) && run.y < top).sort((a, b) => b.y - a.y)[0];
  const body = runs.filter((run) => run.y < top && (!stop || run.y > stop.y + stop.size * 0.4) && !NOT_ITEM.test(run.text.trim()));
  let anchors = body.filter((run) => /^\d{1,4}$/.test(run.text.trim()) && nearest(run, columns) === "item");
  if (!anchors.length) anchors = body.filter((run) => nearest(run, columns) === "material" && /^[A-Z0-9][A-Z0-9.\-_/]{3,}$/i.test(run.text.trim()));
  anchors = anchors.sort((a, b) => b.y - a.y).filter((run, index, list) => index === 0 || Math.abs(list[index - 1].y - run.y) > 1);
  const reach = anchors.map((anchor, index) => {
    const gaps = [index > 0 ? anchors[index - 1].y - anchor.y : Infinity, index < anchors.length - 1 ? anchor.y - anchors[index + 1].y : Infinity];
    const gap = Math.min(...gaps);
    return Number.isFinite(gap) ? gap / 2 : anchor.size * 1.6;
  });
  const rows: TextRun[][] = anchors.map(() => []);
  for (const run of body) {
    let best = -1,
      distance = Infinity;
    anchors.forEach((anchor, index) => {
      const d = Math.abs(anchor.y - run.y);
      if (d < distance) {
        distance = d;
        best = index;
      }
    });
    if (best >= 0 && distance <= reach[best] + 0.5) rows[best].push(run);
  }
  // Código vai no material; texto com espaço perto do material é a descrição (alinhada à esquerda, longe do centro do título).
  const strong = (run: TextRun) => {
    const text = run.text.trim();
    if (/^\d{8}(-\d{2})?$/.test(text)) return "material";
    return nearest(run, columns) === "material" && /\s/.test(text) ? "description" : null;
  };
  return rows.map((row) => cells([...row].sort((a, b) => b.y - a.y || a.x - b.x), columns, strong));
}

/** REMARKS (motivo) e APPROVAL (nomes) da página que tem o quadro. */
function ccRemarks(runs: TextRun[], notes: string[]) {
  const labels = (pattern: RegExp) => runs.filter((run) => pattern.test(run.text.trim())).sort((a, b) => b.y - a.y)[0];
  const main = labels(/^INFORM THE MAIN REASON:?$/i),
    reason = labels(/^REASON:?$/i),
    action = labels(/^ACTION:?$/i),
    responsible = labels(/^RESPONSIBLE$/i),
    nameLabel = labels(/^NAME$/i);
  const remarks: Record<string, string[]> = { mainReason: [], reason: [], action: [] };
  // O quadro APPROVAL começa no RESPONSIBLE ou no primeiro cargo (o que estiver mais à esquerda).
  const roleStart = runs.filter((run) => /Requester|Direct Manager|SCM Manager|Finance Department/i.test(run.text)).map((run) => run.x);
  const limit = Math.min(responsible ? responsible.x : Infinity, ...roleStart) - 2;
  if (main && reason && action) {
    const columns = [
      { key: "mainReason", x: center(main) },
      { key: "reason", x: center(reason) },
      { key: "action", x: center(action) },
    ];
    for (const line of lines(runs.filter((run) => run.y < main.y - main.size * 0.5 && run.x < limit && center(run) < limit && !NOT_ITEM.test(run.text.trim()))))
      for (const run of line.runs) {
        const key = columns.reduce((best, column) => (Math.abs(column.x - center(run)) < Math.abs(best.x - center(run)) ? column : best)).key;
        remarks[key].push(run.text);
      }
  } else notes.push("Não achei o quadro REMARKS: confira o motivo depois de importar.");

  const approvers = defaultApprovers(null, CC_SLOTS);
  if (responsible && nameLabel) {
    const roles: [string, RegExp][] = [
      ["requester", /Requester/i],
      ["manager", /Manager/i],
      ["scm", /SCM/i],
      ["finance", /Finance/i],
    ];
    const roleRuns = roles
      .map(([slot, pattern]) => ({ slot, run: runs.filter((run) => run.x >= responsible.x - 4 && run.y < responsible.y && pattern.test(run.text) && (slot !== "manager" || !/SCM/i.test(run.text))).sort((a, b) => b.y - a.y)[0] }))
      .filter((entry): entry is { slot: string; run: TextRun } => !!entry.run);
    const nextLabel = runs.filter((run) => run.y === nameLabel.y && run.x > nameLabel.x).sort((a, b) => a.x - b.x)[0];
    const right = nextLabel ? nextLabel.x - 2 : nameLabel.x + 400;
    const left = Math.max(...runs.filter((run) => run.y === nameLabel.y && run.x < nameLabel.x).map((run) => run.x + run.width), responsible.x + responsible.width);
    const names = runs
      .filter((run) => run.y < nameLabel.y && center(run) > left && center(run) < right && !/_{3,}|\d{1,2}\/\d{1,2}\/\d{4}/.test(run.text) && /[A-Za-zÀ-ú]{2}/.test(run.text) && !NOT_ITEM.test(run.text.trim()))
      .sort((a, b) => b.y - a.y);
    // Quatro nomes: a ordem de cima para baixo é a do quadro (Solicitante, Gestor, SCM, Financeiro).
    if (names.length === CC_SLOTS.length) names.forEach((name, index) => (approvers[CC_SLOTS[index].id] = name.text.trim().slice(0, 80)));
    else
      for (const name of names) {
        if (!roleRuns.length) break;
        const role = roleRuns.reduce((best, entry) => (Math.abs(entry.run.y - name.y) < Math.abs(best.run.y - name.y) ? entry : best));
        if (Math.abs(role.run.y - name.y) < 60) approvers[role.slot] = name.text.trim().slice(0, 80);
      }
  }
  const join = (key: string, max: number) => remarks[key].join(" ").replace(/\s+/g, " ").trim().slice(0, max);
  return { mainReason: join("mainReason", 600), reason: join("reason", 120), action: join("action", 600), approvers };
}

export function parseLegacyCc(input: PageText | PageText[], fileName = ""): { data: CcFormData; notes: string[] } {
  const notes: string[] = [];
  const pages = (Array.isArray(input) ? input : [input]).map((page) => page.runs.filter((run) => !run.rotated));
  const all = pages.flat();
  // Mês de referência: "Junho/2026"; se houver mais de um, vale o do nome do arquivo.
  const periodsOf = (runs: TextRun[]) =>
    runs
      .map((run) => /^([A-Za-zçÇ]+)\s*\/\s*(\d{4})$/.exec(run.text.trim()))
      .filter((match): match is RegExpExecArray => !!match && monthIndex(match[1]) > 0)
      .map((match) => `${match[2]}-${pad(monthIndex(match[1]))}`);
  const periods = [...new Set(periodsOf(pages[0] || []).length ? periodsOf(pages[0] || []) : periodsOf(all))];
  const lower = fileName.toLowerCase();
  const named = MONTHS.findIndex((month) => lower.includes(month) || lower.includes(month.replace("ç", "c")));
  const yearInName = /20\d{2}/.exec(fileName)?.[0];
  const fromName = named >= 0 && yearInName ? `${yearInName}-${pad(named + 1)}` : "";
  const period = periods.find((value) => value === fromName) || periods[0] || (isPeriod(fromName) ? fromName : todayIso().slice(0, 7));
  if (periods.length > 1) notes.push(`O PDF mostra mais de um mês (${periods.join(", ")}): ficou ${period}.`);

  // Itens de todas as páginas; página de continuação sem título da tabela usa as colunas da anterior.
  const items: CcItem[] = [];
  let columns: Column[] | null = null;
  for (const runs of pages) {
    const head = header(runs, CC_LABELS, /^ITEM$/i);
    if (head) columns = head.columns;
    if (!columns) continue;
    for (const row of ccRows(runs, columns, head ? head.y - head.size * 0.3 : Infinity)) {
      const material = materialCode(row.material || "");
      const quantity = row.quantity ? legacyQuantity(row.quantity) : null;
      if (!material && !(row.description && quantity !== null)) continue;
      let unitCost = row.unitCost ? legacyMoney(row.unitCost) : null;
      const total = row.total ? legacyMoney(row.total) : null;
      // O total da linha vale: o custo unitário é o que reproduz o total (centavo a centavo).
      if (total !== null && quantity) {
        const same = (value: number) => cents(Math.abs(value) * quantity) === cents(total) || cents(Math.abs(value * quantity)) === cents(Math.abs(total));
        if (unitCost === null || !same(unitCost)) unitCost = unitFromTotal(total, quantity);
      }
      items.push({
        company: (row.company || CC_DEFAULTS.company).toUpperCase().slice(0, 10),
        plant: (row.plant || CC_DEFAULTS.plant).toUpperCase().slice(0, 10),
        wh: (row.wh || CC_DEFAULTS.wh).toUpperCase().slice(0, 10),
        material: material.slice(0, 40),
        description: (row.description || "").replace(/\s+/g, " ").trim().slice(0, 120),
        quantity,
        unitCost: unitCost !== null ? Math.abs(unitCost) : null,
        costCenter: (row.costCenter || "").toUpperCase().slice(0, 20),
        costCenterDescription: (row.costCenterDescription || "").replace(/\s+/g, " ").trim().slice(0, 80),
      });
    }
  }
  if (!columns) notes.push("Não achei a tabela de itens: confira e preencha os itens depois de importar.");
  else if (!items.length) notes.push("Nenhum item lido na tabela: preencha os itens depois de importar.");

  // REMARKS / APPROVAL: na página que tem o quadro (no FO.FI.C.007 longo do portal, a última).
  const remarksPage = [...pages].reverse().find((runs) => runs.some((run) => /^INFORM THE MAIN REASON:?$/i.test(run.text.trim()))) || pages[0] || [];
  const remarks = ccRemarks(remarksPage, notes);
  return {
    data: {
      period,
      items,
      mainReason: remarks.mainReason,
      reason: remarks.reason,
      action: remarks.action,
      approvers: remarks.approvers,
      scrapForms: [],
      sapDocument: "",
      notes: "",
    },
    notes,
  };
}

/* ------------------------------------------------------------------------ */

/** Qual formulário é: pelo texto da página; PDF escaneado (sem texto), pelo nome do arquivo. */
export function legacyKind(page: PageText, fileName = ""): DocKind | null {
  const text = page.runs.map((run) => run.text).join(" ");
  if (/FO\.?FI\.?C\.?007|INVENTORY ADJUSTMENT/i.test(text)) return "cc";
  if (/Scrap Form|DESCRIPTION OF THE DEFECT/i.test(text)) return "scrap";
  if (/scrap/i.test(fileName)) return "scrap";
  if (/FO\.?FI|invent[aá]rio|ajuste|baixa/i.test(fileName)) return "cc";
  return null;
}

/** Dados gravados pelo portal no PDF que ele emitiu (Info WBYDData). */
export function embeddedForm(doc: PDFDocument): { kind: DocKind; number: string; data: ScrapFormData | CcFormData } | null {
  try {
    const info = doc.context.lookup(doc.context.trailerInfo.Info);
    if (!(info instanceof PDFDict)) return null;
    const value = info.lookup(PDFName.of("WBYDData"));
    const text = value instanceof PDFString || value instanceof PDFHexString ? value.decodeText() : "";
    if (!text) return null;
    const parsed = JSON.parse(new TextDecoder().decode(base64ToBytes(text)));
    if (parsed?.v !== 1 || (parsed.kind !== "scrap" && parsed.kind !== "cc") || !parsed.data || typeof parsed.data !== "object" || !Array.isArray(parsed.data.items)) return null;
    return { kind: parsed.kind, number: typeof parsed.number === "string" ? parsed.number : "", data: parsed.data };
  } catch {
    return null;
  }
}

const EMPTY_PAGE: PageText = { width: 0, height: 0, box: { x: 0, y: 0, width: 0, height: 0 }, runs: [] };
export async function readLegacyPdf(bytes: Uint8Array, fileName = "", forced?: DocKind): Promise<LegacyDocument> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false });
  const embedded = embeddedForm(doc);
  if (embedded && (!forced || forced === embedded.kind))
    return embedded.kind === "cc"
      ? { kind: "cc", data: embedded.data as CcFormData, notes: [], hasText: true, embedded: true }
      : { kind: "scrap", data: embedded.data as ScrapFormData, notes: [], hasText: true, embedded: true };
  const pages: PageText[] = [];
  for (let index = 0; index < Math.min(doc.getPageCount(), 30); index++) {
    try {
      pages.push(pageText(doc, index));
    } catch {
      pages.push(EMPTY_PAGE);
    }
  }
  const page = pages[0] || EMPTY_PAGE;
  const hasText = pages.reduce((sum, entry) => sum + entry.runs.length, 0) > 5;
  const kind = forced || legacyKind(page, fileName);
  const scanned = hasText ? [] : ["PDF sem texto (escaneado ou imagem): os itens não dão para ler; preencha depois de importar."];
  if (kind === "scrap") {
    const result = parseLegacyScrap(page, fileName);
    return { kind, data: result.data, notes: [...scanned, ...(hasText ? result.notes : [])], hasText };
  }
  if (kind === "cc") {
    const result = parseLegacyCc(pages, fileName);
    return { kind, data: result.data, notes: [...scanned, ...(hasText ? result.notes : [])], hasText };
  }
  return { kind: null, notes: [...scanned, "Não reconheci o formulário: escolha se é Scrap Form ou FO.FI.C.007."], hasText };
}
