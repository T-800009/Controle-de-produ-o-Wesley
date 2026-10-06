/**
 * FO.FI.C.007 — Inventory Adjustment (baixa / ajuste de estoque em centro de custo).
 *
 * Mesmo fluxo do Scrap Form: o portal preenche, gera o PDF com um campo de
 * assinatura digital por quadro (Solicitante, Gestor, SCM, Financeiro — todos
 * obrigatórios), confere o PDF assinado e guarda a versão final.
 * Os itens podem vir de Scrap Forms assinados (quantidade negativa = saída do estoque).
 */
import {
  CC_SLOTS,
  brMoney,
  cents,
  defaultApprovers,
  materialCode,
  parseBrNumber,
  signatureProgress,
  text,
  todayIso,
  type ScrapForm,
} from "./scrap-form.ts";

/** Página 1 com 20 itens e o quadro de aprovação; o resto vai em páginas de continuação. */
export const MAX_CC_ITEMS = 300;
export const CC_TITLE = "FO.FI.C.007 - INVENTORY ADJUSTMENT";

export type CcItem = {
  company: string;
  plant: string;
  wh: string;
  material: string;
  description: string;
  /** Negativa = saída do estoque (baixa); positiva = entrada (sobra no inventário). */
  quantity: number | null;
  unitCost: number | null;
  costCenter: string;
  costCenterDescription: string;
};
export type CcFormData = {
  /** Mês de referência, aaaa-mm ("Junho/2026" no PDF). */
  period: string;
  items: CcItem[];
  /** REMARKS: INFORM THE MAIN REASON / REASON / ACTION. */
  mainReason: string;
  reason: string;
  action: string;
  approvers: Record<string, string>;
  /** Scrap Forms que deram origem a esta baixa (números SCRAP-…). */
  scrapForms: string[];
  sapDocument: string;
  notes: string;
  /** FO.FI.C.007 que já existia (importado): nome do PDF original. */
  source?: string;
};
export type CcForm = Omit<ScrapForm, "data"> & { data: CcFormData };

export type CcDefaults = Pick<CcItem, "company" | "plant" | "wh" | "costCenter" | "costCenterDescription">;
export const CC_DEFAULTS: CcDefaults = { company: "BR00", plant: "BR02", wh: "7000", costCenter: "BR000411", costCenterDescription: "Operational - Chassis" };

const MONTHS = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];
export const isPeriod = (value: unknown): value is string => typeof value === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
/** 2026-06 → "Junho/2026" */
export function periodLabel(period: string) {
  if (!isPeriod(period)) return "";
  const [year, month] = period.split("-");
  return `${MONTHS[Number(month) - 1]}/${year}`;
}

export function emptyCcItem(defaults: Partial<CcDefaults> = {}, previous?: Partial<CcItem>): CcItem {
  return {
    company: previous?.company || defaults.company || CC_DEFAULTS.company,
    plant: previous?.plant || defaults.plant || CC_DEFAULTS.plant,
    wh: previous?.wh || defaults.wh || CC_DEFAULTS.wh,
    material: "",
    description: "",
    quantity: null,
    unitCost: null,
    costCenter: previous?.costCenter || defaults.costCenter || CC_DEFAULTS.costCenter,
    costCenterDescription: previous?.costCenterDescription || defaults.costCenterDescription || CC_DEFAULTS.costCenterDescription,
  };
}
export function emptyCcForm(approvers?: Partial<Record<string, string>> | null, defaults: Partial<CcDefaults> = {}): CcFormData {
  return {
    period: todayIso().slice(0, 7),
    items: [emptyCcItem(defaults)],
    mainReason: "",
    reason: "",
    action: "",
    approvers: defaultApprovers(approvers, CC_SLOTS),
    scrapForms: [],
    sapDocument: "",
    notes: "",
  };
}

function signedAmount(value: unknown, max: number, allowNegative: boolean): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : parseBrNumber(String(value));
  if (parsed === null || !Number.isFinite(parsed) || Math.abs(parsed) > max || (!allowNegative && parsed < 0)) throw Error("Quantidade ou custo inválido.");
  return parsed;
}

export function sanitizeCcData(input: unknown): CcFormData {
  const raw = (input && typeof input === "object" ? input : null) as Record<string, any> | null;
  if (!raw || !Array.isArray(raw.items)) throw Error("Formulário inválido.");
  if (raw.items.length > MAX_CC_ITEMS) throw Error(`Use no máximo ${MAX_CC_ITEMS} itens por formulário. Crie outro formulário para os demais.`);
  const items = raw.items.map((item: any) => {
    if (!item || typeof item !== "object") throw Error("Item inválido.");
    return {
      company: text(item.company, 10).toUpperCase(),
      plant: text(item.plant, 10).toUpperCase(),
      wh: text(item.wh, 10).toUpperCase(),
      material: materialCode(item.material).slice(0, 40),
      description: text(item.description, 120),
      quantity: signedAmount(item.quantity, 10_000_000, true),
      unitCost: signedAmount(item.unitCost, 1_000_000_000, false),
      costCenter: text(item.costCenter, 20).toUpperCase(),
      costCenterDescription: text(item.costCenterDescription, 80),
    } satisfies CcItem;
  });
  const approvers: Record<string, string> = {};
  for (const slot of CC_SLOTS) approvers[slot.id] = text(raw.approvers?.[slot.id], 80);
  const scrapForms = Array.isArray(raw.scrapForms) ? [...new Set(raw.scrapForms.map((value: unknown) => text(value, 30)).filter((value: string) => /^SCRAP-\d{4}-\d{4,}$/.test(value)))].slice(0, 50) : [];
  return {
    period: isPeriod(raw.period) ? raw.period : todayIso().slice(0, 7),
    items,
    mainReason: text(raw.mainReason, 600),
    reason: text(raw.reason, 120),
    action: text(raw.action, 600),
    approvers,
    scrapForms: scrapForms as string[],
    sapDocument: text(raw.sapDocument, 40),
    notes: text(raw.notes, 500),
    ...(raw.source ? { source: text(raw.source, 160) } : {}),
  };
}

export function ccItemTotal(item: Pick<CcItem, "quantity" | "unitCost">) {
  return item.quantity === null || item.unitCost === null ? null : cents(item.quantity * item.unitCost);
}
export function ccTotals(data: Pick<CcFormData, "items">) {
  return {
    quantity: Math.round(data.items.reduce((sum, item) => sum + (item.quantity || 0), 0) * 1000) / 1000,
    cost: cents(data.items.reduce((sum, item) => sum + (ccItemTotal(item) || 0), 0)),
  };
}

export function ccProblems(data: CcFormData): string[] {
  const problems: string[] = [];
  if (!data.items.length) problems.push("Inclua pelo menos um item.");
  data.items.forEach((item, index) => {
    const missing: string[] = [];
    if (!item.company) missing.push("company");
    if (!item.plant) missing.push("plant");
    if (!item.wh) missing.push("depósito (WH)");
    if (!item.material) missing.push("código do material");
    if (!item.description) missing.push("descrição");
    if (item.quantity === null || item.quantity === 0) missing.push("quantidade (negativa para baixa)");
    if (item.unitCost === null || item.unitCost <= 0) missing.push("custo unitário");
    if (!item.costCenter) missing.push("centro de custo");
    if (!item.costCenterDescription) missing.push("descrição do centro de custo");
    if (missing.length) problems.push(`Item ${index + 1}: informe ${missing.join(", ")}.`);
  });
  if (!data.mainReason) problems.push("Informe o motivo principal (INFORM THE MAIN REASON).");
  if (!data.reason) problems.push("Informe o motivo resumido (REASON).");
  if (!data.action) problems.push("Informe a ação (ACTION).");
  for (const slot of CC_SLOTS) if (!data.approvers[slot.id]) problems.push(`Informe o nome do responsável: ${slot.label}.`);
  return problems;
}

/** "FO.FI.C.007 CC-2026-0001 Junho-2026 - para assinatura.pdf" */
export function ccFileName(form: Pick<CcForm, "number" | "data" | "status" | "signatures">) {
  const base = `FO.FI.C.007 ${form.number}${form.data.period ? " " + periodLabel(form.data.period).replace("/", "-") : ""}`;
  if (form.status === "draft") return `${base} - rascunho.pdf`;
  const progress = signatureProgress(form.data, form.signatures, "cc");
  if (progress.complete) return `${base} - ASSINADO.pdf`;
  if (!progress.signed.length) return `${base} - para assinatura.pdf`;
  const missing = progress.missing.map((entry) => entry.expected.split(/\s+/)[0] || entry.slot.label);
  return `${base} - falta assinar ${missing.join(" e ")}.pdf`.replace(/[\\/:*?"<>|]+/g, "-");
}

export function ccShareMessage(form: Pick<CcForm, "number" | "data" | "status" | "signatures">, link = "") {
  const progress = signatureProgress(form.data, form.signatures, "cc");
  const totals = ccTotals(form.data);
  const name = `FO.FI.C.007 ${form.number} (${periodLabel(form.data.period)})`;
  const lines = form.data.items.map(
    (item) => `• ${item.material} — ${item.description} · ${item.quantity ?? "?"} · ${brMoney(ccItemTotal(item)) || "sem valor"} · CC ${item.costCenter}`,
  );
  const subject = progress.complete
    ? `${name} assinado — ${brMoney(totals.cost)}`
    : `${name} para assinatura — ${progress.missing.map((entry) => entry.slot.label).join(", ")}`;
  const intro = progress.complete
    ? `Segue o ${name} com todas as assinaturas.`
    : `Segue o ${name} para assinatura digital. Falta: ${progress.missing.map((entry) => `${entry.expected} (${entry.slot.label})`).join(", ")}.`;
  const how = progress.complete ? [] : ["", "Abra o PDF no Adobe, clique no campo do seu quadro e assine com o seu certificado. Depois devolva o PDF assinado."];
  const origin = form.data.scrapForms.length ? ["", `Origem: ${form.data.scrapForms.join(", ")}.`] : [];
  const body = [intro, "", ...lines, `Total: ${brMoney(totals.cost)}`, ...origin, ...how, ...(link ? ["", link] : [])].join("\n");
  return { subject, body };
}

/**
 * Itens e textos a partir de Scrap Forms assinados: cada peça sucateada sai do
 * estoque (quantidade negativa) pelo centro de custo escolhido.
 */
export function ccFromScrapForms(forms: Pick<ScrapForm, "number" | "data">[], defaults: Partial<CcDefaults> = {}) {
  const base = { ...CC_DEFAULTS, ...Object.fromEntries(Object.entries(defaults).filter(([, value]) => value)) } as CcDefaults;
  const items: CcItem[] = forms.flatMap((form) =>
    form.data.items.map((item) => ({
      company: base.company,
      plant: base.plant,
      wh: base.wh,
      material: item.material,
      description: item.name,
      quantity: item.quantity === null ? null : -Math.abs(item.quantity),
      unitCost: item.unitPrice,
      costCenter: base.costCenter,
      costCenterDescription: base.costCenterDescription,
    })),
  );
  const numbers = forms.map((form) => form.number);
  const list = numbers.join(", ");
  return {
    items,
    scrapForms: numbers,
    mainReason: `Scrapped materials approved in Scrap Form ${list}. Parts damaged or defective in production, not repairable.`,
    reason: "Scrap",
    action: `Write off the scrapped quantities from warehouse ${base.wh} through cost center ${base.costCenter} - ${base.costCenterDescription}.`,
  };
}

export function summarizeCcForms(forms: CcForm[]) {
  let open = 0,
    signed = 0,
    valueOpen = 0;
  for (const form of forms) {
    if (form.status === "signing") {
      open++;
      valueOpen += ccTotals(form.data).cost;
    }
    if (form.status === "signed") signed++;
  }
  return { open, signed, drafts: forms.filter((form) => form.status === "draft").length, valueOpen: cents(valueOpen) };
}


/* ------------------------------------------------------------------------ */
/* Itens a partir de uma planilha (ex.: LOSS 7000.xlsx, exportada da MB52)   */
/* ------------------------------------------------------------------------ */

const plain = (value: unknown) =>
  String(value ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
const SHEET_COLUMNS: Record<string, string[]> = {
  material: ["material", "codigo", "codigosap", "materialcode", "sap", "partnumber", "pn", "pnsap"],
  description: ["textobrevematerial", "textobrevedematerial", "textobreve", "descricao", "descricaodomaterial", "descriptionofmaterial", "description"],
  company: ["company", "empresa"],
  plant: ["centro", "plant"],
  wh: ["deposito", "wh", "storagelocation", "sloc"],
  stock: ["utilizacaolivre", "utilizlivre", "estoquelivre", "estoque", "saldo", "unrestricted"],
  quantity: ["quantidade", "qtd", "qty", "quantity", "qtde"],
  value: ["valutilizlivre", "valutilizacaolivre", "valorutilizacaolivre", "valorlivre", "valor", "valortotal", "totalcost", "custototal", "montante"],
  unitCost: ["custounitario", "custounit", "unitcost", "precounitario", "precomedio", "preco"],
  costCenter: ["centrodecusto", "costcenter", "cc"],
  costCenterDescription: ["descricaodocentrodecusto", "costcenterdescription", "descricaocc"],
  comment: ["comentarios", "comentario", "observacao", "observacoes", "motivo", "reason"],
};
/** Número de célula do Excel: número de verdade ou texto "R$ 1.471,23" / "1,471.23" / "10-". */
export function sheetNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  let text = String(value ?? "")
    .replace(/R\$|\s| /g, "")
    .trim();
  if (!text) return null;
  let negative = false;
  if (/^-|-$|^\(.*\)$/.test(text)) {
    negative = true;
    text = text.replace(/^-|-$|^\(|\)$/g, "");
  }
  if (!/^[\d.,]+$/.test(text)) return null;
  const comma = text.lastIndexOf(","),
    dot = text.lastIndexOf(".");
  if (comma >= 0 && dot >= 0) text = comma > dot ? text.replace(/\./g, "").replace(",", ".") : text.replace(/,/g, "");
  else if (comma >= 0) text = /,\d{3}$/.test(text) && text.split(",").length > 2 ? text.replace(/,/g, "") : text.replace(",", ".");
  else if (/^\d{1,3}(\.\d{3}){2,}$/.test(text)) text = text.replace(/\./g, "");
  const parsed = Number(text);
  return Number.isFinite(parsed) ? (negative ? -parsed : parsed) : null;
}

/** Custo unitário com o mínimo de casas que ainda dá o total da planilha (centavo a centavo). */
function unitFromTotal(total: number, quantity: number) {
  const raw = Math.abs(total) / Math.abs(quantity);
  for (let digits = 2; digits <= 8; digits++) {
    const unit = Math.round(raw * 10 ** digits) / 10 ** digits;
    if (cents(quantity * unit) === cents(Math.sign(quantity) * Math.abs(total))) return unit;
  }
  return Math.round(raw * 1e8) / 1e8;
}

/**
 * Linhas de uma planilha (primeira aba, com cabeçalho) → itens do FO.FI.C.007.
 * "Utilização livre" (estoque) vira baixa: quantidade negativa. Uma coluna
 * "Quantidade" mantém o sinal que veio. Custo unitário = valor ÷ quantidade
 * quando a planilha só traz o valor total.
 */
export function ccFromSpreadsheet(rows: unknown[][], defaults: Partial<CcDefaults> = {}) {
  const base = { ...CC_DEFAULTS, ...Object.fromEntries(Object.entries(defaults).filter(([, value]) => value)) } as CcDefaults;
  const headerIndex = rows.findIndex((row) => Array.isArray(row) && row.some((cell) => SHEET_COLUMNS.material.includes(plain(cell))));
  if (headerIndex < 0) throw Error("Não achei a coluna Material na planilha. A primeira linha da tabela tem de ter os nomes das colunas.");
  const header = rows[headerIndex].map(plain);
  const column = (key: string) => header.findIndex((name) => SHEET_COLUMNS[key].includes(name));
  const at = Object.fromEntries(Object.keys(SHEET_COLUMNS).map((key) => [key, column(key)])) as Record<string, number>;
  const quantityColumn = at.stock >= 0 ? at.stock : at.quantity;
  if (quantityColumn < 0) throw Error('Não achei a coluna de quantidade (por exemplo "Utilização livre" ou "Quantidade").');
  if (at.unitCost < 0 && at.value < 0) throw Error('Não achei o custo: a planilha precisa de "Val.utiliz.livre" (valor total) ou de um custo unitário.');
  const cell = (row: unknown[], index: number) => (index >= 0 ? row[index] : undefined);
  const text = (row: unknown[], index: number) => String(cell(row, index) ?? "").trim();
  const items: CcItem[] = [];
  const comments = new Set<string>();
  let skipped = 0;
  for (const row of rows.slice(headerIndex + 1)) {
    if (!Array.isArray(row)) continue;
    const material = materialCode(text(row, at.material));
    const amount = sheetNumber(cell(row, quantityColumn));
    if (!material || amount === null || amount === 0) {
      if (row.some((value) => String(value ?? "").trim())) skipped++;
      continue;
    }
    const quantity = at.stock >= 0 ? -Math.abs(amount) : amount;
    const unit = sheetNumber(cell(row, at.unitCost));
    const value = sheetNumber(cell(row, at.value));
    const unitCost = unit !== null ? Math.abs(unit) : value !== null ? unitFromTotal(value, quantity) : null;
    const comment = text(row, at.comment);
    if (comment) comments.add(comment);
    items.push({
      company: (text(row, at.company) || base.company).toUpperCase().slice(0, 10),
      plant: (text(row, at.plant) || base.plant).toUpperCase().slice(0, 10),
      wh: (text(row, at.wh) || base.wh).toUpperCase().slice(0, 10),
      material: material.slice(0, 40),
      description: text(row, at.description).slice(0, 120),
      quantity,
      unitCost,
      costCenter: (text(row, at.costCenter) || base.costCenter).toUpperCase().slice(0, 20),
      costCenterDescription: (text(row, at.costCenterDescription) || base.costCenterDescription).slice(0, 80),
    });
  }
  const reason = comments.size === 1 ? [...comments][0] : "";
  const warehouses = [...new Set(items.map((item) => item.wh))].join(", ");
  return {
    items,
    skipped,
    reason,
    mainReason: reason ? `Materials listed as ${reason} in warehouse ${warehouses}.` : "",
    action: items.length ? `Write off the quantities from warehouse ${warehouses} through cost center ${base.costCenter} - ${base.costCenterDescription}.` : "",
  };
}
