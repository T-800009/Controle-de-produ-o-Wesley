import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFString,
  StandardFonts,
  decodePDFRawStream,
  rgb,
  type PDFFont,
  type PDFPage,
} from "pdf-lib";
import { checkCmsSignature, sha256Hex } from "./pdf-signature.ts";
import { SCRAP_FORM_LOGO_JPEG } from "./scrap-logo.ts";
import { CC_TITLE, MAX_CC_ITEMS, ccItemTotal, ccTotals, periodLabel, type CcFormData } from "./cc-form.ts";
import {
  CAUSES,
  CC_SLOTS,
  MAX_ITEMS,
  MAX_PDF_BYTES,
  SLOTS,
  isSlotId,
  brDate,
  formTotal,
  itemTotal,
  requiredSlots,
  slotFromFieldName,
  type ScrapFormData,
  type ScrapSignature,
  type SlotId,
} from "./scrap-form.ts";

/**
 * PDF do Scrap Form: uma página Carta paisagem, no layout do formulário da
 * equipe, com um campo de assinatura digital vazio (e nomeado) em cada quadro.
 * Quem assina clica no campo do próprio quadro no Adobe; o Adobe grava a
 * assinatura como atualização incremental, sem tocar no conteúdo gerado aqui.
 */

export const PAGE = { width: 792, height: 612, margin: 36 };
const CONTENT_WIDTH = PAGE.width - PAGE.margin * 2;
/** Quadros de aprovação: coluna de rótulos + 4 colunas iguais. */
export const APPROVAL = { label: 70, slot: (CONTENT_WIDTH - 70) / 4 };
/** Marca gravada no PDF para reconhecer o formulário ao receber de volta. */
export const FORM_KEY = "WBYDScrapForm";
const BOXES_KEY = "WBYDSignatureBoxes";

type Column = { key: string; label: string[]; width: number; align: "left" | "center" | "right" };
const COLUMNS: Column[] = [
  { key: "date", label: ["DATE"], width: 50, align: "center" },
  { key: "material", label: ["P/N SAP"], width: 62, align: "center" },
  { key: "quantity", label: ["QTD"], width: 28, align: "center" },
  { key: "name", label: ["Name"], width: 130, align: "left" },
  { key: "defect", label: ["DESCRIPTION OF THE DEFECT"], width: 170, align: "left" },
  { key: "vin", label: ["N° VIN"], width: 38, align: "center" },
  { key: "op", label: ["Production", "Order"], width: 62, align: "center" },
  { key: "cause", label: ["CAUSE"], width: 36, align: "center" },
  { key: "unitPrice", label: ["UNIT PRICE"], width: 58, align: "right" },
  { key: "total", label: ["TOTAL", "VALUE"], width: 58, align: "right" },
  { key: "classification", label: ["CLASS"], width: 28, align: "center" },
];

const BLACK = rgb(0, 0, 0);
const GRAY = rgb(0.84, 0.84, 0.84);
const LIGHT = rgb(0.95, 0.95, 0.95);
const MUTED = rgb(0.38, 0.38, 0.38);
const RED = rgb(0.78, 0.07, 0.11);

const money = (value: number | null) =>
  value === null ? "" : value.toLocaleString("pt-BR", { style: "currency", currency: "BRL" }).replace(/ /g, " ");
const quantity = (value: number | null) => (value === null ? "" : value.toLocaleString("pt-BR", { maximumFractionDigits: 3 }));

/** Fontes padrão do PDF só têm o alfabeto latino (WinAnsi): troca o resto. */
function cleaner(font: PDFFont) {
  const supported = new Set(font.getCharacterSet());
  return (value: string) =>
    String(value ?? "")
      .normalize("NFC")
      .replace(/[‘’‛]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/[–—−]/g, "-")
      .replace(/…/g, "...")
      .replace(/[   ]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .split("")
      .map((char) => (supported.has(char.codePointAt(0)!) ? char : "?"))
      .join("");
}

type Fonts = { regular: PDFFont; bold: PDFFont; clean: (value: string) => string };
type TextOptions = { size?: number; min?: number; bold?: boolean; align?: "left" | "center" | "right"; lines?: number; color?: ReturnType<typeof rgb> };

function wrap(font: PDFFont, text: string, size: number, width: number) {
  const words = text.split(" ");
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const next = line ? line + " " + word : word;
    if (font.widthOfTextAtSize(next, size) <= width || !line) line = next;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}
function truncate(font: PDFFont, text: string, size: number, width: number) {
  if (font.widthOfTextAtSize(text, size) <= width) return text;
  let out = text;
  while (out.length > 1 && font.widthOfTextAtSize(out + "...", size) > width) out = out.slice(0, -1);
  return out.trimEnd() + "...";
}

/** Escreve dentro da célula: reduz a fonte e quebra linha até caber. */
function cell(page: PDFPage, fonts: Fonts, raw: string, x: number, y: number, width: number, height: number, options: TextOptions = {}) {
  const font = options.bold ? fonts.bold : fonts.regular;
  const text = fonts.clean(raw);
  if (!text) return;
  const pad = 2.5;
  const inner = width - pad * 2;
  const base = options.size ?? 7;
  const min = options.min ?? 4.6;
  const maxLines = options.lines ?? 2;
  let size = base;
  let lines = [text];
  let fitted = false;
  // 1º uma linha só, reduzindo um pouco; 2º quebra em até `maxLines` linhas.
  for (size = base; size >= Math.max(min, base - 1.2) - 0.001; size -= 0.2)
    if (font.widthOfTextAtSize(text, size) <= inner) {
      fitted = true;
      break;
    }
  if (!fitted && maxLines > 1)
    for (size = base; size >= min - 0.001; size -= 0.2) {
      const wrapped = wrap(font, text, size, inner);
      if (wrapped.length <= maxLines && wrapped.every((line) => font.widthOfTextAtSize(line, size) <= inner) && wrapped.length * size * 1.12 <= height - 1) {
        lines = wrapped;
        fitted = true;
        break;
      }
    }
  if (!fitted && maxLines === 1)
    for (size = base; size >= min - 0.001; size -= 0.2)
      if (font.widthOfTextAtSize(text, size) <= inner) {
        fitted = true;
        break;
      }
  if (!fitted) {
    size = min;
    const wrapped = maxLines > 1 ? wrap(font, text, size, inner) : [text];
    lines = wrapped.slice(0, maxLines);
    const rest = wrapped.slice(maxLines - 1).join(" ");
    lines[lines.length - 1] = truncate(font, wrapped.length > maxLines ? rest : lines[lines.length - 1], size, inner);
  }
  const leading = size * 1.12;
  const block = lines.length * leading;
  let baseline = y + height / 2 + block / 2 - size * 0.86;
  for (const line of lines) {
    const lineWidth = font.widthOfTextAtSize(line, size);
    const left = options.align === "center" ? x + (width - lineWidth) / 2 : options.align === "right" ? x + width - pad - lineWidth : x + pad;
    page.drawText(line, { x: left, y: baseline, size, font, color: options.color ?? BLACK });
    baseline -= leading;
  }
}
function box(page: PDFPage, x: number, y: number, width: number, height: number, fill?: ReturnType<typeof rgb>) {
  page.drawRectangle({ x, y, width, height, borderColor: BLACK, borderWidth: 0.6, ...(fill ? { color: fill } : {}) });
}

export type ScrapPdfInput = { number: string; data: ScrapFormData; generatedAt?: Date };

function base64Bytes(value: string) {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export async function buildScrapPdf({ number, data, generatedAt = new Date() }: ScrapPdfInput): Promise<Uint8Array> {
  if (data.items.length > MAX_ITEMS) throw Error(`Use no máximo ${MAX_ITEMS} itens por formulário.`);
  const doc = await PDFDocument.create();
  const page = doc.addPage([PAGE.width, PAGE.height]);
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const fonts: Fonts = { regular, bold, clean: cleaner(regular) };
  const left = PAGE.margin;
  const top = PAGE.height - PAGE.margin;

  // Cabeçalho: logotipo, título e número do formulário.
  const logo = await doc.embedJpg(base64Bytes(SCRAP_FORM_LOGO_JPEG));
  page.drawImage(logo, { x: left, y: top - 30, width: 55, height: 30 });
  const title = "Scrap Form";
  page.drawText(title, { x: PAGE.width / 2 - bold.widthOfTextAtSize(title, 18) / 2, y: top - 22, size: 18, font: bold });
  const subtitle = "Formulário de SCRAP A-B";
  page.drawText(subtitle, { x: PAGE.width / 2 - regular.widthOfTextAtSize(subtitle, 7.5) / 2, y: top - 33, size: 7.5, font: regular, color: MUTED });
  const numberText = fonts.clean(`Nº ${number}`);
  page.drawText(numberText, { x: left + CONTENT_WIDTH - bold.widthOfTextAtSize(numberText, 10), y: top - 12, size: 10, font: bold, color: RED });
  const dateText = fonts.clean(`DATE ${brDate(data.formDate)}`);
  page.drawText(dateText, { x: left + CONTENT_WIDTH - regular.widthOfTextAtSize(dateText, 8), y: top - 24, size: 8, font: regular });

  // Tabela de itens.
  const headerHeight = 24;
  const rows = Math.max(12, data.items.length);
  // Espaço até o rodapé descontando total, legenda e aprovação: linhas entre 15 e 20 pt.
  const available = top - 42 - headerHeight - (PAGE.margin + 15 + 16 + 28 + 22 + 113);
  const rowHeight = Math.max(15, Math.min(20, Math.floor(available / rows)));
  const textSize = rowHeight >= 18 ? 7.3 : 6.6;
  let y = top - 42 - headerHeight;
  let x = left;
  for (const column of COLUMNS) {
    box(page, x, y, column.width, headerHeight, GRAY);
    cell(page, fonts, column.label.join(" "), x, y, column.width, headerHeight, { bold: true, align: "center", size: 7, min: 5.5 });
    x += column.width;
  }
  for (let index = 0; index < rows; index++) {
    y -= rowHeight;
    const item = data.items[index];
    const values: Record<string, string> = item
      ? {
          date: brDate(item.date),
          material: item.material,
          quantity: quantity(item.quantity),
          name: item.name,
          defect: item.defect,
          vin: item.vin,
          op: item.op,
          cause: item.cause,
          unitPrice: money(item.unitPrice),
          total: money(itemTotal(item)),
          classification: item.classification,
        }
      : {};
    x = left;
    for (const column of COLUMNS) {
      box(page, x, y, column.width, rowHeight);
      if (item)
        cell(page, fonts, values[column.key] || "", x, y, column.width, rowHeight, {
          align: column.align,
          size: column.key === "cause" || column.key === "classification" ? 7.8 : textSize,
          bold: column.key === "cause" || column.key === "classification",
          lines: column.key === "name" || column.key === "defect" ? 2 : 1,
        });
      x += column.width;
    }
  }
  // Total do formulário, embaixo de UNIT PRICE / TOTAL VALUE.
  y -= rowHeight;
  const priceX = left + COLUMNS.slice(0, 8).reduce((sum, column) => sum + column.width, 0);
  box(page, priceX, y, COLUMNS[8].width, rowHeight, LIGHT);
  cell(page, fonts, "TOTAL", priceX, y, COLUMNS[8].width, rowHeight, { bold: true, align: "right", size: 7 });
  box(page, priceX + COLUMNS[8].width, y, COLUMNS[9].width, rowHeight, LIGHT);
  cell(page, fonts, money(formTotal(data)), priceX + COLUMNS[8].width, y, COLUMNS[9].width, rowHeight, { bold: true, align: "right", size: 7, min: 5 });
  const itemCount = `${data.items.length} item(s)`;
  page.drawText(itemCount, { x: left, y: y + 4.5, size: 6.5, font: regular, color: MUTED });

  // Legenda das causas.
  y -= 16;
  const captionTitle = "CAPTION";
  page.drawText(captionTitle, { x: PAGE.width / 2 - bold.widthOfTextAtSize(captionTitle, 9) / 2, y, size: 9, font: bold });
  y -= 6 + 22;
  const captionWidth = CONTENT_WIDTH / CAUSES.length;
  CAUSES.forEach((cause, index) => {
    box(page, left + index * captionWidth, y, captionWidth, 22);
    cell(page, fonts, `( ${cause.code} ) ${cause.en}`, left + index * captionWidth, y, captionWidth, 22, { align: "center", size: 6.8, lines: 2 });
  });

  // Aprovação: um campo de assinatura digital por quadro.
  y -= 16;
  const approvalTitle = "APPROVAL";
  page.drawText(approvalTitle, { x: PAGE.width / 2 - bold.widthOfTextAtSize(approvalTitle, 9) / 2, y, size: 9, font: bold });
  const required = new Set(requiredSlots(data).map((slot) => slot.id));
  const rowsSpec = [
    { label: "Responsible", height: 15 },
    { label: "Name", height: 15 },
    { label: "DATE:", height: 15 },
    { label: "Signature", height: 46 },
  ];
  y -= 6;
  const boxes: string[] = [];
  for (const row of rowsSpec) {
    y -= row.height;
    box(page, left, y, APPROVAL.label, row.height, GRAY);
    cell(page, fonts, row.label, left, y, APPROVAL.label, row.height, { bold: true, align: "center", size: 7 });
    SLOTS.forEach((slot, index) => {
      const slotX = left + APPROVAL.label + index * APPROVAL.slot;
      const active = required.has(slot.id);
      box(page, slotX, y, APPROVAL.slot, row.height, active ? undefined : LIGHT);
      if (row.label === "Responsible") cell(page, fonts, `${slot.order} . ${slot.role}`, slotX, y, APPROVAL.slot, row.height, { align: "center", size: 7 });
      if (row.label === "Name") cell(page, fonts, active ? data.approvers[slot.id] : "N/A (Class C)", slotX, y, APPROVAL.slot, row.height, { align: "center", size: 7.2, color: active ? BLACK : MUTED });
      if (row.label === "Signature") {
        if (!active) {
          cell(page, fonts, "Não se aplica: todos os itens são classe C", slotX, y, APPROVAL.slot, row.height, { align: "center", size: 6.5, color: MUTED });
          return;
        }
        boxes.push(signatureField(doc, page, slot, data.approvers[slot.id], [slotX + 2, y + 2, slotX + APPROVAL.slot - 2, y + row.height - 2]));
      }
    });
  }

  // Rodapé.
  const stamp = generatedAt.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
  const footer = fonts.clean(
    `${number} · gerado no Controle de Produção WBYD em ${stamp} · cada responsável assina com o ID digital clicando no campo do seu quadro`,
  );
  page.drawText(footer, { x: left, y: PAGE.margin - 14, size: 6.2, font: regular, color: MUTED });
  page.drawText("Página 1/1", { x: left + CONTENT_WIDTH - regular.widthOfTextAtSize("Página 1/1", 6.2), y: PAGE.margin - 14, size: 6.2, font: regular, color: MUTED });

  return finish(doc, { title: `Scrap Form ${number}`, subject: "Formulário de SCRAP A-B", keyword: "Scrap Form", number, generatedAt, boxes });
}

/** Campo de assinatura digital vazio, com o nome do quadro. Devolve o quadro para o Info do PDF. */
function signatureField(doc: PDFDocument, page: PDFPage, slot: { id: SlotId; field: string; order: string; role: string }, name: string, rect: number[]) {
  const widget = doc.context.obj({
    Type: "Annot",
    Subtype: "Widget",
    FT: "Sig",
    T: PDFString.of(slot.field),
    TU: PDFHexString.fromText(`${slot.order} ${slot.role}: ${name}`),
    Rect: rect,
    F: 4,
    P: page.ref,
  });
  const ref = doc.context.register(widget);
  page.node.addAnnot(ref);
  doc.getForm().acroForm.addField(ref);
  return `${slot.id}:${rect.map((value) => value.toFixed(1)).join(",")}`;
}
function finish(doc: PDFDocument, meta: { title: string; subject: string; keyword: string; number: string; generatedAt: Date; boxes: string[] }) {
  doc.setTitle(meta.title);
  doc.setSubject(meta.subject);
  doc.setAuthor("Controle de Produção WBYD");
  doc.setCreator("Controle de Produção WBYD");
  doc.setProducer("Controle de Produção WBYD");
  doc.setKeywords([meta.keyword, meta.number]);
  doc.setCreationDate(meta.generatedAt);
  doc.setModificationDate(meta.generatedAt);
  const info = doc.context.lookup(doc.context.trailerInfo.Info, PDFDict);
  info.set(PDFName.of(FORM_KEY), PDFString.of(meta.number));
  // Quadros de assinatura (página 1): um campo desenhado à parte só vale se estiver dentro de um deles.
  info.set(PDFName.of(BOXES_KEY), PDFString.of(meta.boxes.join(";")));
  return doc.save({ useObjectStreams: false, updateFieldAppearances: false });
}

/* ------------------------------------------------------------------------ */
/* FO.FI.C.007 — Inventory Adjustment (baixa em centro de custo)             */
/* ------------------------------------------------------------------------ */

/** A3 paisagem: a planilha original é larga (11 colunas + quadro de aprovação). */
export const CC_PAGE = { width: 1191, height: 842, margin: 24 };
const CC_COLUMNS: Column[] = [
  { key: "item", label: ["ITEM"], width: 40, align: "center" },
  { key: "company", label: ["COMPANY"], width: 62, align: "center" },
  { key: "plant", label: ["PLANT"], width: 52, align: "center" },
  { key: "wh", label: ["WH"], width: 46, align: "center" },
  { key: "material", label: ["MATERIAL CODE"], width: 92, align: "center" },
  { key: "description", label: ["DESCRIPTION OF MATERIAL"], width: 300, align: "left" },
  { key: "quantity", label: ["QTY"], width: 70, align: "center" },
  { key: "unitCost", label: ["UNIT COST"], width: 95, align: "right" },
  { key: "total", label: ["TOTAL COST"], width: 105, align: "right" },
  { key: "costCenter", label: ["COST CENTER"], width: 90, align: "center" },
  { key: "costCenterDescription", label: ["COST CENTER DESCRIPTION"], width: 191, align: "center" },
];
const REMARK_COLUMNS = [
  { key: "mainReason", label: "INFORM THE MAIN REASON:", width: 230 },
  { key: "reason", label: "REASON:", width: 130 },
  { key: "action", label: "ACTION", width: 232 },
] as const;
const APPROVAL_COLUMNS = [
  { key: "responsible", label: "RESPONSIBLE", width: 120 },
  { key: "name", label: "NAME", width: 150 },
  { key: "signature", label: "SIGNATURE", width: 171 },
  { key: "date", label: "DATE", width: 110 },
] as const;

export async function buildCcPdf({ number, data, generatedAt = new Date() }: { number: string; data: CcFormData; generatedAt?: Date }): Promise<Uint8Array> {
  if (data.items.length > MAX_CC_ITEMS) throw Error(`Use no máximo ${MAX_CC_ITEMS} itens por formulário.`);
  const doc = await PDFDocument.create();
  const page = doc.addPage([CC_PAGE.width, CC_PAGE.height]);
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const fonts: Fonts = { regular, bold, clean: cleaner(regular) };
  const left = CC_PAGE.margin;
  const width = CC_PAGE.width - CC_PAGE.margin * 2;
  let y = CC_PAGE.height - CC_PAGE.margin;

  // Cabeçalho: logotipo | título | mês de referência.
  const headerHeight = 46,
    logoWidth = 110,
    periodWidth = 230;
  y -= headerHeight;
  box(page, left, y, logoWidth, headerHeight);
  const logo = await doc.embedJpg(base64Bytes(SCRAP_FORM_LOGO_JPEG));
  page.drawImage(logo, { x: left + (logoWidth - 62) / 2, y: y + (headerHeight - 34) / 2, width: 62, height: 34 });
  box(page, left + logoWidth, y, width - logoWidth - periodWidth, headerHeight);
  cell(page, fonts, CC_TITLE, left + logoWidth, y, width - logoWidth - periodWidth, headerHeight, { bold: true, align: "center", size: 15, min: 11, lines: 1 });
  box(page, left + width - periodWidth, y, periodWidth, headerHeight);
  cell(page, fonts, periodLabel(data.period), left + width - periodWidth, y + 12, periodWidth, headerHeight - 12, { bold: true, align: "center", size: 14, lines: 1 });
  cell(page, fonts, `Nº ${number}`, left + width - periodWidth, y + 2, periodWidth, 14, { align: "center", size: 7.5, color: RED, lines: 1 });

  // Tabela de itens.
  y -= 8;
  const tableHeader = 28,
    totalHeight = 18,
    band = 24,
    subHeader = 26,
    footer = 16;
  const rows = Math.max(10, data.items.length);
  const fixed = headerHeight + 8 + tableHeader + totalHeight + 10 + band + subHeader + footer;
  const space = CC_PAGE.height - CC_PAGE.margin * 2 - fixed;
  const rowHeight = Math.max(15, Math.min(22, Math.floor((space - 4 * 60) / rows)));
  const approvalHeight = Math.max(60, Math.min(92, Math.floor((space - rowHeight * rows) / 4)));
  y -= tableHeader;
  let x = left;
  for (const column of CC_COLUMNS) {
    box(page, x, y, column.width, tableHeader, GRAY);
    cell(page, fonts, column.label.join(" "), x, y, column.width, tableHeader, { bold: true, align: "center", size: 7.5, min: 5.5 });
    x += column.width;
  }
  for (let index = 0; index < rows; index++) {
    y -= rowHeight;
    const item = data.items[index];
    const values: Record<string, string> = item
      ? {
          item: String(index + 1),
          company: item.company,
          plant: item.plant,
          wh: item.wh,
          material: item.material,
          description: item.description,
          quantity: quantity(item.quantity),
          unitCost: money(item.unitCost),
          total: money(ccItemTotal(item)),
          costCenter: item.costCenter,
          costCenterDescription: item.costCenterDescription,
        }
      : {};
    x = left;
    for (const column of CC_COLUMNS) {
      box(page, x, y, column.width, rowHeight);
      if (item) cell(page, fonts, values[column.key] || "", x, y, column.width, rowHeight, { align: column.align, size: 7.4, bold: column.key === "quantity", lines: column.key === "description" ? 2 : 1 });
      x += column.width;
    }
  }
  // TOTAL: quantidade e custo.
  y -= totalHeight;
  const totals = ccTotals(data);
  const span = CC_COLUMNS.slice(0, 6).reduce((sum, column) => sum + column.width, 0);
  box(page, left, y, span, totalHeight);
  cell(page, fonts, "TOTAL", left, y, span, totalHeight, { bold: true, align: "center", size: 8.5 });
  x = left + span;
  CC_COLUMNS.slice(6).forEach((column) => {
    box(page, x, y, column.width, totalHeight);
    if (column.key === "quantity") cell(page, fonts, quantity(totals.quantity), x, y, column.width, totalHeight, { bold: true, align: "center", size: 8.5 });
    if (column.key === "total") cell(page, fonts, money(totals.cost), x, y, column.width, totalHeight, { bold: true, align: "right", size: 8.5 });
    x += column.width;
  });

  // REMARKS (motivo) | APPROVAL (assinaturas obrigatórias).
  y -= 10 + band;
  const remarksWidth = REMARK_COLUMNS.reduce((sum, column) => sum + column.width, 0);
  box(page, left, y, remarksWidth, band, GRAY);
  cell(page, fonts, "REMARKS:", left, y, remarksWidth, band, { bold: true, size: 9, lines: 1 });
  box(page, left + remarksWidth, y, width - remarksWidth, band, GRAY);
  cell(page, fonts, "APPROVAL :", left + remarksWidth, y, 110, band, { bold: true, size: 9, lines: 1 });
  cell(page, fonts, "Obs: Mandatory signatures", left + remarksWidth + 110, y, 260, band, { bold: true, size: 9, lines: 1 });
  y -= subHeader;
  x = left;
  for (const column of [...REMARK_COLUMNS, ...APPROVAL_COLUMNS]) {
    box(page, x, y, column.width, subHeader, GRAY);
    cell(page, fonts, column.label, x, y, column.width, subHeader, { bold: true, align: column.key === "action" || column.key === "responsible" ? "left" : "center", size: 7.5, lines: 1 });
    x += column.width;
  }
  const blockTop = y;
  const blockHeight = approvalHeight * 4;
  x = left;
  for (const column of REMARK_COLUMNS) {
    box(page, x, blockTop - blockHeight, column.width, blockHeight);
    cell(page, fonts, data[column.key], x, blockTop - blockHeight, column.width, blockHeight, { align: "center", size: 10, min: 6.5, lines: 18 });
    x += column.width;
  }
  const boxes: string[] = [];
  CC_SLOTS.forEach((slot, index) => {
    const rowY = blockTop - approvalHeight * (index + 1);
    let columnX = left + remarksWidth;
    for (const column of APPROVAL_COLUMNS) {
      box(page, columnX, rowY, column.width, approvalHeight);
      if (column.key === "responsible") cell(page, fonts, `${slot.order} . ${slot.role}`, columnX, rowY, column.width, approvalHeight, { size: 8, lines: 2 });
      if (column.key === "name") cell(page, fonts, data.approvers[slot.id], columnX, rowY, column.width, approvalHeight, { align: "center", size: 8.5, lines: 2 });
      if (column.key === "signature") boxes.push(signatureField(doc, page, slot, data.approvers[slot.id], [columnX + 2, rowY + 2, columnX + column.width - 2, rowY + approvalHeight - 2]));
      if (column.key === "date") cell(page, fonts, "_____/_____/__________", columnX, rowY, column.width, approvalHeight, { align: "center", size: 8, color: MUTED, lines: 1 });
      columnX += column.width;
    }
  });

  // Rodapé.
  const stamp = generatedAt.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
  const origin = data.scrapForms.length ? ` · origem: ${data.scrapForms.join(", ")}` : "";
  const footerY = blockTop - blockHeight - 12;
  page.drawText(fonts.clean(`${number} · gerado no Controle de Produção WBYD em ${stamp}${origin} · cada responsável assina com o ID digital clicando no campo do seu quadro`), {
    x: left,
    y: footerY,
    size: 6.5,
    font: regular,
    color: MUTED,
  });
  page.drawText("Página 1/1", { x: left + width - regular.widthOfTextAtSize("Página 1/1", 6.5), y: footerY, size: 6.5, font: regular, color: MUTED });
  return finish(doc, { title: `${CC_TITLE} ${number}`, subject: "Baixa / ajuste de estoque em centro de custo", keyword: "FO.FI.C.007", number, generatedAt, boxes });
}

/* ------------------------------------------------------------------------ */
/* Leitura do PDF devolvido com assinaturas                                  */
/* ------------------------------------------------------------------------ */

export type SignatureField = { name: string; slot: SlotId | null; signed: boolean };
export type ScrapPdfReading = {
  formNumber: string | null;
  pages: number;
  size: number;
  sha256: string;
  fields: SignatureField[];
  signatures: ScrapSignature[];
};

const decode = (value: unknown) =>
  value instanceof PDFString || value instanceof PDFHexString ? value.decodeText().replace(/\u0000/g, "").trim() : "";
const bytesOf = (value: unknown) => (value instanceof PDFHexString || value instanceof PDFString ? value.asBytes() : null);

/** D:20260506150804-03'00' → ISO */
export function pdfDate(raw: string): string | null {
  const match = raw.match(/^D?:?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?([Zz+-])?(\d{2})?'?(\d{2})?/);
  if (!match) return null;
  const [, year, month = "01", day = "01", hour = "00", minute = "00", second = "00", sign, offsetHour = "00", offsetMinute = "00"] = match;
  let time = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
  if (sign === "+" || sign === "-") time -= (sign === "+" ? 1 : -1) * (Number(offsetHour) * 60 + Number(offsetMinute)) * 60_000;
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

type Box = { slot: SlotId; x1: number; y1: number; x2: number; y2: number };
function parseBoxes(raw: string): Box[] {
  return raw
    .split(";")
    .map((part) => {
      const [slot, numbers = ""] = part.split(":");
      const [x1, y1, x2, y2] = numbers.split(",").map(Number);
      return isSlotId(slot) && [x1, y1, x2, y2].every(Number.isFinite) ? { slot, x1, y1, x2, y2 } : null;
    })
    .filter((box): box is Box => !!box);
}
/** Campo criado à parte no Adobe ("Signature2"): vale o quadro onde ele foi desenhado (página 1). */
export function slotFromPosition(center: { x: number; y: number; page: number }, boxes: Box[]): SlotId | null {
  if (center.page !== 0) return null;
  return boxes.find((box) => center.x >= box.x1 && center.x <= box.x2 && center.y >= box.y1 && center.y <= box.y2)?.slot || null;
}

type FieldEntry = { name: string; dict: PDFDict; widgets: PDFDict[] };
function collectFields(doc: PDFDocument): FieldEntry[] {
  const acro = doc.catalog.lookup(PDFName.of("AcroForm"));
  if (!(acro instanceof PDFDict)) return [];
  const fields = acro.lookup(PDFName.of("Fields"));
  if (!(fields instanceof PDFArray)) return [];
  const out: FieldEntry[] = [];
  const seen = new Set<PDFDict>();
  const visit = (node: unknown, prefix: string, inheritedType: string) => {
    const dict = node instanceof PDFRef ? doc.context.lookup(node) : node;
    if (!(dict instanceof PDFDict) || seen.has(dict) || seen.size > 500) return;
    seen.add(dict);
    const partial = decode(dict.lookup(PDFName.of("T")));
    const name = partial ? (prefix ? `${prefix}.${partial}` : partial) : prefix;
    const typeValue = dict.lookup(PDFName.of("FT"));
    const type = typeValue instanceof PDFName ? typeValue.asString() : inheritedType;
    const kids = dict.lookup(PDFName.of("Kids"));
    const kidDicts = kids instanceof PDFArray ? kids.asArray().map((kid) => (kid instanceof PDFRef ? doc.context.lookup(kid) : kid)).filter((kid): kid is PDFDict => kid instanceof PDFDict) : [];
    const childFields = kidDicts.filter((kid) => kid.has(PDFName.of("T")));
    if (childFields.length) {
      for (const kid of childFields) visit(kid, name, type);
      return;
    }
    if (type === "/Sig") out.push({ name, dict, widgets: dict.has(PDFName.of("Rect")) ? [dict] : kidDicts });
  };
  for (const field of fields.asArray()) visit(field, "", "");
  return out;
}

function widgetCenter(doc: PDFDocument, widgets: PDFDict[]) {
  const widget = widgets[0];
  const rect = widget?.lookup(PDFName.of("Rect"));
  if (!(rect instanceof PDFArray) || rect.size() < 4) return null;
  const [x1, y1, x2, y2] = rect.asArray().map((value) => (value instanceof PDFNumber ? value.asNumber() : NaN));
  const pages = doc.getPages();
  const pageRef = widget.get(PDFName.of("P"));
  let page = pages.findIndex((candidate) => candidate.ref === pageRef);
  if (page < 0) page = pages.findIndex((candidate) => candidate.node.Annots()?.asArray().some((ref) => doc.context.lookup(ref) === widget));
  return [x1, y1, x2, y2].every(Number.isFinite) ? { x: (x1 + x2) / 2, y: (y1 + y2) / 2, page } : null;
}

function concat(parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
const HEX = /^[0-9a-fA-F]*$/;
/** O intervalo fora do ByteRange tem de ser exatamente o /Contents desta assinatura. */
function gapMatches(bytes: Uint8Array, b: number, c: number, contents: Uint8Array) {
  if (bytes[b] !== 0x3c || bytes[c - 1] !== 0x3e) return false;
  let hex = "";
  for (let i = b + 1; i < c - 1; i++) {
    const char = bytes[i];
    if (char === 0x20 || char === 0x0a || char === 0x0d || char === 0x09) continue;
    hex += String.fromCharCode(char);
  }
  if (!HEX.test(hex)) return false;
  if (hex.length % 2) hex += "0";
  if (hex.length / 2 !== contents.length) return false;
  for (let i = 0; i < contents.length; i++) if (parseInt(hex.slice(i * 2, i * 2 + 2), 16) !== contents[i]) return false;
  return true;
}

/** maxBytes: limite para guardar no portal; a conferência local ("Conferir um PDF") aceita arquivos maiores. */
export async function readScrapPdf(bytes: Uint8Array, { maxBytes = MAX_PDF_BYTES } = {}): Promise<ScrapPdfReading> {
  if (bytes.length > 30_000_000) throw Error("O PDF passa de 30 MB.");
  if (bytes.length > maxBytes) throw Error("O PDF passa de 1,5 MB. O formulário gerado pelo portal fica bem abaixo disso: confira se é o arquivo certo (não regrave o PDF assinado em outro programa, isso invalida as assinaturas).");
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 1024));
  if (!head.includes("%PDF-")) throw Error("Este arquivo não é um PDF.");
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false });
    if (!doc.catalog || !doc.getPageCount()) throw Error("sem páginas");
  } catch {
    throw Error("Não consegui abrir este PDF. Salve-o de novo no Adobe e tente outra vez.");
  }
  const info = doc.context.lookup(doc.context.trailerInfo.Info);
  const formNumber = info instanceof PDFDict ? decode(info.lookup(PDFName.of(FORM_KEY))) || null : null;
  const boxes = info instanceof PDFDict && formNumber ? parseBoxes(decode(info.lookup(PDFName.of(BOXES_KEY)))) : [];
  let end = bytes.length;
  while (end > 0 && [0x0a, 0x0d, 0x20, 0x00, 0x09].includes(bytes[end - 1])) end--;
  const fields: SignatureField[] = [];
  const signatures: ScrapSignature[] = [];
  const seenRanges = new Map<string, string>();
  for (const entry of collectFields(doc)) {
    const center = widgetCenter(doc, entry.widgets);
    const slot = slotFromFieldName(entry.name) || (center ? slotFromPosition(center, boxes) : null);
    const value = entry.dict.lookup(PDFName.of("V"));
    if (!(value instanceof PDFDict)) {
      fields.push({ name: entry.name, slot, signed: false });
      continue;
    }
    fields.push({ name: entry.name, slot, signed: true });
    const range = value.lookup(PDFName.of("ByteRange"));
    const numbers = range instanceof PDFArray ? range.asArray().map((item) => (item instanceof PDFNumber ? item.asNumber() : NaN)) : [];
    const contents = bytesOf(value.lookup(PDFName.of("Contents")));
    const nameInAdobe = decode(value.lookup(PDFName.of("Name")));
    const signedAtRaw = decode(value.lookup(PDFName.of("M")));
    const subFilter = value.lookup(PDFName.of("SubFilter"));
    const base: ScrapSignature = { field: entry.name, slot, signer: nameInAdobe, signedAt: signedAtRaw ? pdfDate(signedAtRaw) : null, check: "unchecked", coversWholeFile: false, detail: "" };
    const [a, b, c, d] = numbers;
    const validRange =
      numbers.length === 4 &&
      numbers.every((number) => Number.isInteger(number) && number >= 0) &&
      a === 0 &&
      b < c &&
      c + d <= bytes.length &&
      !!contents &&
      gapMatches(bytes, b, c, contents);
    if (!validRange || !contents) {
      signatures.push({ ...base, check: "invalid", detail: "O arquivo foi regravado depois desta assinatura (por exemplo, salvo em outro programa). No Adobe ela aparece como inválida: é preciso assinar de novo." });
      continue;
    }
    // A mesma assinatura apontada por dois campos não vale duas vezes.
    const rangeKey = numbers.join(",");
    if (seenRanges.has(rangeKey)) {
      signatures.push({ ...base, coversWholeFile: c + d >= end, check: "invalid", detail: `É a mesma assinatura do campo ${seenRanges.get(rangeKey)}, reaproveitada neste quadro.` });
      continue;
    }
    seenRanges.set(rangeKey, entry.name);
    if (subFilter instanceof PDFName && subFilter.asString() === "/adbe.pkcs7.sha1") {
      signatures.push({ ...base, coversWholeFile: c + d >= end, detail: "Assinatura no formato antigo (adbe.pkcs7.sha1): confira no Adobe." });
      continue;
    }
    const signedData = concat([bytes.subarray(a, a + b), bytes.subarray(c, c + d)]);
    const result = await checkCmsSignature(contents, signedData);
    const signer = result.signer || nameInAdobe;
    const differentName = result.signer && nameInAdobe && nameInAdobe.trim().toLowerCase() !== result.signer.trim().toLowerCase();
    signatures.push({
      ...base,
      signer,
      signedAt: base.signedAt || result.signingTime,
      check: result.check,
      coversWholeFile: c + d >= end,
      detail: result.detail + (differentName ? ` Nome informado no Adobe: "${nameInAdobe}".` : ""),
      issuer: result.issuer,
      selfSigned: result.selfSigned,
    });
  }
  signatures.sort((x, y) => String(x.signedAt || "").localeCompare(String(y.signedAt || "")));
  return { formNumber, pages: doc.getPageCount(), size: bytes.length, sha256: await sha256Hex(bytes), fields, signatures };
}

/* ------------------------------------------------------------------------ */
/* O PDF devolvido mostra o mesmo formulário que o portal emitiu?            */
/* ------------------------------------------------------------------------ */

/** Representação estável de um objeto do PDF (referências resolvidas, streams decodificados). */
function fingerprint(doc: PDFDocument, value: unknown, seen: Set<unknown>, depth: number, skip: Set<string>): string {
  if (depth > 40) return "…";
  const resolved = value instanceof PDFRef ? doc.context.lookup(value) : value;
  if (resolved === undefined || resolved === null) return "null";
  if (resolved instanceof PDFName) return resolved.asString();
  if (resolved instanceof PDFNumber) return String(resolved.asNumber());
  if (resolved instanceof PDFString || resolved instanceof PDFHexString) return "(" + Array.from(resolved.asBytes(), (byte) => byte.toString(16).padStart(2, "0")).join("") + ")";
  if (resolved instanceof PDFArray) return "[" + resolved.asArray().map((item) => fingerprint(doc, item, seen, depth + 1, skip)).join(" ") + "]";
  if (resolved instanceof PDFRawStream) {
    if (seen.has(resolved)) return "<loop>";
    seen.add(resolved);
    let data: Uint8Array;
    try {
      data = decodePDFRawStream(resolved).decode();
    } catch {
      data = resolved.getContents();
    }
    const dict = fingerprint(doc, resolved.dict, seen, depth + 1, new Set([...skip, "/Length", "/Filter", "/DecodeParms"]));
    let hash = 2166136261;
    for (const byte of data) hash = Math.imul(hash ^ byte, 16777619) >>> 0;
    return `stream${dict}#${data.length}:${hash.toString(16)}`;
  }
  if (resolved instanceof PDFDict) {
    if (seen.has(resolved)) return "<loop>";
    seen.add(resolved);
    const entries = resolved
      .entries()
      .filter(([key]) => !skip.has(key.asString()))
      .sort(([x], [y]) => x.asString().localeCompare(y.asString()))
      .map(([key, item]) => key.asString() + " " + fingerprint(doc, item, seen, depth + 1, new Set()));
    return "<<" + entries.join(" ") + ">>";
  }
  return String(resolved);
}
function pageFingerprint(doc: PDFDocument) {
  const page = doc.getPages()[0];
  return fingerprint(doc, page.node, new Set(), 0, new Set(["/Annots", "/Parent", "/StructParents", "/Tabs"]));
}
const SIGNATURE_WIDGET = (doc: PDFDocument, annot: PDFDict) => {
  if (annot.lookup(PDFName.of("Subtype")) !== PDFName.of("Widget")) return false;
  let node: PDFDict | undefined = annot;
  for (let i = 0; node && i < 10; i++) {
    if (node.lookup(PDFName.of("FT")) === PDFName.of("Sig")) return true;
    const parent: unknown = node.lookup(PDFName.of("Parent"));
    node = parent instanceof PDFDict ? parent : undefined;
  }
  return false;
};
export type ContentComparison = { sameContent: boolean; pages: number; extraAnnotations: string[]; notes: string[] };
/**
 * Compara a página do PDF emitido pelo portal com a do PDF devolvido: texto,
 * tabela, imagens e fontes (não os bytes do arquivo, então vale mesmo se o
 * Adobe regravar). Em cima da página só podem existir campos de assinatura.
 */
export async function compareWithGenerated(generated: Uint8Array, signed: Uint8Array): Promise<ContentComparison> {
  const options = { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false } as const;
  const [original, received] = await Promise.all([PDFDocument.load(generated, options), PDFDocument.load(signed, options)]);
  const pages = received.getPageCount();
  const sameContent = pages === original.getPageCount() && pageFingerprint(original) === pageFingerprint(received);
  const extraAnnotations: string[] = [];
  const notes: string[] = [];
  received.getPages().forEach((page, index) => {
    for (const ref of page.node.Annots()?.asArray() || []) {
      const annot = received.context.lookup(ref);
      if (!(annot instanceof PDFDict) || SIGNATURE_WIDGET(received, annot)) continue;
      const subtype = annot.lookup(PDFName.of("Subtype"));
      const name = subtype instanceof PDFName ? subtype.asString().slice(1) : "desconhecida";
      if (name === "Popup" || name === "Text") notes.push(`Comentário do Adobe na página ${index + 1} (${name}).`);
      else extraAnnotations.push(`${name} na página ${index + 1}`);
    }
  });
  return { sameContent, pages, extraAnnotations, notes };
}
