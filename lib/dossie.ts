/**
 * DOSSIÊ WAREHOUSE
 *
 * Cobrança ao Warehouse de transferências feitas sem justificativa (ex.: 311
 * do 2000 para o 7000 de um material que a linha não usa). O dossiê nasce das
 * linhas da MB51 (coladas do SAP/Excel ou do arquivo exportado) e guarda a
 * prova: documento, itens, depósitos, quantidade, data, usuário e o que
 * aconteceu depois no depósito de destino (consumo, devolução, sucata), além
 * do valor parado.
 *
 * Só regra: o mesmo código roda no navegador, no Worker e nos testes.
 */
import { normalize } from "./materials.ts";

export const DEFAULT_TARGET = "7000";
/** Lançamentos guardados por dossiê (a MB51 de um material raramente passa disso). */
export const MAX_MOVEMENTS = 300;
/** Cada dossiê cabe numa linha de até ~90 KB (limite de comando do D1 na cópia do banco). */
export const MAX_DATA_CHARS = 90_000;
export const MAX_FILES = 5;
export const MAX_FILE_BYTES = 1_500_000;
export const MAX_IMPORT_ROWS = 20_000;

export type DossieStatus = "open" | "sent" | "answered" | "closed";
export const DOSSIE_STATUSES: readonly DossieStatus[] = ["open", "sent", "answered", "closed"];
export const STATUS_LABELS: Record<DossieStatus, string> = {
  open: "Aberto",
  sent: "Cobrado",
  answered: "Respondido",
  closed: "Encerrado",
};
export const isDossieStatus = (value: unknown): value is DossieStatus => DOSSIE_STATUSES.includes(value as DossieStatus);

export type Outcome = "returned" | "justified" | "reversed" | "adjusted" | "other";
export const OUTCOMES: readonly Outcome[] = ["returned", "justified", "reversed", "adjusted", "other"];
export const OUTCOME_LABELS: Record<Outcome, string> = {
  returned: "Devolvido ao depósito de origem",
  justified: "Justificado pelo Warehouse",
  reversed: "Transferência estornada",
  adjusted: "Baixa ou ajuste de estoque",
  other: "Outro",
};
export const isOutcome = (value: unknown): value is Outcome => OUTCOMES.includes(value as Outcome);

/** Uma linha da MB51 de um material (documento + item). */
export type Movement = {
  document: string;
  year: string;
  item: string;
  postingDate: string;
  entryDate: string;
  entryTime: string;
  depot: string;
  /** Depósito receptor (UMLGO), quando a MB51 traz. */
  counterDepot: string;
  plant: string;
  type: string;
  typeText: string;
  special: string;
  quantity: number | null;
  unit: string;
  amount: number | null;
  currency: string;
  user: string;
  headerText: string;
  itemText: string;
  order: string;
  costCenter: string;
  reference: string;
  receiver: string;
  batch: string;
};
export type ParsedMovement = Movement & { material: string; description: string };

export type StockCheck = {
  readAt: string;
  depots: { depot: string; quantity: number | null; value: number | null; unit: string; found: boolean }[];
};

/** O que o usuário edita (e a prova da MB51). O andamento fica em DossieTrack. */
export type DossieData = {
  material: string;
  description: string;
  plant: string;
  /** Depósito de destino que está sendo cobrado (padrão 7000). */
  target: string;
  movements: Movement[];
  /** Chaves das transferências questionadas (documento/ano/item). */
  questioned: string[];
  manualPrice: number | null;
  request: string;
  deadline: string;
  recipients: string;
  notes: string;
  stockCheck: StockCheck | null;
  source: string;
  importedAt: string;
};

export type LogEntry = { at: string; role: string; text: string };
/** Andamento: só o servidor muda, pelas ações de cobrança, resposta e encerramento. */
export type DossieTrack = {
  sentAt: string;
  reminders: string[];
  response: string;
  responseBy: string;
  respondedAt: string;
  outcome: Outcome | "";
  outcomeNote: string;
  returnDocument: string;
  closedAt: string;
  log: LogEntry[];
};
export const emptyTrack = (): DossieTrack => ({
  sentAt: "",
  reminders: [],
  response: "",
  responseBy: "",
  respondedAt: "",
  outcome: "",
  outcomeNote: "",
  returnDocument: "",
  closedAt: "",
  log: [],
});

export type DossieFileMeta = { id: string; name: string; type: string; size: number; createdAt: string; createdBy: string };
export type DossieSummary = {
  material: string;
  description: string;
  unit: string;
  target: string;
  transfers: { key: string; document: string; items: string[]; from: string; to: string; quantity: number; date: string; time: string; user: string }[];
  transferred: number;
  idle: number | null;
  unitPrice: number | null;
  value: number | null;
  firstDate: string;
  deadline: string;
};
export type Dossie = {
  id: string;
  number: string;
  status: DossieStatus;
  data: DossieData;
  track: DossieTrack;
  summary: DossieSummary;
  files: DossieFileMeta[];
  revision: number;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
};
/** Lista: sem os lançamentos e sem o histórico completo. */
export type DossieListItem = Omit<Dossie, "data" | "track" | "files"> & {
  track: Omit<DossieTrack, "log" | "response" | "outcomeNote"> & { logCount: number; hasResponse: boolean };
  fileCount: number;
};

export type BomUse = {
  id: string;
  name: string;
  revision: string;
  kind: "op" | "plan";
  required: number | null;
  unit: string;
  ops: number;
  units: number | null;
};
export type BomLookup = { materials: Record<string, BomUse[]>; checked: number };

// ---------------------------------------------------------------------------
// Leitura da MB51 (texto colado ou planilha)
// ---------------------------------------------------------------------------

type FieldKey =
  | keyof ParsedMovement
  | "documentDate"
  | "debitCredit"
  | "quantityEntry"
  | "unitEntry"
  | "unitGeneric";
type FieldDef = { key: FieldKey; label: string; aliases: string[] };
/** Títulos das colunas da MB51 em português e inglês (texto médio/longo do ALV). */
const FIELDS: FieldDef[] = [
  { key: "material", label: "Material", aliases: ["Material", "Nº material", "Número do material", "Código do material", "Material Number"] },
  {
    key: "description",
    label: "Texto breve material",
    aliases: ["Texto breve material", "Texto breve de material", "Texto breve do material", "Denominação do material", "Descrição do material", "Material Description", "Material description"],
  },
  { key: "plant", label: "Centro", aliases: ["Centro", "Cen.", "Plant", "Plnt"] },
  { key: "depot", label: "Depósito", aliases: ["Depósito", "Dep.", "Storage location", "Storage Location", "SLoc", "Stor. Loc."] },
  {
    key: "counterDepot",
    label: "Depósito receptor",
    aliases: ["Depósito receptor", "Dep.receptor", "Dep. receptor", "Depósito de destino", "Receiving stor. loc.", "Receiving Storage Location", "Receiving SLoc", "Rcvg SLoc"],
  },
  {
    key: "type",
    label: "Tipo de movimento",
    aliases: ["Tipo de movimento", "Tipo movimento", "Tipo mov.", "Tipo de mov.", "Tipo movim.", "TMv", "MvT", "Mvt", "Movement type", "Movement Type"],
  },
  {
    key: "typeText",
    label: "Texto tipo de movimento",
    aliases: ["Texto tipo de movimento", "Texto do tipo de movimento", "Txt.tipo mov.", "Texto TMv", "Texto tipo movimento", "Movement Type Text", "Mvt Type Text"],
  },
  { key: "special", label: "Estoque especial", aliases: ["Estoque especial", "E", "Special Stock", "Special stock"] },
  { key: "quantity", label: "Quantidade", aliases: ["Quantidade", "Qtd.", "Qtd", "Quantity", "Qtd.em UM básica", "Qtd. em UM básica", "Quantidade em UM básica"] },
  {
    key: "quantityEntry",
    label: "Qtd.em UM registro",
    aliases: ["Qtd.em UM registro", "Qtd. em UM registro", "Qtd.UMR", "Qtd. UMR", "Qtd.em UMR", "Quantidade em UM registro", "Qtd.UM registro", "Qty in unit of entry", "Qty in Un. of Entry", "Quantity in UnE"],
  },
  { key: "unit", label: "UM básica", aliases: ["UM básica", "UMB", "Unidade de medida básica", "Unidade medida básica", "Base Unit of Measure", "BUn"] },
  { key: "unitEntry", label: "UM registro", aliases: ["UM registro", "UMR", "Unidade de medida do registro", "Unit of Entry", "EUn"] },
  { key: "unitGeneric", label: "Unidade", aliases: ["Unidade", "Unidade de medida", "UM", "UMP", "Unit"] },
  { key: "amount", label: "Montante em MI", aliases: ["Montante em MI", "Montante MI", "Mont.em MI", "Mont.MI", "Montante", "Amount in LC", "Amount in local currency", "Amt.in Loc.Cur."] },
  { key: "currency", label: "Moeda", aliases: ["Moeda", "Currency", "Crcy"] },
  {
    key: "headerText",
    label: "Texto cabeçalho documento",
    aliases: ["Texto cabeçalho documento", "Texto cab.documento", "Texto do cabeçalho do documento", "Texto cabeçalho doc.", "Txt.cab.doc.", "Document Header Text", "Doc.Header Text"],
  },
  { key: "itemText", label: "Texto", aliases: ["Texto", "Texto do item", "Texto item", "Item Text", "Text"] },
  { key: "document", label: "Doc.material", aliases: ["Doc.material", "Doc.mat.", "Documento material", "Documento de material", "Nº documento material", "Material Document", "Mat. Doc.", "Mat.Doc."] },
  { key: "item", label: "Item", aliases: ["Item", "Item doc.material", "Item do documento material", "Material Doc.Item", "Mat.Doc.Item"] },
  { key: "year", label: "Ano doc.material", aliases: ["Ano doc.material", "Ano do documento material", "Ano documento material", "Material Doc. Year", "Mat. Doc. Year", "Ano"] },
  {
    key: "postingDate",
    label: "Data de lançamento",
    aliases: ["Data de lançamento", "Data lançamento", "Data lçto.", "Dt.lçto.", "Dt.lançamento", "Data de lanç.", "Posting Date", "Pstng Date"],
  },
  { key: "documentDate", label: "Data do documento", aliases: ["Data do documento", "Data documento", "Document Date", "Doc. Date"] },
  { key: "entryDate", label: "Data de entrada", aliases: ["Data de entrada", "Data entrada", "Dt.entrada", "Dt.entr.", "Entrado em", "Entry Date", "Entered on"] },
  { key: "entryTime", label: "Hora de entrada", aliases: ["Hora de entrada", "Hora entrada", "Hora entr.", "Hora", "Time of Entry", "Entry Time", "Time"] },
  { key: "user", label: "Nome do usuário", aliases: ["Nome do usuário", "Nome usuário", "Nome de usuário", "Usuário", "User Name", "User name", "User"] },
  { key: "order", label: "Ordem", aliases: ["Ordem", "Order"] },
  { key: "costCenter", label: "Centro custo", aliases: ["Centro custo", "Centro de custo", "Cost Center", "Cost Ctr"] },
  { key: "reference", label: "Referência", aliases: ["Referência", "Reference"] },
  { key: "receiver", label: "Recebedor", aliases: ["Recebedor", "Recebedor da mercadoria", "Recebedor mercadoria", "Goods recipient", "Goods Recipient"] },
  { key: "batch", label: "Lote", aliases: ["Lote", "Batch"] },
  {
    key: "debitCredit",
    label: "Débito/crédito",
    aliases: ["Código débito/crédito", "Cód.débito/crédito", "Débito/crédito", "D/C", "Debit/Credit ind.", "Debit/Credit Indicator"],
  },
];
const ALIASES = new Map<FieldKey, string[]>(FIELDS.map((field) => [field.key, field.aliases.map(normalize)]));
const KNOWN = new Set(FIELDS.flatMap((field) => field.aliases.map(normalize)));
/** Sem estas colunas não dá para montar a prova da transferência. */
const REQUIRED: FieldKey[] = ["material", "depot", "type", "document"];
/** Colunas que deixam o dossiê completo (quem e quando). */
const RECOMMENDED: { keys: FieldKey[]; label: string }[] = [
  { keys: ["postingDate", "entryDate"], label: "Data de lançamento" },
  { keys: ["user"], label: "Nome do usuário" },
  { keys: ["item"], label: "Item" },
  { keys: ["entryTime"], label: "Hora de entrada" },
];

const clean = (value: unknown, max = 200) =>
  String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
/** Código SAP: inteiro do Excel sem ".0", espaços fora. */
function code(value: unknown, max = 40) {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return clean(value, max).replace(/\.0+$/, "");
}
const itemNumber = (value: string) => {
  const n = Number(String(value).replace(/^0+(?=\d)/, ""));
  return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
};

/** Texto copiado do SAP/Excel → linhas e células (tabulação, "|" da lista SAP ou ";" do CSV). */
export function tableFromText(text: string): string[][] {
  const lines = String(text || "").replace(/^﻿/, "").replace(/\r\n?/g, "\n").split("\n");
  const semicolon = !lines.some((line) => line.includes("\t")) && lines.some((line) => line.split(";").length > 3);
  const rows: string[][] = [];
  for (const line of lines) {
    if (!/\S/.test(line)) continue;
    if (/^[\s\-|+=_]*$/.test(line)) continue; // linhas de traço da lista SAP
    let cells: string[];
    if (line.includes("\t")) cells = line.split("\t");
    else if (/^\s*\|/.test(line)) cells = line.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|");
    else if (semicolon && line.includes(";")) cells = line.split(";").map((cell) => cell.replace(/^"(.*)"$/, "$1").replace(/""/g, '"'));
    else continue; // título do relatório, data, usuário
    rows.push(cells.map((cell) => cell.replace(/[   ]/g, " ").trim()));
  }
  return rows;
}

export type DecimalStyle = "comma" | "dot";
/** O SAP escreve 1.234,50 (Brasil) ou 1,234.50 (EUA): decide pelo que aparece nos valores. */
export function decimalStyle(samples: unknown[]): DecimalStyle | null {
  let comma = 0,
    dot = 0;
  for (const raw of samples) {
    if (typeof raw !== "string") continue;
    const s = raw.trim().replace(/^-|-$/g, "").replace(/\s/g, "");
    if (!/^[\d.,]+$/.test(s)) continue;
    const c = s.lastIndexOf(","),
      d = s.lastIndexOf(".");
    if (c >= 0 && d >= 0) {
      if (c > d) comma++;
      else dot++;
      continue;
    }
    const sep = c >= 0 ? "," : d >= 0 ? "." : "";
    if (!sep) continue;
    // Separador repetido é milhar; um só com 3 casas depois é ambíguo (168,000 = 168 ou 168 mil).
    if (s.split(sep).length > 2) {
      if (sep === ",") dot++;
      else comma++;
    } else if (s.length - s.lastIndexOf(sep) - 1 !== 3) {
      if (sep === ",") comma++;
      else dot++;
    }
  }
  if (!comma && !dot) return null;
  return comma > dot ? "comma" : "dot";
}
/** "1,573.49-" → -1573.49; "62-" → -62; número do Excel passa direto. */
export function sapNumber(value: unknown, style: DecimalStyle = "comma"): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  let s = String(value).replace(/R\$|BRL|\s|[  ]/g, "");
  if (!s) return null;
  let negative = false;
  if (/-$/.test(s)) {
    negative = true;
    s = s.slice(0, -1);
  } else if (/^-/.test(s)) {
    negative = true;
    s = s.slice(1);
  } else if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  if (!/^[\d.,]+$/.test(s)) return null;
  s = style === "comma" ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return negative && n !== 0 ? -n : n;
}

export type DateOrder = "dmy" | "mdy";
const pad = (n: number, size = 2) => String(n).padStart(size, "0");
function validIso(y: number, m: number, d: number) {
  if (y < 1990 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return "";
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCMonth() === m - 1 && date.getUTCDate() === d ? `${y}-${pad(m)}-${pad(d)}` : "";
}
/** Data do Excel (número de série), "2026.10.06", "06.10.2026", "06/10/2026" ou "10/06/2026" → "2026-10-06". */
export function parseDate(value: unknown, order: DateOrder = "dmy"): string {
  if (value === null || value === undefined || value === "") return "";
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? validIso(value.getFullYear(), value.getMonth() + 1, value.getDate()) : "";
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 20000 || value > 80000) return "";
    const date = new Date(Date.UTC(1899, 11, 30) + Math.floor(value) * 86_400_000);
    return validIso(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
  }
  const s = String(value).trim();
  let m = s.match(/^(\d{4})[.\/-](\d{1,2})[.\/-](\d{1,2})(?:[ T].*)?$/);
  if (m) return validIso(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return validIso(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})([.\/-])(\d{1,2})\2(\d{4})(?:[ T].*)?$/);
  if (m) {
    const a = +m[1],
      b = +m[3],
      y = +m[4];
    // DD.MM.AAAA é o formato 1 do SAP: ponto nunca é mês primeiro.
    if (m[2] === ".") return validIso(y, b, a);
    return order === "mdy" ? validIso(y, a, b) : validIso(y, b, a);
  }
  return "";
}
/** Hora "14:36:12", "143612" ou fração de dia do Excel → "14:36:12". */
export function parseTime(value: unknown): string {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "number" && Number.isFinite(value)) {
    const fraction = value % 1;
    if (value >= 0 && value < 1) {
      const seconds = Math.round(fraction * 86_400) % 86_400;
      return `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor((seconds % 3600) / 60))}:${pad(seconds % 60)}`;
    }
    return "";
  }
  const s = String(value).trim();
  let m = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) m = s.match(/^(\d{2})(\d{2})(\d{2})$/);
  if (!m) return "";
  const h = +m[1],
    min = +m[2],
    sec = +(m[3] || 0);
  return h < 24 && min < 60 && sec < 60 ? `${pad(h)}:${pad(min)}:${pad(sec)}` : "";
}
/** Datas ambíguas (01/02/2026): o mês fica onde as datas acompanham a ordem dos documentos. */
function chooseDateOrder(samples: { raw: unknown; document: string }[]): { order: DateOrder; ambiguous: boolean } {
  let dmy = false,
    mdy = false,
    ambiguous = false;
  for (const { raw } of samples) {
    if (typeof raw !== "string") continue;
    const m = raw.trim().match(/^(\d{1,2})([\/-])(\d{1,2})\2\d{4}/);
    if (!m) continue;
    if (+m[1] > 12) dmy = true;
    else if (+m[3] > 12) mdy = true;
    else if (+m[1] !== +m[3]) ambiguous = true;
  }
  if (dmy && !mdy) return { order: "dmy", ambiguous: false };
  if (mdy && !dmy) return { order: "mdy", ambiguous: false };
  if (!ambiguous) return { order: "dmy", ambiguous: false };
  // Documentos de material são numerados na ordem em que entram: a leitura certa
  // das datas tem menos "voltas no tempo" quando ordenada pelo número.
  const inversions = (order: DateOrder) => {
    const dated = samples
      .map((sample) => ({ doc: Number(sample.document) || 0, date: parseDate(sample.raw, order) }))
      .filter((row) => row.doc && row.date)
      .sort((a, b) => a.doc - b.doc);
    let count = 0;
    for (let i = 1; i < dated.length; i++) if (dated[i].date < dated[i - 1].date) count++;
    return count;
  };
  const a = inversions("dmy"),
    b = inversions("mdy");
  if (a === b) return { order: "dmy", ambiguous: true };
  return { order: a < b ? "dmy" : "mdy", ambiguous: true };
}

export type Mb51Parse = {
  movements: ParsedMovement[];
  columns: string[];
  missing: string[];
  warnings: string[];
  dateOrder: DateOrder;
  dateAmbiguous: boolean;
  decimal: DecimalStyle;
  decimalAmbiguous: boolean;
  ignored: number;
  duplicates: number;
  rows: number;
};

function headerIndex(rows: unknown[][]) {
  for (let r = 0; r < Math.min(rows.length, 40); r++) {
    const names = new Set(rows[r].map(expandTruncated));
    const known = [...names].filter((name) => KNOWN.has(name)).length;
    const has = (key: FieldKey) => ALIASES.get(key)!.some((alias) => names.has(alias));
    if (known >= 3 && has("material") && has("type")) return r;
  }
  return -1;
}
/** Título cortado na tela do SAP ("Quan…", "Centro …"): vale só se um único campo começar assim. */
function expandTruncated(cell: unknown) {
  const raw = String(cell ?? "");
  const name = normalize(raw);
  if (!/(\.\.\.|…)\s*$/.test(raw)) return name;
  if (name.length < 2) return "";
  const canonical = FIELDS.filter((field) => ALIASES.get(field.key)![0].startsWith(name));
  if (canonical.length === 1) return ALIASES.get(canonical[0].key)![0];
  // "Da…": só datas começam assim; na MB51 a coluna padrão é a Data de lançamento.
  if (canonical.length && canonical.every((field) => ["postingDate", "documentDate", "entryDate"].includes(field.key))) return ALIASES.get("postingDate")![0];
  return "";
}
function columnsOf(header: unknown[]) {
  const names = header.map(expandTruncated);
  const used = new Set<number>();
  const map = new Map<FieldKey, number>();
  for (const field of FIELDS) {
    for (const alias of ALIASES.get(field.key)!) {
      const index = names.findIndex((name, i) => name === alias && !used.has(i));
      if (index >= 0) {
        map.set(field.key, index);
        used.add(index);
        break;
      }
    }
  }
  return map;
}

/**
 * Lê a MB51 já separada em linhas/células (texto colado ou planilha).
 * A primeira linha com Material e Tipo de movimento é o cabeçalho.
 */
export function parseMb51Rows(input: unknown[][], options: { dateOrder?: DateOrder; decimal?: DecimalStyle } = {}): Mb51Parse {
  const rows = input.filter((row) => Array.isArray(row));
  const start = headerIndex(rows);
  if (start < 0)
    throw Error(
      "Não achei o cabeçalho da MB51 (Material, Tipo de movimento, Depósito, Doc.material…). Copie as linhas com a linha de títulos, ou exporte a MB51 para o Excel e envie o arquivo.",
    );
  const header = rows[start];
  const columns = columnsOf(header);
  const missingRequired = REQUIRED.filter((key) => !columns.has(key));
  const hasQuantity = columns.has("quantity") || columns.has("quantityEntry");
  if (missingRequired.length || !hasQuantity) {
    const names = [...missingRequired.map((key) => FIELDS.find((field) => field.key === key)!.label), ...(hasQuantity ? [] : ["Quantidade"])];
    throw Error(`A MB51 colada não tem a coluna ${names.join(", ")}. Inclua no layout da MB51 e copie de novo (com a linha de títulos).`);
  }
  const quantityKey: FieldKey = columns.has("quantity") ? "quantity" : "quantityEntry";
  const unitKeys: FieldKey[] = quantityKey === "quantity" ? ["unit", "unitGeneric", "unitEntry"] : ["unitEntry", "unitGeneric", "unit"];
  const cell = (row: unknown[], key: FieldKey) => {
    const index = columns.get(key);
    return index === undefined ? undefined : row[index];
  };
  const body = rows.slice(start + 1).slice(0, MAX_IMPORT_ROWS + 1);
  if (body.length > MAX_IMPORT_ROWS) throw Error(`A MB51 tem mais de ${MAX_IMPORT_ROWS.toLocaleString("pt-BR")} linhas. Filtre por material ou período e cole de novo.`);
  const headerKey = header.map((cell) => normalize(cell)).join("|");

  // Separador decimal e ordem das datas valem para a extração inteira.
  const numberSamples: unknown[] = [];
  const dateSamples: { raw: unknown; document: string }[] = [];
  for (const row of body) {
    for (const key of [quantityKey, "amount"] as FieldKey[]) {
      const value = cell(row, key);
      if (typeof value === "string" && value.trim()) numberSamples.push(value);
    }
    for (const key of ["postingDate", "entryDate", "documentDate"] as FieldKey[]) {
      const value = cell(row, key);
      if (value !== undefined && value !== "") dateSamples.push({ raw: value, document: code(cell(row, "document")) });
    }
  }
  const detected = decimalStyle(numberSamples);
  const decimal = options.decimal || detected || "comma";
  const chosen = chooseDateOrder(dateSamples);
  const dateOrder = options.dateOrder || chosen.order;

  const movements: ParsedMovement[] = [];
  const seen = new Map<string, string>();
  let ignored = 0,
    duplicates = 0,
    conflicts = 0;
  for (const row of body) {
    if (!row.some((value) => String(value ?? "").trim())) continue;
    if (row.map((value) => normalize(value)).join("|") === headerKey) continue; // cabeçalho repetido
    const material = code(cell(row, "material")).toUpperCase();
    const document = code(cell(row, "document"));
    if (!material || /^\*+/.test(String(row[0] ?? "").trim()) || !document) {
      ignored++;
      continue;
    }
    let quantity = sapNumber(cell(row, quantityKey), decimal);
    const dc = clean(cell(row, "debitCredit")).toUpperCase();
    if (quantity !== null && quantity > 0 && dc === "H") quantity = -quantity;
    const unit = unitKeys.map((key) => clean(cell(row, key), 8)).find(Boolean) || "";
    const postingDate = parseDate(cell(row, "postingDate"), dateOrder) || parseDate(cell(row, "documentDate"), dateOrder);
    const entryDate = parseDate(cell(row, "entryDate"), dateOrder);
    const year = code(cell(row, "year"), 4) || (postingDate || entryDate).slice(0, 4);
    const movement: ParsedMovement = {
      material,
      description: clean(cell(row, "description"), 120),
      document,
      year,
      item: code(cell(row, "item"), 6).replace(/^0+(?=\d)/, ""),
      postingDate,
      entryDate,
      entryTime: parseTime(cell(row, "entryTime")),
      depot: code(cell(row, "depot"), 10).toUpperCase(),
      counterDepot: code(cell(row, "counterDepot"), 10).toUpperCase(),
      plant: code(cell(row, "plant"), 10).toUpperCase(),
      type: code(cell(row, "type"), 4).toUpperCase(),
      typeText: clean(cell(row, "typeText"), 60),
      special: clean(cell(row, "special"), 2).toUpperCase(),
      quantity,
      unit: unit.toUpperCase(),
      amount: sapNumber(cell(row, "amount"), decimal),
      currency: clean(cell(row, "currency"), 5).toUpperCase(),
      user: clean(cell(row, "user"), 30).toUpperCase(),
      headerText: clean(cell(row, "headerText"), 120),
      itemText: clean(cell(row, "itemText"), 120),
      order: code(cell(row, "order"), 20),
      costCenter: code(cell(row, "costCenter"), 20),
      reference: clean(cell(row, "reference"), 30),
      receiver: clean(cell(row, "receiver"), 30),
      batch: clean(cell(row, "batch"), 20),
    };
    const key = movementKey(movement);
    const signature = JSON.stringify([material, movement.depot, movement.type, movement.quantity]);
    if (movement.item && seen.has(key)) {
      if (seen.get(key) !== signature) conflicts++;
      duplicates++;
      continue;
    }
    if (movement.item) seen.set(key, signature);
    movements.push(movement);
  }
  if (!movements.length) throw Error("Nenhum lançamento com material e documento foi encontrado nas linhas coladas.");
  const missing = RECOMMENDED.filter((group) => !group.keys.some((key) => columns.has(key))).map((group) => group.label);
  const warnings: string[] = [];
  if (conflicts) warnings.push(`${conflicts} documento(s) repetido(s) com valores diferentes: ficou a primeira linha de cada um. Confira a extração.`);
  if (movements.some((m) => m.quantity === null)) warnings.push("Há lançamentos sem quantidade válida; eles aparecem no dossiê, mas não entram nas contas.");
  return {
    movements,
    columns: FIELDS.filter((field) => columns.has(field.key)).map((field) => field.label),
    missing,
    warnings,
    dateOrder,
    dateAmbiguous: chosen.ambiguous && !options.dateOrder,
    decimal,
    decimalAmbiguous: !detected && !options.decimal && numberSamples.some((value) => /[.,]/.test(String(value))),
    ignored,
    duplicates,
    rows: body.length,
  };
}
export const parseMb51Text = (text: string, options: { dateOrder?: DateOrder; decimal?: DecimalStyle } = {}) => parseMb51Rows(tableFromText(text), options);

/** Documento/ano/item: identifica um lançamento (e uma transferência pelo 1º item). */
export const movementKey = (m: Pick<Movement, "document" | "year" | "item">) => `${m.document}/${m.year || "-"}/${m.item || "-"}`;

/** Lançamentos da MB51 agrupados por material (a importação abre um dossiê por material). */
export function groupByMaterial(movements: ParsedMovement[]) {
  const groups = new Map<string, { material: string; description: string; plant: string; movements: Movement[] }>();
  for (const { material, description, ...movement } of movements) {
    const group = groups.get(material) || { material, description: "", plant: "", movements: [] };
    if (!group.description && description) group.description = description;
    if (!group.plant && movement.plant) group.plant = movement.plant;
    group.movements.push(movement);
    groups.set(material, group);
  }
  return [...groups.values()];
}

/** Junta lançamentos novos aos já guardados, sem repetir documento/ano/item. */
export function mergeMovements(current: Movement[], incoming: Movement[]) {
  const keys = new Set(current.map(movementKey));
  const added: Movement[] = [];
  for (const movement of incoming) {
    const key = movementKey(movement);
    if (movement.item && keys.has(key)) continue;
    keys.add(key);
    added.push(movement);
  }
  return { movements: [...current, ...added], added: added.length };
}

// ---------------------------------------------------------------------------
// Transferências, saldos e o que aconteceu depois
// ---------------------------------------------------------------------------

const TRANSFER_TYPES = new Set([
  "301", "302", "303", "304", "305", "306", "309", "310", "311", "312", "313", "314", "315", "316",
  "321", "322", "323", "324", "325", "326", "343", "344", "349", "350", "411", "412", "413", "414", "415", "416",
]);
export const isTransferType = (type: string) => TRANSFER_TYPES.has(type);

const TYPE_TEXT: Record<string, string> = {
  "101": "Entrada de mercadoria",
  "102": "Estorno de entrada de mercadoria",
  "122": "Devolução ao fornecedor",
  "161": "Devolução de pedido",
  "201": "Consumo para centro de custo",
  "202": "Estorno de consumo para centro de custo",
  "221": "Consumo para projeto",
  "222": "Estorno de consumo para projeto",
  "261": "Consumo para ordem",
  "262": "Estorno de consumo para ordem",
  "301": "Transferência entre centros",
  "302": "Estorno de transferência entre centros",
  "309": "Transferência de material para material",
  "310": "Estorno de transferência de material para material",
  "311": "Transferência entre depósitos",
  "312": "Estorno de transferência entre depósitos",
  "313": "Transferência entre depósitos (saída, 2 etapas)",
  "314": "Estorno de saída em 2 etapas",
  "315": "Transferência entre depósitos (entrada, 2 etapas)",
  "316": "Estorno de entrada em 2 etapas",
  "321": "Liberação do controle de qualidade",
  "343": "Bloqueado para livre",
  "344": "Livre para bloqueado",
  "501": "Entrada sem pedido",
  "521": "Entrada sem ordem",
  "531": "Entrada de subproduto",
  "551": "Sucata",
  "552": "Estorno de sucata",
  "561": "Entrada inicial de saldo",
  "562": "Estorno de entrada inicial de saldo",
  "601": "Saída para remessa",
  "602": "Estorno de saída para remessa",
  "641": "Transferência para estoque em trânsito",
  "701": "Diferença de inventário (entrada)",
  "702": "Diferença de inventário (saída)",
  "711": "Diferença de inventário",
  "712": "Diferença de inventário",
};
/** Descrição do tipo de movimento: a da MB51, se veio; senão a padrão; senão entrada/saída. */
export function typeLabel(m: Pick<Movement, "type" | "typeText" | "quantity">) {
  if (m.typeText) return m.typeText;
  if (TYPE_TEXT[m.type]) return TYPE_TEXT[m.type];
  if (m.quantity === null || m.quantity === 0) return "Movimento";
  return m.quantity > 0 ? "Entrada" : "Saída";
}

export type Transfer = {
  key: string;
  document: string;
  year: string;
  type: string;
  items: string[];
  from: string;
  to: string;
  quantity: number;
  unit: string;
  date: string;
  time: string;
  user: string;
  headerText: string;
  itemText: string;
  paired: boolean;
  sort: string;
  /** Linhas da MB51 desta transferência (só para as contas; não vai para o banco). */
  lines: Movement[];
};

const dateOf = (m: Movement) => m.entryDate || m.postingDate;
/** Ordem cronológica: data de entrada (ou lançamento), hora, documento, item. */
export const chronoKey = (m: Movement) =>
  `${dateOf(m) || "0000-00-00"} ${m.entryDate ? m.entryTime || "00:00:00" : "00:00:00"} ${m.document.padStart(12, "0")} ${String(itemNumber(m.item)).padStart(16, "0")}`;
export const chronological = (movements: Movement[]) => [...movements].sort((a, b) => (chronoKey(a) < chronoKey(b) ? -1 : chronoKey(a) > chronoKey(b) ? 1 : 0));

/** Junta as duas linhas de cada transferência (saída do depósito de origem + entrada no destino). */
export function transfersOf(movements: Movement[]): Transfer[] {
  const byDocument = new Map<string, Movement[]>();
  for (const m of movements) {
    if (!isTransferType(m.type) || !m.quantity) continue;
    const key = `${m.document}/${m.year || "-"}`;
    byDocument.set(key, [...(byDocument.get(key) || []), m]);
  }
  const out: Transfer[] = [];
  const build = (lines: Movement[], from: string, to: string, paired: boolean): Transfer => {
    const first = lines[0];
    const negative = lines.find((line) => (line.quantity || 0) < 0);
    const positive = lines.find((line) => (line.quantity || 0) > 0);
    const main = positive || first;
    return {
      key: movementKey(first),
      document: first.document,
      year: first.year,
      type: first.type,
      items: lines.map((line) => line.item).filter(Boolean),
      from,
      to,
      quantity: Math.abs(first.quantity || 0),
      unit: lines.map((line) => line.unit).find(Boolean) || "",
      date: dateOf(main) || dateOf(first),
      time: main.entryTime || first.entryTime,
      user: lines.map((line) => line.user).find(Boolean) || "",
      headerText: lines.map((line) => line.headerText).find(Boolean) || "",
      itemText: [negative?.itemText, positive?.itemText].filter(Boolean).filter((text, i, all) => all.indexOf(text) === i).join(" / "),
      paired,
      sort: chronoKey(first),
      lines,
    };
  };
  for (const lines of byDocument.values()) {
    const sorted = [...lines].sort((a, b) => itemNumber(a.item) - itemNumber(b.item));
    const used = new Set<Movement>();
    for (const negative of sorted.filter((line) => (line.quantity || 0) < 0)) {
      const candidates = sorted.filter(
        (line) => !used.has(line) && (line.quantity || 0) > 0 && line.type === negative.type && Math.abs((line.quantity || 0) + (negative.quantity || 0)) < 1e-9,
      );
      candidates.sort(
        (a, b) => Math.abs(itemNumber(a.item) - itemNumber(negative.item) - 1) - Math.abs(itemNumber(b.item) - itemNumber(negative.item) - 1) || itemNumber(a.item) - itemNumber(b.item),
      );
      const positive = candidates[0];
      if (!positive) continue;
      used.add(negative);
      used.add(positive);
      out.push(build([negative, positive], negative.depot, positive.depot, true));
    }
    for (const line of sorted)
      if (!used.has(line)) {
        const outgoing = (line.quantity || 0) < 0;
        out.push(build([line], outgoing ? line.depot : line.counterDepot, outgoing ? line.counterDepot : line.depot, false));
      }
  }
  return out.sort((a, b) => (a.sort < b.sort ? -1 : a.sort > b.sort ? 1 : 0));
}

/** Transferências que entram no depósito de destino (as que o dossiê cobra por padrão).
 * Estornos (312, 302…, final par) não entram: são a volta de um lançamento anterior. */
export const inboundTransfers = (transfers: Transfer[], target: string) =>
  transfers.filter((t) => t.to === target && t.from !== target && Number(t.type) % 2 === 1);

const round = (value: number) => Math.round(value * 1e6) / 1e6;
/** Saldo de cada depósito pelos lançamentos colados (não substitui a MB52). */
export function balancesOf(movements: Movement[]) {
  const map = new Map<string, number>();
  for (const m of movements) if (m.depot && m.quantity !== null) map.set(m.depot, round((map.get(m.depot) || 0) + m.quantity));
  return [...map.entries()].map(([depot, quantity]) => ({ depot, quantity })).sort((a, b) => a.depot.localeCompare(b.depot, "pt-BR", { numeric: true }));
}

export type LotResult = {
  key: string;
  depot: string;
  quantity: number;
  consumed: number;
  transferredOut: number;
  outTo: Record<string, number>;
  scrapped: number;
  other: number;
  remaining: number;
};
type Lot = LotResult & { at: string };
/**
 * O que aconteceu com cada entrada em cada depósito. Cada entrada (transferência,
 * entrada de mercadoria, saldo inicial…) vira um lote; cada saída do depósito abate
 * primeiro o lote mais antigo (FIFO): consumo (2xx), transferência para outro
 * depósito, sucata (551/553/555) ou outro; o estorno de consumo (262) devolve ao
 * lote de onde saiu. O que sobra no lote ainda está parado.
 * Saída anterior a qualquer entrada colada abate saldo que a extração não mostra.
 */
export function lotsOf(movements: Movement[], transfers: Transfer[]) {
  const sides = new Map<Movement, { transfer: Transfer; side: "in" | "out" }>();
  for (const t of transfers) {
    if (t.from === t.to) continue;
    for (const line of t.lines) sides.set(line, { transfer: t, side: (line.quantity || 0) > 0 ? "in" : "out" });
  }
  const lots: Lot[] = [];
  const results = new Map<string, LotResult>();
  for (const m of chronological(movements)) {
    if (!m.depot || !m.quantity) continue;
    const side = sides.get(m);
    if (m.quantity > 0) {
      let back = m.quantity;
      // Estorno de consumo (262, 202…): volta para o lote de onde saiu o consumo mais recente.
      if (m.type.startsWith("2") && side === undefined)
        for (const lot of [...lots].reverse()) {
          if (back <= 1e-9) break;
          if (lot.depot !== m.depot || lot.consumed <= 1e-9) continue;
          const give = Math.min(lot.consumed, back);
          lot.consumed = round(lot.consumed - give);
          lot.remaining = round(lot.remaining + give);
          back = round(back - give);
        }
      if (back <= 1e-9) continue;
      const key = side?.side === "in" ? side.transfer.key : "mov:" + movementKey(m);
      const lot: Lot = { key, depot: m.depot, quantity: back, consumed: 0, transferredOut: 0, outTo: {}, scrapped: 0, other: 0, remaining: back, at: chronoKey(m) };
      lots.push(lot);
      results.set(key, lot);
      continue;
    }
    let out = -m.quantity;
    const kind = side?.side === "out" ? "transferredOut" : m.type.startsWith("2") ? "consumed" : ["551", "553", "555"].includes(m.type) ? "scrapped" : "other";
    for (const lot of lots) {
      if (out <= 1e-9) break;
      if (lot.depot !== m.depot || lot.remaining <= 1e-9) continue;
      const take = Math.min(lot.remaining, out);
      lot.remaining = round(lot.remaining - take);
      lot[kind] = round(lot[kind] + take);
      if (kind === "transferredOut") {
        const to = side?.transfer.to || "?";
        lot.outTo[to] = round((lot.outTo[to] || 0) + take);
      }
      out = round(out - take);
    }
  }
  return results;
}

export type QuestionedTransfer = Transfer & {
  consumed: number | null;
  transferredOut: number | null;
  outTo: Record<string, number>;
  scrapped: number | null;
  other: number | null;
  idle: number | null;
  days: number | null;
};
export type Finding = { tone: "alert" | "info" | "ok"; text: string };
export type DossieAnalysis = {
  ordered: Movement[];
  transfers: Transfer[];
  questioned: QuestionedTransfer[];
  balances: { depot: string; quantity: number }[];
  unit: string;
  unitPrice: number | null;
  priceSource: "manual" | "estoque" | "mb51" | "";
  priceNote: string;
  transferred: number;
  idle: number | null;
  idleValue: number | null;
  findings: Finding[];
  /** Frase sobre as BOMs do portal (vazia sem consulta). */
  bomText: string;
  missingColumns: string[];
};

export const fmtQty = (value: number | null | undefined) =>
  value === null || value === undefined ? "—" : value.toLocaleString("pt-BR", { maximumFractionDigits: 3 });
export const fmtMoney = (value: number | null | undefined) =>
  value === null || value === undefined ? "—" : value.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
export const brDate = (iso: string) => (/^\d{4}-\d{2}-\d{2}/.test(iso || "") ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : "");
/** "AAAA-MM-DD" de hoje em Brasília. */
export function todayIso(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  return /^\d{4}-\d{2}-\d{2}$/.test(parts) ? parts : now.toISOString().slice(0, 10);
}
/** Dia (Brasília) de um carimbo ISO. */
export const isoDay = (stamp: string) => (Number.isFinite(Date.parse(stamp)) ? todayIso(new Date(stamp)) : "");
export function addBusinessDays(iso: string, days: number) {
  const date = new Date(iso + "T12:00:00Z");
  let left = days;
  while (left > 0) {
    date.setUTCDate(date.getUTCDate() + 1);
    const day = date.getUTCDay();
    if (day !== 0 && day !== 6) left--;
  }
  return date.toISOString().slice(0, 10);
}
export const daysBetween = (fromIso: string, toIso: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(fromIso) && /^\d{4}-\d{2}-\d{2}$/.test(toIso)
    ? Math.round((Date.parse(toIso + "T12:00:00Z") - Date.parse(fromIso + "T12:00:00Z")) / 86_400_000)
    : null;

/** Unidade do dossiê: a mais frequente nas linhas (a MB51 pode trazer a unidade só em algumas). */
function mainUnit(movements: Movement[]) {
  const count = new Map<string, number>();
  for (const m of movements) if (m.unit) count.set(m.unit, (count.get(m.unit) || 0) + 1);
  return [...count.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "";
}
const depotName = (depot: string) => (depot ? depot : "?");
export const route = (t: Pick<Transfer, "from" | "to">) => `${depotName(t.from)} → ${depotName(t.to)}`;
export const itemsLabel = (items: string[]) => (items.length ? `${items.length > 1 ? "itens" : "item"} ${items.join("/")}` : "sem item");

export function analyzeDossie(data: DossieData, options: { today?: string; bom?: BomLookup | null } = {}): DossieAnalysis {
  const today = options.today || todayIso();
  const ordered = chronological(data.movements);
  const transfers = transfersOf(data.movements);
  const lots = lotsOf(data.movements, transfers);
  const unit = mainUnit(data.movements);
  const questionedKeys = new Set(data.questioned);
  const questioned: QuestionedTransfer[] = transfers
    .filter((t) => questionedKeys.has(t.key))
    .map((t) => {
      const lot = t.to ? lots.get(t.key) : undefined;
      return {
        ...t,
        consumed: lot ? lot.consumed : null,
        transferredOut: lot ? lot.transferredOut : null,
        outTo: lot ? lot.outTo : {},
        scrapped: lot ? lot.scrapped : null,
        other: lot ? lot.other : null,
        idle: lot ? lot.remaining : null,
        days: lot && lot.remaining > 1e-9 ? daysBetween(t.date, today) : null,
      };
    });
  const transferred = round(questioned.reduce((sum, t) => sum + t.quantity, 0));
  const idleKnown = questioned.filter((t) => t.idle !== null);
  const idle = idleKnown.length ? round(idleKnown.reduce((sum, t) => sum + (t.idle || 0), 0)) : null;

  // Preço: digitado > valor do estoque na planilha (destino) > média dos lançamentos com valor.
  let unitPrice: number | null = null,
    priceSource: DossieAnalysis["priceSource"] = "",
    priceNote = "";
  if (data.manualPrice !== null && Number.isFinite(data.manualPrice)) {
    unitPrice = data.manualPrice;
    priceSource = "manual";
    priceNote = "preço informado no dossiê";
  } else {
    const destination = questioned.find((t) => t.to)?.to || data.target;
    const stock = data.stockCheck?.depots.find((d) => d.depot === destination && d.found && d.quantity && d.value !== null && d.quantity > 0);
    if (stock && stock.value !== null && stock.quantity) {
      unitPrice = stock.value / stock.quantity;
      priceSource = "estoque";
      priceNote = `valor do estoque ${destination} na planilha`;
    } else {
      let qty = 0,
        value = 0;
      for (const m of data.movements)
        if (m.amount && m.quantity && (!m.currency || m.currency === "BRL")) {
          qty += Math.abs(m.quantity);
          value += Math.abs(m.amount);
        }
      if (qty > 0) {
        unitPrice = value / qty;
        priceSource = "mb51";
        priceNote = "média dos lançamentos com valor na MB51";
      }
    }
  }
  const idleValue = idle !== null && unitPrice !== null ? Math.round(idle * unitPrice * 100) / 100 : null;

  const findings: Finding[] = [];
  const u = unit ? " " + unit : "";
  if (!questioned.length) findings.push({ tone: "alert", text: "Nenhuma transferência marcada para cobrança. Marque a transferência questionada na lista de transferências." });
  for (const t of questioned) {
    const when = t.date ? ` em ${brDate(t.date)}${t.time ? " às " + t.time.slice(0, 5) : ""}` : "";
    findings.push({
      tone: "info",
      text: `Transferência ${route(t)} de ${fmtQty(t.quantity)}${u} (doc. ${t.document}, ${itemsLabel(t.items)}, TMv ${t.type})${when}${t.user ? ` por ${t.user}` : ""}.`,
    });
    if (!t.headerText && !t.itemText) findings.push({ tone: "alert", text: `O documento ${t.document} não tem texto de cabeçalho nem texto do item explicando a transferência.` });
    if (!t.paired) findings.push({ tone: "alert", text: `Só uma das linhas do documento ${t.document} foi colada; o outro depósito ${t.to ? "de origem" : "de destino"} não aparece.` });
    if (t.idle === null) continue;
    const dest = t.to;
    if (t.consumed) findings.push({ tone: "ok", text: `Consumido no ${dest} depois da transferência: ${fmtQty(t.consumed)}${u} (${Math.round((t.consumed / t.quantity) * 100)}% do transferido).` });
    else findings.push({ tone: "alert", text: `Nenhum consumo (261) deste material no ${dest} depois da transferência.` });
    const outs = Object.entries(t.outTo);
    if (outs.length) findings.push({ tone: "ok", text: `Saiu do ${dest} depois: ${outs.map(([to, qty]) => `${fmtQty(qty)}${u} para o ${to}`).join(", ")}.` });
    if (t.scrapped) findings.push({ tone: "info", text: `Sucata no ${dest} depois: ${fmtQty(t.scrapped)}${u}.` });
    if (t.other) findings.push({ tone: "info", text: `Outras saídas do ${dest} depois: ${fmtQty(t.other)}${u}.` });
    if (t.idle > 1e-9) {
      const value = unitPrice !== null ? ` · ${fmtMoney(Math.round(t.idle * unitPrice * 100) / 100)}` : "";
      findings.push({ tone: "alert", text: `Ainda parado no ${dest} por esta transferência: ${fmtQty(t.idle)}${u}${value}${t.days !== null && t.days >= 0 ? ` · há ${t.days} dia(s)` : ""}.` });
    } else findings.push({ tone: "ok", text: `Nada desta transferência continua parado no ${dest}.` });
  }
  const bom = options.bom;
  let bomText = "";
  if (bom) {
    const uses = bom.materials[data.material] || [];
    bomText = !uses.length
      ? `O material não consta em nenhuma das ${bom.checked} BOM(s) cadastradas no portal (BOM × OP e plano).`
      : `Consta em ${uses.length} BOM(s) do portal: ${uses
          .slice(0, 4)
          .map((use) => `${use.name}${use.revision ? " — " + use.revision : ""} (${fmtQty(use.required)} ${use.unit || unit}/${use.kind === "plan" ? "ônibus" : "OP"})`)
          .join("; ")}${uses.length > 4 ? "; …" : ""}.`;
    findings.push({ tone: uses.length ? "info" : "alert", text: bomText });
  }
  if (data.stockCheck) {
    const read = data.stockCheck.depots.map((d) => `${d.depot} ${d.found ? fmtQty(d.quantity) + (d.unit ? " " + d.unit : u) : "sem saldo"}`).join(" · ");
    findings.push({ tone: "info", text: `Saldo na planilha (${brDate(isoDay(data.stockCheck.readAt))}): ${read}.` });
  }
  const missingColumns: string[] = [];
  if (!data.movements.some((m) => m.postingDate || m.entryDate)) missingColumns.push("Data de lançamento");
  if (!data.movements.some((m) => m.user)) missingColumns.push("Nome do usuário");
  if (!data.movements.some((m) => m.item)) missingColumns.push("Item");
  if (missingColumns.length)
    findings.push({ tone: "info", text: `A MB51 colada não trouxe ${missingColumns.join(", ")}. Inclua no layout para o dossiê mostrar quem e quando transferiu.` });

  return {
    ordered,
    transfers,
    questioned,
    balances: balancesOf(data.movements),
    unit,
    unitPrice,
    priceSource,
    priceNote,
    transferred,
    idle,
    idleValue,
    findings,
    bomText,
    missingColumns,
  };
}

export function dossieSummary(data: DossieData): DossieSummary {
  const analysis = analyzeDossie(data, { today: "2000-01-01" });
  return {
    material: data.material,
    description: data.description,
    unit: analysis.unit,
    target: data.target,
    transfers: analysis.questioned.map((t) => ({ key: t.key, document: t.document, items: t.items, from: t.from, to: t.to, quantity: t.quantity, date: t.date, time: t.time, user: t.user })),
    transferred: analysis.transferred,
    idle: analysis.idle,
    unitPrice: analysis.unitPrice,
    value: analysis.idleValue,
    firstDate: analysis.questioned.map((t) => t.date).filter(Boolean).sort()[0] || "",
    deadline: data.deadline,
  };
}

// ---------------------------------------------------------------------------
// Texto da cobrança
// ---------------------------------------------------------------------------

export const DEFAULT_REQUEST =
  "Pedimos que o Warehouse informe:\n1. o motivo da transferência e quem solicitou (requisição, e-mail ou chamado);\n2. se a linha não precisa do material, a devolução ao depósito de origem (311) com o número do documento.";

export function cobranca(input: { number: string; data: DossieData; track?: DossieTrack | null; status?: DossieStatus; analysis: DossieAnalysis }) {
  const { number, data, analysis } = input;
  const track = input.track || emptyTrack();
  const u = analysis.unit ? " " + analysis.unit : "";
  const routes = [...new Set(analysis.questioned.map((t) => route(t)))].join(", ") || `para o ${data.target}`;
  const subject = `[${number}] Transferência ${routes} sem justificativa · ${data.material}${data.description ? " " + data.description : ""}`;
  const lines: string[] = ["Olá, Warehouse.", ""];
  // Já cobrado e sem resposta: o próximo envio é um reforço.
  if (track.sentAt && (input.status === undefined || input.status === "sent"))
    lines.push(`Reforçando a cobrança enviada em ${brDate(isoDay(track.sentAt))} (${track.reminders.length + 2}ª cobrança).`, "");
  const target = analysis.questioned[0]?.to || data.target;
  lines.push(`Encontramos ${analysis.questioned.length > 1 ? "as transferências abaixo" : "a transferência abaixo"} para o depósito ${target} e precisamos do motivo.`, "");
  lines.push(`Dossiê: ${number}`, `Material: ${data.material}${data.description ? " · " + data.description : ""}`);
  for (const t of analysis.questioned) {
    lines.push(
      "",
      `Transferência: doc. ${t.document} (${itemsLabel(t.items)}) · TMv ${t.type} · ${route(t)} · ${fmtQty(t.quantity)}${u}`,
      `Lançada: ${t.date ? brDate(t.date) + (t.time ? " às " + t.time.slice(0, 5) : "") : "data não informada"}${t.user ? " por " + t.user : ""}`,
      `Texto no documento: ${[t.headerText, t.itemText].filter(Boolean).join(" / ") || "nenhum"}`,
    );
    if (t.idle !== null) {
      const outs = Object.entries(t.outTo);
      lines.push(
        `Depois da transferência, no ${t.to}:`,
        `• Consumo: ${t.consumed ? fmtQty(t.consumed) + u : "nenhum"}`,
        `• Saiu para outro depósito: ${outs.length ? outs.map(([to, qty]) => `${fmtQty(qty)}${u} para o ${to}`).join(", ") : "nada"}`,
        `• Parado: ${fmtQty(t.idle)}${u}${analysis.unitPrice !== null ? ` · ${fmtMoney(Math.round(t.idle * analysis.unitPrice * 100) / 100)} (${fmtMoney(analysis.unitPrice)}/${analysis.unit || "un"})` : ""}${t.days !== null && t.days >= 0 ? ` · há ${t.days} dia(s)` : ""}`,
      );
    }
  }
  if (analysis.bomText) lines.push("", analysis.bomText);
  lines.push("", (data.request || DEFAULT_REQUEST).trim());
  if (data.deadline) lines.push("", `Prazo para resposta: ${brDate(data.deadline)}.`);
  lines.push("", "Obrigado.");
  return { subject, text: lines.join("\n") };
}

// ---------------------------------------------------------------------------
// Validação (servidor e tela)
// ---------------------------------------------------------------------------

const isIso = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !!validIso(+value.slice(0, 4), +value.slice(5, 7), +value.slice(8, 10));
const isStamp = (value: unknown): value is string => typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value));
const finite = (value: unknown) => (value === null || value === undefined || value === "" ? null : typeof value === "number" && Number.isFinite(value) ? value : null);
const text = (value: unknown, max: number) =>
  String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim()
    .slice(0, max);
export const validMaterial = (value: string) => /^[A-Z0-9][A-Z0-9._\-\/ ]{0,39}$/.test(value);
export const validDepot = (value: string) => /^[A-Z0-9]{1,10}$/.test(value);

export function sanitizeMovement(input: unknown): Movement {
  const m = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const document = code(m.document, 20);
  if (!/^[A-Z0-9]{1,20}$/i.test(document)) throw Error("Lançamento sem documento de material válido.");
  const type = code(m.type, 4).toUpperCase();
  if (!/^[A-Z0-9]{1,4}$/.test(type)) throw Error(`Tipo de movimento inválido no documento ${document}.`);
  const quantity = finite(m.quantity),
    amount = finite(m.amount);
  if (m.quantity !== null && m.quantity !== undefined && m.quantity !== "" && quantity === null) throw Error(`Quantidade inválida no documento ${document}.`);
  if (quantity !== null && Math.abs(quantity) > 1e12) throw Error(`Quantidade inválida no documento ${document}.`);
  if (amount !== null && Math.abs(amount) > 1e13) throw Error(`Valor inválido no documento ${document}.`);
  const depot = code(m.depot, 10).toUpperCase();
  if (depot && !validDepot(depot)) throw Error(`Depósito inválido no documento ${document}.`);
  const counterDepot = code(m.counterDepot, 10).toUpperCase();
  return {
    document,
    year: /^\d{4}$/.test(String(m.year ?? "")) ? String(m.year) : "",
    item: /^\d{1,6}$/.test(String(m.item ?? "")) ? String(Number(m.item)) : "",
    postingDate: isIso(m.postingDate) ? m.postingDate : "",
    entryDate: isIso(m.entryDate) ? m.entryDate : "",
    entryTime: typeof m.entryTime === "string" && /^\d{2}:\d{2}:\d{2}$/.test(m.entryTime) ? m.entryTime : "",
    depot,
    counterDepot: validDepot(counterDepot) ? counterDepot : "",
    plant: clean(m.plant, 10).toUpperCase(),
    type,
    typeText: clean(m.typeText, 60),
    special: clean(m.special, 2).toUpperCase(),
    quantity,
    unit: clean(m.unit, 8).toUpperCase(),
    amount,
    currency: clean(m.currency, 5).toUpperCase(),
    user: clean(m.user, 30).toUpperCase(),
    headerText: clean(m.headerText, 120),
    itemText: clean(m.itemText, 120),
    order: clean(m.order, 20),
    costCenter: clean(m.costCenter, 20),
    reference: clean(m.reference, 30),
    receiver: clean(m.receiver, 30),
    batch: clean(m.batch, 20),
  };
}

export function sanitizeStockCheck(input: unknown): StockCheck | null {
  if (!input || typeof input !== "object") return null;
  const s = input as Record<string, unknown>;
  if (!isStamp(s.readAt) || !Array.isArray(s.depots)) return null;
  const depots = s.depots.slice(0, 6).flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const d = raw as Record<string, unknown>;
    const depot = code(d.depot, 10).toUpperCase();
    if (!validDepot(depot)) return [];
    return [{ depot, quantity: finite(d.quantity), value: finite(d.value), unit: clean(d.unit, 8).toUpperCase(), found: d.found === true }];
  });
  return { readAt: new Date(s.readAt).toISOString(), depots };
}

/** Dados do dossiê enviados pela tela: confere tudo e devolve só o que vale. */
export function sanitizeDossieData(input: unknown): DossieData {
  const d = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const material = code(d.material, 40).toUpperCase();
  if (!validMaterial(material)) throw Error("Material inválido.");
  if (!Array.isArray(d.movements) || !d.movements.length) throw Error("O dossiê precisa dos lançamentos da MB51 do material.");
  if (d.movements.length > MAX_MOVEMENTS)
    throw Error(`A MB51 deste material tem ${d.movements.length} lançamentos; o dossiê guarda até ${MAX_MOVEMENTS}. Filtre o período na MB51 e cole de novo.`);
  const movements = d.movements.map(sanitizeMovement);
  const keys = new Set<string>();
  for (const m of movements) {
    const key = movementKey(m);
    if (m.item && keys.has(key)) throw Error(`O lançamento ${m.document} item ${m.item} aparece duas vezes.`);
    keys.add(key);
  }
  const target = code(d.target, 10).toUpperCase() || DEFAULT_TARGET;
  if (!validDepot(target)) throw Error("Depósito de destino inválido.");
  const transferKeys = new Set(transfersOf(movements).map((t) => t.key));
  const questioned = Array.isArray(d.questioned) ? [...new Set(d.questioned.map(String))].filter((key) => transferKeys.has(key)).slice(0, 50) : [];
  if (!questioned.length) throw Error("Marque pelo menos uma transferência para cobrar.");
  const manualPrice = finite(d.manualPrice);
  if (manualPrice !== null && (manualPrice < 0 || manualPrice > 1e9)) throw Error("Preço unitário inválido.");
  const deadline = d.deadline === "" || d.deadline === undefined || d.deadline === null ? "" : isIso(d.deadline) ? d.deadline : null;
  if (deadline === null) throw Error("Prazo inválido.");
  return {
    material,
    description: clean(d.description, 120),
    plant: clean(d.plant, 10).toUpperCase(),
    target,
    movements,
    questioned,
    manualPrice,
    request: text(d.request, 4000),
    deadline,
    recipients: text(d.recipients, 500).replace(/\n+/g, " "),
    notes: text(d.notes, 4000),
    stockCheck: sanitizeStockCheck(d.stockCheck),
    source: clean(d.source, 200),
    importedAt: isStamp(d.importedAt) ? new Date(d.importedAt).toISOString() : "",
  };
}

/** Ordem na gravação compacta: os campos quase sempre vazios ficam no fim e são cortados. */
const MOVEMENT_FIELDS = [
  "document", "year", "item", "postingDate", "depot", "type", "quantity", "amount", "user", "entryTime", "headerText", "itemText",
  "unit", "currency", "entryDate", "counterDepot", "typeText", "special", "plant", "order", "costCenter", "reference", "receiver", "batch",
] as const satisfies readonly (keyof Movement)[];
/** Gravação compacta: cada lançamento vira uma lista na ordem de MOVEMENT_FIELDS, sem os vazios do fim. */
export function packData(data: DossieData) {
  const movements = data.movements.map((m) => {
    const row: unknown[] = MOVEMENT_FIELDS.map((field) => m[field]);
    while (row.length && (row[row.length - 1] === "" || row[row.length - 1] === null)) row.pop();
    return row;
  });
  return JSON.stringify({ v: 1, ...data, movements });
}
export function unpackData(raw: string): DossieData {
  const parsed = JSON.parse(raw);
  const movements = Array.isArray(parsed.movements)
    ? parsed.movements.map((row: unknown) => (Array.isArray(row) ? Object.fromEntries(MOVEMENT_FIELDS.map((field, i) => [field, row[i]])) : row))
    : [];
  return sanitizeDossieData({ ...parsed, movements });
}

export function sanitizeTrack(input: unknown): DossieTrack {
  const t = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const stamp = (value: unknown) => (isStamp(value) ? new Date(value).toISOString() : "");
  return {
    sentAt: stamp(t.sentAt),
    reminders: Array.isArray(t.reminders) ? t.reminders.map(stamp).filter(Boolean).slice(-50) : [],
    response: text(t.response, 4000),
    responseBy: clean(t.responseBy, 80),
    respondedAt: isIso(t.respondedAt) ? t.respondedAt : "",
    outcome: isOutcome(t.outcome) ? t.outcome : "",
    outcomeNote: text(t.outcomeNote, 2000),
    returnDocument: clean(t.returnDocument, 30),
    closedAt: stamp(t.closedAt),
    log: Array.isArray(t.log)
      ? t.log
          .flatMap((entry) => {
            if (!entry || typeof entry !== "object") return [];
            const e = entry as Record<string, unknown>;
            return isStamp(e.at) ? [{ at: new Date(e.at).toISOString(), role: clean(e.role, 20), text: clean(e.text, 300) }] : [];
          })
          .slice(-100)
      : [],
  };
}
