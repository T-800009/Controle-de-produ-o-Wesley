/**
 * E-mail formal do Scrap Form e do FO.FI.C.007 — para pedir as assinaturas ou
 * mandar o documento já assinado. Sai em três formas:
 *  - text: o texto completo (Copiar texto, Compartilhar);
 *  - html: o mesmo conteúdo formatado (vai no .eml);
 *  - short: versão curta para o mailto (link de e-mail tem limite de tamanho).
 * buildEml monta um rascunho (.eml com "X-Unsent: 1") com o PDF anexado: o
 * Outlook abre como mensagem nova, pronta para conferir e enviar.
 */
import { brDate, brMoney, formTotal, itemTotal, signatureProgress, type DocKind, type ScrapForm } from "./scrap-form.ts";
import { ccItemTotal, ccTotals, periodLabel, type CcForm } from "./cc-form.ts";
import { bytesToBase64 as base64 } from "./base64.ts";

export type EmailOptions = { sender?: string; link?: string; now?: Date };
export type FormEmail = { subject: string; text: string; html: string; short: string };

type Block =
  | { type: "p"; text: string }
  | { type: "facts"; title: string; rows: [string, string][] }
  | { type: "table"; title: string; head: string[]; right: number[]; rows: string[][]; more: string }
  | { type: "list"; title: string; items: string[] }
  | { type: "steps"; title: string; items: string[] }
  | { type: "link"; text: string; href: string }
  | { type: "closing"; sender: string };

/** Até quantos itens vão listados no e-mail (o resto está no PDF). */
const TABLE_ITEMS = 15;

export const greeting = (now = new Date()) => {
  const hour = now.getHours();
  return hour < 12 ? "bom dia" : hour < 18 ? "boa tarde" : "boa noite";
};
const quantity = (value: number | null) => (value === null ? "—" : value.toLocaleString("pt-BR", { maximumFractionDigits: 3 }));
const unitCost = (value: number | null) =>
  value === null ? "—" : value.toLocaleString("pt-BR", { style: "currency", currency: "BRL", minimumFractionDigits: 2, maximumFractionDigits: 4 });
const unique = (values: string[]) => [...new Set(values.map((value) => value.trim()).filter(Boolean))];

/* ------------------------------------------------------------------------ */
/* Conteúdo                                                                  */
/* ------------------------------------------------------------------------ */

function signatureBlocks(kind: DocKind, form: ScrapForm | CcForm, final: boolean): Block[] {
  const progress = signatureProgress(form.data, form.signatures, kind);
  const who = (entry: (typeof progress.slots)[number]) => `${entry.slot.label}: ${entry.signature?.signer || entry.expected}`;
  const signedLine = (entry: (typeof progress.slots)[number]) =>
    `${who(entry)}${entry.signature?.signedAt ? ` (assinado em ${brDate(entry.signature.signedAt.slice(0, 10))})` : ""}`;
  if (final) return [{ type: "list", title: "Assinaturas", items: progress.signed.map(signedLine) }];
  const blocks: Block[] = [];
  if (progress.signed.length) blocks.push({ type: "list", title: "Já assinaram", items: progress.signed.map(signedLine) });
  blocks.push({ type: "list", title: "Aguardando assinatura de", items: progress.missing.map((entry) => `${entry.slot.label}: ${entry.expected}`) });
  blocks.push({
    type: "steps",
    title: "Como assinar",
    items: [
      "Abra o PDF em anexo no Adobe Acrobat Reader.",
      "Clique no campo de assinatura do seu quadro e assine com o seu ID digital.",
      "Salve o arquivo e responda a este e-mail com o PDF assinado.",
    ],
  });
  return blocks;
}

function ccContent(form: CcForm, final: boolean) {
  const { data, number } = form;
  const period = periodLabel(data.period) || data.period;
  const totals = ccTotals(data);
  const name = `FO.FI.C.007 – Inventory Adjustment nº ${number}`;
  const subject = final
    ? `FO.FI.C.007 nº ${number} assinado – Ajuste de inventário de ${period}`
    : `Solicitação de assinatura – FO.FI.C.007 nº ${number} – Ajuste de inventário de ${period}`;
  const intro = final
    ? `Encaminho, em anexo, o formulário **${name}**, referente ao ajuste de inventário de **${period}**, devidamente assinado por todos os responsáveis.`
    : `Encaminho, em anexo, o formulário **${name}**, referente ao ajuste de inventário de **${period}**, para análise e assinatura digital.`;
  const facts: [string, string][] = [
    ["Itens", String(data.items.length)],
    ["Quantidade total", quantity(totals.quantity)],
    ["Valor total", brMoney(totals.cost) || "—"],
  ];
  const centers = unique(data.items.map((item) => (item.costCenter ? `${item.costCenter}${item.costCenterDescription ? ` – ${item.costCenterDescription}` : ""}` : "")));
  if (centers.length) facts.push([centers.length > 1 ? "Centros de custo" : "Centro de custo", centers.join("; ")]);
  const warehouses = unique(data.items.map((item) => item.wh));
  if (warehouses.length) facts.push([warehouses.length > 1 ? "Depósitos" : "Depósito", warehouses.join(", ")]);
  const reason = [data.reason, data.mainReason].map((value) => value.trim()).filter(Boolean).join(" – ");
  if (reason) facts.push(["Motivo", reason]);
  if (data.scrapForms.length) facts.push(["Origem", data.scrapForms.join(", ")]);
  if (final && data.sapDocument) facts.push(["Documento SAP", data.sapDocument]);
  const rows = data.items.map((item, index) => [
    String(index + 1),
    item.material || "—",
    item.description || "—",
    quantity(item.quantity),
    unitCost(item.unitCost),
    brMoney(ccItemTotal(item)) || "—",
  ]);
  const request: Block[] = final
    ? [
        {
          type: "p",
          text: data.sapDocument
            ? `O ajuste já foi lançado no SAP (documento ${data.sapDocument}). Encaminho para conhecimento e arquivo.`
            : "Solicito, por gentileza, a efetivação do ajuste no SAP e o retorno com o número do documento gerado.",
        },
      ]
    : [];
  return { subject, intro, facts, rows, head: ["Item", "Material", "Descrição", "Qtd.", "Custo unit.", "Valor"], right: [0, 3, 4, 5], request };
}

function scrapContent(form: ScrapForm, final: boolean) {
  const { data, number } = form;
  const date = brDate(data.formDate) || data.formDate;
  const name = `Formulário de Scrap A-B nº ${number}`;
  const subject = final ? `Scrap Form nº ${number} assinado (${date})` : `Solicitação de assinatura – Scrap Form nº ${number} (${date})`;
  const intro = final
    ? `Encaminho, em anexo, o **${name}**, de **${date}**, devidamente assinado por todos os responsáveis.`
    : `Encaminho, em anexo, o **${name}**, de **${date}**, para análise e assinatura digital.`;
  const facts: [string, string][] = [
    ["Itens", String(data.items.length)],
    ["Valor total", brMoney(formTotal(data)) || "—"],
  ];
  const ops = unique(data.items.map((item) => item.op));
  if (ops.length) facts.push([ops.length > 1 ? "Ordens de produção" : "Ordem de produção", ops.join(", ")]);
  if (final) {
    if (data.pr) facts.push(["PR (reposição)", `${data.pr}${data.prDate ? ` de ${brDate(data.prDate)}` : ""}`]);
    if (data.po) facts.push(["PO", data.po]);
    if (data.sapDocument) facts.push(["Documento SAP", data.sapDocument]);
  }
  const rows = data.items.map((item) => [
    item.material || "—",
    item.name || "—",
    quantity(item.quantity),
    brMoney(itemTotal(item)) || "—",
    item.op || "—",
    item.vin || "—",
    item.classification || "—",
  ]);
  const request: Block[] = final
    ? [
        {
          type: "p",
          text: data.sapDocument
            ? "Encaminho para conhecimento e arquivo."
            : "Solicito, por gentileza, o lançamento da baixa no SAP e o retorno com o número do documento gerado.",
        },
      ]
    : [];
  return { subject, intro, facts, rows, head: ["Material", "Descrição", "Qtd.", "Valor", "OP", "VIN", "Classe"], right: [2, 3], request };
}

function blocksOf(kind: DocKind, form: ScrapForm | CcForm, options: EmailOptions) {
  const final = form.status === "signed";
  const content = kind === "cc" ? ccContent(form as CcForm, final) : scrapContent(form as ScrapForm, final);
  const extra = content.rows.length - TABLE_ITEMS;
  const opening: Block[] = [
    { type: "p", text: `Prezados, ${greeting(options.now)}.` },
    { type: "p", text: content.intro },
    { type: "facts", title: "Resumo", rows: content.facts },
  ];
  const signatures = signatureBlocks(kind, form, final);
  const ending: Block[] = [
    ...content.request,
    { type: "p", text: "Agradeço desde já e fico à disposição para qualquer esclarecimento." },
    { type: "closing", sender: (options.sender || "").trim() },
  ];
  const link: Block[] = options.link ? [{ type: "link", text: "O formulário também pode ser consultado no portal Controle de Produção:", href: options.link }] : [];
  const blocks: Block[] = [
    ...opening,
    {
      type: "table",
      title: "Itens",
      head: content.head,
      right: content.right,
      rows: content.rows.slice(0, TABLE_ITEMS),
      more: extra > 0 ? `… e mais ${extra} ${extra === 1 ? "item" : "itens"}. A lista completa está no PDF em anexo.` : "",
    },
    ...signatures,
    ...link,
    ...ending,
  ];
  // Link de e-mail (mailto) tem limite de tamanho: sem a lista de itens e com o passo a passo em uma frase.
  const short: Block[] = [
    ...opening,
    { type: "p", text: "Os itens estão detalhados no PDF em anexo." },
    ...signatures.filter((block) => block.type !== "steps"),
    ...(final
      ? []
      : [{ type: "p" as const, text: "Para assinar, abra o PDF no Adobe Acrobat Reader, clique no campo do seu quadro e assine com o seu ID digital. Depois, por gentileza, responda a este e-mail com o PDF assinado." }]),
    ...ending,
  ];
  return { subject: content.subject, blocks, short };
}

/* ------------------------------------------------------------------------ */
/* Texto e HTML                                                              */
/* ------------------------------------------------------------------------ */

const plain = (text: string) => text.replace(/\*\*(.+?)\*\*/g, "$1");
function renderText(blocks: Block[]) {
  const out: string[] = [];
  for (const block of blocks) {
    if (block.type === "p") out.push(plain(block.text));
    else if (block.type === "facts") out.push([`${block.title}:`, ...block.rows.map(([label, value]) => `• ${label}: ${value}`)].join("\n"));
    else if (block.type === "table")
      out.push([`${block.title}:`, ...block.rows.map((row) => `• ${row.join(" · ")}`), ...(block.more ? [block.more] : [])].join("\n"));
    else if (block.type === "list") out.push([`${block.title}:`, ...block.items.map((item) => `• ${item}`)].join("\n"));
    else if (block.type === "steps") out.push([`${block.title}:`, ...block.items.map((item, index) => `${index + 1}. ${item}`)].join("\n"));
    else if (block.type === "link") out.push(`${block.text}\n${block.href}`);
    else out.push(["Atenciosamente,", ...(block.sender ? [block.sender] : [])].join("\n"));
  }
  return out.join("\n\n");
}

const esc = (value: unknown) =>
  String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
const rich = (text: string) => esc(text).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
const FONT = "font-family:Calibri,'Segoe UI',Arial,sans-serif";
const P = "margin:0 0 12px";
const TITLE = "margin:18px 0 6px;font-weight:bold;color:#1f1f1f";
const CELL = "border:1px solid #d4d4d4;padding:4px 8px;vertical-align:top";
function renderHtml(blocks: Block[]) {
  const out: string[] = [];
  for (const block of blocks) {
    if (block.type === "p") out.push(`<p style="${P}">${rich(block.text)}</p>`);
    else if (block.type === "facts")
      out.push(
        `<p style="${TITLE}">${esc(block.title)}</p>`,
        `<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:0 0 6px;font-size:10.5pt">${block.rows
          .map(
            ([label, value]) =>
              `<tr><td style="padding:3px 16px 3px 0;color:#595959;white-space:nowrap;vertical-align:top">${esc(label)}</td><td style="padding:3px 0;color:#1f1f1f;font-weight:bold">${esc(value)}</td></tr>`,
          )
          .join("")}</table>`,
      );
    else if (block.type === "table") {
      if (!block.rows.length) continue;
      const align = (index: number) => (block.right.includes(index) ? "right" : "left");
      out.push(
        `<p style="${TITLE}">${esc(block.title)}</p>`,
        `<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:0 0 6px;font-size:10pt">` +
          `<tr>${block.head.map((label, index) => `<th style="${CELL};background:#f2f2f2;text-align:${align(index)};white-space:nowrap">${esc(label)}</th>`).join("")}</tr>` +
          block.rows.map((row) => `<tr>${row.map((value, index) => `<td style="${CELL};text-align:${align(index)}${block.right.includes(index) ? ";white-space:nowrap" : ""}">${esc(value)}</td>`).join("")}</tr>`).join("") +
          `</table>`,
      );
      if (block.more) out.push(`<p style="margin:0 0 12px;font-size:10pt;color:#595959">${esc(block.more)}</p>`);
    } else if (block.type === "list")
      out.push(`<p style="${TITLE}">${esc(block.title)}</p>`, `<ul style="margin:0 0 12px 22px;padding:0">${block.items.map((item) => `<li style="margin:0 0 3px">${esc(item)}</li>`).join("")}</ul>`);
    else if (block.type === "steps")
      out.push(`<p style="${TITLE}">${esc(block.title)}</p>`, `<ol style="margin:0 0 12px 22px;padding:0">${block.items.map((item) => `<li style="margin:0 0 3px">${esc(item)}</li>`).join("")}</ol>`);
    else if (block.type === "link") out.push(`<p style="${P};font-size:10pt;color:#595959">${esc(block.text)} <a href="${esc(block.href)}">${esc(block.href)}</a></p>`);
    else out.push(`<p style="margin:18px 0 0">Atenciosamente,${block.sender ? `<br><b>${esc(block.sender)}</b>` : ""}</p>`);
  }
  return `<div style="${FONT};font-size:11pt;color:#1f1f1f;line-height:1.45">${out.join("")}</div>`;
}

export function formEmail(kind: DocKind, form: ScrapForm | CcForm, options: EmailOptions = {}): FormEmail {
  const { subject, blocks, short } = blocksOf(kind, form, options);
  return { subject, text: renderText(blocks), html: renderHtml(blocks), short: renderText(short) };
}

/* ------------------------------------------------------------------------ */
/* Rascunho .eml (Outlook)                                                   */
/* ------------------------------------------------------------------------ */

const utf8 = (text: string) => new TextEncoder().encode(text);
const wrap = (text: string) => text.replace(/.{1,76}/g, "$&\r\n");
const ascii = (text: string) => /^[\x20-\x7e]*$/.test(text);
/** Cabeçalho com acento: palavras codificadas (RFC 2047) de até 75 caracteres. */
export function encodeHeader(text: string) {
  if (ascii(text)) return text;
  const words: string[] = [];
  let chunk = "";
  for (const char of text) {
    if (utf8(chunk + char).length > 45) {
      words.push(chunk);
      chunk = "";
    }
    chunk += char;
  }
  if (chunk) words.push(chunk);
  return words.map((word) => `=?UTF-8?B?${base64(utf8(word))}?=`).join("\r\n ");
}
const addresses = (value: string) =>
  value
    .split(/[;,\s]+/)
    .map((entry) => entry.trim())
    .filter((entry) => /^[^@\s<>"]+@[^@\s<>"]+$/.test(entry));

export function buildEml({ to, subject, text, html, attachment }: { to: string; subject: string; text: string; html: string; attachment?: { name: string; bytes: Uint8Array } }) {
  const mixed = "----=_WBYD_mixed",
    alternative = "----=_WBYD_alt";
  const lines: string[] = ["X-Unsent: 1"];
  const recipients = addresses(to);
  if (recipients.length) lines.push(`To: ${recipients.join(", ")}`);
  lines.push(`Subject: ${encodeHeader(subject)}`, "MIME-Version: 1.0", `Content-Type: multipart/mixed; boundary="${mixed}"`, "", "This is a multi-part message in MIME format.", "");
  lines.push(`--${mixed}`, `Content-Type: multipart/alternative; boundary="${alternative}"`, "");
  lines.push(`--${alternative}`, 'Content-Type: text/plain; charset="utf-8"', "Content-Transfer-Encoding: base64", "", wrap(base64(utf8(text))));
  lines.push(
    `--${alternative}`,
    'Content-Type: text/html; charset="utf-8"',
    "Content-Transfer-Encoding: base64",
    "",
    wrap(base64(utf8(`<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${html}</body></html>`))),
  );
  lines.push(`--${alternative}--`, "");
  if (attachment) {
    const name = encodeHeader(attachment.name).replace(/\r\n /g, " ");
    lines.push(
      `--${mixed}`,
      `Content-Type: application/pdf; name="${name}"`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; filename="${name}"`,
      "",
      wrap(base64(attachment.bytes)),
    );
  }
  lines.push(`--${mixed}--`, "");
  return lines.join("\r\n").replace(/\r\n\r\n\r\n/g, "\r\n\r\n");
}
/** "FO.FI.C.007 CC-2026-0005 … - para assinatura.pdf" → "… - para assinatura - e-mail.eml" */
export const emailFileName = (pdfName: string) => `${pdfName.replace(/\.pdf$/i, "")} - e-mail.eml`;
