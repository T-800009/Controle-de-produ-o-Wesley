/**
 * E-mail do GRÁFICO para o Warehouse: os gráficos das OPs (status e consumo por
 * classe) como imagens e a lista dos materiais que o Warehouse ainda precisa
 * enviar para o 7000, no mesmo tom formal dos outros e-mails do portal.
 *
 * Os gráficos saem como SVG com fundo branco e todas as OPs da BOM (o gráfico da
 * tela pagina e tem fundo escuro). A tela transforma o SVG em PNG para o e-mail:
 * o Outlook não mostra SVG.
 */
import { PROGRESS_CLASSES, progressLabel, shortOpLabels, type ClassProgress, type OpProgress } from "./op-progress.ts";
import type { OpStatuses } from "./op-status.ts";
import type { WarehouseItem } from "./warehouse.ts";
import { greeting, renderHtml, renderText, type Block, type FormEmail } from "./form-email.ts";

export type ChartId = "status" | "consumo";
export type ChartSvg = { id: ChartId; title: string; alt: string; svg: string; width: number; height: number; file: string };
export type ChartImage = { id: ChartId; title: string; alt: string; src: string; width: number; height: number };

/** Largura do gráfico no e-mail (px). O PNG sai com o dobro, para ficar nítido. */
export const CHART_WIDTH = 720;
/** Até quantos materiais vão listados no corpo (o resto está na planilha). */
export const EMAIL_MATERIALS = 40;

const COLORS: Record<string, string> = { A: "#346775", B: "#d4aa39", C: "#dea077" };
const STATUS = {
  complete: { fill: "#2f9e6e", stroke: "#2f9e6e", text: "#ffffff", label: "Concluída" },
  waiting: { fill: "#fbefd0", stroke: "#d9a520", text: "#7a5600", label: "Aguardando Warehouse" },
  not_started: { fill: "#ffffff", stroke: "#c95f66", text: "#a8424a", label: "Não iniciada" },
} as const;
const FONT = "'Segoe UI', Arial, Helvetica, sans-serif";
const INK = "#1f2937",
  MUTED = "#6b7280",
  GRID = "#e5e7eb";

const esc = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
const num = (value: number) => value.toLocaleString("pt-BR", { maximumFractionDigits: 3 });
const count = (value: number) => value.toLocaleString("pt-BR");
/** Largura aproximada de um texto (para posicionar a legenda sem medir no navegador). */
const textWidth = (text: string, size: number) => text.length * size * 0.62;
const stateOf = (statuses: OpStatuses, op: string) => statuses[op]?.status || "not_started";

/** Linhas equilibradas: 17 OPs com no máximo 12 por linha → 9 + 8. */
function layout(total: number, max: number) {
  const rows = Math.max(1, Math.ceil(total / max));
  return { rows, perRow: Math.max(1, Math.ceil(total / rows)) };
}

function legend(items: { color: string; stroke?: string; dashed?: boolean; text: string }[], x: number, y: number) {
  let left = x;
  return items
    .map((item) => {
      const out = `<rect x="${left}" y="${y - 9}" width="11" height="11" rx="2" fill="${item.color}" stroke="${item.stroke || item.color}"${item.dashed ? ' stroke-dasharray="2 2"' : ""}/><text x="${left + 16}" y="${y}" font-size="12" fill="${INK}">${esc(item.text)}</text>`;
      left += 16 + textWidth(item.text, 12) + 22;
      return out;
    })
    .join("");
}

function svgDocument(width: number, height: number, label: string, body: string) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="${esc(FONT)}" role="img" aria-label="${esc(label)}"><rect width="${width}" height="${height}" fill="#ffffff"/>${body}</svg>`;
}

/** Status das OPs (marcação da equipe): verde concluída, amarela aguardando o Warehouse, vermelha não iniciada. */
export function statusChart(summary: OpProgress[], statuses: OpStatuses, bomLabel: string): ChartSvg {
  const ops = summary.map((item) => item.op);
  const labels = shortOpLabels(ops);
  const totals = { complete: 0, waiting: 0, not_started: 0 };
  for (const op of ops) totals[stateOf(statuses, op)]++;
  const { rows, perRow } = layout(ops.length, 16);
  const left = 20,
    top = 66,
    rowHeight = 96,
    slot = (CHART_WIDTH - left * 2) / perRow;
  const height = top + rows * rowHeight + 26;
  const tiles = ops
    .map((op, index) => {
      const row = Math.floor(index / perRow),
        col = index % perRow;
      const x = left + col * slot + slot / 2,
        y = top + row * rowHeight;
      const state = stateOf(statuses, op),
        style = STATUS[state];
      const w = Math.min(44, slot - 8);
      const inner = state === "complete" ? `<text x="${x}" y="${y + 37}" text-anchor="middle" font-size="22" font-weight="700" fill="${style.text}">✓</text>` : `<text x="${x}" y="${y + 34}" text-anchor="middle" font-size="10" font-weight="600" fill="${style.text}">${state === "waiting" ? "Espera" : "Aberta"}</text>`;
      return (
        `<g><title>OP ${esc(op)}: ${esc(style.label)}</title>` +
        `<rect x="${x - w / 2}" y="${y}" width="${w}" height="56" rx="6" fill="${style.fill}" stroke="${style.stroke}" stroke-width="1.5"${state === "not_started" ? ' stroke-dasharray="4 3"' : ""}/>` +
        inner +
        `<text x="${x}" y="${y + 74}" text-anchor="middle" font-size="11" font-weight="600" fill="${INK}">${esc(labels.get(op))}</text></g>`
      );
    })
    .join("");
  const body =
    `<text x="${left}" y="26" font-size="15" font-weight="700" fill="${INK}">Status das OPs · ${esc(bomLabel)}</text>` +
    legend(
      [
        { color: STATUS.complete.fill, text: `Concluída (${totals.complete})` },
        { color: STATUS.waiting.fill, stroke: STATUS.waiting.stroke, text: `Aguardando Warehouse (${totals.waiting})` },
        { color: STATUS.not_started.fill, stroke: STATUS.not_started.stroke, dashed: true, text: `Não iniciada (${totals.not_started})` },
      ],
      left,
      50,
    ) +
    tiles +
    `<text x="${CHART_WIDTH / 2}" y="${height - 9}" text-anchor="middle" font-size="10.5" fill="${MUTED}">Final da OP · status registrado pela equipe no portal</text>`;
  const alt = `Status das ${ops.length} OPs: ${totals.complete} concluídas, ${totals.waiting} aguardando Warehouse, ${totals.not_started} não iniciadas`;
  return { id: "status", title: "Status das OPs", alt, svg: svgDocument(CHART_WIDTH, height, alt, body), width: CHART_WIDTH, height, file: "Status das OPs.png" };
}

/** Percentual de materiais da BOM atendidos (MB51 + SCRAP) por OP e classe, como o "Consumo por classe" da tela. */
export function consumoChart(summary: OpProgress[], statuses: OpStatuses, bomLabel: string): ChartSvg {
  const labels = shortOpLabels(summary.map((item) => item.op));
  const { rows, perRow } = layout(summary.length, 12);
  // 34 px acima de cada linha para os percentuais (texto em pé sobre as barras)
  const left = 44,
    right = 14,
    pctSpace = 34,
    top = 76 + pctSpace,
    plot = 140,
    rowHeight = plot + 52 + pctSpace,
    slot = (CHART_WIDTH - left - right) / perRow;
  const bar = Math.max(6, Math.min(16, (slot - 12) / 3)),
    gap = Math.min(4, bar / 4);
  // a última linha não precisa do espaço dos percentuais da linha seguinte; 22 px de rodapé
  const height = top + rows * rowHeight - pctSpace + 22;
  let body =
    `<text x="20" y="26" font-size="15" font-weight="700" fill="${INK}">Materiais atendidos por OP e classe · ${esc(bomLabel)}</text>` +
    `<text x="20" y="45" font-size="11" fill="${MUTED}">% de materiais da BOM atendidos pela MB51 + SCRAP</text>` +
    legend(
      PROGRESS_CLASSES.map((name) => ({ color: COLORS[name], text: `Classe ${name}` })),
      20,
      68,
    );
  for (let row = 0; row < rows; row++) {
    const base = top + row * rowHeight + plot;
    for (const tick of [0, 25, 50, 75, 100]) {
      const y = base - (plot * tick) / 100;
      body += `<line x1="${left}" x2="${CHART_WIDTH - right}" y1="${y}" y2="${y}" stroke="${GRID}"${tick ? ' stroke-dasharray="3 4"' : ""}/>`;
      if (tick % 50 === 0) body += `<text x="${left - 8}" y="${y + 4}" text-anchor="end" font-size="10" fill="${MUTED}">${tick}%</text>`;
    }
    summary.slice(row * perRow, (row + 1) * perRow).forEach((item, col) => {
      const x = left + col * slot + slot / 2;
      PROGRESS_CLASSES.forEach((name, i) => {
        const group: ClassProgress = item.classes[name];
        const value = group.percent ?? 0,
          h = (plot * value) / 100,
          bx = x + (i - 1) * (bar + gap) - bar / 2,
          y = base - Math.max(h, 2);
        body += `<rect x="${bx}" y="${y}" width="${bar}" height="${Math.max(h, 2)}" fill="${group.percent !== null ? COLORS[name] : "#cbd2d9"}"${group.percent === null ? ' opacity="0.6"' : ""}><title>OP ${esc(item.op)} · Classe ${name}: ${esc(progressLabel(group))}</title></rect>`;
        body += `<text transform="translate(${bx + bar / 2 + 3.5},${y - 4}) rotate(-90)" font-size="9.5" fill="#374151">${esc(progressLabel(group))}</text>`;
      });
      const state = stateOf(statuses, item.op);
      const note = state === "complete" ? "Concluída*" : item.complete ? "BOM atendida" : item.review > 0 ? "Conferir" : "";
      body += `<text x="${x}" y="${base + 18}" text-anchor="middle" font-size="11" font-weight="600" fill="${INK}">${esc(labels.get(item.op))}</text>`;
      if (note) body += `<text x="${x}" y="${base + 32}" text-anchor="middle" font-size="9.5" fill="${state === "complete" ? "#267854" : MUTED}">${esc(note)}</text>`;
    });
  }
  body += `<text x="${CHART_WIDTH / 2}" y="${height - 8}" text-anchor="middle" font-size="10.5" fill="${MUTED}">Final da OP · * Concluída = status da equipe · — = classe sem itens ou sem dados confiáveis</text>`;
  const alt = `Percentual de materiais atendidos por classe em ${summary.length} OPs`;
  return { id: "consumo", title: "Materiais atendidos por OP e classe", alt, svg: svgDocument(CHART_WIDTH, height, alt, body), width: CHART_WIDTH, height, file: "Consumo por classe.png" };
}

/* ------------------------------------------------------------------------ */
/* Conteúdo                                                                  */
/* ------------------------------------------------------------------------ */

/** Materiais que o Warehouse precisa mandar: o que o 7000 não cobre. Classe A primeiro. */
export function materialsToSend(items: WarehouseItem[]) {
  const rank = (item: WarehouseItem) => Math.min(...item.classes.map((cls) => ({ A: 0, B: 1, C: 2 })[cls] ?? 3), 3);
  return items.filter((item) => item.request !== null && item.request > 0).sort((a, b) => rank(a) - rank(b) || a.material.localeCompare(b.material));
}

export function classTotals(summary: OpProgress[]) {
  return PROGRESS_CLASSES.map((name) => {
    const total: ClassProgress = { total: 0, done: 0, pending: 0, review: 0, percent: null };
    for (const item of summary) for (const field of ["total", "done", "pending", "review"] as const) total[field] += item.classes[name][field];
    total.percent = total.total && total.review !== total.total ? (total.done / total.total) * 100 : null;
    return { name, ...total };
  });
}

const situation = (item: WarehouseItem) =>
  item.state === "short"
    ? `Reposição: ${item.uncovered === 1 ? "falta" : "faltam"} ${num(item.uncovered ?? 0)} ${item.unit} além do 2000`
    : item.state === "transfer"
      ? "Transferir do 2000"
      : "Conferir o saldo do 2000";
const opList = (ops: string[], labels: Map<string, string>) => {
  const names = ops.map((op) => labels.get(op) || op);
  return names.length > 4 ? `${names.slice(0, 4).join(", ")} +${names.length - 4}` : names.join(", ");
};
const stamp = (value?: string) => (value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }).replace(", ", " às ") : "");

export type GraficoEmailInput = {
  bom: { name: string; revision: string; updatedAt?: string };
  summary: OpProgress[];
  statuses: OpStatuses;
  /** Itens do resumo do Warehouse (warehouseReport). */
  items: WarehouseItem[];
  /** MB51 lida: sem ela não há consumo por classe nem lista de faltas. */
  consumption: boolean;
  /** Incluir a lista dos materiais a enviar. */
  materials: boolean;
  charts: ChartImage[];
  /** Nome da planilha anexada (se houver). */
  attachment?: string;
  sender?: string;
  link?: string;
  now?: Date;
};

export function graficoEmail(input: GraficoEmailInput): FormEmail & { toSend: WarehouseItem[] } {
  const { bom, summary, statuses, charts, now = new Date() } = input;
  const bomLabel = `${bom.name} · ${bom.revision}`;
  const ops = summary.map((item) => item.op);
  const labels = shortOpLabels(ops);
  const states = { complete: 0, waiting: 0, not_started: 0 };
  for (const op of ops) states[stateOf(statuses, op)]++;
  const withMaterials = input.materials && input.consumption;
  const toSend = withMaterials ? materialsToSend(input.items) : [];
  const date = now.toLocaleDateString("pt-BR");
  const subject = withMaterials
    ? `Acompanhamento das OPs ${bomLabel} – materiais a enviar pelo Warehouse (${date})`
    : `Acompanhamento das OPs ${bomLabel} (${date})`;
  const read = stamp(bom.updatedAt);
  const intro = withMaterials
    ? `Segue o acompanhamento das ordens de produção da **${bomLabel}**${read ? `, com a MB51 consultada em **${read}**` : ""}, e a lista dos materiais que ainda precisam ser enviados pelo Warehouse para a produção (depósito 7000).`
    : `Segue o acompanhamento das ordens de produção da **${bomLabel}**${input.consumption && read ? `, com a MB51 consultada em **${read}**` : ""}.`;
  const facts: [string, string][] = [
    ["Ordens de produção", `${count(ops.length)} (${count(states.complete)} concluídas, ${count(states.waiting)} aguardando Warehouse, ${count(states.not_started)} não iniciadas)`],
  ];
  if (input.consumption)
    for (const cls of classTotals(summary))
      if (cls.total) facts.push([`Classe ${cls.name}`, `${progressLabel(cls)} dos materiais atendidos (${count(cls.done)} de ${count(cls.total)}; ${count(cls.pending)} com diferença)`]);
  if (withMaterials) {
    const transfer = toSend.filter((item) => item.state === "transfer").length,
      short = toSend.filter((item) => item.state === "short").length,
      review = toSend.filter((item) => item.state === "review").length;
    const parts = [transfer && `${count(transfer)} com saldo no 2000 para transferir`, short && `${count(short)} ${short === 1 ? "precisa" : "precisam"} de reposição`, review && `${count(review)} com o saldo do 2000 a conferir`].filter(Boolean);
    facts.push(["Materiais a enviar", toSend.length ? `${count(toSend.length)}${parts.length ? ` (${parts.join("; ")})` : ""}` : "nenhum"]);
  }
  const imageBlocks: Block[] = charts.map((chart) => ({ type: "image", title: chart.title, heading: false, src: chart.src, alt: chart.alt, width: chart.width, height: chart.height }));
  const extra = toSend.length - EMAIL_MATERIALS;
  const table: Block[] =
    withMaterials && toSend.length
      ? [
          {
            type: "table",
            title: "Materiais a enviar pelo Warehouse",
            head: ["Material", "Descrição", "Classe", "Enviar", "Saldo 2000", "Situação", "OPs"],
            right: [3, 4],
            nowrap: [0],
            prefix: ["", "", "Classe ", "enviar ", "saldo 2000: ", "", "OPs "],
            rows: toSend.slice(0, EMAIL_MATERIALS).map((item) => [
              item.material,
              item.description || "—",
              item.classes.join("/") || "—",
              `${num(item.request!)} ${item.unit}`,
              item.s2000 === null ? "—" : `${num(item.s2000)} ${item.unit}`,
              situation(item),
              opList(item.ops, labels),
            ]),
            more:
              extra > 0
                ? `… e mais ${count(extra)} ${extra === 1 ? "material" : "materiais"}. ${input.attachment ? "A lista completa, com as quantidades por OP, está na planilha em anexo." : "A lista completa está na aba WAREHOUSE do portal."}`
                : input.attachment
                  ? "As quantidades por OP estão na planilha em anexo."
                  : "",
          },
        ]
      : [];
  const transfer = toSend.some((item) => item.state === "transfer" || item.state === "review"),
    short = toSend.some((item) => item.state === "short");
  const request: Block[] = withMaterials
    ? [
        {
          type: "p",
          text: !toSend.length
            ? "No momento não há materiais pendentes de envio pelo Warehouse nesta BOM: o saldo do 7000 cobre as diferenças de consumo das OPs abertas."
            : transfer && short
              ? "Solicito, por gentileza, a transferência do depósito 2000 para o 7000 dos materiais com saldo e, para os itens sem saldo suficiente, o retorno com a previsão de reposição."
              : short
                ? "Solicito, por gentileza, o retorno com a previsão de reposição dos materiais listados, que não têm saldo suficiente no depósito 2000."
                : "Solicito, por gentileza, a transferência dos materiais listados do depósito 2000 para o 7000.",
        },
      ]
    : [];
  const ending: Block[] = [
    ...request,
    { type: "p", text: "Agradeço desde já e fico à disposição para qualquer esclarecimento." },
    { type: "closing", sender: (input.sender || "").trim() },
  ];
  const opening: Block[] = [
    { type: "p", text: `Prezados, ${greeting(now)}.` },
    { type: "p", text: intro },
    { type: "facts", title: "Resumo", rows: facts },
  ];
  const link: Block[] = input.link ? [{ type: "link", text: "O acompanhamento também pode ser consultado no portal Controle de Produção:", href: input.link }] : [];
  const blocks: Block[] = [...opening, ...imageBlocks, ...table, ...link, ...ending];
  // mailto tem limite de tamanho: sem gráficos e sem a tabela.
  const short_: Block[] = [
    ...opening,
    { type: "p", text: input.attachment ? "A lista dos materiais, com as quantidades por OP, segue na planilha em anexo." : "A lista dos materiais está na aba WAREHOUSE do portal." },
    ...ending,
  ];
  return { subject, text: renderText(blocks), html: renderHtml(blocks), short: renderText(short_), toSend };
}

/** "Acompanhamento OPs BC22S02 BOM 1339 08-10-2026 - e-mail.eml" (sem caracteres que o Windows recusa). */
export function graficoFileName(bom: { name: string; revision: string }, now = new Date(), suffix = " - e-mail.eml") {
  const safe = `${bom.name} ${bom.revision}`.replace(/[\\/:*?"<>|·]+/g, " ").replace(/\s+/g, " ").trim();
  return `Acompanhamento OPs ${safe} ${now.toLocaleDateString("pt-BR").replace(/\//g, "-")}${suffix}`;
}
