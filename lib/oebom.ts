import type { Row } from "./materials.ts";

/**
 * BOM DO PLANO (OEBOM da China)
 *
 * Lê o arquivo OEBOM (`BC22S02-DWB1339_OEBOM_A7_V9….xlsx`) e devolve a
 * quantidade POR ÔNIBUS usada na fábrica do Brasil:
 * - aba "采购明细（统计表）BOM（Stats）": coluna "Overseas Factory Use Total"
 *   (quantidade usada no Brasil; se a coluna não existir, usa "Total");
 * - aba "自制件KD清单 Self-made Part KD list": peças KD montadas aqui.
 * O mesmo material nas duas abas conta uma vez (vale a maior quantidade).
 *
 * A demanda do projeto é quantidade por ônibus × ônibus restantes, informado
 * no portal a partir do plano de produção. Não usa OPs nem MB51.
 */

export type PlanBomRow = { id: string; material: string; description: string; unit: string; required: number; source: string };
export type PlanBom = {
  id: string;
  name: string;
  revision: string;
  model: string;
  dwb: string;
  rows: PlanBomRow[];
  statsRows: number;
  kdRows: number;
  warnings: string[];
};
type Grid = unknown[][];

const MATERIAL = /^\d{8}-\d{2}$/;
const text = (value: unknown) => String(value ?? "").trim();
const num = (value: unknown) => {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const s = text(value).replace(",", ".");
  return s !== "" && Number.isFinite(Number(s)) ? Number(s) : null;
};
const round = (value: number) => Math.round(value * 1e9) / 1e9;

const UNIT_MAP: Record<string, string> = {
  PCS: "PCS", PC: "PCS", 个: "PCS", 件: "PCS", 套: "PCS", 只: "PCS", 根: "PCS", 块: "PCS",
  M: "M", METER: "M", METRE: "M", 米: "M",
  KG: "KG", 千克: "KG", 公斤: "KG",
  L: "L", LITRE: "L", LITER: "L", 升: "L",
};
/** "PCS\nPCS" → PCS · "升\nlitre" → L · "M\nM" → M. */
export function planUnit(value: unknown) {
  const parts = text(value)
    .split(/[\n\r/]+/)
    .map((part) => part.trim())
    .filter(Boolean);
  for (const part of [...parts].reverse()) {
    const found = UNIT_MAP[part.toUpperCase()] || UNIT_MAP[part];
    if (found) return found;
  }
  return (parts[parts.length - 1] || "").toUpperCase();
}

/** Modelo e DWB a partir do nome do arquivo ou do "Car Number" (BC22S02-DWB1339). */
export function planIdentity(fileName: string, carNumber = "") {
  const from = (value: string) => value.match(/(BC\d{2}S\d{2}|[A-Z]\d{1,2}[A-Z]{0,2}\d{0,3})[-_ ]*DWB[-_ ]?(\d{3,5})/i);
  const found = from(carNumber) || from(fileName);
  const model = found ? found[1].toUpperCase() : "";
  const dwb = found ? found[2] : (fileName.match(/DWB[-_ ]?(\d{3,5})/i)?.[1] ?? "");
  // "_A7_V92026-08-14…" → A7_V9 (a data vem colada na versão).
  const rev = fileName.match(/_(A\d+)_V(\d+?)(?=20\d{2}-\d{2}-\d{2})/i) || fileName.match(/_(A\d+)_V(\d+)/i);
  const revision = rev ? `${rev[1]}_V${rev[2]}`.toUpperCase() : "";
  return { model, dwb, revision };
}
export const planId = (model: string, dwb: string) =>
  "plano:" + `${model}-dwb${dwb}`.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 120);

function headerRow(grid: Grid, test: (cells: string[]) => boolean, limit = 15) {
  for (let i = 0; i < Math.min(grid.length, limit); i++) {
    const cells = (grid[i] || []).map(text);
    if (test(cells)) return i;
  }
  return -1;
}
const col = (cells: string[], ...patterns: RegExp[]) => {
  for (const pattern of patterns) {
    const index = cells.findIndex((cell) => pattern.test(cell));
    if (index >= 0) return index;
  }
  return -1;
};

type Acc = Map<string, { material: string; description: string; unit: string; required: number; source: string }>;
function add(acc: Acc, material: string, description: string, unit: string, quantity: number) {
  const item = acc.get(material);
  if (item) item.required = round(item.required + quantity);
  else acc.set(material, { material, description, unit, required: quantity, source: "" });
}

/** Aba Stats: SAP, descrição, unidade e quantidade usada no Brasil por ônibus. */
export function readStatsSheet(grid: Grid) {
  const h = headerRow(grid, (cells) => cells.some((c) => /^SAP/i.test(c)) && cells.some((c) => /Total/i.test(c)));
  if (h < 0) return { rows: new Map() as Acc, carNumber: "", usedOverseas: false };
  const cells = (grid[h] || []).map(text);
  const iSap = col(cells, /^SAP/i),
    iDesc = col(cells, /Material Description/i, /Part Name Description/i, /物料描述/),
    iPart = col(cells, /Part Name Description/i),
    iUnit = col(cells, /^Unit/i, /单位/),
    iOverseas = col(cells, /Overseas Factory Use Total/i, /海外工厂使用数量/),
    iTotal = col(cells, /^Total/i, /数量/),
    iCar = col(cells, /Car Number/i);
  const iQty = iOverseas >= 0 ? iOverseas : iTotal;
  const rows: Acc = new Map();
  let carNumber = "";
  for (const row of grid.slice(h + 1)) {
    const material = text(row?.[iSap]);
    if (!MATERIAL.test(material)) continue;
    const quantity = num(row?.[iQty]);
    if (quantity === null || quantity <= 0) continue;
    carNumber ||= text(row?.[iCar]);
    const english = iPart >= 0 ? text(row?.[iPart]) : "";
    add(rows, material, english || text(row?.[iDesc]), planUnit(row?.[iUnit]), quantity);
  }
  return { rows, carNumber, usedOverseas: iOverseas >= 0 };
}

/** Aba "Self-made Part KD list": cabeçalho abaixo do título, com SAP e Quantity. */
export function readKdSheet(grid: Grid) {
  const h = headerRow(grid, (cells) => cells.some((c) => /SAP/i.test(c)) && cells.some((c) => /Quantity|数量/i.test(c)));
  const rows: Acc = new Map();
  if (h < 0) return rows;
  const cells = (grid[h] || []).map(text);
  const iSap = col(cells, /SAP/i),
    iDesc = col(cells, /Part Name Description|英文描述/i, /PartName|零部件名称/i),
    iUnit = col(cells, /Unit|单位/i),
    iQty = col(cells, /Quantity|数量/i);
  for (const row of grid.slice(h + 1)) {
    const material = text(row?.[iSap]);
    if (!MATERIAL.test(material)) continue;
    const quantity = num(row?.[iQty]);
    if (quantity === null || quantity <= 0) continue;
    add(rows, material, text(row?.[iDesc]), planUnit(row?.[iUnit]), quantity);
  }
  return rows;
}

/** sheets: nome da aba → linhas (sheet_to_json com header:1). */
export function parsePlanBom(fileName: string, sheets: Record<string, Grid>): PlanBom {
  const names = Object.keys(sheets);
  const statsName =
    names.find((name) => /Stats/i.test(name) && /采购明细/.test(name) && !/变更|Chang/i.test(name)) ||
    names.find((name) => /BOM.*Stats/i.test(name) && !/Chang/i.test(name));
  if (!statsName)
    throw Error(
      `${fileName}: aba "采购明细（统计表）BOM（Stats）" não encontrada. Envie o arquivo OEBOM original da China.`,
    );
  const stats = readStatsSheet(sheets[statsName]);
  if (!stats.rows.size) throw Error(`${fileName}: a aba Stats não tem materiais com quantidade.`);
  const kdName = names.find((name) => /KD/i.test(name) && /Self-made|自制件/i.test(name));
  const kd = kdName ? readKdSheet(sheets[kdName]) : new Map() as Acc;
  const warnings: string[] = [];
  if (!stats.usedOverseas) warnings.push('Coluna "Overseas Factory Use Total" ausente: usada a coluna Total.');
  if (!kdName) warnings.push("Aba KD (Self-made Part KD list) não encontrada.");
  const merged = new Map<string, PlanBomRow>();
  for (const [source, acc] of [["Stats", stats.rows], ["KD", kd]] as const)
    for (const item of acc.values()) {
      const found = merged.get(item.material);
      if (!found) merged.set(item.material, { id: "", ...item, source });
      else {
        // Mesmo material nas duas abas: uma única necessidade (a maior).
        if (item.required > found.required) found.required = item.required;
        if (!found.source.includes(source)) found.source += "+" + source;
        if (found.unit !== item.unit && item.unit) warnings.push(`${item.material}: unidade ${found.unit} (Stats) × ${item.unit} (KD).`);
      }
    }
  const { model, dwb, revision } = planIdentity(fileName, stats.carNumber);
  if (!model || !dwb) throw Error(`${fileName}: não foi possível identificar modelo e DWB (ex.: BC22S02-DWB1339).`);
  const rows = [...merged.values()]
    .sort((a, b) => a.material.localeCompare(b.material))
    .map((row, index) => ({ ...row, id: String(index + 1) }));
  return {
    id: planId(model, dwb),
    name: `${model} · DWB${dwb}`,
    revision,
    model,
    dwb,
    rows,
    statsRows: stats.rows.size,
    kdRows: kd.size,
    warnings,
  };
}

export function validatePlanRows(rows: Row[]) {
  if (!Array.isArray(rows) || !rows.length) throw Error("BOM do plano sem materiais.");
  if (rows.length > 5000) throw Error("BOM do plano com mais de 5.000 materiais.");
  for (const row of rows) {
    if (!MATERIAL.test(text(row.material))) throw Error(`Código SAP inválido: ${text(row.material) || "vazio"}.`);
    if (typeof row.required !== "number" || !Number.isFinite(row.required) || row.required < 0)
      throw Error(`Quantidade por ônibus inválida em ${row.material}.`);
  }
}
export function validPlanUnits(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100000;
}
