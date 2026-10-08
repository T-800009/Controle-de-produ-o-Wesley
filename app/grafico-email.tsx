import { useMemo, useState } from "react";
import { Copy, Download, Mail, Send, TriangleAlert } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { Dataset, Row } from "@/lib/materials";
import type { OpStatuses } from "@/lib/op-status";
import { summarizeOpProgress } from "@/lib/op-progress";
import { warehouseReport, warehouseWorkbook } from "@/lib/warehouse";
import { buildEml } from "@/lib/form-email";
import { consumoChart, graficoEmail, graficoFileName, materialsToSend, statusChart, type ChartImage, type ChartSvg } from "@/lib/grafico-email";
import { PORTAL_VERSION } from "@/lib/version";

/* Destinatários e assinatura ficam no navegador, como nos outros e-mails do portal. */
const TO_KEY = "wbyd:grafico:para",
  CC_KEY = "wbyd:grafico:cc",
  SENDER_KEY = "wbyd:email:nome",
  DOSSIE_TO_KEY = "wbyd:dossie:destinatarios";
const store = {
  get(key: string) {
    try {
      return localStorage.getItem(key) || "";
    } catch {
      return "";
    }
  },
  set(key: string, value: string) {
    try {
      if (value) localStorage.setItem(key, value);
      else localStorage.removeItem(key);
    } catch {
      // Navegador sem armazenamento: só não lembra para a próxima vez.
    }
  },
};
const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const count = (value: number) => value.toLocaleString("pt-BR");
const safeName = (text: string) => text.replace(/[\\/:*?"<>|·]+/g, " ").replace(/\s+/g, " ").trim();

function saveFile(bytes: Uint8Array, name: string, type: string) {
  if (typeof URL.createObjectURL !== "function") return;
  const url = URL.createObjectURL(new Blob([bytes.slice().buffer as ArrayBuffer], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
const svgDataUrl = (svg: string) => `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`;

/** SVG → PNG no próprio navegador (o Outlook não mostra SVG). Sai com o dobro do tamanho, para ficar nítido. */
async function svgToPng(chart: ChartSvg, scale = 2): Promise<Uint8Array> {
  const url = URL.createObjectURL(new Blob([chart.svg], { type: "image/svg+xml" }));
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(Error(`Não foi possível desenhar o gráfico "${chart.title}".`));
      image.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = chart.width * scale;
    canvas.height = chart.height * scale;
    const context = canvas.getContext("2d");
    if (!context) throw Error("Este navegador não gera imagens. Use o Chrome ou o Edge.");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.scale(scale, scale);
    context.drawImage(image, 0, 0, chart.width, chart.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw Error(`Não foi possível gerar a imagem do gráfico "${chart.title}".`);
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    URL.revokeObjectURL(url);
  }
}

export type GraficoEmailProps = {
  data: Dataset;
  rows: Row[];
  ops: string[];
  stocks: (Dataset | null)[];
  statuses: OpStatuses;
  checks: Record<string, boolean>;
  /** Saldos 7000/2000, status das OPs e itens OK conferidos (o mesmo que o WAREHOUSE espera). */
  ready: boolean;
  /** MB51 lida: sem ela não há consumo por classe nem lista de faltas. */
  sourceReady: boolean;
};

/** Janela "Enviar por e-mail" do GRÁFICO (carregada só ao clicar): gráficos das OPs + materiais que o Warehouse precisa enviar. */
export default function GraficoEmailDialog({ data, rows, ops, stocks, statuses, checks, ready, sourceReady, onClose }: GraficoEmailProps & { onClose: () => void }) {
  const [to, setTo] = useState(() => store.get(TO_KEY) || store.get(DOSSIE_TO_KEY));
  const [cc, setCc] = useState(() => store.get(CC_KEY));
  const [sender, setSender] = useState(() => store.get(SENDER_KEY));
  const [want, setWant] = useState({ status: true, consumo: true, materials: true, excel: true });
  const [busy, setBusy] = useState(""),
    [done, setDone] = useState(""),
    [error, setError] = useState("");
  const bom = { name: data.name, revision: data.revision, updatedAt: data.updatedAt };
  const bomLabel = `${data.name} · ${data.revision}`;
  const summary = useMemo(() => summarizeOpProgress(rows, ops), [rows, ops]);
  const report = useMemo(() => warehouseReport(rows, statuses, checks), [rows, statuses, checks]);
  const pending = useMemo(() => materialsToSend(report.items), [report]);
  // O que dá para mandar agora: o consumo precisa da MB51; a lista, também dos saldos e das marcações.
  const can = { status: summary.length > 0, consumo: sourceReady && summary.length > 0, materials: sourceReady && ready };
  const use = { status: want.status && can.status, consumo: want.consumo && can.consumo, materials: want.materials && can.materials };
  const excel = use.materials && want.excel;
  const charts = useMemo(() => {
    const list: ChartSvg[] = [];
    if (use.status) list.push(statusChart(summary, statuses, bomLabel));
    if (use.consumo) list.push(consumoChart(summary, statuses, bomLabel));
    return list;
  }, [use.status, use.consumo, summary, statuses, bomLabel]);
  const now = new Date();
  const link = typeof location !== "undefined" ? `${location.origin}/?bom=${encodeURIComponent(data.id)}&modulo=grafico` : "";
  const excelName = `Materiais a enviar ${safeName(bomLabel)} ${now.toLocaleDateString("pt-BR").replace(/\//g, "-")}.xlsx`;
  const message = (images: ChartImage[]) =>
    graficoEmail({ bom, summary, statuses, items: report.items, consumption: sourceReady, materials: use.materials, charts: images, attachment: excel ? excelName : undefined, sender, link, now });
  const preview = useMemo(
    () => message(charts.map((chart) => ({ id: chart.id, title: chart.title, alt: chart.alt, width: chart.width, height: chart.height, src: svgDataUrl(chart.svg) }))),
    [charts, report, use.materials, excel, sender, sourceReady],
  );
  const states = { complete: 0, waiting: 0 };
  for (const op of ops) {
    const state = statuses[op]?.status;
    if (state === "complete") states.complete++;
    else if (state === "waiting") states.waiting++;
  }

  function remember() {
    store.set(TO_KEY, to.trim());
    store.set(CC_KEY, cc.trim());
    store.set(SENDER_KEY, sender.trim());
  }
  async function excelBytes() {
    const x = await import("xlsx");
    const book = warehouseWorkbook(x, {
      items: pending,
      statuses,
      report,
      bom: data,
      stocks,
      filter: "Solicitar ao Warehouse",
      classLabel: "Todas as classes",
      version: PORTAL_VERSION,
      title: "Materiais a enviar pelo Warehouse",
    });
    return new Uint8Array(x.write(book, { type: "array", bookType: "xlsx" }) as ArrayBuffer);
  }
  async function run(label: string, task: () => Promise<string>) {
    setBusy(label);
    setError("");
    setDone("");
    try {
      setDone(await task());
    } catch (e) {
      setError((e as Error).message || "Não foi possível preparar o e-mail.");
    } finally {
      setBusy("");
    }
  }
  /** Rascunho .eml: o Outlook abre como mensagem nova, com os gráficos no corpo e a planilha anexada. */
  const draft = () =>
    run("Preparando o e-mail…", async () => {
      remember();
      const images = await Promise.all(charts.map(async (chart) => ({ chart, bytes: await svgToPng(chart) })));
      const mail = message(images.map(({ chart }) => ({ id: chart.id, title: chart.title, alt: chart.alt, width: chart.width, height: chart.height, src: `cid:grafico-${chart.id}@wbyd` })));
      const eml = buildEml({
        to,
        cc,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
        images: images.map(({ chart, bytes }) => ({ cid: `grafico-${chart.id}@wbyd`, name: chart.file, bytes, type: "image/png" })),
        attachments: excel ? [{ name: excelName, bytes: await excelBytes(), type: XLSX_TYPE }] : [],
      });
      saveFile(new TextEncoder().encode(eml), graficoFileName(data, now), "message/rfc822");
      return `E-mail pronto baixado. Abra o arquivo: o Outlook mostra a mensagem com ${charts.length ? "os gráficos" : "o texto"}${excel ? " e a planilha anexada" : ""}. Confira e clique em Enviar.`;
    });
  /** Programa de e-mail padrão: texto curto (link de e-mail tem limite); a planilha é baixada para anexar. */
  const email = () =>
    run("Abrindo o e-mail…", async () => {
      remember();
      if (excel) saveFile(await excelBytes(), excelName, XLSX_TYPE);
      const address = (value: string) => encodeURIComponent(value.trim()).replace(/%40/g, "@").replace(/%2C/gi, ",").replace(/%3B/gi, ";");
      window.location.href = `mailto:${address(to)}?${cc.trim() ? `cc=${address(cc)}&` : ""}subject=${encodeURIComponent(preview.subject)}&body=${encodeURIComponent(preview.short)}`;
      return excel ? `Planilha baixada (${excelName}). Anexe-a no e-mail que abriu. Os gráficos vão no E-mail pronto (Outlook).` : "E-mail aberto. Os gráficos vão no E-mail pronto (Outlook).";
    });
  /** Copia formatado (cola bonito no Outlook/Teams), sem os gráficos. */
  const copy = () =>
    run("Copiando…", async () => {
      const mail = message([]);
      if (typeof ClipboardItem === "function" && navigator.clipboard?.write)
        await navigator.clipboard.write([new ClipboardItem({ "text/html": new Blob([mail.html], { type: "text/html" }), "text/plain": new Blob([mail.text], { type: "text/plain" }) })]);
      else await navigator.clipboard.writeText(`${mail.subject}\n\n${mail.text}`);
      return "Texto copiado (sem os gráficos). Cole no e-mail ou no Teams; use Baixar gráficos para anexar as imagens.";
    });
  const pictures = () =>
    run("Gerando as imagens…", async () => {
      for (const chart of charts) saveFile(await svgToPng(chart), `${safeName(bomLabel)} - ${chart.file}`, "image/png");
      return charts.length === 1 ? "Gráfico baixado em PNG." : `${charts.length} gráficos baixados em PNG.`;
    });

  const toggle = (key: keyof typeof want) => (event: React.ChangeEvent<HTMLInputElement>) => setWant((previous) => ({ ...previous, [key]: event.target.checked }));
  const nothing = !charts.length && !use.materials;
  return (
    <Dialog open onOpenChange={(value) => !value && !busy && onClose()}>
      <DialogContent className="import-dialog scrap-dialog grafico-email-dialog">
        <DialogHeader>
          <DialogTitle>Enviar o acompanhamento por e-mail</DialogTitle>
          <DialogDescription>
            O e-mail já vem escrito, com os gráficos das OPs e os materiais que o Warehouse ainda precisa enviar para o 7000. Os destinatários ficam salvos para a próxima vez.
          </DialogDescription>
        </DialogHeader>
        <div className="grafico-email-body">
          {!sourceReady ? (
            <p className="grafico-email-note">
              <TriangleAlert size={15} />
              <span>
                Para incluir o consumo por classe e a lista de faltas, clique em <b>Atualizar dados</b> no topo. Sem isso, vai só o status das OPs.
              </span>
            </p>
          ) : !ready ? (
            <p className="grafico-email-note" role="status">
              <TriangleAlert size={15} />
              <span>Conferindo os saldos do 7000 e do 2000 e as marcações da equipe. A lista de faltas entra assim que terminar.</span>
            </p>
          ) : null}
          <div className="grafico-email-fields">
            <label className="wide">
              Para (e-mail)
              <input type="email" multiple value={to} placeholder="warehouse@empresa.com; outro@empresa.com" onChange={(e) => setTo(e.target.value)} />
            </label>
            <label>
              Cópia (Cc)
              <input type="email" multiple value={cc} placeholder="opcional" onChange={(e) => setCc(e.target.value)} />
            </label>
            <label>
              Assinar o e-mail como
              <input value={sender} maxLength={80} placeholder="Seu nome" onChange={(e) => setSender(e.target.value)} />
            </label>
          </div>
          <fieldset className="grafico-email-include">
            <legend>O que vai no e-mail</legend>
            <label>
              <input type="checkbox" checked={use.status} disabled={!can.status} onChange={toggle("status")} />
              <span>
                Gráfico do status das OPs
                <small>
                  {count(ops.length)} OPs · {count(states.complete)} concluídas · {count(states.waiting)} aguardando Warehouse
                </small>
              </span>
            </label>
            <label>
              <input type="checkbox" checked={use.consumo} disabled={!can.consumo} onChange={toggle("consumo")} />
              <span>
                Gráfico de consumo por classe
                <small>{can.consumo ? "% de materiais atendidos por OP (A, B e C)" : "precisa da MB51 atualizada"}</small>
              </span>
            </label>
            <label>
              <input type="checkbox" checked={use.materials} disabled={!can.materials} onChange={toggle("materials")} />
              <span>
                Lista dos materiais a enviar
                <small>{!can.materials ? (sourceReady ? "aguardando os saldos" : "precisa da MB51 atualizada") : pending.length ? `${count(pending.length)} ${pending.length === 1 ? "material que o 7000 não cobre" : "materiais que o 7000 não cobre"}` : "nenhum material pendente"}</small>
              </span>
            </label>
            <label>
              <input type="checkbox" checked={excel} disabled={!use.materials} onChange={toggle("excel")} />
              <span>
                Planilha em anexo
                <small>com as quantidades por OP (a mesma do WAREHOUSE)</small>
              </span>
            </label>
          </fieldset>
          <div className="scrap-actions">
            <button className="primary" disabled={!!busy || nothing} onClick={draft} title="Baixa o e-mail pronto (.eml): abre no Outlook com os gráficos no corpo e a planilha anexada">
              <Mail size={16} />
              E-mail pronto (Outlook)
            </button>
            <button disabled={!!busy || nothing} onClick={email} title="Abre o programa de e-mail padrão com um texto curto; a planilha é baixada para anexar">
              <Send size={16} />
              Abrir no e-mail
            </button>
            <button disabled={!!busy || nothing} onClick={copy}>
              <Copy size={16} />
              Copiar texto
            </button>
            <button disabled={!!busy || !charts.length} onClick={pictures}>
              <Download size={16} />
              Baixar gráficos
            </button>
            {busy && <small role="status">{busy}</small>}
          </div>
          {error && (
            <p className="scrap-message error" role="alert">
              <TriangleAlert size={15} />
              <span>{error}</span>
            </p>
          )}
          {done && <p className="scrap-review-note grafico-email-done">{done}</p>}
          <details className="scrap-send-preview grafico-email-preview" open>
            <summary>
              <Mail size={13} />
              {preview.subject}
            </summary>
            {/* Num iframe: a prévia fica igual ao e-mail, sem o estilo do portal. */}
            <iframe className="scrap-email-preview" title="Prévia do e-mail" sandbox="" srcDoc={`<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:16px 18px;background:#fff">${preview.html}</body></html>`} />
          </details>
        </div>
      </DialogContent>
    </Dialog>
  );
}
