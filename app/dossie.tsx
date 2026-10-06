"use client";
import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent as ReactClipboardEvent } from "react";
import {
  ArrowLeft,
  CheckCircle2,
  ClipboardCopy,
  Clock3,
  FileDown,
  FilePlus2,
  FileSpreadsheet,
  ImagePlus,
  Mail,
  MessageSquare,
  PackageSearch,
  Plus,
  RefreshCw,
  Send,
  Trash2,
  TriangleAlert,
  Undo2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { requestJson } from "@/lib/api";
import { readAutomatic } from "@/lib/automatic-worker-client";
import { stockModule } from "@/lib/stock-modules";
import type { Dataset } from "@/lib/materials";
import {
  DEFAULT_REQUEST,
  DEFAULT_TARGET,
  MAX_DATA_CHARS,
  MAX_FILES,
  MAX_FILE_BYTES,
  OUTCOMES,
  OUTCOME_LABELS,
  STATUS_LABELS,
  addBusinessDays,
  analyzeDossie,
  brDate,
  cobranca,
  daysBetween,
  fmtMoney,
  fmtQty,
  groupByMaterial,
  inboundTransfers,
  isoDay,
  itemsLabel,
  mergeMovements,
  movementKey,
  packData,
  parseMb51Rows,
  route,
  sanitizeDossieData,
  tableFromText,
  todayIso,
  transfersOf,
  typeLabel,
  validDepot,
  type BomLookup,
  type DateOrder,
  type DecimalStyle,
  type Dossie,
  type DossieData,
  type DossieListItem,
  type DossieStatus,
  type Movement,
  type Outcome,
  type StockCheck,
} from "@/lib/dossie";

type ListState = { dossies: DossieListItem[]; canEdit: boolean; canDelete: boolean; role: string };
type StatusFilter = "active" | "all" | "late" | DossieStatus;
const api = requestJson;
const RECIPIENTS_KEY = "wbyd:dossie:destinatarios";
/** O servidor abre até 10 dossiês por envio (limite de consultas do Cloudflare). */
const CREATE_CHUNK = 10;

function readRecipients() {
  try {
    return localStorage.getItem(RECIPIENTS_KEY) || "";
  } catch {
    return "";
  }
}
function saveRecipients(value: string) {
  try {
    if (value) localStorage.setItem(RECIPIENTS_KEY, value);
  } catch {}
}
async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {}
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {}
  area.remove();
  return ok;
}
function download(content: Blob, name: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(content);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
/** Arquivo de texto do SAP: UTF-16 (com BOM), UTF-8 ou Windows-1252. */
function decodeText(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}
/** MB51 exportada: planilha (xlsx/xls) ou texto (txt/csv, lista do SAP). */
async function rowsFromFile(file: File): Promise<unknown[][]> {
  if (/\.(txt|tsv|prn|csv)$/i.test(file.name) || file.type.startsWith("text/")) return tableFromText(decodeText(await file.arrayBuffer()));
  const x = await import("xlsx");
  const book = x.read(new Uint8Array(await file.arrayBuffer()), { type: "array" });
  let first: unknown[][] | null = null;
  for (const name of book.SheetNames) {
    const rows = x.utils.sheet_to_json<unknown[]>(book.Sheets[name], { header: 1, raw: true, defval: "" });
    if (!first) first = rows;
    try {
      parseMb51Rows(rows);
      return rows;
    } catch {}
  }
  return first || [];
}
async function toBase64(blob: Blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
/** Print grande em PNG vira JPEG (e diminui) até caber no limite. */
async function fitImage(file: Blob): Promise<Blob> {
  if (file.size <= MAX_FILE_BYTES) return file;
  if (typeof createImageBitmap !== "function") throw Error("O print passa de 1,5 MB. Recorte a imagem.");
  const bitmap = await createImageBitmap(file);
  let scale = 1;
  for (let attempt = 0; attempt < 5; attempt++) {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.86));
    if (blob && blob.size <= MAX_FILE_BYTES) return blob;
    scale *= 0.75;
  }
  throw Error("O print passa de 1,5 MB mesmo reduzido. Recorte a imagem.");
}
/** Saldo atual do material nos depósitos (abas 7000/2000/1500 da planilha). */
async function readStock(material: string, depots: string[]): Promise<StockCheck> {
  const result: StockCheck["depots"] = [];
  for (const depot of depots) {
    const base = (await api("/api/data?id=" + encodeURIComponent(depot))) as Dataset;
    const data = await readAutomatic(base);
    const rows = data.rows.filter((row) => String(row.material ?? "").trim().toUpperCase() === material);
    const sum = (key: "quantity" | "value") =>
      rows.reduce<number | null>((total, row) => (typeof row[key] === "number" && Number.isFinite(row[key]) ? (total ?? 0) + row[key] : total), null);
    result.push({ depot, quantity: rows.length ? sum("quantity") : 0, value: rows.length ? sum("value") : 0, unit: String(rows[0]?.unit || "").toUpperCase(), found: rows.length > 0 });
  }
  return { readAt: new Date().toISOString(), depots: result };
}
const sentCount = (track: { sentAt: string; reminders: string[] }) => (track.sentAt ? 1 + track.reminders.length : 0);
const late = (status: DossieStatus, deadline: string, today: string) => status === "sent" && !!deadline && deadline < today;
function trackLine(d: Pick<DossieListItem, "status" | "summary" | "track">, today: string) {
  const t = d.track;
  if (d.status === "closed") return `${t.outcome ? OUTCOME_LABELS[t.outcome] : "Encerrado"}${t.closedAt ? " · " + brDate(isoDay(t.closedAt)) : ""}`;
  if (d.status === "answered") return `Respondido${t.respondedAt ? " em " + brDate(t.respondedAt) : ""} · falta encerrar`;
  if (d.status === "sent") {
    const count = sentCount(t);
    const overdue = late(d.status, d.summary.deadline, today) ? daysBetween(d.summary.deadline, today) : null;
    return `${count}ª cobrança em ${brDate(isoDay(t.reminders.at(-1) || t.sentAt))}${overdue ? ` · prazo vencido há ${overdue} dia(s)` : d.summary.deadline ? " · prazo " + brDate(d.summary.deadline) : ""}`;
  }
  return "Ainda não cobrado";
}
function errorText(error: unknown) {
  return (error as Error)?.message || "Não foi possível concluir.";
}
const isConflict = (error: unknown) => /Outra pessoa alterou/.test(errorText(error));

export default function Dossies() {
  const [list, setList] = useState<ListState | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<StatusFilter>("active");
  const [opened, setOpened] = useState<string | null>(() => {
    try {
      return new URLSearchParams(location.search).get("dossie");
    } catch {
      return null;
    }
  });
  const [importing, setImporting] = useState(false);
  const today = todayIso();
  const sequence = useRef(0);

  const load = useCallback(async () => {
    const n = ++sequence.current;
    setLoading(true);
    setError("");
    try {
      const data = (await api("/api/dossies")) as ListState;
      if (n === sequence.current) setList(data);
    } catch (e) {
      if (n === sequence.current) setError(errorText(e));
    } finally {
      if (n === sequence.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  function open(number: string | null) {
    setOpened(number);
    try {
      const url = new URL(location.href);
      if (number) url.searchParams.set("dossie", number);
      else url.searchParams.delete("dossie");
      history.replaceState(null, "", url);
    } catch {}
    window.scrollTo?.({ top: 0 });
  }

  const dossies = list?.dossies || [];
  const filtered = useMemo(() => {
    const words = query
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .split(/\s+/)
      .filter(Boolean);
    return dossies.filter((d) => {
      if (status === "active" && d.status === "closed") return false;
      if (status === "late" && !late(d.status, d.summary.deadline, today)) return false;
      if (status !== "active" && status !== "all" && status !== "late" && d.status !== status) return false;
      if (!words.length) return true;
      const hay = [d.number, d.summary.material, d.summary.description, ...d.summary.transfers.flatMap((t) => [t.document, t.user, t.from, t.to])]
        .join(" ")
        .toLowerCase()
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "");
      return words.every((word) => hay.includes(word));
    });
  }, [dossies, query, status, today]);
  const metrics = useMemo(() => {
    const active = dossies.filter((d) => d.status !== "closed");
    return {
      open: dossies.filter((d) => d.status === "open").length,
      waiting: dossies.filter((d) => d.status === "sent").length,
      overdue: dossies.filter((d) => late(d.status, d.summary.deadline, today)).length,
      answered: dossies.filter((d) => d.status === "answered").length,
      value: active.reduce((sum, d) => sum + (d.summary.value || 0), 0),
      valued: active.filter((d) => d.summary.value !== null).length,
      active: active.length,
      closed: dossies.filter((d) => d.status === "closed").length,
      returned: dossies.filter((d) => d.track.outcome === "returned").length,
    };
  }, [dossies, today]);
  const hasFilters = !!query || status !== "active";

  async function exportList() {
    const x = await import("xlsx");
    const header = [
      "Dossiê", "Situação", "Material", "Descrição", "Documento(s)", "De", "Para", "Data da transferência", "Usuário", "Qtd transferida",
      "Parado", "Unidade", "Preço unitário (R$)", "Valor parado (R$)", "Prazo", "1ª cobrança", "Cobranças", "Respondido em", "Resultado", "Encerrado em",
    ];
    const unique = (values: string[]) => [...new Set(values.filter(Boolean))].join(", ");
    const rows = filtered.map((d) => {
      const t = d.summary.transfers;
      return [
        d.number,
        STATUS_LABELS[d.status],
        d.summary.material,
        d.summary.description,
        unique(t.map((item) => `${item.document} (${item.items.join("/")})`)),
        unique(t.map((item) => item.from)),
        unique(t.map((item) => item.to)),
        unique(t.map((item) => brDate(item.date))),
        unique(t.map((item) => item.user)),
        d.summary.transferred,
        d.summary.idle,
        d.summary.unit,
        d.summary.unitPrice === null ? null : Math.round(d.summary.unitPrice * 100) / 100,
        d.summary.value,
        brDate(d.summary.deadline),
        d.track.sentAt ? brDate(isoDay(d.track.sentAt)) : "",
        sentCount(d.track),
        brDate(d.track.respondedAt),
        d.track.outcome ? OUTCOME_LABELS[d.track.outcome] : "",
        d.track.closedAt ? brDate(isoDay(d.track.closedAt)) : "",
      ];
    });
    const sheet = x.utils.aoa_to_sheet([["Dossiê Warehouse · transferências cobradas"], [`Gerado em ${new Date().toLocaleString("pt-BR")}`], [], header, ...rows]);
    sheet["!cols"] = [14, 13, 16, 40, 26, 8, 8, 14, 14, 12, 10, 8, 14, 15, 12, 12, 10, 13, 30, 13].map((wch) => ({ wch }));
    sheet["!autofilter"] = { ref: `A4:T${4 + rows.length}` };
    const book = x.utils.book_new();
    x.utils.book_append_sheet(book, sheet, "Dossiês");
    x.writeFile(book, `dossie-warehouse-${today}.xlsx`);
  }
  async function copySummary() {
    const active = filtered.filter((d) => d.status !== "closed");
    if (!active.length) return toast.error("Nenhum dossiê em andamento neste filtro.");
    const total = active.reduce((sum, d) => sum + (d.summary.value || 0), 0);
    const lines = [
      `Dossiês com o Warehouse em andamento (${active.length}):`,
      "",
      ...active.map((d) => {
        const t = d.summary.transfers;
        const docs = t.map((item) => `doc. ${item.document} ${route(item)}${item.date ? " em " + brDate(item.date) : ""}`).join("; ");
        return `• ${d.number} · ${d.summary.material} ${d.summary.description} · ${docs} · parado ${fmtQty(d.summary.idle)} ${d.summary.unit}${d.summary.value !== null ? " (" + fmtMoney(d.summary.value) + ")" : ""} · ${trackLine(d, today)}`;
      }),
      "",
      `Valor parado somado: ${fmtMoney(Math.round(total * 100) / 100)}.`,
    ];
    if (await copyText(lines.join("\n"))) toast.success("Resumo copiado. Cole no e-mail ou no Teams.");
    else toast.error("Não foi possível copiar. Selecione o texto manualmente.");
  }

  const selected = opened ? dossies.find((d) => d.number === opened || d.id === opened) : undefined;
  if (opened && list && selected)
    return (
      <DossieDetail
        key={selected.id}
        id={selected.id}
        canEdit={list.canEdit}
        canDelete={list.canDelete}
        onBack={() => open(null)}
        onChanged={load}
        onDeleted={() => {
          open(null);
          void load();
        }}
      />
    );

  return (
    <section className="shortages panel dossie" aria-label="Dossiê Warehouse">
      <div className="warehouse-heading">
        <div>
          <p className="eyebrow">COBRANÇA AO WAREHOUSE</p>
          <h3>Dossiês de transferência</h3>
          <p>
            Cole a MB51 do material: o portal acha a transferência para o {DEFAULT_TARGET}, mostra quem fez e quando, o que foi consumido
            depois e o valor parado, e monta a cobrança com prazo.
          </p>
        </div>
        <div className="stock-projects-actions">
          {list?.canEdit && (
            <button className="primary" onClick={() => setImporting(true)}>
              <FilePlus2 size={16} />
              Novo dossiê (colar MB51)
            </button>
          )}
          <button disabled={!filtered.length} onClick={() => void copySummary()} title="Texto com todos os dossiês em andamento deste filtro">
            <ClipboardCopy size={16} />
            Copiar resumo
          </button>
          <button disabled={!filtered.length} onClick={() => void exportList().catch((e) => toast.error(errorText(e)))}>
            <FileSpreadsheet size={16} />
            Baixar planilha
          </button>
          <button disabled={loading} onClick={() => void load()} aria-label="Atualizar lista">
            <RefreshCw size={16} className={loading ? "spin" : ""} />
            {loading ? "Lendo…" : "Atualizar"}
          </button>
        </div>
      </div>

      {error && (
        <div role="alert" className="notice danger">
          {error}
          <button onClick={() => void load()}>Tentar novamente</button>
        </div>
      )}
      {opened && list && !selected && (
        <div role="alert" className="notice">
          O dossiê {opened} não está na lista. Ele pode ter sido apagado.
          <button onClick={() => open(null)}>Ver todos</button>
        </div>
      )}
      {!list && !error && (
        <div className="empty" role="status">
          <RefreshCw className="spin" />
          <h3>Carregando os dossiês…</h3>
        </div>
      )}

      {list && (
        <>
          <div className="warehouse-metrics dossie-metrics">
            <article className="metric-return">
              <Clock3 size={19} />
              <span>Aguardando o Warehouse</span>
              <strong>{fmtQty(metrics.waiting)}</strong>
              <small>{metrics.overdue ? `${metrics.overdue} com prazo vencido` : metrics.waiting ? "dentro do prazo" : "nenhuma cobrança pendente"}</small>
            </article>
            <article className="dossie-metric-value">
              <PackageSearch size={19} />
              <span>Valor parado em andamento</span>
              <strong>{fmtMoney(Math.round(metrics.value * 100) / 100)}</strong>
              <small>
                {metrics.active ? `${metrics.active} dossiê(s) em andamento${metrics.valued < metrics.active ? ` · ${metrics.active - metrics.valued} sem preço` : ""}` : "nenhum dossiê em andamento"}
              </small>
            </article>
            <article>
              <span>Não cobrados / respondidos</span>
              <strong>
                {fmtQty(metrics.open)} / {fmtQty(metrics.answered)}
              </strong>
              <small>abertos sem envio · respondidos sem encerrar</small>
            </article>
            <article>
              <CheckCircle2 size={19} />
              <span>Encerrados</span>
              <strong>{fmtQty(metrics.closed)}</strong>
              <small>{metrics.returned ? `${metrics.returned} devolvido(s) ao depósito de origem` : "nenhum encerrado ainda"}</small>
            </article>
          </div>

          <div className="warehouse-filter-panel" role="search" aria-label="Filtros dos dossiês">
            <div className="warehouse-filter-heading">
              <b>Encontre um dossiê</b>
              <button
                className="warehouse-clear-filters"
                disabled={!hasFilters}
                onClick={() => {
                  setQuery("");
                  setStatus("active");
                }}
              >
                Limpar filtros
              </button>
            </div>
            <div className="warehouse-filters dossie-filters">
              <label>
                Busca
                <input aria-label="Buscar dossiês" placeholder="Nº, material, descrição, documento, usuário…" value={query} onChange={(e) => setQuery(e.target.value)} />
              </label>
              <label>
                Situação
                <select aria-label="Situação do dossiê" value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)}>
                  <option value="active">Em andamento</option>
                  <option value="all">Todos</option>
                  <option value="open">Aberto (não cobrado)</option>
                  <option value="sent">Cobrado</option>
                  <option value="late">Prazo vencido</option>
                  <option value="answered">Respondido</option>
                  <option value="closed">Encerrado</option>
                </select>
              </label>
            </div>
            <div className="warehouse-filter-summary" aria-live="polite">
              <span>
                <b>{fmtQty(filtered.length)}</b> de {fmtQty(dossies.length)} dossiê(s)
              </span>
              <span>{list.canEdit ? "Clique num dossiê para abrir" : "Perfil Consulta: ver, copiar e baixar"}</span>
            </div>
          </div>

          {!filtered.length ? (
            <div className="empty">
              <PackageSearch size={30} />
              <h3>{!dossies.length ? "Nenhum dossiê ainda" : hasFilters ? "Nenhum dossiê neste filtro" : "Nenhum dossiê em andamento"}</h3>
              <p>
                {!dossies.length
                  ? list.canEdit
                    ? "Clique em Novo dossiê e cole as linhas da MB51 do material (Lista de documentos de material)."
                    : "Os dossiês abertos aparecem aqui."
                  : hasFilters
                    ? "Ajuste os filtros."
                    : `${metrics.closed} dossiê(s) encerrado(s): escolha Situação “Todos” ou “Encerrado” para ver.`}
              </p>
            </div>
          ) : (
            <div className="dossie-list" role="list" aria-label="Dossiês">
              <div className="dossie-list-head" aria-hidden="true">
                <span>Dossiê</span>
                <span>Material</span>
                <span>Transferência cobrada</span>
                <span>Parado</span>
                <span>Andamento</span>
              </div>
              {filtered.map((d) => (
                <button type="button" role="listitem" key={d.id} className={`dossie-row ${d.status}${late(d.status, d.summary.deadline, today) ? " late" : ""}`} onClick={() => open(d.number)}>
                  <span className="dossie-row-id">
                    <b>{d.number}</b>
                    <em className={`dossie-status ${d.status}`}>{STATUS_LABELS[d.status]}</em>
                  </span>
                  <span className="dossie-row-material">
                    <b>{d.summary.material}</b>
                    <small>{d.summary.description || "Sem descrição"}</small>
                  </span>
                  <span className="dossie-row-transfer">
                    {d.summary.transfers.map((t) => (
                      <small key={t.key}>
                        <b>{route(t)}</b> · doc. {t.document}
                        {t.date ? " · " + brDate(t.date) : ""}
                        {t.user ? " · " + t.user : ""}
                      </small>
                    ))}
                  </span>
                  <span className="dossie-row-value">
                    <b>
                      {fmtQty(d.summary.idle)} {d.summary.unit}
                    </b>
                    <small>{d.summary.value !== null ? fmtMoney(d.summary.value) : "sem preço"}</small>
                  </span>
                  <span className="dossie-row-track">
                    <small>{trackLine(d, today)}</small>
                    {d.fileCount > 0 && <small>{d.fileCount} print(s)</small>}
                  </span>
                </button>
              ))}
            </div>
          )}
        </>
      )}

      {importing && list && (
        <ImportDialog
          existing={dossies}
          onClose={() => setImporting(false)}
          onCreated={(created) => {
            setImporting(false);
            void load().then(() => {
              if (created.length === 1) open(created[0].number);
            });
          }}
        />
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Importar a MB51 → um dossiê por material
// ---------------------------------------------------------------------------

type Candidate = {
  material: string;
  description: string;
  data: DossieData | null;
  inbound: ReturnType<typeof transfersOf>;
  taken: { key: string; number: string }[];
  analysis: ReturnType<typeof analyzeDossie> | null;
  problem: string;
  movements: number;
};

function ImportDialog({ existing, onClose, onCreated }: { existing: DossieListItem[]; onClose: () => void; onCreated: (created: Dossie[]) => void }) {
  const [text, setText] = useState("");
  const [source, setSource] = useState("");
  const [rows, setRows] = useState<unknown[][] | null>(null);
  const [dateOrder, setDateOrder] = useState<DateOrder | "">("");
  const [decimal, setDecimal] = useState<DecimalStyle | "">("");
  const [target, setTarget] = useState(DEFAULT_TARGET);
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const today = todayIso();

  const parsed = useMemo(() => {
    if (!rows) return null;
    try {
      return { ok: parseMb51Rows(rows, { dateOrder: dateOrder || undefined, decimal: decimal || undefined }), error: "" };
    } catch (e) {
      return { ok: null, error: errorText(e) };
    }
  }, [rows, dateOrder, decimal]);
  const taken = useMemo(() => {
    const map = new Map<string, string>();
    for (const d of existing) for (const t of d.summary.transfers) map.set(`${d.summary.material}|${t.key}`, d.number);
    return map;
  }, [existing]);
  const depot = target.trim().toUpperCase();
  const candidates = useMemo<Candidate[]>(() => {
    if (!parsed?.ok || !validDepot(depot)) return [];
    const recipients = readRecipients();
    return groupByMaterial(parsed.ok.movements)
      .map((group) => {
        const inbound = inboundTransfers(transfersOf(group.movements), depot);
        const takenHere = inbound.flatMap((t) => {
          const number = taken.get(`${group.material}|${t.key}`);
          return number ? [{ key: t.key, number }] : [];
        });
        const free = inbound.filter((t) => !takenHere.some((item) => item.key === t.key));
        let data: DossieData | null = null,
          problem = "",
          analysis = null;
        if (!inbound.length) problem = `Nenhuma transferência para o ${depot} nestas linhas.`;
        else if (!free.length) problem = `Já está no ${takenHere.map((item) => item.number).join(", ")}.`;
        else
          try {
            data = sanitizeDossieData({
              material: group.material,
              description: group.description,
              plant: group.plant,
              target: depot,
              movements: group.movements,
              questioned: free.map((t) => t.key),
              manualPrice: null,
              request: "",
              deadline: addBusinessDays(today, 3),
              recipients,
              notes: "",
              stockCheck: null,
              source: source || "MB51 colada",
              importedAt: new Date().toISOString(),
            });
            if (packData(data).length > MAX_DATA_CHARS) throw Error("Lançamentos demais para um dossiê: cole só o período que interessa.");
            analysis = analyzeDossie(data, { today });
          } catch (e) {
            problem = errorText(e);
            data = null;
          }
        return { material: group.material, description: group.description, data, inbound, taken: takenHere, analysis, problem, movements: group.movements.length };
      })
      .sort((a, b) => Number(!!b.data) - Number(!!a.data) || a.material.localeCompare(b.material, "pt-BR", { numeric: true }));
  }, [parsed, depot, taken, source, today]);
  useEffect(() => {
    setPicked(Object.fromEntries(candidates.map((c) => [c.material, !!c.data])));
  }, [candidates]);
  const chosen = candidates.filter((c) => c.data && picked[c.material]);

  function readText() {
    setError("");
    const table = tableFromText(text);
    if (!table.length) return setError("Cole as linhas da MB51 (com a linha de títulos) antes de ler.");
    setSource(`MB51 colada em ${brDate(today)}`);
    setDateOrder("");
    setDecimal("");
    setRows(table);
  }
  async function readFile(file: File | undefined) {
    if (!file) return;
    setError("");
    setBusy("Lendo o arquivo…");
    try {
      const table = await rowsFromFile(file);
      setSource(file.name.slice(0, 120));
      setDateOrder("");
      setDecimal("");
      setRows(table);
    } catch (e) {
      setError("Não consegui ler o arquivo: " + errorText(e));
    } finally {
      setBusy("");
      if (fileInput.current) fileInput.current.value = "";
    }
  }
  async function create() {
    if (!chosen.length) return;
    setBusy("Abrindo os dossiês…");
    setError("");
    const created: Dossie[] = [];
    try {
      for (let i = 0; i < chosen.length; i += CREATE_CHUNK) {
        const result = await api("/api/dossies", { action: "create", items: chosen.slice(i, i + CREATE_CHUNK).map((c) => c.data) });
        created.push(...(result.dossies as Dossie[]));
      }
      toast.success(created.length === 1 ? `${created[0].number} aberto.` : `${created.length} dossiês abertos (${created[0].number} a ${created.at(-1)!.number}).`);
      onCreated(created);
    } catch (e) {
      setError((created.length ? `${created.length} dossiê(s) foram abertos antes do erro. ` : "") + errorText(e));
      if (created.length) onCreated(created);
    } finally {
      setBusy("");
    }
  }

  const info = parsed?.ok;
  return (
    <Dialog open onOpenChange={(value) => !value && !busy && onClose()}>
      <DialogContent className="scrap-dialog dossie-dialog">
        <DialogHeader>
          <DialogTitle>Novo dossiê · colar a MB51</DialogTitle>
          <DialogDescription>Um dossiê por material, com a transferência para o depósito de destino e toda a movimentação colada como prova.</DialogDescription>
        </DialogHeader>

        <section className="scrap-section">
          <div className="scrap-section-head">
            <h4>1. Linhas da MB51</h4>
            <span>Lista de documentos de material do material (centro BR02)</span>
          </div>
          <ol className="dossie-howto">
            <li>
              No layout da MB51, deixe também <b>Data de lançamento</b>, <b>Hora de entrada</b> e <b>Nome do usuário</b>: é o que mostra quem transferiu e quando.
            </li>
            <li>
              Exporte com <b>Exportar ▸ Arquivo local… ▸ Na área de transferência</b> e cole aqui (Ctrl+V). Também vale copiar do Excel com a linha de títulos, ou escolher o arquivo exportado.
            </li>
          </ol>
          <textarea
            className="dossie-paste"
            aria-label="Linhas da MB51"
            placeholder={"Material\tTexto breve material\tDepósito\tTipo de movimento\tQuantidade\tDoc.material\tItem\tData de lançamento…"}
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={7}
            spellCheck={false}
          />
          <div className="scrap-actions">
            <button className="primary" disabled={!text.trim() || !!busy} onClick={readText}>
              <PackageSearch size={16} />
              Ler MB51
            </button>
            <input ref={fileInput} type="file" hidden accept=".xlsx,.xls,.csv,.txt,.tsv,.prn" aria-label="Arquivo da MB51" onChange={(e) => void readFile(e.target.files?.[0])} />
            <button disabled={!!busy} onClick={() => fileInput.current?.click()}>
              <FileSpreadsheet size={16} />
              Escolher arquivo exportado
            </button>
            <label className="dossie-target">
              Depósito de destino
              <input aria-label="Depósito de destino" value={target} maxLength={10} onChange={(e) => setTarget(e.target.value.toUpperCase())} />
            </label>
          </div>
          {busy && (
            <p className="stock-plan-status" role="status">
              <RefreshCw size={14} className="spin" /> {busy}
            </p>
          )}
          {(error || parsed?.error) && (
            <p className="notice danger" role="alert">
              {error || parsed?.error}
            </p>
          )}
          {!validDepot(depot) && <p className="notice">Informe o depósito de destino (ex.: 7000).</p>}
        </section>

        {info && (
          <section className="scrap-section">
            <div className="scrap-section-head">
              <h4>2. Conferir antes de abrir</h4>
              <span>
                {fmtQty(info.movements.length)} lançamento(s) · {fmtQty(candidates.length)} material(is)
                {info.duplicates ? ` · ${info.duplicates} repetido(s) ignorado(s)` : ""}
                {info.ignored ? ` · ${info.ignored} linha(s) de total ignorada(s)` : ""}
              </span>
            </div>
            {info.missing.length > 0 && (
              <p className="notice">
                <TriangleAlert size={16} /> A MB51 não trouxe {info.missing.join(", ")}. O dossiê abre, mas sem mostrar quem e quando. Inclua no layout e cole de novo se puder.
              </p>
            )}
            {info.warnings.map((warning) => (
              <p className="notice" key={warning}>
                {warning}
              </p>
            ))}
            {(info.dateAmbiguous || dateOrder) && (
              <label className="dossie-inline-field">
                As datas estão como
                <select aria-label="Formato das datas" value={dateOrder || info.dateOrder} onChange={(e) => setDateOrder(e.target.value as DateOrder)}>
                  <option value="dmy">dia/mês/ano</option>
                  <option value="mdy">mês/dia/ano</option>
                </select>
              </label>
            )}
            {(info.decimalAmbiguous || decimal) && (
              <label className="dossie-inline-field">
                Os números usam
                <select aria-label="Separador decimal" value={decimal || info.decimal} onChange={(e) => setDecimal(e.target.value as DecimalStyle)}>
                  <option value="comma">vírgula para decimais (1.234,56)</option>
                  <option value="dot">ponto para decimais (1,234.56)</option>
                </select>
              </label>
            )}
            <div className="dossie-candidates" role="list" aria-label="Materiais encontrados">
              {candidates.map((c) => (
                <label key={c.material} role="listitem" className={`dossie-candidate${c.data ? "" : " disabled"}`}>
                  <input
                    type="checkbox"
                    aria-label={`Abrir dossiê de ${c.material}`}
                    disabled={!c.data}
                    checked={!!c.data && !!picked[c.material]}
                    onChange={(e) => setPicked((current) => ({ ...current, [c.material]: e.target.checked }))}
                  />
                  <span className="dossie-candidate-main">
                    <b>{c.material}</b>
                    <small>{c.description || "Sem descrição"}</small>
                    <small>{fmtQty(c.movements)} lançamento(s) colado(s)</small>
                  </span>
                  <span className="dossie-candidate-transfers">
                    {c.analysis?.questioned.map((t) => (
                      <small key={t.key}>
                        <b>
                          {route(t)} · {fmtQty(t.quantity)} {c.analysis!.unit}
                        </b>{" "}
                        · doc. {t.document} ({itemsLabel(t.items)}){t.date ? ` · ${brDate(t.date)}` : ""}
                        {t.user ? ` · ${t.user}` : ""}
                        {t.consumed === 0 ? " · sem consumo depois" : t.consumed ? ` · ${fmtQty(t.consumed)} consumido(s)` : ""}
                      </small>
                    ))}
                    {c.taken.map((item) => (
                      <small key={item.key} className="dossie-taken">
                        doc. {item.key.split("/")[0]} já está no {item.number}
                      </small>
                    ))}
                    {c.problem && <small className="dossie-problem">{c.problem}</small>}
                  </span>
                  <span className="dossie-candidate-value">
                    {c.analysis ? (
                      <>
                        <b>
                          {fmtQty(c.analysis.idle)} {c.analysis.unit} parado(s)
                        </b>
                        <small>{c.analysis.idleValue !== null ? fmtMoney(c.analysis.idleValue) : "sem preço na MB51"}</small>
                      </>
                    ) : null}
                  </span>
                </label>
              ))}
            </div>
          </section>
        )}

        <div className="dialog-actions scrap-footer">
          <button onClick={onClose} disabled={!!busy}>
            Cancelar
          </button>
          <button className="primary" disabled={!chosen.length || !!busy} onClick={() => void create()}>
            <FilePlus2 size={16} />
            {chosen.length > 1 ? `Abrir ${chosen.length} dossiês` : "Abrir dossiê"}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Um dossiê
// ---------------------------------------------------------------------------

type Loaded = { dossie: Dossie; canEdit: boolean; canDelete: boolean };

function DossieDetail({
  id,
  canEdit: listCanEdit,
  canDelete: listCanDelete,
  onBack,
  onChanged,
  onDeleted,
}: {
  id: string;
  canEdit: boolean;
  canDelete: boolean;
  onBack: () => void;
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [bom, setBom] = useState<BomLookup | null>(null);
  const [bomError, setBomError] = useState("");
  const [form, setForm] = useState({ request: "", deadline: "", recipients: "", notes: "" });
  const [answer, setAnswer] = useState({ response: "", responseBy: "", respondedAt: todayIso() });
  const [closing, setClosing] = useState<{ outcome: Outcome | ""; outcomeNote: string; returnDocument: string }>({ outcome: "", outcomeNote: "", returnDocument: "" });
  const [price, setPrice] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [stockPreview, setStockPreview] = useState<StockCheck | null>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const today = todayIso();

  const apply = useCallback((dossie: Dossie, rest?: { canEdit: boolean; canDelete: boolean }) => {
    setLoaded((current) => ({ dossie, canEdit: rest?.canEdit ?? current?.canEdit ?? false, canDelete: rest?.canDelete ?? current?.canDelete ?? false }));
    setForm({ request: dossie.data.request || DEFAULT_REQUEST, deadline: dossie.data.deadline, recipients: dossie.data.recipients, notes: dossie.data.notes });
    setAnswer({ response: dossie.track.response, responseBy: dossie.track.responseBy, respondedAt: dossie.track.respondedAt || todayIso() });
    setClosing({ outcome: dossie.track.outcome, outcomeNote: dossie.track.outcomeNote, returnDocument: dossie.track.returnDocument });
    setPrice(null);
  }, []);
  const load = useCallback(async () => {
    setError("");
    try {
      const result = await api("/api/dossies?id=" + encodeURIComponent(id));
      apply(result.dossie as Dossie, { canEdit: !!result.canEdit, canDelete: !!result.canDelete });
    } catch (e) {
      setError(errorText(e));
    }
  }, [id, apply]);
  useEffect(() => {
    void load();
  }, [load]);
  const material = loaded?.dossie.data.material;
  useEffect(() => {
    if (!material) return;
    let alive = true;
    setBomError("");
    api("/api/dossies?lookup=" + encodeURIComponent(material))
      .then((result) => alive && setBom(result as BomLookup))
      .catch((e) => alive && setBomError(errorText(e)));
    return () => {
      alive = false;
    };
  }, [material]);

  const dossie = loaded?.dossie;
  const analysis = useMemo(() => (dossie ? analyzeDossie(dossie.data, { today, bom }) : null), [dossie, today, bom]);
  const letter = useMemo(
    () => (dossie && analysis ? cobranca({ number: dossie.number, data: dossie.data, track: dossie.track, status: dossie.status, analysis }) : null),
    [dossie, analysis],
  );

  if (error && !dossie)
    return (
      <section className="shortages panel dossie">
        <button className="text-button dossie-back" onClick={onBack}>
          <ArrowLeft size={16} /> Todos os dossiês
        </button>
        <div role="alert" className="notice danger">
          {error}
          <button onClick={() => void load()}>Tentar novamente</button>
        </div>
      </section>
    );
  if (!dossie || !analysis || !letter)
    return (
      <section className="shortages panel dossie">
        <div className="empty" role="status">
          <RefreshCw className="spin" />
          <h3>Abrindo o dossiê…</h3>
        </div>
      </section>
    );

  const canEdit = (loaded?.canEdit ?? listCanEdit) && dossie.status !== "closed";
  const canWrite = loaded?.canEdit ?? listCanEdit;
  const canRemove = (loaded?.canDelete ?? listCanDelete) || (canWrite && dossie.status === "open" && !dossie.track.sentAt && !dossie.files.length);
  const d = dossie.data;
  const unit = analysis.unit;
  const u = unit ? " " + unit : "";
  const formChanged =
    form.request.trim() !== (d.request || DEFAULT_REQUEST).trim() || form.deadline !== d.deadline || form.recipients.trim() !== d.recipients || form.notes.trim() !== d.notes;
  const overdue = late(dossie.status, d.deadline, today) ? daysBetween(d.deadline, today) : null;
  const stock = d.stockCheck || stockPreview;

  async function run<T>(label: string, task: () => Promise<T>, success?: string) {
    setBusy(label);
    try {
      const result = await task();
      if (success) toast.success(success);
      return result;
    } catch (e) {
      toast.error(errorText(e));
      if (isConflict(e)) void load();
      return undefined;
    } finally {
      setBusy("");
    }
  }
  async function act(label: string, body: Record<string, unknown>, success: string) {
    const result = await run(label, () => api("/api/dossies", { ...body, id: dossie!.id, revision: dossie!.revision }), success);
    if (result?.dossie) {
      apply(result.dossie as Dossie);
      onChanged();
    }
    return result;
  }
  const update = (data: Partial<DossieData>, label: string, success: string) => act(label, { action: "update", data: { ...dossie.data, ...data } }, success);

  async function copyLetter() {
    if (await copyText(`${letter!.subject}\n\n${letter!.text}`)) toast.success("Cobrança copiada. Cole no e-mail ou no Teams.");
    else toast.error("Não foi possível copiar. Selecione o texto da cobrança manualmente.");
  }
  async function makePdf() {
    const { buildDossiePdf } = await import("@/lib/dossie-pdf");
    const images: { name: string; type: string; bytes: Uint8Array }[] = [];
    for (const file of dossie!.files) {
      const response = await fetch(`/api/dossies?file=${encodeURIComponent(file.id)}&dossie=${encodeURIComponent(dossie!.id)}`);
      if (response.ok) images.push({ name: file.name, type: file.type, bytes: new Uint8Array(await response.arrayBuffer()) });
    }
    return buildDossiePdf({ number: dossie!.number, status: dossie!.status, data: dossie!.data, track: dossie!.track, analysis: analysis!, letter: letter!, images, generatedAt: new Date() });
  }
  async function downloadPdf() {
    const bytes = await run("Gerando o PDF…", makePdf);
    if (bytes) download(new Blob([bytes.slice().buffer as ArrayBuffer], { type: "application/pdf" }), `${dossie!.number} ${d.material}.pdf`.replace(/[\\/:*?"<>|]+/g, "-"));
  }
  async function emailWithPdf() {
    const bytes = await run("Gerando o PDF…", makePdf);
    if (!bytes) return;
    download(new Blob([bytes.slice().buffer as ArrayBuffer], { type: "application/pdf" }), `${dossie!.number} ${d.material}.pdf`.replace(/[\\/:*?"<>|]+/g, "-"));
    const to = d.recipients.replace(/[;\s]+/g, ",").replace(/^,|,$/g, "");
    let body = letter!.text + "\n\n(O dossiê em PDF segue anexo.)";
    let href = `mailto:${encodeURIComponent(to).replace(/%2C/g, ",").replace(/%40/g, "@")}?subject=${encodeURIComponent(letter!.subject)}&body=${encodeURIComponent(body)}`;
    if (href.length > 1900) {
      // Alguns programas cortam links longos: o texto completo vai para a área de transferência.
      await copyText(letter!.text);
      body = `Segue o dossiê ${dossie!.number} em anexo (PDF).\n\n[Cole aqui o texto da cobrança: ele já foi copiado.]`;
      href = `mailto:${encodeURIComponent(to).replace(/%2C/g, ",").replace(/%40/g, "@")}?subject=${encodeURIComponent(letter!.subject)}&body=${encodeURIComponent(body)}`;
      toast.message("O PDF foi baixado e o texto da cobrança foi copiado: anexe o PDF e cole o texto no e-mail.");
    } else toast.message("O PDF foi baixado: anexe ao e-mail que abriu.");
    location.href = href;
  }
  async function checkStock() {
    const depots = [...new Set([...analysis!.questioned.flatMap((t) => [t.to, t.from]), d.target])].filter((depot) => !!stockModule(depot));
    if (!depots.length) return toast.error("Os depósitos deste dossiê não têm aba de saldo no portal (7000, 2000, 1500).");
    const result = await run(`Lendo ${depots.join(" e ")} na planilha…`, () => readStock(d.material, depots));
    if (!result) return;
    if (canEdit) await update({ stockCheck: result }, "Salvando o saldo…", "Saldo atual guardado no dossiê.");
    else setStockPreview(result);
  }
  async function addImage(file: Blob | null | undefined, name: string) {
    if (!file) return;
    if (!/^image\/(png|jpeg)$/.test(file.type)) return toast.error("Anexe um print em PNG ou JPG.");
    const blob = await run("Preparando o print…", () => fitImage(file));
    if (!blob) return;
    const data = await toBase64(blob);
    await act("Anexando o print…", { action: "file", name: blob === file ? name : name.replace(/\.\w+$/, "") + ".jpg", data }, "Print anexado.");
  }
  function onPaste(event: ReactClipboardEvent) {
    const item = Array.from({ length: event.clipboardData.items.length }, (_, i) => event.clipboardData.items[i]).find((entry) => entry.kind === "file" && /^image\/(png|jpeg)$/.test(entry.type));
    if (!item) return;
    event.preventDefault();
    void addImage(item.getAsFile(), `print-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.png`);
  }
  function toggleQuestioned(key: string, on: boolean) {
    const next = on ? [...new Set([...d.questioned, key])] : d.questioned.filter((item) => item !== key);
    if (!next.length) return toast.error("O dossiê precisa de pelo menos uma transferência cobrada.");
    void update({ questioned: next }, "Salvando…", on ? "Transferência incluída na cobrança." : "Transferência retirada da cobrança.");
  }
  async function savePrice() {
    const raw = (price || "").trim().replace(/\./g, "").replace(",", ".");
    const value = raw === "" ? null : Number(raw);
    if (value !== null && (!Number.isFinite(value) || value < 0)) return toast.error("Preço inválido. Use, por exemplo, 10,49.");
    await update({ manualPrice: value }, "Salvando o preço…", value === null ? "Voltou ao preço automático." : "Preço salvo.");
  }
  async function saveForm() {
    saveRecipients(form.recipients.trim());
    await update(
      { request: form.request.trim() === DEFAULT_REQUEST.trim() ? "" : form.request, deadline: form.deadline, recipients: form.recipients, notes: form.notes },
      "Salvando…",
      "Cobrança atualizada.",
    );
  }

  const transfers = analysis.transfers;
  const questionedKeys = new Set(d.questioned);
  const highlight = new Set(analysis.questioned.flatMap((t) => t.lines));
  const count = sentCount(dossie.track);

  return (
    <section className="shortages panel dossie dossie-detail" aria-label={`Dossiê ${dossie.number}`} onPaste={canEdit ? onPaste : undefined}>
      <button className="text-button dossie-back" onClick={onBack}>
        <ArrowLeft size={16} /> Todos os dossiês
      </button>
      <div className="dossie-head">
        <div>
          <p className="eyebrow">
            {dossie.number} · aberto em {brDate(isoDay(dossie.createdAt))}
          </p>
          <h3>
            {d.material} <span>{d.description}</span>
          </h3>
          <p className="dossie-head-status">
            <em className={`dossie-status ${dossie.status}`}>{STATUS_LABELS[dossie.status]}</em>
            {count > 0 && <span>{count === 1 ? "cobrado 1 vez" : `cobrado ${count} vezes`}</span>}
            {d.deadline && dossie.status !== "closed" && <span className={overdue ? "dossie-late" : ""}>{overdue ? `prazo vencido há ${overdue} dia(s)` : `prazo ${brDate(d.deadline)}`}</span>}
            {dossie.status === "closed" && dossie.track.outcome && <span>{OUTCOME_LABELS[dossie.track.outcome]}</span>}
          </p>
        </div>
        <div className="stock-projects-actions dossie-actions">
          <button onClick={() => void copyLetter()} disabled={!!busy}>
            <ClipboardCopy size={16} />
            Copiar cobrança
          </button>
          <button onClick={() => void emailWithPdf()} disabled={!!busy} title="Baixa o PDF e abre o e-mail com o texto">
            <Mail size={16} />
            E-mail com PDF
          </button>
          <button onClick={() => void downloadPdf()} disabled={!!busy}>
            <FileDown size={16} />
            Baixar PDF
          </button>
          {canEdit && (
            <button className="primary" disabled={!!busy} onClick={() => void act("Registrando…", { action: "send" }, count ? `${count + 1}ª cobrança registrada.` : "Cobrança registrada.")}>
              <Send size={16} />
              {count ? "Registrar nova cobrança" : "Marcar como cobrado"}
            </button>
          )}
          {canWrite && dossie.status === "closed" && (
            <button disabled={!!busy} onClick={() => void act("Reabrindo…", { action: "reopen" }, "Dossiê reaberto.")}>
              <Undo2 size={16} />
              Reabrir
            </button>
          )}
          {canRemove && (
            <button className="dossie-delete" disabled={!!busy} onClick={() => setConfirmDelete(true)}>
              <Trash2 size={16} />
              Apagar
            </button>
          )}
        </div>
      </div>
      {busy && (
        <p className="stock-plan-status" role="status">
          <RefreshCw size={14} className="spin" /> {busy}
        </p>
      )}

      <div className="dossie-grid">
        <div className="dossie-main">
          <section className="scrap-section dossie-questioned" aria-label="Transferência cobrada">
            <div className="scrap-section-head">
              <h4>{analysis.questioned.length > 1 ? "Transferências cobradas" : "Transferência cobrada"}</h4>
              <span>{analysis.questioned.length ? `${fmtQty(analysis.transferred)}${u} transferido(s)` : "nenhuma marcada"}</span>
            </div>
            {analysis.questioned.map((t) => (
              <article key={t.key} className="dossie-transfer-card">
                <div className="dossie-route">
                  <b>{t.from || "?"}</b>
                  <span aria-hidden="true">→</span>
                  <b>{t.to || "?"}</b>
                  <strong>
                    {fmtQty(t.quantity)}
                    {u}
                  </strong>
                </div>
                <dl>
                  <div>
                    <dt>Documento</dt>
                    <dd>
                      {t.document} · {itemsLabel(t.items)} · TMv {t.type}
                    </dd>
                  </div>
                  <div>
                    <dt>Lançado</dt>
                    <dd>{t.date ? `${brDate(t.date)}${t.time ? " às " + t.time.slice(0, 5) : ""}` : "sem data na MB51"}</dd>
                  </div>
                  <div>
                    <dt>Usuário</dt>
                    <dd>{t.user || "sem usuário na MB51"}</dd>
                  </div>
                  <div>
                    <dt>Texto no documento</dt>
                    <dd className={t.headerText || t.itemText ? "" : "dossie-late"}>{[t.headerText, t.itemText].filter(Boolean).join(" / ") || "nenhum"}</dd>
                  </div>
                </dl>
                {t.idle !== null && (
                  <div className="dossie-after" aria-label="Depois da transferência">
                    <span>
                      Consumido
                      <b>{fmtQty(t.consumed)}</b>
                    </span>
                    <span>
                      Saiu do {t.to}
                      <b>{fmtQty(t.transferredOut)}</b>
                    </span>
                    <span>
                      Sucata/outros
                      <b>{fmtQty((t.scrapped || 0) + (t.other || 0))}</b>
                    </span>
                    <span className={t.idle > 0 ? "idle" : "ok"}>
                      Parado no {t.to}
                      <b>
                        {fmtQty(t.idle)}
                        {u}
                      </b>
                      {t.idle > 0 && analysis.unitPrice !== null && <small>{fmtMoney(Math.round(t.idle * analysis.unitPrice * 100) / 100)}</small>}
                      {t.days !== null && t.days >= 0 && <small>há {t.days} dia(s)</small>}
                    </span>
                  </div>
                )}
              </article>
            ))}
          </section>

          <section className="scrap-section" aria-label="Constatações">
            <div className="scrap-section-head">
              <h4>Constatações</h4>
              <span>{bom ? `${bom.checked} BOM(s) do portal conferida(s)` : bomError ? "BOMs não conferidas" : "conferindo as BOMs…"}</span>
            </div>
            <ul className="dossie-findings">
              {analysis.findings.map((finding, index) => (
                <li key={index} className={finding.tone}>
                  {finding.tone === "alert" ? <TriangleAlert size={15} /> : finding.tone === "ok" ? <CheckCircle2 size={15} /> : <MessageSquare size={15} />}
                  <span>{finding.text}</span>
                </li>
              ))}
              {bomError && (
                <li className="info">
                  <TriangleAlert size={15} />
                  <span>Não consegui conferir as BOMs: {bomError}</span>
                </li>
              )}
            </ul>
          </section>

          <section className="scrap-section" aria-label="Saldos e valor">
            <div className="scrap-section-head">
              <h4>Saldos e valor</h4>
              <button disabled={!!busy} onClick={() => void checkStock()} title="Lê as abas de saldo da planilha (7000, 2000, 1500)">
                <RefreshCw size={14} />
                Conferir saldo atual na planilha
              </button>
            </div>
            <div className="dossie-table-wrap">
              <table className="dossie-table">
                <thead>
                  <tr>
                    <th>Depósito</th>
                    <th className="num">Pelos lançamentos colados</th>
                    <th className="num">Na planilha {stock ? `(${brDate(isoDay(stock.readAt))})` : ""}</th>
                    <th className="num">Valor na planilha</th>
                  </tr>
                </thead>
                <tbody>
                  {[...new Set([...analysis.balances.map((b) => b.depot), ...(stock?.depots.map((s) => s.depot) || [])])].sort().map((depot) => {
                    const balance = analysis.balances.find((b) => b.depot === depot);
                    const sheet = stock?.depots.find((s) => s.depot === depot);
                    return (
                      <tr key={depot} className={depot === d.target ? "target" : ""}>
                        <td>{depot}</td>
                        <td className="num">{balance ? `${fmtQty(balance.quantity)}${u}` : "—"}</td>
                        <td className="num">{sheet ? (sheet.found ? `${fmtQty(sheet.quantity)} ${sheet.unit || unit}` : "sem saldo") : "—"}</td>
                        <td className="num">{sheet?.found ? fmtMoney(sheet.value) : "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="dossie-note">
              O saldo pelos lançamentos considera só as linhas coladas (não substitui a MB52). Consumo, devolução e sucata abatem primeiro a entrada mais antiga do depósito.
            </p>
            <div className="dossie-price">
              <span>
                Preço unitário: <b>{analysis.unitPrice !== null ? fmtMoney(analysis.unitPrice) + (unit ? "/" + unit : "") : "sem preço"}</b>
                {analysis.priceNote && <small> ({analysis.priceNote})</small>}
                {analysis.idleValue !== null && (
                  <>
                    {" "}
                    · valor parado <b>{fmtMoney(analysis.idleValue)}</b>
                  </>
                )}
              </span>
              {canEdit &&
                (price === null ? (
                  <button className="text-button" onClick={() => setPrice(d.manualPrice !== null ? String(d.manualPrice).replace(".", ",") : "")}>
                    Alterar preço
                  </button>
                ) : (
                  <span className="dossie-price-edit">
                    <input aria-label="Preço unitário" inputMode="decimal" placeholder="ex.: 10,49 (vazio = automático)" value={price} onChange={(e) => setPrice(e.target.value)} />
                    <button disabled={!!busy} onClick={() => void savePrice()}>
                      Salvar preço
                    </button>
                    <button className="text-button" onClick={() => setPrice(null)}>
                      Cancelar
                    </button>
                  </span>
                ))}
            </div>
          </section>

          <section className="scrap-section" aria-label="Transferências encontradas">
            <div className="scrap-section-head">
              <h4>Transferências na MB51</h4>
              <span>{canEdit ? "marque as que entram na cobrança" : `${transfers.length} transferência(s)`}</span>
            </div>
            <div className="dossie-table-wrap">
              <table className="dossie-table">
                <thead>
                  <tr>
                    <th>Cobrar</th>
                    <th>Documento</th>
                    <th>De → para</th>
                    <th className="num">Qtd</th>
                    <th>Data</th>
                    <th>Usuário</th>
                    <th>Texto</th>
                  </tr>
                </thead>
                <tbody>
                  {transfers.map((t) => (
                    <tr key={t.key} className={questionedKeys.has(t.key) ? "questioned" : ""}>
                      <td>
                        <input
                          type="checkbox"
                          aria-label={`Cobrar a transferência ${t.document}`}
                          checked={questionedKeys.has(t.key)}
                          disabled={!canEdit || !!busy}
                          onChange={(e) => toggleQuestioned(t.key, e.target.checked)}
                        />
                      </td>
                      <td>
                        {t.document} <small>({itemsLabel(t.items)} · {t.type})</small>
                      </td>
                      <td>{route(t)}</td>
                      <td className="num">{fmtQty(t.quantity)}</td>
                      <td>{t.date ? brDate(t.date) + (t.time ? " " + t.time.slice(0, 5) : "") : "—"}</td>
                      <td>{t.user || "—"}</td>
                      <td>{[t.headerText, t.itemText].filter(Boolean).join(" / ") || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="scrap-section" aria-label="Lançamentos da MB51">
            <div className="scrap-section-head">
              <h4>Lançamentos da MB51 ({analysis.ordered.length})</h4>
              {canEdit && (
                <button disabled={!!busy} onClick={() => setAdding(true)}>
                  <Plus size={14} />
                  Colar mais lançamentos
                </button>
              )}
            </div>
            <div className="dossie-table-wrap">
              <table className="dossie-table dossie-movements">
                <thead>
                  <tr>
                    <th>Data</th>
                    <th>Documento</th>
                    <th>TMv</th>
                    <th>Depósito</th>
                    <th className="num">Qtd</th>
                    <th className="num">Valor</th>
                    <th>Usuário</th>
                    <th>Texto</th>
                  </tr>
                </thead>
                <tbody>
                  {[...analysis.ordered].reverse().map((m, index) => (
                    <tr key={`${movementKey(m)}#${index}`} className={highlight.has(m) ? "questioned" : ""}>
                      <td>{brDate(m.entryDate || m.postingDate) || "—"}</td>
                      <td>
                        {m.document}
                        {m.item ? <small> / {m.item}</small> : null}
                      </td>
                      <td title={typeLabel(m)}>
                        {m.type} <small>{typeLabel(m)}</small>
                      </td>
                      <td>{m.depot || "—"}</td>
                      <td className={`num ${(m.quantity || 0) < 0 ? "neg" : "pos"}`}>{fmtQty(m.quantity)}</td>
                      <td className="num">{m.amount ? fmtMoney(m.amount) : "—"}</td>
                      <td>{m.user || "—"}</td>
                      <td>{[m.headerText, m.itemText].filter(Boolean).join(" / ") || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="dossie-note">Fonte: {d.source || "MB51"}. As linhas em destaque são a transferência cobrada.</p>
          </section>
        </div>

        <aside className="dossie-side">
          <section className="scrap-section" aria-label="Pedido ao Warehouse">
            <div className="scrap-section-head">
              <h4>Pedido ao Warehouse</h4>
            </div>
            <label>
              O que pedimos
              <textarea aria-label="Pedido ao Warehouse" rows={5} disabled={!canEdit} value={form.request} onChange={(e) => setForm({ ...form, request: e.target.value })} />
            </label>
            <div className="dossie-two">
              <label>
                Prazo para resposta
                <input type="date" aria-label="Prazo para resposta" disabled={!canEdit} value={form.deadline} onChange={(e) => setForm({ ...form, deadline: e.target.value })} />
              </label>
              <label>
                E-mail do Warehouse
                <input aria-label="Destinatários" disabled={!canEdit} placeholder="nome@byd.com; outro@byd.com" value={form.recipients} onChange={(e) => setForm({ ...form, recipients: e.target.value })} />
              </label>
            </div>
            <label>
              Observações internas (não vão na cobrança)
              <textarea aria-label="Observações internas" rows={2} disabled={!canEdit} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
            </label>
            {canEdit && (
              <button disabled={!formChanged || !!busy} onClick={() => void saveForm()}>
                Salvar pedido
              </button>
            )}
          </section>

          <section className="scrap-section dossie-letter" aria-label="Texto da cobrança">
            <div className="scrap-section-head">
              <h4>Texto da cobrança</h4>
              <button className="text-button" onClick={() => void copyLetter()}>
                <ClipboardCopy size={14} /> Copiar
              </button>
            </div>
            <p className="dossie-subject">{letter.subject}</p>
            <pre>{letter.text}</pre>
          </section>

          <section className="scrap-section" aria-label="Resposta do Warehouse">
            <div className="scrap-section-head">
              <h4>Resposta do Warehouse</h4>
              {dossie.track.respondedAt && <span>{brDate(dossie.track.respondedAt)}</span>}
            </div>
            {canEdit ? (
              <>
                <label>
                  Resposta (cole o e-mail ou resuma)
                  <textarea aria-label="Resposta do Warehouse" rows={4} value={answer.response} onChange={(e) => setAnswer({ ...answer, response: e.target.value })} />
                </label>
                <div className="dossie-two">
                  <label>
                    Quem respondeu
                    <input aria-label="Quem respondeu" value={answer.responseBy} onChange={(e) => setAnswer({ ...answer, responseBy: e.target.value })} />
                  </label>
                  <label>
                    Data da resposta
                    <input type="date" aria-label="Data da resposta" value={answer.respondedAt} onChange={(e) => setAnswer({ ...answer, respondedAt: e.target.value })} />
                  </label>
                </div>
                <button
                  disabled={!answer.response.trim() || !!busy}
                  onClick={() => void act("Registrando a resposta…", { action: "answer", ...answer }, "Resposta registrada.")}
                >
                  <MessageSquare size={14} />
                  {dossie.track.response ? "Salvar resposta" : "Registrar resposta"}
                </button>
              </>
            ) : dossie.track.response ? (
              <>
                <pre className="dossie-response">{dossie.track.response}</pre>
                {dossie.track.responseBy && <small>Por {dossie.track.responseBy}</small>}
              </>
            ) : (
              <p className="dossie-note">Sem resposta registrada.</p>
            )}
          </section>

          <section className="scrap-section" aria-label="Encerramento">
            <div className="scrap-section-head">
              <h4>{dossie.status === "closed" ? "Encerrado" : "Encerrar"}</h4>
              {dossie.track.closedAt && <span>{brDate(isoDay(dossie.track.closedAt))}</span>}
            </div>
            {dossie.status === "closed" ? (
              <>
                <p>
                  <b>{dossie.track.outcome ? OUTCOME_LABELS[dossie.track.outcome] : "Encerrado"}</b>
                  {dossie.track.returnDocument ? ` · doc. ${dossie.track.returnDocument}` : ""}
                </p>
                {dossie.track.outcomeNote && <pre className="dossie-response">{dossie.track.outcomeNote}</pre>}
              </>
            ) : canEdit ? (
              <>
                <label>
                  Como foi resolvido
                  <select aria-label="Como foi resolvido" value={closing.outcome} onChange={(e) => setClosing({ ...closing, outcome: e.target.value as Outcome })}>
                    <option value="">Escolha…</option>
                    {OUTCOMES.map((outcome) => (
                      <option key={outcome} value={outcome}>
                        {OUTCOME_LABELS[outcome]}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Documento SAP (devolução, estorno ou baixa)
                  <input aria-label="Documento SAP" value={closing.returnDocument} onChange={(e) => setClosing({ ...closing, returnDocument: e.target.value })} />
                </label>
                <label>
                  Observação
                  <textarea aria-label="Observação do encerramento" rows={2} value={closing.outcomeNote} onChange={(e) => setClosing({ ...closing, outcomeNote: e.target.value })} />
                </label>
                <button disabled={!closing.outcome || !!busy} onClick={() => void act("Encerrando…", { action: "close", ...closing }, "Dossiê encerrado.")}>
                  <CheckCircle2 size={14} />
                  Encerrar dossiê
                </button>
              </>
            ) : (
              <p className="dossie-note">Em andamento.</p>
            )}
          </section>

          <section className="scrap-section" aria-label="Prints">
            <div className="scrap-section-head">
              <h4>Prints ({dossie.files.length}/{MAX_FILES})</h4>
              {canEdit && dossie.files.length < MAX_FILES && (
                <button disabled={!!busy} onClick={() => imageInput.current?.click()}>
                  <ImagePlus size={14} />
                  Anexar
                </button>
              )}
            </div>
            <input
              ref={imageInput}
              type="file"
              hidden
              accept="image/png,image/jpeg"
              aria-label="Print da tela"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void addImage(file, file.name);
                e.target.value = "";
              }}
            />
            {canEdit && dossie.files.length < MAX_FILES && <p className="dossie-note">Dica: com a tela do dossiê aberta, cole um print com Ctrl+V.</p>}
            <div className="dossie-prints">
              {dossie.files.map((file) => {
                const src = `/api/dossies?file=${encodeURIComponent(file.id)}&dossie=${encodeURIComponent(dossie.id)}`;
                return (
                  <figure key={file.id}>
                    <a href={src} target="_blank" rel="noreferrer">
                      <img src={src} alt={file.name} loading="lazy" />
                    </a>
                    <figcaption>
                      <span>{file.name}</span>
                      {canEdit && (
                        <button className="text-button" aria-label={`Remover ${file.name}`} disabled={!!busy} onClick={() => void act("Removendo…", { action: "file-delete", fileId: file.id }, "Print removido.")}>
                          <X size={14} />
                        </button>
                      )}
                    </figcaption>
                  </figure>
                );
              })}
            </div>
          </section>

          <section className="scrap-section" aria-label="Histórico">
            <div className="scrap-section-head">
              <h4>Histórico</h4>
            </div>
            <ol className="dossie-log">
              {[...dossie.track.log].reverse().map((entry, index) => (
                <li key={index}>
                  <time>{new Date(entry.at).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}</time>
                  <span>
                    {entry.text}
                    {entry.role ? <small> · {entry.role}</small> : null}
                  </span>
                </li>
              ))}
            </ol>
          </section>
        </aside>
      </div>

      {adding && (
        <AddLinesDialog
          material={d.material}
          current={d.movements}
          onClose={() => setAdding(false)}
          onAdd={async (movements, added) => {
            const result = await update({ movements }, "Salvando os lançamentos…", `${added} lançamento(s) incluído(s).`);
            if (result) setAdding(false);
          }}
        />
      )}
      {confirmDelete && (
        <Dialog open onOpenChange={(value) => !value && setConfirmDelete(false)}>
          <DialogContent className="scrap-dialog dossie-confirm">
            <DialogHeader>
              <DialogTitle>Apagar {dossie.number}?</DialogTitle>
              <DialogDescription>O dossiê, o histórico e os prints saem do portal. O número {dossie.number} não volta a ser usado.</DialogDescription>
            </DialogHeader>
            <div className="dialog-actions">
              <button onClick={() => setConfirmDelete(false)}>Cancelar</button>
              <button
                className="primary"
                disabled={!!busy}
                onClick={async () => {
                  const result = await run("Apagando…", () => api("/api/dossies", { action: "delete", id: dossie.id, revision: dossie.revision }), `${dossie.number} apagado.`);
                  setConfirmDelete(false);
                  if (result) onDeleted();
                }}
              >
                <Trash2 size={16} />
                Apagar
              </button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </section>
  );
}

function AddLinesDialog({
  material,
  current,
  onClose,
  onAdd,
}: {
  material: string;
  current: Movement[];
  onClose: () => void;
  onAdd: (movements: Movement[], added: number) => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function add() {
    setError("");
    try {
      const parsed = parseMb51Rows(tableFromText(text));
      const group = groupByMaterial(parsed.movements).find((item) => item.material === material);
      if (!group) throw Error(`As linhas coladas não têm o material ${material}.`);
      const merged = mergeMovements(current, group.movements);
      if (!merged.added) throw Error("Todos esses lançamentos já estão no dossiê.");
      setBusy(true);
      await onAdd(merged.movements, merged.added);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open onOpenChange={(value) => !value && !busy && onClose()}>
      <DialogContent className="scrap-dialog dossie-confirm">
        <DialogHeader>
          <DialogTitle>Colar mais lançamentos de {material}</DialogTitle>
          <DialogDescription>Use para trazer o que aconteceu depois (consumo, devolução). Documentos já guardados não se repetem.</DialogDescription>
        </DialogHeader>
        <textarea className="dossie-paste" aria-label="Novas linhas da MB51" rows={8} spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} />
        {error && (
          <p className="notice danger" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button onClick={onClose} disabled={busy}>
            Cancelar
          </button>
          <button className="primary" disabled={!text.trim() || busy} onClick={() => void add()}>
            <Plus size={16} />
            Incluir lançamentos
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
