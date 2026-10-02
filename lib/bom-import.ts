import * as XLSX from "xlsx";
import { normalize, number, pick, validateRows, type Row } from "./materials.ts";
import { joinExcelMB51 } from "./excel-mb51.ts";
import { addFixedBomItems } from "./bom-additions.ts";
import { table } from "./workbook-join.ts";

/**
 * Cadastro de BOM a partir de um Excel.
 *
 * - Usa a aba escolhida (ou a que mais parece BOM) — nunca adivinha outra aba.
 * - Acha o cabeçalho nas primeiras linhas, mesmo com título acima.
 * - Colunas por prioridade: Qtd.necessária vence "Quantidade" genérica.
 * - OPs: números no cabeçalho; senão aba Ordens do modelo; senão OPs coladas.
 * - Aba MB51 do arquivo é opcional: se não cruzar, a BOM entra assim mesmo e a
 *   MB51 do Google Sheets é lida em Atualizar dados.
 */

const MATERIAL = ["Material", "Código SAP", "SAP", "SAP No.", "SAP No", "Código", "Part Number", "Componente", "Component"];
const DESCRIPTION = ["Texto breve material", "Texto breve do material", "Descrição", "Description", "Denominação", "Texto breve"];
const UNIT = ["UMB", "UM básica", "Unidade de medida básica", "Unidade", "Base Unit of Measure", "Unit", "UM", "Un"];
const REQUIRED = [
  "Qtd.necessária",
  "Qtd. necessária",
  "Quantidade necessária",
  "Qtd por ônibus",
  "Qtd/ônibus",
  "Qtd. por ônibus",
  "BOM QTY",
  "Qtd BOM",
  "Qtd. BOM",
  "Quantidade BOM",
  "Qtd",
  "Qtd.",
  "Quantidade",
  "Qty",
  "Quantity",
];
const CLASS = ["CLASSIFICAÇÃO", "Classificação", "Classe", "Class"];
const ITEM = ["ITEM BOM SAP", "Item lista técnica", "Item BOM", "Item"];
const OP = /^\d{8,18}$/;

const opLabel = (value: unknown) =>
  String(value ?? "")
    .trim()
    .replace(/\.0+$/, "");
/** First alias (in priority order) present in the header. */
function column(headers: string[], aliases: string[]) {
  const labels = headers.map(normalize);
  for (const alias of aliases) {
    const index = labels.indexOf(normalize(alias));
    if (index >= 0) return index;
  }
  return -1;
}
export const isMb51Sheet = (name: string) => /mb\s*51/i.test(name);

export type SheetDiagnosis = {
  sheet: string;
  headerRow: number;
  materials: number;
  hasRequired: boolean;
  hasUnit: boolean;
  ops: string[];
  score: number;
  summary: string;
  problems: string[];
};

function matrixOf(book: XLSX.WorkBook, sheet: string): unknown[][] {
  const ws = book.Sheets[sheet];
  return ws ? XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true, defval: null }) : [];
}

/** Header = first row (of the first 25) that has a material column. */
function headerIndex(matrix: unknown[][]) {
  const limit = Math.min(matrix.length, 25);
  for (let i = 0; i < limit; i++)
    if (column((matrix[i] || []).map((cell) => String(cell ?? "").trim()), MATERIAL) >= 0) return i;
  return -1;
}

export function parseBomMatrix(matrix: unknown[][], extraOps: string[] = []) {
  const header = headerIndex(matrix);
  const problems: string[] = [];
  if (header < 0)
    return {
      rows: [] as Row[],
      ops: [] as string[],
      headerRow: -1,
      hasRequired: false,
      hasUnit: false,
      problems: ["não tem coluna Material/SAP nas primeiras 25 linhas"],
    };
  const headers = (matrix[header] || []).map((cell) => String(cell ?? "").trim());
  const at = {
    material: column(headers, MATERIAL),
    description: column(headers, DESCRIPTION),
    unit: column(headers, UNIT),
    required: column(headers, REQUIRED),
    classification: column(headers, CLASS),
    item: column(headers, ITEM),
  };
  const opColumns = headers.flatMap((label, index) => (OP.test(opLabel(label)) ? [{ op: opLabel(label), index }] : []));
  const sheetOps = [...new Set(opColumns.map((item) => item.op))];
  const ops = sheetOps.length ? sheetOps : [...new Set(extraOps)];
  if (at.required < 0) problems.push("não tem coluna de quantidade (Qtd.necessária, BOM QTY ou Quantidade)");
  if (at.unit < 0) problems.push("não tem coluna de unidade (UMB)");
  const rows: Row[] = [];
  matrix.slice(header + 1).forEach((cells, i) => {
    const value = (index: number) => (index >= 0 ? (cells?.[index] ?? null) : null);
    const material = String(value(at.material) ?? "").trim();
    if (!material) return;
    const consumption: Row = {};
    if (sheetOps.length) for (const { op, index } of opColumns) consumption[op] = number(value(index));
    else for (const op of ops) consumption[op] = null;
    rows.push({
      id: String(header + i + 2),
      material,
      description: String(value(at.description) ?? ""),
      unit: String(value(at.unit) ?? "").trim(),
      item: at.item >= 0 ? String(value(at.item) ?? "") : "",
      classification: at.classification >= 0 ? String(value(at.classification) ?? "").trim() : "",
      required: number(value(at.required)),
      consumption,
    });
  });
  if (!rows.length) problems.push("não tem linhas com código de material abaixo do cabeçalho");
  return { rows, ops, sheetOps, headerRow: header, hasRequired: at.required >= 0, hasUnit: at.unit >= 0, problems };
}

export function diagnoseWorkbook(book: XLSX.WorkBook): SheetDiagnosis[] {
  return book.SheetNames.map((sheet) => {
    if (isMb51Sheet(sheet))
      return {
        sheet,
        headerRow: -1,
        materials: 0,
        hasRequired: false,
        hasUnit: false,
        ops: [],
        score: -100,
        summary: "movimentos MB51 (não é BOM)",
        problems: ["é uma aba de movimentos MB51, não a BOM"],
      };
    const parsed = parseBomMatrix(matrixOf(book, sheet));
    const materials = parsed.rows.length;
    const withQty = parsed.rows.filter((row) => typeof row.required === "number").length;
    let score = 0;
    if (parsed.headerRow >= 0) score += 3;
    if (parsed.hasRequired && withQty) score += 3;
    if (parsed.hasUnit) score += 2;
    if (parsed.sheetOps?.length) score += 3;
    if (materials) score += 1;
    if (/^\s*consumo\s*$/i.test(sheet)) score += 2;
    else if (/bom|consumo/i.test(sheet)) score += 1;
    if (/compar/i.test(sheet)) score -= 2;
    // SAP stock/price/cost exports have Material + UMB but are never the BOM.
    if (/^\s*(mb52|mm60|kob1|zpp009|coois|7000|2000|1500|1300)\s*$/i.test(sheet)) score -= 6;
    const summary =
      parsed.headerRow < 0 || !materials
        ? "não parece BOM"
        : `${materials} materiais${parsed.sheetOps?.length ? ` · ${parsed.sheetOps.length} OPs` : " · sem OPs no cabeçalho"}${parsed.problems.length ? " · incompleta" : ""}`;
    return {
      sheet,
      headerRow: parsed.headerRow,
      materials,
      hasRequired: parsed.hasRequired,
      hasUnit: parsed.hasUnit,
      ops: parsed.sheetOps || [],
      score,
      summary,
      problems: parsed.problems,
    };
  });
}

export function bestBomSheet(book: XLSX.WorkBook, diagnosis = diagnoseWorkbook(book)) {
  const ranked = [...diagnosis].sort((a, b) => b.score - a.score);
  return ranked[0]?.score > 0 ? ranked[0].sheet : book.SheetNames[0] || "";
}

/** Any 8–18 digit numbers typed or pasted (one per line, commas, spaces…). */
export function parseOpList(text: string) {
  return [...new Set((String(text || "").match(/\b\d{8,18}\b/g) || []).map(String))];
}

/** "BOM BC22S02_1363.xlsx" → "BC22S02" (bus model codes such as BC22X, D9W). */
export function inferModel(fileName: string) {
  const tokens = String(fileName || "")
    .replace(/\.[^.]+$/, "")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  return tokens.find((token) => /^(BC|D)\d/i.test(token) && /[A-Z]/i.test(token.slice(2)))?.toUpperCase() ||
    tokens.find((token) => /^(BC|D)\d/i.test(token))?.toUpperCase() || "";
}

function ordersFromSheets(book: XLSX.WorkBook, model: string) {
  const found = new Set<string>();
  const wanted = model.trim().toUpperCase();
  for (const name of book.SheetNames.filter((n) => /^(ordens|ops)(\b|[_ -])/i.test(n)))
    for (const row of table(book, name, true)) {
      const rowModel = String(pick(row, ["Modelo", "Model"])).trim().toUpperCase();
      if (rowModel ? rowModel !== wanted : !name.toUpperCase().includes(wanted)) continue;
      const op = opLabel(pick(row, ["Ordem", "Ordem de produção", "OP", "Order"]));
      if (OP.test(op)) found.add(op);
    }
  return [...found];
}

export type BomImport = {
  rows: Row[];
  ops: string[];
  source: string;
  notes: string[];
  opsFrom: "sheet" | "orders" | "pasted";
};

/** Builds the BOM from the chosen sheet. Throws a message that says exactly
 * what is missing in that sheet and which other sheet looks like the BOM. */
export function buildBomImport(
  book: XLSX.WorkBook,
  sheet: string,
  { model = "", pastedOps = "", fileName = "" }: { model?: string; pastedOps?: string; fileName?: string } = {},
): BomImport {
  const diagnosis = diagnoseWorkbook(book);
  const selected = diagnosis.find((item) => item.sheet === sheet);
  // Suggest another sheet only when it really looks better than the chosen one.
  const other = diagnosis
    .filter((item) => item.sheet !== sheet && item.score >= 9 && item.score > (selected?.score ?? -Infinity))
    .sort((a, b) => b.score - a.score)[0];
  const hint = other ? ` A aba "${other.sheet}" parece ser a BOM (${other.summary}); selecione-a.` : "";
  const withOps = diagnosis.find((item) => item.sheet !== sheet && item.ops.length && item.materials);
  if (!book.Sheets[sheet]) throw Error("Escolha a aba da planilha que contém a BOM.");
  if (isMb51Sheet(sheet)) throw Error(`A aba "${sheet}" tem movimentos MB51, não a BOM.${hint}`);
  const first = parseBomMatrix(matrixOf(book, sheet));
  const blocking = first.problems.filter((problem) => !/OPs/.test(problem));
  if (blocking.length) throw Error(`A aba "${sheet}" ${blocking.join("; ")}.${hint}`);
  let opsFrom: BomImport["opsFrom"] = "sheet";
  let parsed = first;
  const notes: string[] = [];
  if (!first.sheetOps?.length) {
    const orders = ordersFromSheets(book, model);
    const pasted = parseOpList(pastedOps);
    const extra = orders.length ? orders : pasted;
    if (!extra.length)
      throw Error(
        `A aba "${sheet}" não tem números de OP no cabeçalho. Cole as OPs desta BOM no campo "OPs desta BOM" (uma por linha).${withOps ? ` Ou use a aba "${withOps.sheet}", que tem ${withOps.ops.length} OPs nas colunas.` : ""}`,
      );
    opsFrom = orders.length ? "orders" : "pasted";
    parsed = parseBomMatrix(matrixOf(book, sheet), extra);
    notes.push(
      orders.length
        ? `${orders.length} OPs lidas da aba Ordens para o modelo ${model}.`
        : `${pasted.length} OPs informadas manualmente. O consumo será lido da MB51 em Atualizar dados.`,
    );
  }
  let rows = parsed.rows,
    source = `${fileName} · ${sheet}`;
  const mb51 = book.SheetNames.filter(isMb51Sheet);
  if (mb51.length === 1) {
    try {
      const result = joinExcelMB51(addFixedBomItems(rows, parsed.ops), parsed.ops, table(book, mb51[0]));
      rows = result.rows;
      source = `${fileName} · ${sheet} + ${mb51[0]} · ${result.matched} movimentos`;
    } catch (e) {
      notes.push(
        `A aba ${mb51[0]} do arquivo não foi usada (${(e as Error).message}). Sem problema: a MB51 do Google Sheets é lida em Atualizar dados.`,
      );
    }
  } else if (mb51.length > 1) notes.push("O arquivo tem mais de uma aba MB51; elas foram ignoradas. A MB51 do Google Sheets é lida em Atualizar dados.");
  const withoutQty = rows.filter((row) => row.required === null).length;
  if (withoutQty) notes.push(`${withoutQty} linha(s) sem quantidade na BOM ficam em Conferir dados.`);
  const withoutClass = rows.filter((row) => !String(row.classification || "").trim()).length;
  if (withoutClass && withoutClass < rows.length) notes.push(`${withoutClass} linha(s) sem classe A/B/C ficam em Conferir antes do Warehouse.`);
  else if (withoutClass) notes.push("A aba não tem coluna CLASSIFICAÇÃO: os itens ficam sem classe A/B/C e aparecem em Conferir antes do Warehouse.");
  validateRows(rows, "consumo");
  return { rows, ops: parsed.ops, source, notes, opsFrom };
}
