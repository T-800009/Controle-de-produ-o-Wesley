import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage, type PDFPage } from "pdf-lib";
import { SCRAP_FORM_LOGO_JPEG } from "./scrap-logo.ts";
import {
  OUTCOME_LABELS,
  STATUS_LABELS,
  brDate,
  fmtMoney,
  fmtQty,
  isoDay,
  route,
  typeLabel,
  type DossieAnalysis,
  type DossieData,
  type DossieStatus,
  type DossieTrack,
} from "./dossie.ts";

/**
 * PDF do dossiê (A4 retrato): a prova da transferência, o que aconteceu depois,
 * as constatações, os lançamentos da MB51, o texto da cobrança, o andamento e
 * os prints anexados (uma página para cada). Gerado no navegador.
 */
const A4 = { width: 595.28, height: 841.89 };
const M = 36;
const WIDTH = A4.width - M * 2;
const BLACK = rgb(0.07, 0.07, 0.08);
const MUTED = rgb(0.38, 0.4, 0.44);
const LINE = rgb(0.8, 0.82, 0.85);
const LIGHT = rgb(0.95, 0.96, 0.97);
const RED = rgb(0.78, 0.07, 0.11);
const RED_LIGHT = rgb(1, 0.93, 0.93);
const GREEN = rgb(0.12, 0.5, 0.3);

export type DossiePdfInput = {
  number: string;
  status: DossieStatus;
  data: DossieData;
  track: DossieTrack;
  analysis: DossieAnalysis;
  letter: { subject: string; text: string };
  images?: { name: string; type: string; bytes: Uint8Array }[];
  generatedAt?: Date;
};

/** Fontes padrão do PDF só têm o alfabeto latino (WinAnsi): troca o resto. */
function cleaner(font: PDFFont) {
  const supported = new Set(font.getCharacterSet());
  return (value: string) =>
    String(value ?? "")
      .normalize("NFC")
      .replace(/→/g, "->")
      .replace(/[‘’‛]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/[–—−]/g, "-")
      .replace(/[   ]/g, " ")
      .replace(/\t/g, " ")
      .split("")
      .map((char) => (char === "\n" || supported.has(char.codePointAt(0)!) ? char : "?"))
      .join("");
}
function wrap(font: PDFFont, text: string, size: number, width: number) {
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    const words = paragraph.split(" ");
    let line = "";
    for (const word of words) {
      const next = line ? line + " " + word : word;
      if (font.widthOfTextAtSize(next, size) <= width || !line) {
        line = next;
        // Palavra maior que a linha (documento, código): quebra no meio.
        while (font.widthOfTextAtSize(line, size) > width && line.length > 1) {
          let cut = line.length - 1;
          while (cut > 1 && font.widthOfTextAtSize(line.slice(0, cut), size) > width) cut--;
          out.push(line.slice(0, cut));
          line = line.slice(cut);
        }
      } else {
        out.push(line);
        line = word;
      }
    }
    out.push(line);
  }
  return out;
}

type Column = { title: string; width: number; align?: "left" | "right" };
type Cell = string;

class Writer {
  page!: PDFPage;
  y = 0;
  pages: PDFPage[] = [];
  readonly clean: (value: string) => string;
  constructor(
    readonly doc: PDFDocument,
    readonly regular: PDFFont,
    readonly bold: PDFFont,
    readonly logo: PDFImage,
    readonly header: { number: string; subtitle: string },
  ) {
    this.clean = cleaner(regular);
    this.newPage();
  }
  newPage() {
    this.page = this.doc.addPage([A4.width, A4.height]);
    this.pages.push(this.page);
    const top = A4.height - M;
    this.page.drawImage(this.logo, { x: M, y: top - 26, width: 47.5, height: 26 });
    this.page.drawText(this.clean("Dossiê de transferência · Warehouse"), { x: M + 58, y: top - 12, size: 13, font: this.bold, color: BLACK });
    this.page.drawText(this.clean(this.header.subtitle), { x: M + 58, y: top - 25, size: 7.5, font: this.regular, color: MUTED });
    const number = this.clean(this.header.number);
    this.page.drawText(number, { x: A4.width - M - this.bold.widthOfTextAtSize(number, 13), y: top - 12, size: 13, font: this.bold, color: RED });
    this.page.drawLine({ start: { x: M, y: top - 33 }, end: { x: A4.width - M, y: top - 33 }, thickness: 1.2, color: RED });
    this.y = top - 48;
  }
  ensure(height: number) {
    if (this.y - height < M + 20) this.newPage();
  }
  heading(text: string) {
    this.ensure(40);
    this.y -= 6;
    this.page.drawText(this.clean(text.toUpperCase()), { x: M, y: this.y - 9, size: 8.5, font: this.bold, color: RED });
    this.y -= 15;
  }
  paragraph(text: string, options: { size?: number; bold?: boolean; color?: ReturnType<typeof rgb>; indent?: number; gap?: number } = {}) {
    const size = options.size ?? 8.5;
    const font = options.bold ? this.bold : this.regular;
    const indent = options.indent ?? 0;
    const leading = size * 1.32;
    for (const line of wrap(font, this.clean(text), size, WIDTH - indent)) {
      this.ensure(leading + 2);
      this.page.drawText(line, { x: M + indent, y: this.y - size, size, font, color: options.color ?? BLACK });
      this.y -= leading;
    }
    this.y -= options.gap ?? 3;
  }
  bullet(text: string, color = BLACK) {
    const size = 8.5,
      leading = size * 1.32;
    const lines = wrap(this.regular, this.clean(text), size, WIDTH - 12);
    lines.forEach((line, index) => {
      this.ensure(leading + 2);
      if (index === 0) this.page.drawText("•", { x: M + 2, y: this.y - size, size, font: this.bold, color });
      this.page.drawText(line, { x: M + 12, y: this.y - size, size, font: this.regular, color: BLACK });
      this.y -= leading;
    });
    this.y -= 2;
  }
  /** Tabela com quebra de linha nas células e cabeçalho repetido em cada página. */
  table(columns: Column[], rows: { cells: Cell[]; highlight?: boolean; bold?: boolean }[], size = 7.2) {
    const total = columns.reduce((sum, c) => sum + c.width, 0);
    const widths = columns.map((c) => (c.width / total) * WIDTH);
    const pad = 3,
      leading = size * 1.25;
    const drawHeader = () => {
      const height = leading + pad * 2;
      this.page.drawRectangle({ x: M, y: this.y - height, width: WIDTH, height, color: LIGHT });
      let x = M;
      columns.forEach((column, i) => {
        const text = this.clean(column.title);
        const w = this.bold.widthOfTextAtSize(text, size);
        this.page.drawText(text, { x: column.align === "right" ? x + widths[i] - pad - w : x + pad, y: this.y - pad - size, size, font: this.bold, color: BLACK });
        x += widths[i];
      });
      this.y -= height;
    };
    this.ensure(leading * 3 + pad * 4);
    drawHeader();
    for (const row of rows) {
      const font = row.bold ? this.bold : this.regular;
      const lines = row.cells.map((cell, i) => wrap(font, this.clean(cell), size, widths[i] - pad * 2).slice(0, 4));
      const height = Math.max(...lines.map((l) => l.length)) * leading + pad * 2;
      if (this.y - height < M + 20) {
        this.newPage();
        drawHeader();
      }
      if (row.highlight) this.page.drawRectangle({ x: M, y: this.y - height, width: WIDTH, height, color: RED_LIGHT });
      let x = M;
      lines.forEach((cellLines, i) => {
        cellLines.forEach((line, j) => {
          const w = font.widthOfTextAtSize(line, size);
          this.page.drawText(line, { x: columns[i].align === "right" ? x + widths[i] - pad - w : x + pad, y: this.y - pad - size - j * leading, size, font, color: BLACK });
        });
        x += widths[i];
      });
      this.y -= height;
      this.page.drawLine({ start: { x: M, y: this.y }, end: { x: M + WIDTH, y: this.y }, thickness: 0.4, color: LINE });
    }
    this.y -= 8;
  }
  /** Quadros lado a lado: rótulo pequeno em cima, valor em negrito. */
  boxes(items: { label: string; value: string; note?: string; alert?: boolean }[]) {
    const gap = 6,
      width = (WIDTH - gap * (items.length - 1)) / items.length,
      height = 40;
    this.ensure(height + 6);
    items.forEach((item, i) => {
      const x = M + i * (width + gap);
      this.page.drawRectangle({ x, y: this.y - height, width, height, borderColor: item.alert ? RED : LINE, borderWidth: item.alert ? 1 : 0.6, color: item.alert ? RED_LIGHT : undefined });
      this.page.drawText(this.clean(item.label), { x: x + 6, y: this.y - 11, size: 6.8, font: this.regular, color: MUTED });
      const value = this.clean(item.value);
      let size = 11;
      while (size > 6 && this.bold.widthOfTextAtSize(value, size) > width - 12) size -= 0.5;
      this.page.drawText(value, { x: x + 6, y: this.y - 25, size, font: this.bold, color: item.alert ? RED : BLACK });
      if (item.note) {
        const note = this.clean(item.note);
        let noteSize = 6.5;
        while (noteSize > 4.5 && this.regular.widthOfTextAtSize(note, noteSize) > width - 12) noteSize -= 0.25;
        this.page.drawText(note, { x: x + 6, y: this.y - 35, size: noteSize, font: this.regular, color: MUTED });
      }
    });
    this.y -= height + 8;
  }
}

function base64Bytes(value: string) {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export async function buildDossiePdf(input: DossiePdfInput): Promise<Uint8Array> {
  const { number, status, data, track, analysis, letter } = input;
  const generatedAt = input.generatedAt || new Date();
  const doc = await PDFDocument.create();
  doc.setTitle(`${number} · ${data.material}`);
  doc.setSubject("Dossiê de transferência cobrada do Warehouse");
  doc.setAuthor("Controle de Produção WBYD");
  doc.setCreator("Controle de Produção WBYD");
  doc.setKeywords(["WBYDDossie", number, data.material]);
  doc.setCreationDate(generatedAt);
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const logo = await doc.embedJpg(base64Bytes(SCRAP_FORM_LOGO_JPEG));
  const subtitle = `Controle de Produção · ${STATUS_LABELS[status]} · gerado em ${generatedAt.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" })}`;
  const w = new Writer(doc, regular, bold, logo, { number, subtitle });
  const u = analysis.unit ? " " + analysis.unit : "";

  // Material
  w.paragraph(`${data.material}${data.description ? " · " + data.description : ""}`, { size: 12, bold: true, gap: 2 });
  w.paragraph(
    `Centro ${data.plant || "—"} · depósito de destino ${data.target} · ${data.movements.length} lançamento(s) da MB51 · fonte: ${data.source || "MB51"}${data.deadline ? ` · prazo para resposta ${brDate(data.deadline)}` : ""}`,
    { size: 7.5, color: MUTED, gap: 6 },
  );

  // Transferência cobrada e o que aconteceu depois
  w.heading(analysis.questioned.length > 1 ? "Transferências cobradas" : "Transferência cobrada");
  w.table(
    [
      { title: "Documento", width: 15 },
      { title: "Itens · TMv", width: 11 },
      { title: "De -> para", width: 13 },
      { title: "Qtd", width: 9, align: "right" },
      { title: "Lançado", width: 14 },
      { title: "Usuário", width: 12 },
      { title: "Texto no documento", width: 26 },
    ],
    analysis.questioned.map((t) => ({
      cells: [
        t.document,
        `${t.items.join("/") || "—"} · ${t.type}`,
        route(t),
        fmtQty(t.quantity) + u,
        t.date ? brDate(t.date) + (t.time ? " " + t.time.slice(0, 5) : "") : "sem data",
        t.user || "—",
        [t.headerText, t.itemText].filter(Boolean).join(" / ") || "nenhum",
      ],
      highlight: true,
    })),
  );
  for (const t of analysis.questioned) {
    if (t.idle === null) continue;
    const value = analysis.unitPrice !== null ? fmtMoney(Math.round(t.idle * analysis.unitPrice * 100) / 100) : "sem preço";
    w.boxes([
      { label: `Consumido no ${t.to} depois`, value: fmtQty(t.consumed) + u, note: t.consumed ? `${Math.round(((t.consumed || 0) / t.quantity) * 100)}% do transferido` : "nenhum consumo", alert: !t.consumed },
      { label: `Saiu do ${t.to} depois`, value: fmtQty(t.transferredOut) + u, note: Object.entries(t.outTo).map(([to, qty]) => `${fmtQty(qty)} p/ ${to}`).join(", ") || "nada devolvido" },
      { label: "Sucata / outras saídas", value: fmtQty((t.scrapped || 0) + (t.other || 0)) + u },
      { label: `Parado no ${t.to}`, value: fmtQty(t.idle) + u, note: `${value}${t.days !== null && t.days >= 0 ? ` · há ${t.days} dia(s)` : ""}`, alert: t.idle > 0 },
    ]);
  }

  w.heading("Constatações");
  for (const finding of analysis.findings) w.bullet(finding.text, finding.tone === "alert" ? RED : finding.tone === "ok" ? GREEN : MUTED);
  w.y -= 4;

  w.heading("Saldos e valor");
  const depots = [...new Set([...analysis.balances.map((b) => b.depot), ...(data.stockCheck?.depots.map((d) => d.depot) || [])])].sort();
  w.table(
    [
      { title: "Depósito", width: 20 },
      { title: "Pelos lançamentos colados", width: 28, align: "right" },
      { title: `Na planilha${data.stockCheck ? " (" + brDate(isoDay(data.stockCheck.readAt)) + ")" : ""}`, width: 26, align: "right" },
      { title: "Valor na planilha", width: 26, align: "right" },
    ],
    depots.map((depot) => {
      const balance = analysis.balances.find((b) => b.depot === depot);
      const sheet = data.stockCheck?.depots.find((d) => d.depot === depot);
      return {
        cells: [depot, balance ? fmtQty(balance.quantity) + u : "—", sheet ? (sheet.found ? `${fmtQty(sheet.quantity)} ${sheet.unit || analysis.unit}` : "sem saldo") : "—", sheet?.found ? fmtMoney(sheet.value) : "—"],
        bold: depot === data.target,
      };
    }),
  );
  w.paragraph(
    `Preço unitário: ${analysis.unitPrice !== null ? fmtMoney(analysis.unitPrice) + (analysis.unit ? "/" + analysis.unit : "") + ` (${analysis.priceNote})` : "sem preço"}${analysis.idleValue !== null ? ` · valor parado ${fmtMoney(analysis.idleValue)}` : ""}. O saldo pelos lançamentos considera só as linhas coladas; consumo, devolução e sucata abatem primeiro a entrada mais antiga do depósito.`,
    { size: 7.5, color: MUTED, gap: 6 },
  );

  w.heading(`Lançamentos da MB51 (${analysis.ordered.length})`);
  const highlight = new Set(analysis.questioned.flatMap((t) => t.lines));
  w.table(
    [
      { title: "Data", width: 10 },
      { title: "Documento / item", width: 15 },
      { title: "TMv", width: 20 },
      { title: "Dep.", width: 7 },
      { title: "Qtd", width: 9, align: "right" },
      { title: "Valor", width: 12, align: "right" },
      { title: "Usuário", width: 10 },
      { title: "Texto", width: 17 },
    ],
    analysis.ordered.map((m) => ({
      cells: [
        brDate(m.entryDate || m.postingDate) || "—",
        `${m.document}${m.item ? " / " + m.item : ""}`,
        `${m.type} ${typeLabel(m)}`,
        m.depot || "—",
        fmtQty(m.quantity),
        m.amount ? fmtMoney(m.amount) : "—",
        m.user || "—",
        [m.headerText, m.itemText].filter(Boolean).join(" / ") || "—",
      ],
      highlight: highlight.has(m),
    })),
    6.8,
  );

  w.heading("Cobrança ao Warehouse");
  w.paragraph(letter.subject, { bold: true, size: 8.5, gap: 4 });
  w.paragraph(letter.text, { size: 8.3, gap: 6 });

  w.heading("Andamento");
  const sent = track.sentAt ? [track.sentAt, ...track.reminders] : [];
  w.paragraph(sent.length ? `Cobranças: ${sent.map((stamp, i) => `${i + 1}ª em ${brDate(isoDay(stamp))}`).join(" · ")}.` : "Ainda não cobrado.", { size: 8.3 });
  if (track.response) {
    w.paragraph(`Resposta do Warehouse${track.responseBy ? ` (${track.responseBy})` : ""}${track.respondedAt ? ` em ${brDate(track.respondedAt)}` : ""}:`, { bold: true, size: 8.3, gap: 1 });
    w.paragraph(track.response, { size: 8.3, indent: 10 });
  }
  if (status === "closed")
    w.paragraph(
      `Encerrado${track.closedAt ? ` em ${brDate(isoDay(track.closedAt))}` : ""}: ${track.outcome ? OUTCOME_LABELS[track.outcome] : "—"}${track.returnDocument ? ` (doc. ${track.returnDocument})` : ""}${track.outcomeNote ? `. ${track.outcomeNote}` : ""}`,
      { bold: true, size: 8.3 },
    );
  if (track.log.length) {
    w.y -= 2;
    w.table(
      [
        { title: "Quando", width: 18 },
        { title: "Quem", width: 14 },
        { title: "O quê", width: 68 },
      ],
      track.log.map((entry) => ({ cells: [new Date(entry.at).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" }), entry.role, entry.text] })),
      6.8,
    );
  }

  // Prints: uma página cada, ajustado à página.
  for (const image of input.images || []) {
    let embedded: PDFImage;
    try {
      embedded = image.type === "image/png" ? await doc.embedPng(image.bytes) : await doc.embedJpg(image.bytes);
    } catch {
      continue;
    }
    w.newPage();
    w.heading("Print anexado");
    w.paragraph(image.name, { size: 7.5, color: MUTED });
    const maxW = WIDTH,
      maxH = w.y - M - 24;
    const scale = Math.min(maxW / embedded.width, maxH / embedded.height, 1.5);
    const width = embedded.width * scale,
      height = embedded.height * scale;
    w.page.drawImage(embedded, { x: M + (maxW - width) / 2, y: w.y - height, width, height });
    w.page.drawRectangle({ x: M + (maxW - width) / 2, y: w.y - height, width, height, borderColor: LINE, borderWidth: 0.6 });
    w.y -= height + 8;
  }

  // Rodapé com a numeração das páginas.
  const total = w.pages.length;
  w.pages.forEach((page, index) => {
    const text = w.clean(`WBYD · Controle de Produção · ${number} · ${data.material} · página ${index + 1} de ${total}`);
    page.drawText(text, { x: A4.width / 2 - regular.widthOfTextAtSize(text, 6.8) / 2, y: M - 14, size: 6.8, font: regular, color: MUTED });
  });
  return doc.save({ useObjectStreams: false });
}
