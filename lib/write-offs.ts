import { normalize, number } from "./materials.ts";

/**
 * BAIXA CC — baixas de centro de custo (formulário FO.FI.C.007).
 *
 * A aba "BAIXA CC" do Google Sheets tem uma linha por baixa e uma coluna com o
 * link do PDF no Google Drive. Os nomes das colunas podem variar; só é preciso
 * ter Centro de custo e (Documento ou link do PDF). O portal só lê: não grava
 * na planilha nem no SAP.
 */

export const WRITE_OFF_SHEETS = ["BAIXA CC", "BAIXAS CC", "BAIXA CENTRO DE CUSTO", "BAIXAS"] as const;

const FIELDS = {
  date: ["Data", "Data da baixa", "Data de lançamento", "Data lançamento", "Data doc.", "Data do documento", "Dt"],
  document: ["Documento", "Nº documento", "N° documento", "Número", "Nº", "N°", "Documento material", "Doc.material", "Doc", "Formulário", "FO"],
  costCenter: ["Centro de custo", "Centro de custos", "Centro custo", "C. custo", "CC", "Cost center", "Kostenstelle"],
  costCenterName: ["Descrição do centro de custo", "Nome do centro de custo", "Descrição CC", "Área", "Setor", "Departamento"],
  material: ["Material", "Código SAP", "SAP", "Código"],
  description: ["Texto breve material", "Descrição do material", "Descrição", "Description"],
  quantity: ["Quantidade", "Qtd", "Qtd.", "Qtde", "Qty"],
  unit: ["UMB", "UM", "Unidade", "UM básica"],
  value: ["Valor", "Valor total", "Valor R$", "Montante", "Total"],
  reason: ["Motivo", "Justificativa", "Observação", "Observações", "Obs", "Obs.", "Comentário"],
  requester: ["Solicitante", "Responsável", "Requisitante", "Aprovador"],
  op: ["OP", "Ordem", "Ordem de produção"],
  status: ["Status", "Situação"],
  pdf: ["PDF", "Link PDF", "Link do PDF", "Link", "Arquivo", "Anexo", "Documento PDF", "Drive"],
} as const;
export type WriteOffField = keyof typeof FIELDS;

/** Map each field to its column (first alias by priority). */
export function writeOffColumns(headers: unknown[]) {
  const labels = headers.map((header) => normalize(header));
  const columns: Partial<Record<WriteOffField, number>> = {};
  for (const [field, aliases] of Object.entries(FIELDS) as [WriteOffField, readonly string[]][]) {
    for (const alias of aliases) {
      const index = labels.indexOf(normalize(alias));
      if (index >= 0 && !Object.values(columns).includes(index)) {
        columns[field] = index;
        break;
      }
    }
  }
  return columns;
}

/** The tab must really be the write-off list (protects against reading another tab). */
export function isWriteOffHeader(headers: unknown[]) {
  const columns = writeOffColumns(headers);
  return columns.costCenter !== undefined && (columns.document !== undefined || columns.pdf !== undefined);
}

export type WriteOff = {
  row: number;
  date: string | null;
  month: string;
  document: string;
  costCenter: string;
  costCenterName: string;
  material: string;
  description: string;
  quantity: number | null;
  unit: string;
  value: number | null;
  reason: string;
  requester: string;
  op: string;
  status: string;
  pdfUrl: string | null;
  pdfPreview: string | null;
  pdfLabel: string;
};

const text = (value: unknown) =>
  String(value ?? "")
    .trim()
    .replace(/\.0+$/, "");
const pad = (value: number) => String(value).padStart(2, "0");

/** Sheets serial number, gviz "Date(2026,8,30)", 30/09/2026 or ISO → yyyy-mm-dd. */
export function sheetDate(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value) && value > 20000 && value < 80000) {
    const date = new Date(Date.UTC(1899, 11, 30) + Math.round(value) * 86_400_000);
    return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
  }
  const raw = String(value).trim();
  let match = raw.match(/^Date\((\d{4}),(\d{1,2}),(\d{1,2})/);
  if (match) return `${match[1]}-${pad(Number(match[2]) + 1)}-${pad(Number(match[3]))}`;
  match = raw.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/);
  if (match) return `${match[3]}-${pad(Number(match[2]))}-${pad(Number(match[1]))}`;
  match = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) return `${match[1]}-${match[2]}-${match[3]}`;
  return null;
}

/** Only http(s) links are ever rendered; =HYPERLINK("url";"texto") is accepted. */
export function pdfLink(value: unknown): { url: string | null; label: string } {
  const raw = String(value ?? "").trim();
  if (!raw) return { url: null, label: "" };
  const formula = raw.match(/^=\s*HYPERLINK\(\s*"([^"]+)"\s*(?:[;,]\s*"([^"]*)")?/i);
  const candidate = formula ? formula[1] : raw;
  const label = formula?.[2] || "";
  try {
    const url = new URL(candidate);
    if (url.protocol !== "https:" && url.protocol !== "http:") return { url: null, label: raw };
    return { url: url.href, label: label || "PDF" };
  } catch {
    return { url: null, label: raw };
  }
}

/** Google Drive file → embeddable preview URL; any other site → null (opens in a new tab). */
export function drivePreview(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (!/^(drive|docs)\.google\.com$/.test(parsed.hostname)) return null;
    const id = parsed.pathname.match(/\/(?:file\/)?d\/([A-Za-z0-9_-]{10,})/)?.[1] || parsed.searchParams.get("id");
    return id && /^[A-Za-z0-9_-]{10,}$/.test(id) ? `https://drive.google.com/file/d/${id}/preview` : null;
  } catch {
    return null;
  }
}

export function parseWriteOffs(matrix: unknown[][]): WriteOff[] {
  const [headers = [], ...rows] = matrix;
  if (!isWriteOffHeader(headers))
    throw Error(
      'A aba BAIXA CC precisa ter na primeira linha as colunas "Centro de custo" e "Documento" ou "PDF". Confira o cabeçalho.',
    );
  const at = writeOffColumns(headers);
  const cell = (row: unknown[], field: WriteOffField) => (at[field] === undefined ? null : (row[at[field]!] ?? null));
  const out: WriteOff[] = [];
  rows.forEach((row, index) => {
    if (!Array.isArray(row) || !row.some((value) => value !== null && value !== "")) return;
    const date = sheetDate(cell(row, "date"));
    const link = pdfLink(cell(row, "pdf"));
    out.push({
      row: index + 2,
      date,
      month: date ? date.slice(0, 7) : "",
      document: text(cell(row, "document")),
      costCenter: text(cell(row, "costCenter")),
      costCenterName: text(cell(row, "costCenterName")),
      material: text(cell(row, "material")),
      description: text(cell(row, "description")),
      quantity: number(cell(row, "quantity")),
      unit: text(cell(row, "unit")),
      value: number(cell(row, "value")),
      reason: text(cell(row, "reason")),
      requester: text(cell(row, "requester")),
      op: text(cell(row, "op")),
      status: text(cell(row, "status")),
      pdfUrl: link.url,
      pdfPreview: drivePreview(link.url),
      pdfLabel: link.label,
    });
  });
  // Newest first; rows without date keep the sheet order at the end.
  return out.sort((a, b) => (b.date || "").localeCompare(a.date || "") || a.row - b.row);
}

/** gviz / Sheets API payload → matrix with the header in row 0. */
export function decodeWriteOffMatrix(textBody: string, format: string | null): unknown[][] {
  if (format === "sheets-api") {
    const data = JSON.parse(textBody);
    const values = data.values || data.valueRanges?.[0]?.values;
    if (!Array.isArray(values)) throw Error("Resposta da planilha inválida.");
    return values;
  }
  const match = textBody.match(/setResponse\(([\s\S]*)\);?\s*$/);
  if (!match) throw Error("O Google não retornou a aba BAIXA CC. Confira a autorização da planilha.");
  const data = JSON.parse(match[1]);
  if (data.status === "error" || !data.table) throw Error("A aba BAIXA CC está indisponível na planilha.");
  return [
    data.table.cols.map((column: any) => column.label || column.id),
    ...data.table.rows.map((row: any) => data.table.cols.map((_: any, i: number) => row.c?.[i]?.v ?? null)),
  ];
}

export function summarizeWriteOffs(items: WriteOff[]) {
  const centers = new Map<string, { costCenter: string; name: string; count: number; value: number; withoutValue: number }>();
  for (const item of items) {
    const key = item.costCenter || "(sem centro de custo)";
    const group = centers.get(key) || { costCenter: key, name: item.costCenterName, count: 0, value: 0, withoutValue: 0 };
    group.count++;
    if (item.value === null) group.withoutValue++;
    else group.value = Math.round((group.value + item.value) * 100) / 100;
    if (!group.name && item.costCenterName) group.name = item.costCenterName;
    centers.set(key, group);
  }
  const documents = new Set(items.map((item) => item.document).filter(Boolean));
  return {
    count: items.length,
    documents: documents.size,
    value: Math.round(items.reduce((sum, item) => sum + (item.value || 0), 0) * 100) / 100,
    withoutValue: items.filter((item) => item.value === null).length,
    withoutPdf: items.filter((item) => !item.pdfUrl).length,
    centers: [...centers.values()].sort((a, b) => b.value - a.value || b.count - a.count),
  };
}
