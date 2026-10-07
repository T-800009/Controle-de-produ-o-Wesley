import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import {
  CheckCircle2,
  Clock3,
  Copy,
  Download,
  Eye,
  FilePlus2,
  FileSearch,
  FileSpreadsheet,
  FileText,
  Link2,
  ListPlus,
  Mail,
  Paperclip,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Send,
  Share2,
  ShieldAlert,
  Trash2,
  TriangleAlert,
  Upload,
  X,
  XCircle,
} from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { requestJson } from "@/lib/api";
import {
  CAUSES,
  CC_SLOTS,
  MAX_ITEMS,
  MAX_PDF_BYTES,
  SLOTS,
  brDate,
  brDateTime,
  brMoney,
  defaultApprovers,
  emptyForm,
  emptyItem,
  formHistory,
  accepted,
  acceptOriginal,
  acceptAttached,
  formTotal,
  isTranscription,
  itemTotal,
  materialCode,
  parseBrNumber,
  pdfFileName,
  pdfProblems,
  requiredSlots,
  signatureProgress,
  slotById,
  strongestClass,
  summarizeForms,
  type DocKind,
  type ScrapForm,
  type ScrapFormData,
  type ScrapItem,
  type ScrapSignature,
} from "@/lib/scrap-form";
import {
  CC_DEFAULTS,
  MAX_CC_ITEMS,
  ccFileName,
  ccFromScrapForms,
  ccFromSpreadsheet,
  ccItemTotal,
  ccLayout,
  ccProblems,
  ccTotals,
  emptyCcForm,
  emptyCcItem,
  periodLabel,
  summarizeCcForms,
  type CcDefaults,
  type CcForm,
  type CcFormData,
  type CcItem,
} from "@/lib/cc-form";
import type { ScrapPdfReading } from "@/lib/scrap-pdf";
import type { LegacyDocument } from "@/lib/legacy-import";
import { portalOutdated } from "./update-banner";
import { buildEml, emailFileName, formEmail } from "@/lib/form-email";

const pdfTools = () => import("@/lib/scrap-pdf");
/** Aba com código antigo: recarrega na versão nova e gera o PDF lá (o rascunho já está salvo). */
const reloadToGenerate = (kind: DocKind, id: string) => location.assign(`${location.pathname}?modulo=baixas&${kind}=${id}&gerar=1`);

const APPROVERS_KEY = "wbyd:scrap:responsaveis";
const CC_APPROVERS_KEY = "wbyd:cc:responsaveis";
const CC_DEFAULTS_KEY = "wbyd:cc:padrao";
/** Nome que assina os e-mails (Atenciosamente, …). */
const SENDER_KEY = "wbyd:email:nome";
const EMAIL_KEY = {
  scrap: { signing: "wbyd:scrap:email-assinatura", signed: "wbyd:scrap:email-final" },
  cc: { signing: "wbyd:cc:email-assinatura", signed: "wbyd:cc:email-final" },
} as const;
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
      localStorage.setItem(key, value);
    } catch {
      // Navegador sem armazenamento: só não lembra.
    }
  },
  json<T>(key: string): Partial<T> | null {
    try {
      const value = JSON.parse(this.get(key) || "null");
      return value && typeof value === "object" ? value : null;
    } catch {
      return null;
    }
  },
};

type AnyForm = ScrapForm | CcForm;
type Lookup = { description: string; unit: string; boms: { bom: string; classification: string; description: string }[] };
type Mm60 = Map<string, { price: number; description: string }>;
type ListResponse<F> = { forms: F[]; canEdit: boolean; canDelete: boolean; role: string };
type Review = {
  name: string;
  bytes: Uint8Array;
  reading: ScrapPdfReading;
  notes: string[];
};
type Message = { kind: "ok" | "error"; text: string };

const STATUS_LABEL: Record<ScrapForm["status"], string> = { draft: "Rascunho", signing: "Aguardando assinatura", signed: "Assinado" };
const fmt = (value: number) => value.toLocaleString("pt-BR");
const moneyInput = (value: number | null) =>
  value === null ? "" : value.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qtyInput = (value: number | null) => (value === null ? "" : value.toLocaleString("pt-BR", { maximumFractionDigits: 3 }));
/** Custo unitário da baixa: pode vir da planilha com mais de 2 casas (média do SAP). */
const costInput = (value: number | null) =>
  value === null ? "" : value.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 6 });
const unitCostText = (value: number | null) =>
  value === null ? "" : value.toLocaleString("pt-BR", { style: "currency", currency: "BRL", minimumFractionDigits: 2, maximumFractionDigits: 4 });

function toBase64(bytes: Uint8Array) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
function saveFile(bytes: Uint8Array, name: string, type = "application/pdf") {
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
async function fetchPdf(form: AnyForm, version = form.fileVersion) {
  const response = await fetch(`/api/scrap-forms?file=${encodeURIComponent(form.id)}&version=${version}`, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) {
    let message = "Não foi possível baixar o PDF.";
    try {
      message = ((await response.json()) as { error?: string }).error || message;
    } catch {
      // Resposta sem JSON.
    }
    throw Error(message);
  }
  return new Uint8Array(await response.arrayBuffer());
}
/** Mesma rota para os dois documentos: o FO.FI.C.007 vai com doc: "cc". */
function api<F extends AnyForm = ScrapForm>(body: Record<string, unknown>, kind: DocKind = "scrap") {
  return requestJson("/api/scrap-forms", kind === "cc" ? { ...body, doc: "cc" } : body, 60_000) as Promise<{ form: F }>;
}
const progressOf = (kind: DocKind, form: Pick<AnyForm, "data" | "signatures">) => signatureProgress(form.data, form.signatures, kind);
const fileNameOf = (kind: DocKind, form: AnyForm) => (kind === "cc" ? ccFileName(form as CcForm) : pdfFileName(form as ScrapForm));
const formLink = (kind: DocKind, form: AnyForm) => {
  try {
    return `${location.origin}/?modulo=baixas&${kind}=${form.id}`;
  } catch {
    return "";
  }
};
async function loadMm60(): Promise<Mm60> {
  const response = await fetch("/api/ana-source?sheet=MM60", { signal: AbortSignal.timeout(30_000) });
  const text = await response.text();
  if (!response.ok) {
    let error = "Não foi possível ler a MM60.";
    try {
      error = JSON.parse(text).error || error;
    } catch {
      // Texto simples.
    }
    throw Error(error);
  }
  const [{ decodeAnaSource }, { mm60Prices }] = await Promise.all([import("@/lib/ana-client"), import("@/lib/scrap-mm60")]);
  return mm60Prices(decodeAnaSource(text, response.headers.get("X-Source-Format"), "MM60"));
}
/** Índices de itens preenchidos sozinhos: acompanham o item quando outro é removido ou duplicado. */
function shiftIndex<T>(map: Map<number, T>, at: number, delta: 1 | -1) {
  const next = new Map<number, T>();
  for (const [index, mark] of map) {
    if (index < at || (delta > 0 && index === at)) next.set(index, mark);
    else if (delta < 0 && index > at) next.set(index - 1, mark);
    else if (delta > 0 && index > at) next.set(index + 1, mark);
  }
  if (delta > 0 && map.has(at)) {
    const mark = map.get(at)!;
    next.set(at + 1, typeof mark === "object" ? ({ ...mark } as T) : mark);
  }
  return next;
}

/* ------------------------------------------------------------------------ */
/* Listas (carregadas uma vez para as duas abas)                             */
/* ------------------------------------------------------------------------ */

function useDocList<F extends AnyForm>(kind: DocKind) {
  const [list, setList] = useState<ListResponse<F> | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const run = useRef(0);
  async function load() {
    const n = ++run.current;
    setBusy(true);
    setError("");
    try {
      const data = (await requestJson(kind === "cc" ? "/api/scrap-forms?doc=cc" : "/api/scrap-forms")) as ListResponse<F>;
      if (n === run.current) setList(data);
    } catch (e) {
      if (n === run.current) setError((e as Error).message);
    } finally {
      if (n === run.current) setBusy(false);
    }
  }
  useEffect(() => {
    void load();
    return () => {
      run.current++;
    };
  }, []);
  function replace(form: F) {
    setList((current) =>
      current ? { ...current, forms: current.forms.some((entry) => entry.id === form.id) ? current.forms.map((entry) => (entry.id === form.id ? form : entry)) : [form, ...current.forms] } : current,
    );
  }
  function remove(id: string) {
    setList((current) => (current ? { ...current, forms: current.forms.filter((form) => form.id !== id) } : current));
  }
  return { list, busy, error, setError, load, replace, remove };
}
type DocList<F extends AnyForm> = ReturnType<typeof useDocList<F>>;

function readDeepLink(): { kind: DocKind; id: string; generate?: boolean } | null {
  try {
    const params = new URLSearchParams(location.search);
    const generate = params.get("gerar") === "1";
    if (generate) {
      // Uma vez só: recarregar a página depois não gera de novo.
      params.delete("gerar");
      history.replaceState(null, "", `${location.pathname}?${params.toString()}`);
    }
    for (const kind of ["scrap", "cc"] as const) {
      const id = params.get(kind);
      if (id && /^[a-f0-9-]{36}$/i.test(id)) return { kind, id, generate };
    }
    if (params.get("doc") === "cc") return { kind: "cc", id: "" };
  } catch {
    // Sem endereço: nada a abrir.
  }
  return null;
}

export default function ScrapForms() {
  const [link, setLink] = useState(readDeepLink);
  const [tab, setTab] = useState<DocKind>(() => link?.kind || "scrap");
  const scrap = useDocList<ScrapForm>("scrap");
  const cc = useDocList<CcForm>("cc");
  const [ops, setOps] = useState<string[]>([]),
    [checking, setChecking] = useState(false),
    [importing, setImporting] = useState(false);
  useEffect(() => {
    // OPs das BOMs cadastradas (só metadados) para sugerir no campo Ordem.
    requestJson("/api/data")
      .then((models: { ops?: string[] }[]) => setOps([...new Set(models.flatMap((model) => model.ops || []))].sort().reverse()))
      .catch(() => {});
  }, []);
  // Scrap Form → baixa em CC que já o inclui.
  const ccByScrap = useMemo(() => {
    const map = new Map<string, string>();
    for (const form of cc.list?.forms || []) for (const number of form.data.scrapForms) if (!map.has(number)) map.set(number, form.number);
    return map;
  }, [cc.list]);
  const pending = (forms: AnyForm[] | undefined) => (forms || []).filter((form) => form.status === "signing").length;
  const ready = (scrap.list?.forms || []).filter((form) => form.status === "signed" && !ccByScrap.has(form.number)).length;
  const tabs = [
    { id: "scrap" as const, label: "Scrap Forms", note: pending(scrap.list?.forms) ? `${pending(scrap.list?.forms)} aguardando` : "" },
    { id: "cc" as const, label: "Baixa em CC · FO.FI.C.007", note: [pending(cc.list?.forms) && `${pending(cc.list?.forms)} aguardando`, cc.list && ready && `${ready} prontos para baixa`].filter(Boolean).join(" · ") },
  ];
  const linkFor = (kind: DocKind) => (link?.kind === kind && link.id ? link.id : null);

  return (
    <section className="shortages panel scrap-forms" aria-label="Scrap Forms e baixas em centro de custo">
      <div className="scrap-doc-tabs" role="tablist" aria-label="Documento">
        {tabs.map((entry) => (
          <button key={entry.id} type="button" role="tab" aria-selected={tab === entry.id} className={tab === entry.id ? "active" : ""} onClick={() => setTab(entry.id)}>
            <b>{entry.label}</b>
            {entry.note && <small>{entry.note}</small>}
          </button>
        ))}
      </div>
      {tab === "scrap" ? (
        <ScrapFormList docs={scrap} ops={ops} ccByScrap={ccByScrap} deepLink={linkFor("scrap")} generateLink={!!link?.generate} onLinkUsed={() => setLink(null)} onCheck={() => setChecking(true)} onImport={() => setImporting(true)} />
      ) : (
        <CcFormList docs={cc} scrapDocs={scrap} ccByScrap={ccByScrap} deepLink={linkFor("cc")} generateLink={!!link?.generate} onLinkUsed={() => setLink(null)} onCheck={() => setChecking(true)} onImport={() => setImporting(true)} />
      )}
      <PdfCheckDialog open={checking} onClose={() => setChecking(false)} />
      {importing && (
        <ImportDialog
          existing={[...(scrap.list?.forms || []), ...(cc.list?.forms || [])]}
          defaultKind={tab}
          onImported={() => {
            void scrap.load();
            void cc.load();
          }}
          onClose={() => setImporting(false)}
        />
      )}
    </section>
  );
}

function SignaturePills({ kind, form }: { kind: DocKind; form: Pick<AnyForm, "data" | "signatures" | "status"> }) {
  const progress = progressOf(kind, form);
  return (
    <span className="scrap-pills" aria-label="Assinaturas">
      {progress.slots.map(({ slot, required, signature, expected }) => {
        const state = !required ? "skip" : !signature || form.status === "draft" ? "missing" : signature.check === "invalid" ? "invalid" : signature.check === "unchecked" ? "unknown" : "signed";
        const title = !required
          ? `${slot.label}: não se aplica (classe C)`
          : state === "signed"
            ? `${slot.label}: assinado por ${signature!.signer} ${brDateTime(signature!.signedAt)}`
            : state === "invalid"
              ? `${slot.label}: assinatura inválida (${signature!.signer})`
              : `${slot.label}: falta ${expected}`;
        return (
          <i key={slot.id} className={`scrap-pill ${state}`} title={title} aria-label={title}>
            {slot.short}
          </i>
        );
      })}
    </span>
  );
}
function statusText(kind: DocKind, form: AnyForm) {
  if (form.status === "draft") return "Rascunho";
  if (form.status === "signed") return "Assinado";
  const missing = progressOf(kind, form).missing;
  return missing.length ? `Falta ${missing.map((entry) => entry.slot.label).join(", ")}` : "Conferir assinaturas";
}

/** Abre o formulário do link (?scrap= / ?cc=) quando a lista chega; some se o formulário for apagado. */
function useOpened<F extends AnyForm>(docs: DocList<F>, deepLink: string | null, onLinkUsed: () => void, generateOnOpen = false) {
  const [opened, setOpened] = useState<{ id: string | null; session: number; preset?: string[]; sheet?: File; generate?: boolean } | null>(null);
  const forms = docs.list?.forms || [];
  useEffect(() => {
    if (!deepLink || !docs.list) return;
    if (docs.list.forms.some((form) => form.id === deepLink)) setOpened({ id: deepLink, session: Date.now(), generate: generateOnOpen });
    onLinkUsed();
  }, [docs.list, deepLink]);
  useEffect(() => {
    if (opened?.id && docs.list && !docs.list.forms.some((form) => form.id === opened.id)) {
      setOpened(null);
      docs.setError("Este formulário foi apagado por outra pessoa.");
    }
  }, [docs.list, opened?.id]);
  const current = opened?.id ? forms.find((form) => form.id === opened.id) || null : null;
  return { opened, setOpened, current };
}

function ListNotices({ docs, loading }: { docs: { error: string; busy: boolean; list: unknown; load: () => Promise<void> }; loading: string }) {
  return (
    <>
      {docs.error && (
        <div className="notice" role="alert">
          <TriangleAlert size={18} />
          <div>
            <b>{docs.error}</b>
          </div>
          <button onClick={docs.load}>Tentar novamente</button>
        </div>
      )}
      {!docs.list && docs.busy && (
        <div className="empty" role="status">
          <RefreshCw className="spin" />
          <h3>{loading}</h3>
        </div>
      )}
    </>
  );
}

function ScrapFormList({
  docs,
  ops,
  ccByScrap,
  deepLink,
  generateLink = false,
  onLinkUsed,
  onCheck,
  onImport,
}: {
  docs: DocList<ScrapForm>;
  ops: string[];
  ccByScrap: Map<string, string>;
  deepLink: string | null;
  generateLink?: boolean;
  onLinkUsed: () => void;
  onCheck: () => void;
  onImport: () => void;
}) {
  const { list, busy } = docs;
  const [query, setQuery] = useState(""),
    [status, setStatus] = useState("all"),
    [month, setMonth] = useState("all");
  const deferredQuery = useDeferredValue(query);
  const { opened, setOpened, current } = useOpened(docs, deepLink, onLinkUsed, generateLink);

  const forms = list?.forms || [];
  const months = useMemo(() => [...new Set(forms.map((form) => form.data.formDate.slice(0, 7)).filter(Boolean))].sort().reverse(), [forms]);
  const filtered = useMemo(() => {
    const text = deferredQuery.trim().toLowerCase();
    return forms.filter(
      (form) =>
        (status === "all" || form.status === status || (status === "finance" && form.status === "signing" && statusText("scrap", form) === "Falta Financeiro")) &&
        (month === "all" || form.data.formDate.startsWith(month)) &&
        [form.number, form.data.sapDocument, form.data.costCenter, form.data.pr, form.data.po, ccByScrap.get(form.number) || "", ...form.data.items.flatMap((item) => [item.material, item.name, item.op, item.vin, item.defect])]
          .join(" ")
          .toLowerCase()
          .includes(text),
    );
  }, [forms, deferredQuery, status, month, ccByScrap]);
  const summary = useMemo(() => summarizeForms(forms), [forms]);
  const drafts = forms.filter((form) => form.status === "draft").length;
  const hasFilters = !!query.trim() || status !== "all" || month !== "all";

  return (
    <>
      <div className="warehouse-heading">
        <div>
          <p className="eyebrow">FORMULÁRIO DE SCRAP A-B</p>
          <h3>Scrap Forms</h3>
          <p>
            O portal preenche o formulário, gera o PDF com um campo de assinatura digital em cada quadro e confere as
            assinaturas do Adobe. Quando todos assinam, o PDF final fica guardado aqui.
          </p>
        </div>
        <div className="stock-projects-actions">
          {list?.canEdit && (
            <button className="primary" onClick={() => setOpened({ id: null, session: Date.now() })}>
              <FilePlus2 size={16} />
              Novo Scrap Form
            </button>
          )}
          {list?.canEdit && (
            <button onClick={onImport} title="Guarda qualquer PDF de Scrap Form ou FO.FI.C.007 (do Excel, do portal, assinado ou não): o portal lê os dados e guarda o arquivo">
              <Upload size={16} />
              Adicionar PDFs
            </button>
          )}
          <button onClick={onCheck}>
            <FileSearch size={16} />
            Conferir um PDF
          </button>
          <button disabled={busy} onClick={docs.load} aria-label="Atualizar lista">
            <RefreshCw size={16} className={busy ? "spin" : ""} />
            {busy ? "Lendo…" : "Atualizar"}
          </button>
        </div>
      </div>

      <ListNotices docs={docs} loading="Carregando os formulários…" />

      {list && (
        <>
          <div className="warehouse-metrics scrap-metrics">
            <article className="metric-return">
              <Clock3 size={19} />
              <span>Aguardando assinatura</span>
              <strong>{fmt(summary.open)}</strong>
              <small>{summary.open ? brMoney(summary.valueOpen) + " em aprovação" : "nenhum formulário parado"}</small>
            </article>
            <article>
              <span>Só falta o Financeiro</span>
              <strong>{fmt(summary.missingFinance)}</strong>
              <small>Produção, Qualidade e Logística já assinaram</small>
            </article>
            <article>
              <CheckCircle2 size={19} />
              <span>Assinados no mês</span>
              <strong>{fmt(summary.signedThisMonth)}</strong>
              <small>{brMoney(summary.valueThisMonth)}</small>
            </article>
            <article>
              <span>Rascunhos</span>
              <strong>{fmt(drafts)}</strong>
              <small>ainda sem PDF para assinatura</small>
            </article>
          </div>

          <div className="warehouse-filter-panel" role="search" aria-label="Filtros dos formulários">
            <div className="warehouse-filter-heading">
              <b>Encontre um formulário</b>
              <button
                className="warehouse-clear-filters"
                disabled={!hasFilters}
                onClick={() => {
                  setQuery("");
                  setStatus("all");
                  setMonth("all");
                }}
              >
                Limpar filtros
              </button>
            </div>
            <div className="warehouse-filters scrap-filters">
              <label>
                Busca
                <input aria-label="Buscar formulários" placeholder="Nº, P/N, descrição, OP, VIN, defeito…" value={query} onChange={(e) => setQuery(e.target.value)} />
              </label>
              <label>
                Situação
                <select aria-label="Situação do formulário" value={status} onChange={(e) => setStatus(e.target.value)}>
                  <option value="all">Todas</option>
                  <option value="draft">Rascunho</option>
                  <option value="signing">Aguardando assinatura</option>
                  <option value="finance">Só falta o Financeiro</option>
                  <option value="signed">Assinado</option>
                </select>
              </label>
              <label>
                Mês
                <select aria-label="Mês do formulário" value={month} onChange={(e) => setMonth(e.target.value)}>
                  <option value="all">Todos</option>
                  {months.map((value) => (
                    <option key={value} value={value}>
                      {value.slice(5)}/{value.slice(0, 4)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="warehouse-filter-summary" aria-live="polite">
              <span>
                <b>{fmt(filtered.length)}</b> de {fmt(forms.length)} formulário(s)
              </span>
              <span>{list.canEdit ? "Clique num formulário para abrir" : "Perfil Consulta: ver, baixar e enviar PDFs"}</span>
            </div>
          </div>

          {!filtered.length ? (
            <div className="empty">
              <FileText size={30} />
              <h3>{hasFilters ? "Nenhum formulário neste filtro" : "Nenhum Scrap Form ainda"}</h3>
              <p>{hasFilters ? "Ajuste os filtros." : list.canEdit ? "Clique em Novo Scrap Form para preencher o primeiro." : "Os formulários preenchidos aparecem aqui."}</p>
            </div>
          ) : (
            <div className="scrap-list" role="list" aria-label="Scrap Forms">
              <div className="scrap-list-head" aria-hidden="true">
                <span>Nº / data</span>
                <span>Itens</span>
                <span>OP · VIN</span>
                <span>Valor</span>
                <span>Assinaturas</span>
                <span>Situação</span>
              </div>
              {filtered.map((form) => {
                const first = form.data.items[0];
                const opsOf = [...new Set(form.data.items.map((item) => item.op).filter(Boolean))];
                const vins = [...new Set(form.data.items.map((item) => item.vin).filter(Boolean))];
                const cc = ccByScrap.get(form.number);
                return (
                  <button type="button" role="listitem" key={form.id} className={`scrap-row ${form.status}`} onClick={() => setOpened({ id: form.id, session: Date.now() })}>
                    <span className="scrap-row-id">
                      <b>{form.number}</b>
                      <small>{brDate(form.data.formDate)}</small>
                    </span>
                    <span className="scrap-row-items">
                      <b>{first ? `${first.material || "sem P/N"} · ${first.name || "sem descrição"}` : "Sem itens"}</b>
                      <small>
                        {form.data.items.length > 1 ? `+${form.data.items.length - 1} item(s) · ` : ""}
                        {first?.defect || "—"}
                      </small>
                    </span>
                    <span className="scrap-row-op">
                      <small>{opsOf.length ? `OP ${opsOf.join(", ")}` : "OP —"}</small>
                      <small>{vins.length ? `VIN ${vins.join(", ")}` : "VIN —"}</small>
                    </span>
                    <span className="scrap-row-value">{brMoney(formTotal(form.data))}</span>
                    <SignaturePills kind="scrap" form={form} />
                    <span className="scrap-row-status">
                      <i className={`scrap-status ${form.status}`}>{statusText("scrap", form)}</i>
                      {form.status === "signed" && <small>{form.sentAt ? `Enviado ${brDate(form.sentAt.slice(0, 10))}` : "Ainda não enviado"}</small>}
                      {(form.data.pr || form.data.po) && <small>{[form.data.pr && `PR ${form.data.pr}`, form.data.po && `PO ${form.data.po}`].filter(Boolean).join(" · ")}</small>}
                      {form.data.sapDocument && <small>Doc. SAP {form.data.sapDocument}</small>}
                      {cc && <small className="scrap-row-link">Baixa {cc}</small>}
                      {form.data.source && <small>Importado</small>}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </>
      )}

      {opened && list && (
        <ScrapFormDialog
          key={opened.session}
          form={current}
          forms={forms}
          ops={ops}
          ccNumber={current ? ccByScrap.get(current.number) || "" : ""}
          autoGenerate={!!opened.generate}
          canEdit={list.canEdit}
          canDelete={list.canDelete}
          onSaved={(form) => {
            docs.replace(form);
            setOpened((current) => (current ? { ...current, id: form.id } : current));
          }}
          onDeleted={(id) => {
            docs.remove(id);
            setOpened(null);
          }}
          onClose={() => setOpened(null)}
        />
      )}
    </>
  );
}

function CcFormList({
  docs,
  scrapDocs,
  ccByScrap,
  deepLink,
  generateLink = false,
  onLinkUsed,
  onCheck,
  onImport,
}: {
  docs: DocList<CcForm>;
  scrapDocs: DocList<ScrapForm>;
  ccByScrap: Map<string, string>;
  deepLink: string | null;
  generateLink?: boolean;
  onLinkUsed: () => void;
  onCheck: () => void;
  onImport: () => void;
}) {
  const { list, busy } = docs;
  const [query, setQuery] = useState(""),
    [status, setStatus] = useState("all"),
    [month, setMonth] = useState("all");
  const deferredQuery = useDeferredValue(query);
  const { opened, setOpened, current } = useOpened(docs, deepLink, onLinkUsed, generateLink);
  const sheetInput = useRef<HTMLInputElement>(null);

  const forms = list?.forms || [];
  const scrapForms = scrapDocs.list?.forms || [];
  const ready = useMemo(() => scrapForms.filter((form) => form.status === "signed" && !ccByScrap.has(form.number)), [scrapForms, ccByScrap]);
  const months = useMemo(() => [...new Set(forms.map((form) => form.data.period).filter(Boolean))].sort().reverse(), [forms]);
  const filtered = useMemo(() => {
    const text = deferredQuery.trim().toLowerCase();
    return forms.filter(
      (form) =>
        (status === "all" || form.status === status) &&
        (month === "all" || form.data.period === month) &&
        [form.number, form.data.sapDocument, periodLabel(form.data.period), form.data.reason, ...form.data.scrapForms, ...form.data.items.flatMap((item) => [item.material, item.description, item.costCenter, item.costCenterDescription])]
          .join(" ")
          .toLowerCase()
          .includes(text),
    );
  }, [forms, deferredQuery, status, month]);
  const summary = useMemo(() => summarizeCcForms(forms), [forms]);
  const hasFilters = !!query.trim() || status !== "all" || month !== "all";
  const signedThisMonth = forms.filter((form) => form.status === "signed" && (form.signedAt || "").slice(0, 7) === new Date().toISOString().slice(0, 7)).length;

  return (
    <>
      <div className="warehouse-heading">
        <div>
          <p className="eyebrow">FO.FI.C.007 - INVENTORY ADJUSTMENT</p>
          <h3>Baixa em centro de custo</h3>
          <p>
            O portal monta o FO.FI.C.007 a partir dos Scrap Forms assinados, de uma planilha Excel (ex.: LOSS 7000) ou item a item, gera o PDF com os quatro
            quadros de assinatura obrigatórios (Solicitante, Gestor, SCM e Financeiro) e guarda o PDF final quando todos
            assinarem.
          </p>
        </div>
        <div className="stock-projects-actions">
          {list?.canEdit && (
            <button className="primary" onClick={() => setOpened({ id: null, session: Date.now() })}>
              <FilePlus2 size={16} />
              Nova baixa em CC
            </button>
          )}
          {list?.canEdit && (
            <>
              <button
                className="primary"
                onClick={() => sheetInput.current?.click()}
                title="Escolha a planilha (Material, Texto breve material, Centro, Depósito, Utilização livre, Val.utiliz.livre): a baixa abre com todos os itens preenchidos"
              >
                <FileSpreadsheet size={16} />
                Baixa pelo Excel
              </button>
              <input
                ref={sheetInput}
                type="file"
                accept=".xlsx,.xls,.xlsm,.csv"
                hidden
                aria-label="Planilha para nova baixa"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (file) setOpened({ id: null, session: Date.now(), sheet: file });
                }}
              />
            </>
          )}
          {list?.canEdit && (
            <button onClick={onImport} title="Guarda qualquer PDF de Scrap Form ou FO.FI.C.007 (do Excel, do portal, assinado ou não): o portal lê os dados e guarda o arquivo">
              <Upload size={16} />
              Adicionar PDFs
            </button>
          )}
          <button onClick={onCheck}>
            <FileSearch size={16} />
            Conferir um PDF
          </button>
          <button
            disabled={busy}
            onClick={() => {
              void docs.load();
              void scrapDocs.load();
            }}
            aria-label="Atualizar lista"
          >
            <RefreshCw size={16} className={busy ? "spin" : ""} />
            {busy ? "Lendo…" : "Atualizar"}
          </button>
        </div>
      </div>

      <ListNotices docs={docs} loading="Carregando as baixas…" />

      {list && (
        <>
          <div className="warehouse-metrics scrap-metrics">
            <article className="metric-return">
              <Clock3 size={19} />
              <span>Aguardando assinatura</span>
              <strong>{fmt(summary.open)}</strong>
              <small>{summary.open ? brMoney(summary.valueOpen) + " em aprovação" : "nenhuma baixa parada"}</small>
            </article>
            <article className="cc-ready">
              <Link2 size={19} />
              <span>Scrap Forms prontos para baixa</span>
              <strong>{fmt(ready.length)}</strong>
              {ready.length > 0 && list.canEdit ? (
                <button type="button" onClick={() => setOpened({ id: null, session: Date.now(), preset: ready.map((form) => form.number) })}>
                  <ListPlus size={14} />
                  Criar baixa com eles
                </button>
              ) : (
                <small>{scrapDocs.list ? "assinados e ainda sem FO.FI.C.007" : "lendo os Scrap Forms…"}</small>
              )}
            </article>
            <article>
              <CheckCircle2 size={19} />
              <span>Assinadas no mês</span>
              <strong>{fmt(signedThisMonth)}</strong>
              <small>{fmt(summary.signed)} no total</small>
            </article>
            <article>
              <span>Rascunhos</span>
              <strong>{fmt(summary.drafts)}</strong>
              <small>ainda sem PDF para assinatura</small>
            </article>
          </div>

          <div className="warehouse-filter-panel" role="search" aria-label="Filtros das baixas">
            <div className="warehouse-filter-heading">
              <b>Encontre uma baixa</b>
              <button
                className="warehouse-clear-filters"
                disabled={!hasFilters}
                onClick={() => {
                  setQuery("");
                  setStatus("all");
                  setMonth("all");
                }}
              >
                Limpar filtros
              </button>
            </div>
            <div className="warehouse-filters scrap-filters">
              <label>
                Busca
                <input aria-label="Buscar baixas" placeholder="Nº, P/N, descrição, centro de custo, SCRAP-…" value={query} onChange={(e) => setQuery(e.target.value)} />
              </label>
              <label>
                Situação
                <select aria-label="Situação da baixa" value={status} onChange={(e) => setStatus(e.target.value)}>
                  <option value="all">Todas</option>
                  <option value="draft">Rascunho</option>
                  <option value="signing">Aguardando assinatura</option>
                  <option value="signed">Assinada</option>
                </select>
              </label>
              <label>
                Mês de referência
                <select aria-label="Mês de referência" value={month} onChange={(e) => setMonth(e.target.value)}>
                  <option value="all">Todos</option>
                  {months.map((value) => (
                    <option key={value} value={value}>
                      {periodLabel(value)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="warehouse-filter-summary" aria-live="polite">
              <span>
                <b>{fmt(filtered.length)}</b> de {fmt(forms.length)} baixa(s)
              </span>
              <span>{list.canEdit ? "Clique numa baixa para abrir" : "Perfil Consulta: ver, baixar e enviar PDFs"}</span>
            </div>
          </div>

          {!filtered.length ? (
            <div className="empty">
              <FileText size={30} />
              <h3>{hasFilters ? "Nenhuma baixa neste filtro" : "Nenhum FO.FI.C.007 ainda"}</h3>
              <p>{hasFilters ? "Ajuste os filtros." : list.canEdit ? "Clique em Baixa pelo Excel para mandar a planilha, ou em Nova baixa em CC para puxar os Scrap Forms assinados." : "As baixas preenchidas aparecem aqui."}</p>
            </div>
          ) : (
            <div className="scrap-list" role="list" aria-label="Baixas em centro de custo">
              <div className="scrap-list-head" aria-hidden="true">
                <span>Nº / mês</span>
                <span>Itens</span>
                <span>Centro de custo · origem</span>
                <span>Valor</span>
                <span>Assinaturas</span>
                <span>Situação</span>
              </div>
              {filtered.map((form) => {
                const first = form.data.items[0];
                const centers = [...new Set(form.data.items.map((item) => item.costCenter).filter(Boolean))];
                return (
                  <button type="button" role="listitem" key={form.id} className={`scrap-row cc-row ${form.status}`} onClick={() => setOpened({ id: form.id, session: Date.now() })}>
                    <span className="scrap-row-id">
                      <b>{form.number}</b>
                      <small>{periodLabel(form.data.period)}</small>
                    </span>
                    <span className="scrap-row-items">
                      <b>{first ? `${first.material || "sem código"} · ${first.description || "sem descrição"}` : "Sem itens"}</b>
                      <small>
                        {form.data.items.length > 1 ? `+${form.data.items.length - 1} item(s) · ` : ""}
                        {form.data.reason || "—"}
                      </small>
                    </span>
                    <span className="scrap-row-op">
                      <small>{centers.length ? `CC ${centers.join(", ")}` : "CC —"}</small>
                      <small>{form.data.scrapForms.length ? form.data.scrapForms.join(", ") : "Sem Scrap Form"}</small>
                    </span>
                    <span className="scrap-row-value">{brMoney(ccTotals(form.data).cost)}</span>
                    <SignaturePills kind="cc" form={form} />
                    <span className="scrap-row-status">
                      <i className={`scrap-status ${form.status}`}>{statusText("cc", form)}</i>
                      {form.status === "signed" && <small>{form.sentAt ? `Enviado ${brDate(form.sentAt.slice(0, 10))}` : "Ainda não enviado"}</small>}
                      {form.data.sapDocument && <small>Doc. SAP {form.data.sapDocument}</small>}
                      {form.data.source && <small>Importado</small>}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </>
      )}

      {opened && list && (
        <CcFormDialog
          key={opened.session}
          form={current}
          forms={forms}
          scrapForms={scrapForms}
          preset={opened.preset || []}
          sheet={opened.sheet || null}
          autoGenerate={!!opened.generate}
          canEdit={list.canEdit}
          canDelete={list.canDelete}
          onSaved={(form) => {
            docs.replace(form);
            setOpened((current) => (current ? { ...current, id: form.id } : current));
          }}
          onDeleted={(id) => {
            docs.remove(id);
            setOpened(null);
          }}
          onClose={() => setOpened(null)}
        />
      )}
    </>
  );
}

/* ------------------------------------------------------------------------ */
/* Partes comuns aos dois diálogos                                           */
/* ------------------------------------------------------------------------ */

type Runner = ReturnType<typeof useRunner>;
function useRunner() {
  const [busy, setBusy] = useState(""),
    [message, setMessage] = useState<Message | null>(null);
  // Mensagem nova (PDF gerado, versão salva, erro): leva o diálogo para o topo, onde ela aparece.
  useEffect(() => {
    if (message) document.querySelector(".scrap-dialog")?.scrollTo?.({ top: 0, behavior: "smooth" });
  }, [message]);
  async function run<T>(label: string, task: () => Promise<T>): Promise<T | undefined> {
    setBusy(label);
    setMessage(null);
    try {
      return await task();
    } catch (e) {
      setMessage({ kind: "error", text: (e as Error).message });
      return undefined;
    } finally {
      setBusy("");
    }
  }
  return { busy, message, setMessage, run };
}

function MessageBox({ message }: { message: Message | null }) {
  if (!message) return null;
  return (
    <div className={`scrap-message ${message.kind}`} role={message.kind === "error" ? "alert" : "status"}>
      {message.kind === "error" ? <TriangleAlert size={16} /> : <CheckCircle2 size={16} />}
      <span>{message.text}</span>
    </div>
  );
}

/** Reabrir (assinaturas deixam de valer) e apagar: iguais nos dois documentos. */
function useLifecycle<F extends AnyForm>(kind: DocKind, form: F | null, runner: Runner, onSaved: (form: F) => void, onDeleted: (id: string) => void) {
  async function reopen() {
    if (!form || !window.confirm("Reabrir para corrigir? As assinaturas já coletadas deixam de valer: será preciso gerar um PDF novo e assinar de novo. Os PDFs atuais ficam no histórico.")) return undefined;
    return runner.run("reopen", async () => {
      const next = (await api<F>({ action: "reopen", id: form.id, revision: form.revision }, kind)).form;
      onSaved(next);
      return next;
    });
  }
  async function destroy() {
    if (!form || !window.confirm(`Apagar o ${form.number} e todos os PDFs dele? Não dá para desfazer.`)) return;
    await runner.run("delete", async () => {
      await api({ action: "delete", id: form.id, revision: form.revision }, kind);
      onDeleted(form.id);
    });
  }
  return { reopen, destroy };
}

function DialogFooter({
  form,
  canEdit,
  canDelete,
  editable,
  dirty,
  runner,
  onReopen,
  onDelete,
  onClose,
  onSave,
  onGenerate,
  pending = null,
}: {
  pending?: { label: string; onClick: () => void } | null;
  form: AnyForm | null;
  canEdit: boolean;
  canDelete: boolean;
  editable: boolean;
  dirty: boolean;
  runner: Runner;
  onReopen: () => void;
  onDelete: () => void;
  onClose: () => void;
  onSave: () => void;
  onGenerate: () => void;
}) {
  const { busy } = runner;
  return (
    <div className="dialog-actions scrap-footer">
      {form && (canDelete || (canEdit && form.status === "draft" && !form.files.length)) && (
        <button className="scrap-delete" disabled={!!busy} onClick={onDelete}>
          <Trash2 size={16} />
          Apagar
        </button>
      )}
      {form && form.status !== "draft" && canEdit && (form.status !== "signed" || canDelete) && (
        <button disabled={!!busy} onClick={onReopen}>
          <RotateCcw size={16} />
          Reabrir para corrigir
        </button>
      )}
      <button disabled={!!busy} onClick={onClose}>
        Fechar
      </button>
      {pending && (
        // Campo salvo à parte (PR/PO, Doc SAP) alterado: o botão fica à vista no rodapé.
        <button className="primary" disabled={!!busy} onClick={pending.onClick}>
          <Save size={16} />
          {busy === "posting" ? "Salvando…" : pending.label}
        </button>
      )}
      {editable && form && form.status !== "draft" && (
        // Importado: só os dados (transcrição do PDF) mudam; o PDF assinado continua o mesmo.
        <button className="primary" disabled={!!busy || !dirty} onClick={onSave}>
          <Save size={16} />
          {busy === "save" ? "Salvando…" : "Salvar dados"}
        </button>
      )}
      {editable && (!form || form.status === "draft") && (
        <>
          <button disabled={!!busy || !dirty} onClick={onSave}>
            <Save size={16} />
            {busy === "save" ? "Salvando…" : "Salvar rascunho"}
          </button>
          <button className="primary" disabled={!!busy} onClick={onGenerate}>
            <FileText size={16} />
            {busy === "generate" ? "Gerando PDF…" : "Gerar PDF para assinatura"}
          </button>
        </>
      )}
    </div>
  );
}

async function downloadPdf(kind: DocKind, form: AnyForm, version?: number, name?: string) {
  saveFile(await fetchPdf(form, version), name || fileNameOf(kind, form));
}

/** Quadros de assinatura, baixar/ver o PDF atual e anexar o devolvido com assinaturas. */
function SignatureSection<F extends AnyForm>({ kind, form, canEdit, runner, onSaved }: { kind: DocKind; form: F; canEdit: boolean; runner: Runner; onSaved: (form: F) => void }) {
  const { busy, run, setMessage } = runner;
  const [review, setReview] = useState<Review | null>(null),
    [preview, setPreview] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  useEffect(() => () => void (preview && URL.revokeObjectURL?.(preview)), [preview]);
  const progress = progressOf(kind, form);

  async function chooseSigned(file: File) {
    await run("read", async () => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const { readScrapPdf } = await pdfTools();
      // Qualquer PDF entra. Sem os quadros do portal (PDF feito no Excel), os campos valem pela posição.
      const read = await readScrapPdf(bytes, { legacy: true, kind });
      // Vale quem assinou no arquivo, mesmo que ele tenha sido regravado depois.
      const reading = { ...read, signatures: acceptAttached(read.signatures) };
      setReview(await reviewUpload(kind, form, file.name, bytes, reading));
    });
    if (fileInput.current) fileInput.current.value = "";
  }
  async function saveReview() {
    if (!review) return;
    await run("upload", async () => {
      const next = (await api<F>({ action: "upload", id: form.id, revision: form.revision, kind: "signed", name: review.name, pdf: toBase64(review.bytes), signatures: review.reading.signatures }, kind)).form;
      onSaved(next);
      setReview(null);
      const after = progressOf(kind, next);
      setMessage({
        kind: "ok",
        text: after.complete
          ? "Todos os quadros assinados. O PDF final está guardado: use Enviar para mandar ao Financeiro / arquivo."
          : `Versão ${next.fileVersion} guardada. Falta: ${after.missing.map((entry) => `${entry.expected} (${entry.slot.label})`).join(", ")}.`,
      });
    });
  }
  async function showPdf() {
    await run("view", async () => {
      const bytes = await fetchPdf(form);
      if (typeof URL.createObjectURL !== "function") throw Error("Este navegador não mostra PDF aqui. Use Baixar PDF.");
      setPreview(URL.createObjectURL(new Blob([bytes.slice().buffer as ArrayBuffer], { type: "application/pdf" })));
    });
  }

  return (
    <section className="scrap-section" aria-label="Assinaturas">
      <div className="scrap-section-head">
        <h4>Assinaturas</h4>
        <span>{progress.complete ? "Todos os quadros obrigatórios assinados" : `Falta ${progress.missing.map((entry) => entry.slot.label).join(", ")}`}</span>
      </div>
      <div className="scrap-slots">
        {progress.slots.map(({ slot, required, signature, expected }) => {
          const state = !required ? "skip" : !signature ? "missing" : signature.check === "invalid" ? "invalid" : signature.check === "unchecked" ? "unknown" : "signed";
          return (
            <article key={slot.id} className={`scrap-slot ${state}`}>
              <span>
                {slot.order} {slot.label}
              </span>
              <b>{state === "signed" || state === "invalid" || state === "unknown" ? signature!.signer || "Assinatura sem nome" : required ? expected : "Não se aplica"}</b>
              <small>
                {state === "signed" && <>✓ {brDateTime(signature!.signedAt)}</>}
                {state === "missing" && <>Falta assinar</>}
                {state === "invalid" && <>✗ Inválida: {signature!.detail}</>}
                {state === "unknown" && <>Não foi possível conferir</>}
                {state === "skip" && <>Todos os itens são classe C</>}
              </small>
              {state === "signed" && signature!.signer && expected && !sameName(signature!.signer, expected) && <small className="scrap-note">Previsto: {expected}</small>}
            </article>
          );
        })}
      </div>
      {progress.issues.length > 0 && (
        <ul className="scrap-issues">
          {progress.issues.map((issue) => (
            <li key={issue}>
              <ShieldAlert size={14} />
              {issue}
            </li>
          ))}
        </ul>
      )}
      <div className="scrap-actions">
        <button className={progress.complete ? "primary" : ""} disabled={!!busy} onClick={() => run("download", () => downloadPdf(kind, form))}>
          <Download size={16} />
          {progress.complete ? "Baixar PDF assinado" : "Baixar PDF para assinar"}
        </button>
        <button disabled={!!busy} onClick={showPdf}>
          <Eye size={16} />
          Ver PDF
        </button>
        {canEdit && (
          <>
            <button className={progress.complete ? "" : "primary"} disabled={!!busy} onClick={() => fileInput.current?.click()}>
              <Paperclip size={16} />
              {busy === "read" ? "Lendo o PDF…" : "Anexar PDF assinado"}
            </button>
            <input ref={fileInput} type="file" hidden accept="application/pdf,.pdf" aria-label="PDF assinado" onChange={(e) => e.target.files?.[0] && chooseSigned(e.target.files[0])} />
          </>
        )}
      </div>
      {review && <ReviewPanel review={review} busy={busy === "upload"} onCancel={() => setReview(null)} onSave={saveReview} />}
      {preview && (
        <div className="scrap-preview">
          <iframe title={`PDF ${form.number}`} src={preview} />
          <button onClick={() => setPreview(null)}>Fechar visualização</button>
        </div>
      )}
    </section>
  );
}

function FileHistory({ kind, form, runner }: { kind: DocKind; form: AnyForm; runner: Runner }) {
  if (!form.files.length) return null;
  return (
    <details className="scrap-history">
      <summary>Histórico de PDFs ({form.files.length})</summary>
      <ul>
        {[...form.files].reverse().map((file) => (
          <li key={file.version}>
            <span>
              v{file.version} · {file.kind === "generated" ? "emitido pelo portal" : "anexado"} · {file.name} · {brDateTime(file.createdAt)} · {(file.size / 1024).toFixed(0)} KB
            </span>
            <button disabled={!!runner.busy} onClick={() => runner.run("download", () => downloadPdf(kind, form, file.version, file.name))}>
              <Download size={14} />
              Baixar
            </button>
          </li>
        ))}
      </ul>
    </details>
  );
}

function Problems({ problems }: { problems: string[] }) {
  if (!problems.length) return null;
  return (
    <ul className="scrap-problems" role="alert" aria-label="O que falta para gerar o PDF">
      {problems.map((problem) => (
        <li key={problem}>{problem}</li>
      ))}
    </ul>
  );
}

const sameName = (a: string, b: string) => {
  const clean = (value: string) =>
    value
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z]+/g, " ")
      .trim();
  const left = clean(a),
    right = clean(b);
  return left === right || left.split(" ")[0] === right.split(" ")[0];
};

/** Descrição e classe nas BOMs cadastradas, consultadas no servidor aos poucos. */
function useMaterialLookups(materials: string[]) {
  const [state, setState] = useState<{ found: Record<string, Lookup>; answered: Set<string> }>({ found: {}, answered: new Set() });
  const asked = useRef(new Set<string>());
  const key = materials.join("|");
  useEffect(() => {
    const codes = [
      ...new Set(
        materials
          .flatMap((code) => (/^\d{8}$/.test(code) ? [code, `${code}-00`] : [code]))
          .filter((code) => /^[A-Z0-9.\-/]{3,40}$/.test(code) && !asked.current.has(code)),
      ),
    ].slice(0, 20);
    if (!codes.length) return;
    const timer = setTimeout(() => {
      codes.forEach((code) => asked.current.add(code));
      requestJson("/api/scrap-forms?lookup=" + encodeURIComponent(codes.join(",")))
        .then((result: { materials: Record<string, Lookup> }) => setState((current) => ({ found: { ...current.found, ...result.materials }, answered: new Set([...current.answered, ...codes]) })))
        .catch(() => codes.forEach((code) => asked.current.delete(code)));
    }, 450);
    return () => clearTimeout(timer);
  }, [key]);
  return state;
}

type Hint = { text: string; action?: () => void; label?: string };
function Hints({ hints }: { hints: Hint[] }) {
  if (!hints.length) return null;
  return (
    <ul className="scrap-hints">
      {hints.map((hint) => (
        <li key={hint.text}>
          <span>{hint.text}</span>
          {hint.action && (
            <button type="button" onClick={hint.action}>
              {hint.label}
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

/** Campo numérico em formato brasileiro que não "pula" enquanto se digita. */
function useNumberText(value: number | null, format: (value: number | null) => string) {
  const [textValue, setText] = useState(format(value));
  useEffect(() => {
    if (parseBrNumber(textValue) !== value) setText(format(value));
  }, [value]);
  return [textValue, setText] as const;
}

/* ------------------------------------------------------------------------ */
/* Scrap Form                                                                */
/* ------------------------------------------------------------------------ */

function ScrapFormDialog({
  form,
  forms,
  ops,
  ccNumber,
  autoGenerate = false,
  canEdit,
  canDelete,
  onSaved,
  onDeleted,
  onClose,
}: {
  form: ScrapForm | null;
  forms: ScrapForm[];
  ops: string[];
  ccNumber: string;
  /** Aberto depois de recarregar para gerar o PDF na versão nova. */
  autoGenerate?: boolean;
  canEdit: boolean;
  canDelete: boolean;
  onSaved: (form: ScrapForm) => void;
  onDeleted: (id: string) => void;
  onClose: () => void;
}) {
  const [data, setData] = useState<ScrapFormData>(() => form?.data || emptyForm(readApprovers()));
  const [dirty, setDirty] = useState(!form);
  // Revisão sobre a qual as edições foram feitas: salvar nunca passa por cima de outra pessoa.
  const [baseRevision, setBaseRevision] = useState(form?.revision ?? 0);
  const runner = useRunner();
  const { busy, run, setMessage } = runner;
  const [showProblems, setShowProblems] = useState(false),
    [posting, setPosting] = useState(() => postingOf(form?.data));
  const editable = canEdit && (!form || form.status === "draft" || isTranscription(form));
  const problems = useMemo(() => pdfProblems(data), [data]);
  const history = useMemo(() => formHistory(forms.filter((entry) => entry.id !== form?.id)), [forms, form?.id]);
  const lookups = useMaterialLookups(editable ? data.items.map((item) => item.material) : []);
  const [mm60, setMm60] = useState<Mm60 | null>(null);
  const lifecycle = useLifecycle("scrap", form, runner, onSaved, onDeleted);

  // Quando o form salvo muda (outra aba ou depois de salvar), a tela acompanha.
  useEffect(() => {
    if (form && !dirty) {
      setData(form.data);
      setBaseRevision(form.revision);
      setPosting(postingOf(form.data));
    }
  }, [form?.revision]);

  // Preenche descrição e classe (BOM ou formulários anteriores) e o VIN da OP
  // uma vez por P/N/OP digitado, só nos campos vazios: apagar um campo não o
  // faz voltar sozinho.
  const filled = useRef(new Map<number, { material: string; op: string }>());
  useEffect(() => {
    if (!editable) return;
    let changed = false;
    const items = data.items.map((item, index) => {
      const mark = filled.current.get(index) || { material: "", op: "" };
      let next = item;
      if (item.material && mark.material !== item.material) {
        // A BOM manda; o histórico só entra quando a BOM já respondeu sem esse P/N.
        const found = lookups.found[item.material],
          past = history.materials.get(item.material),
          answered = lookups.answered.has(item.material);
        if (found || (answered && past)) {
          mark.material = item.material;
          const name = item.name || found?.description || past?.name || "";
          const classification = item.classification || (found ? strongestClass(found.boms.map((bom) => bom.classification)) : past?.classification || "");
          if (name !== item.name || classification !== item.classification) next = { ...next, name, classification };
        }
      }
      if (item.op !== mark.op) {
        mark.op = item.op;
        const vin = history.vinByOp.get(item.op);
        if (vin && !item.vin) next = { ...next, vin };
      }
      filled.current.set(index, mark);
      if (next !== item) changed = true;
      return next;
    });
    if (changed) {
      setData({ ...data, items });
      setDirty(true);
    }
  }, [data, lookups, history, editable]);
  // Preços da MM60: só onde o preço está vazio.
  useEffect(() => {
    if (!editable || !mm60) return;
    const items = data.items.map((item) => {
      const found = item.material ? mm60.get(item.material) : undefined;
      return found && item.unitPrice === null ? { ...item, unitPrice: found.price, name: item.name || found.description } : item;
    });
    if (items.some((item, index) => item !== data.items[index])) {
      setData({ ...data, items });
      setDirty(true);
    }
  }, [mm60]);

  function change(next: ScrapFormData) {
    setData(next);
    setDirty(true);
    setMessage(null);
  }
  function setItem(index: number, patch: Partial<ScrapItem>) {
    change({ ...data, items: data.items.map((item, i) => (i === index ? { ...item, ...patch } : item)) });
  }
  function close() {
    const unsaved = (editable && dirty && data.items.some((item) => item.material || item.defect)) || (!editable && !!form && JSON.stringify(posting) !== JSON.stringify(postingOf(form.data)));
    if (unsaved && !window.confirm("Fechar sem salvar as alterações deste formulário?")) return;
    onClose();
  }
  async function saveDraft(): Promise<ScrapForm | undefined> {
    const saved = form ? (await api({ action: "update", id: form.id, revision: baseRevision, data })).form : (await api({ action: "create", data })).form;
    setDirty(false);
    setBaseRevision(saved.revision);
    onSaved(saved);
    return saved;
  }
  async function generate(afterReload = false) {
    setShowProblems(true);
    await run("generate", async () => {
      const saved = dirty || !form ? await saveDraft() : form;
      if (!saved) return;
      if (problems.length) throw Error("Rascunho salvo. Complete os campos marcados para gerar o PDF.");
      if (!afterReload && (await portalOutdated())) {
        setMessage({ kind: "ok", text: "Rascunho salvo. O portal foi atualizado: recarregando para gerar o PDF na versão nova…" });
        reloadToGenerate("scrap", saved.id);
        return;
      }
      store.set(APPROVERS_KEY, JSON.stringify(data.approvers));
      const { buildScrapPdf } = await pdfTools();
      const bytes = await buildScrapPdf({ number: saved.number, data: saved.data });
      const next = (await api({ action: "upload", id: saved.id, revision: saved.revision, kind: "generated", name: pdfFileName({ ...saved, status: "signing", signatures: [] }), pdf: toBase64(bytes) })).form;
      onSaved(next);
      saveFile(bytes, pdfFileName(next));
      setShowProblems(false);
      setMessage({ kind: "ok", text: `PDF ${next.number} gerado e baixado. Envie para assinatura: cada responsável clica no campo do próprio quadro no Adobe.` });
    });
  }
  // Recarregou para gerar na versão nova: gera uma vez, sozinho.
  const autoRan = useRef(false);
  useEffect(() => {
    if (!autoGenerate || autoRan.current || !form || form.status !== "draft" || !canEdit) return;
    autoRan.current = true;
    void generate(true);
  }, [autoGenerate, form?.id]);
  async function readMm60() {
    await run("mm60", async () => {
      const prices = await loadMm60();
      setMm60(prices);
      const found = data.items.filter((item) => item.material && prices.has(item.material)).length;
      setMessage({ kind: found ? "ok" : "error", text: found ? `MM60 lida: preço encontrado para ${found} de ${data.items.length} item(s). Itens que já tinham preço não foram alterados.` : "A MM60 foi lida, mas nenhum P/N deste formulário está nela." });
    });
  }
  async function reopen() {
    const next = await lifecycle.reopen();
    if (next) {
      setDirty(false);
      setData(next.data);
    }
  }
  async function savePosting() {
    if (!form) return;
    await run("posting", async () => {
      const next = (await api({ action: "posting", id: form.id, revision: form.revision, ...posting })).form;
      onSaved(next);
      setMessage({ kind: "ok", text: "PR, PO e baixa no SAP salvos." });
    });
  }

  const missingByItem = useMemo(() => (showProblems ? data.items.map(missingFields) : []), [showProblems, data]);
  const title = form ? `${form.number} · ${STATUS_LABEL[form.status]}` : "Novo Scrap Form";
  // PR/PO: num rascunho ou importado fazem parte dos dados; num formulário emitido pelo portal, salvam à parte.
  const postingValues = editable ? postingOf(data) : posting;
  const setPostingField = (key: keyof ReturnType<typeof postingOf>, value: string) => (editable ? change({ ...data, [key]: value }) : setPosting({ ...posting, [key]: value }));
  const postingDirty = !editable && !!form && JSON.stringify(posting) !== JSON.stringify(postingOf(form.data));

  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent className="scrap-dialog">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {form
              ? `Criado em ${brDateTime(form.createdAt)}${form.status === "signed" && form.signedAt ? ` · assinado por todos em ${brDateTime(form.signedAt)}` : ""}${form.sentAt ? ` · enviado em ${brDateTime(form.sentAt)}` : ""}${ccNumber ? ` · incluído na baixa ${ccNumber}` : ""}${form.data.source ? ` · importado de "${form.data.source}"` : ""}`
              : "Preencha os itens. Descrição e classe vêm da BOM; o preço pode vir da MM60."}
          </DialogDescription>
        </DialogHeader>

        <MessageBox message={runner.message} />

        {form && form.status !== "draft" && <SignatureSection kind="scrap" form={form} canEdit={canEdit} runner={runner} onSaved={onSaved} />}
        {form && form.status !== "draft" && <SendPanel key={form.status} kind="scrap" form={form} canEdit={canEdit} onSent={onSaved} onError={(text) => setMessage({ kind: "error", text })} />}

        <section className="scrap-section" aria-label="Itens do formulário">
          <div className="scrap-section-head">
            <h4>Itens ({data.items.length})</h4>
            <span>Total {brMoney(formTotal(data))}</span>
          </div>
          {editable ? (
            <fieldset className="scrap-fieldset" disabled={!!busy}>
              <datalist id="scrap-ops">
                {[...new Set([...ops, ...history.vinByOp.keys()])].slice(0, 400).map((op) => (
                  <option key={op} value={op} />
                ))}
              </datalist>
              <datalist id="scrap-materials">
                {[...history.materials.entries()].slice(0, 400).map(([code, entry]) => (
                  <option key={code} value={code}>
                    {entry.name}
                  </option>
                ))}
              </datalist>
              {data.items.map((item, index) => (
                <ItemEditor
                  key={index}
                  index={index}
                  item={item}
                  missing={missingByItem[index] || new Set()}
                  lookup={lookups.found[item.material]}
                  suggestion={lookups.found[`${item.material}-00`] && /^\d{8}$/.test(item.material) ? `${item.material}-00` : ""}
                  mm60={mm60?.get(item.material) || null}
                  last={history.materials.get(item.material) || null}
                  canRemove={data.items.length > 1}
                  onChange={(patch) => setItem(index, patch)}
                  onRemove={() => {
                    filled.current = shiftIndex(filled.current, index, -1);
                    change({ ...data, items: data.items.filter((_, i) => i !== index) });
                  }}
                  onDuplicate={() => {
                    if (data.items.length >= MAX_ITEMS) return;
                    filled.current = shiftIndex(filled.current, index, 1);
                    change({ ...data, items: [...data.items.slice(0, index + 1), { ...item }, ...data.items.slice(index + 1)] });
                  }}
                />
              ))}
              <div className="scrap-actions">
                <button disabled={data.items.length >= MAX_ITEMS} onClick={() => change({ ...data, items: [...data.items, emptyItem(data.items.at(-1), data.formDate)] })}>
                  <Plus size={16} />
                  Adicionar item
                </button>
                <button disabled={!!busy} onClick={readMm60} title="Lê a aba MM60 da planilha e preenche os preços vazios">
                  <RefreshCw size={16} className={busy === "mm60" ? "spin" : ""} />
                  {busy === "mm60" ? "Lendo MM60…" : "Buscar preços na MM60"}
                </button>
                {data.items.length >= MAX_ITEMS && <small>Máximo de {MAX_ITEMS} itens: crie outro formulário para o restante.</small>}
              </div>
            </fieldset>
          ) : (
            <ItemsTable items={data.items} />
          )}
        </section>

        <section className="scrap-section" aria-label="Responsáveis">
          <div className="scrap-section-head">
            <h4>Aprovação</h4>
            <span>Nomes impressos no quadro de cada assinatura</span>
          </div>
          <fieldset className="scrap-approvers scrap-fieldset" disabled={!!busy}>
            {SLOTS.map((slot) => {
              const required = requiredSlots(data).some((entry) => entry.id === slot.id);
              return (
                <label key={slot.id} className={showProblems && required && !data.approvers[slot.id] ? "missing" : ""}>
                  {slot.order} {slot.label}
                  <input
                    value={required ? data.approvers[slot.id] : "Não se aplica (classe C)"}
                    disabled={!editable || !required}
                    maxLength={80}
                    onChange={(e) => change({ ...data, approvers: { ...data.approvers, [slot.id]: e.target.value } })}
                  />
                </label>
              );
            })}
            <label>
              Data do formulário
              <input type="date" value={data.formDate} disabled={!editable} onChange={(e) => e.target.value && change({ ...data, formDate: e.target.value })} />
            </label>
          </fieldset>
        </section>

        <section className="scrap-section" aria-label="Reposição e baixa no SAP">
          <div className="scrap-section-head">
            <h4>Reposição e baixa no SAP</h4>
            <span>{editable ? (form && form.status !== "draft" ? "Salva com Salvar dados" : "Salva junto com o rascunho") : "Fica só no portal, não altera o PDF assinado"}</span>
          </div>
          <fieldset className="scrap-approvers scrap-posting scrap-fieldset" disabled={!canEdit || !!busy}>
            <label>
              PR
              <input value={postingValues.pr} maxLength={30} inputMode="numeric" placeholder="6000014878" onChange={(e) => setPostingField("pr", e.target.value)} />
            </label>
            <label>
              Data da PR
              <input type="date" value={postingValues.prDate} onChange={(e) => setPostingField("prDate", e.target.value)} />
            </label>
            <label>
              PO
              <input value={postingValues.po} maxLength={30} inputMode="numeric" placeholder="9900029259" onChange={(e) => setPostingField("po", e.target.value)} />
            </label>
            <label>
              Centro de custo
              <input value={postingValues.costCenter} maxLength={40} onChange={(e) => setPostingField("costCenter", e.target.value)} />
            </label>
            <label>
              Documento SAP da baixa
              <input value={postingValues.sapDocument} maxLength={40} onChange={(e) => setPostingField("sapDocument", e.target.value)} />
            </label>
            {canEdit && !editable && (
              <button disabled={!postingDirty} onClick={savePosting}>
                <Save size={16} />
                Salvar
              </button>
            )}
          </fieldset>
        </section>

        {form && <FileHistory kind="scrap" form={form} runner={runner} />}
        {showProblems && editable && <Problems problems={problems} />}

        <DialogFooter
          form={form}
          canEdit={canEdit}
          canDelete={canDelete}
          editable={editable}
          dirty={dirty}
          runner={runner}
          onReopen={reopen}
          onDelete={lifecycle.destroy}
          onClose={close}
          onSave={() =>
            run("save", async () => {
              const saved = await saveDraft();
              if (saved && saved.status !== "draft") setMessage({ kind: "ok", text: "Dados corrigidos. O PDF e as assinaturas continuam os mesmos." });
            })
          }
          onGenerate={() => generate()}
          pending={postingDirty && canEdit ? { label: "Salvar PR e PO", onClick: savePosting } : null}
        />
      </DialogContent>
    </Dialog>
  );
}

const postingOf = (data?: ScrapFormData) => ({
  pr: data?.pr || "",
  prDate: data?.prDate || "",
  po: data?.po || "",
  costCenter: data?.costCenter || "",
  sapDocument: data?.sapDocument || "",
});
function readApprovers() {
  return defaultApprovers(store.json<Record<string, string>>(APPROVERS_KEY));
}
function missingFields(item: ScrapItem) {
  const missing = new Set<string>();
  if (!item.date) missing.add("date");
  if (!item.material) missing.add("material");
  if (item.quantity === null || item.quantity <= 0) missing.add("quantity");
  if (!item.name) missing.add("name");
  if (!item.defect) missing.add("defect");
  if (!item.cause) missing.add("cause");
  if (!item.vin) missing.add("vin");
  if (!item.op || !/^\d{8,18}$/.test(item.op)) missing.add("op");
  if (item.unitPrice === null || item.unitPrice <= 0) missing.add("unitPrice");
  if (!item.classification) missing.add("classification");
  return missing;
}

function ItemEditor({
  index,
  item,
  missing,
  lookup,
  suggestion,
  mm60,
  last,
  canRemove,
  onChange,
  onRemove,
  onDuplicate,
}: {
  index: number;
  item: ScrapItem;
  missing: Set<string>;
  lookup: Lookup | undefined;
  suggestion: string;
  mm60: { price: number; description: string } | null;
  last: { name: string; unitPrice: number | null; classification: string; date: string } | null;
  canRemove: boolean;
  onChange: (patch: Partial<ScrapItem>) => void;
  onRemove: () => void;
  onDuplicate: () => void;
}) {
  const [price, setPrice] = useNumberText(item.unitPrice, moneyInput);
  const [quantity, setQuantity] = useNumberText(item.quantity, qtyInput);
  const field = (name: string) => (missing.has(name) ? "missing" : undefined);
  const bomClass = lookup ? strongestClass(lookup.boms.map((bom) => bom.classification)) : "";
  const hints: Hint[] = [];
  if (suggestion) hints.push({ text: `P/N com 8 dígitos. Na BOM existe ${suggestion}.`, action: () => onChange({ material: suggestion }), label: "Usar" });
  if (lookup) {
    const classes = lookup.boms.map((bom) => `${bom.bom}: ${bom.classification || "sem classe"}`).join(" · ");
    hints.push({ text: `BOM: ${lookup.description || "sem descrição"} · ${classes}` });
    if (item.name && lookup.description && item.name.trim().toUpperCase() !== lookup.description.trim().toUpperCase())
      hints.push({ text: `A descrição digitada é diferente da BOM.`, action: () => onChange({ name: lookup.description }), label: "Usar a da BOM" });
    if (item.classification && bomClass && item.classification !== bomClass)
      hints.push({ text: `Classe ${item.classification} aqui, mas ${bomClass} na BOM.`, action: () => onChange({ classification: bomClass }), label: `Usar ${bomClass}` });
  } else if (item.material.length >= 8 && !suggestion) hints.push({ text: "P/N não encontrado nas BOMs cadastradas: confira o código e preencha descrição e classe." });
  if (mm60 && item.unitPrice !== null && Math.abs(mm60.price - item.unitPrice) >= 0.01)
    hints.push({ text: `MM60: ${brMoney(mm60.price)}.`, action: () => onChange({ unitPrice: mm60.price }), label: "Usar MM60" });
  if (last?.unitPrice && item.unitPrice === null)
    hints.push({ text: `Último formulário (${brDate(last.date)}): ${brMoney(last.unitPrice)}.`, action: () => onChange({ unitPrice: last.unitPrice }), label: "Usar" });

  return (
    <article className="scrap-item" aria-label={`Item ${index + 1}`}>
      <header>
        <b>Item {index + 1}</b>
        <span>{brMoney(itemTotal(item)) || "sem total"}</span>
        <button type="button" onClick={onDuplicate} title="Duplicar (mesma OP, VIN e defeito)">
          <Copy size={14} />
          Duplicar
        </button>
        {canRemove && (
          <button type="button" onClick={onRemove} aria-label={`Remover item ${index + 1}`}>
            <Trash2 size={14} />
          </button>
        )}
      </header>
      <div className="scrap-item-grid">
        <label className={`f-date ${field("date") || ""}`}>
          Data
          <input type="date" value={item.date} onChange={(e) => onChange({ date: e.target.value })} />
        </label>
        <label className={`f-pn ${field("material") || ""}`}>
          P/N SAP
          <input list="scrap-materials" value={item.material} placeholder="11272431-00" maxLength={40} onChange={(e) => onChange({ material: materialCode(e.target.value) })} />
        </label>
        <label className={`f-qty ${field("quantity") || ""}`}>
          Qtd.
          <input
            inputMode="decimal"
            value={quantity}
            onChange={(e) => {
              setQuantity(e.target.value);
              onChange({ quantity: parseBrNumber(e.target.value) });
            }}
          />
        </label>
        <label className={`f-name ${field("name") || ""}`}>
          Descrição do material
          <input value={item.name} maxLength={120} onChange={(e) => onChange({ name: e.target.value })} />
        </label>
        <label className={`f-class ${field("classification") || ""}`}>
          Classe
          <select value={item.classification} onChange={(e) => onChange({ classification: e.target.value })}>
            <option value="">—</option>
            <option value="A">A</option>
            <option value="B">B</option>
            <option value="C">C</option>
          </select>
        </label>
        <label className={`f-defect ${field("defect") || ""}`}>
          Descrição do defeito
          <input value={item.defect} maxLength={300} placeholder="Ex.: Componente queimado durante o debug" onChange={(e) => onChange({ defect: e.target.value })} />
        </label>
        <label className={`f-cause ${field("cause") || ""}`}>
          Causa
          <select value={item.cause} onChange={(e) => onChange({ cause: e.target.value })}>
            <option value="">Escolha…</option>
            {CAUSES.map((cause) => (
              <option key={cause.code} value={cause.code}>
                ({cause.code}) {cause.pt}
              </option>
            ))}
          </select>
        </label>
        <label className={`f-vin ${field("vin") || ""}`}>
          N° VIN
          <input value={item.vin} maxLength={30} placeholder="1076" onChange={(e) => onChange({ vin: e.target.value })} />
        </label>
        <label className={`f-op ${field("op") || ""}`}>
          Ordem de produção
          <input list="scrap-ops" inputMode="numeric" value={item.op} maxLength={20} placeholder="19000002673" onChange={(e) => onChange({ op: e.target.value.replace(/\s+/g, "") })} />
        </label>
        <label className={`f-price ${field("unitPrice") || ""}`}>
          Preço unit. (R$)
          <input
            inputMode="decimal"
            value={price}
            placeholder="1.054,87"
            onChange={(e) => {
              setPrice(e.target.value);
              onChange({ unitPrice: parseBrNumber(e.target.value) });
            }}
          />
        </label>
        <div className="f-total">
          Total
          <b>{brMoney(itemTotal(item)) || "—"}</b>
        </div>
      </div>
      <Hints hints={hints} />
    </article>
  );
}

function ItemsTable({ items }: { items: ScrapItem[] }) {
  return (
    <div className="scrap-items-table">
      <table>
        <thead>
          <tr>
            {["Data", "P/N SAP", "Qtd.", "Descrição", "Defeito", "Causa", "VIN", "OP", "Preço unit.", "Total", "Classe"].map((label) => (
              <th key={label}>{label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {items.map((item, index) => (
            <tr key={index}>
              <td>{brDate(item.date)}</td>
              <td className="code">{item.material}</td>
              <td className="num">{qtyInput(item.quantity)}</td>
              <td>{item.name}</td>
              <td>{item.defect}</td>
              <td title={CAUSES.find((cause) => cause.code === item.cause)?.pt}>{item.cause}</td>
              <td>{item.vin}</td>
              <td>{item.op}</td>
              <td className="num">{brMoney(item.unitPrice)}</td>
              <td className="num">{brMoney(itemTotal(item))}</td>
              <td>{item.classification}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/* FO.FI.C.007 — baixa em centro de custo                                    */
/* ------------------------------------------------------------------------ */

const ccDefaultsOf = (item?: Partial<CcItem> | null): Partial<CcDefaults> =>
  item ? { company: item.company, plant: item.plant, wh: item.wh, costCenter: item.costCenter, costCenterDescription: item.costCenterDescription } : {};
const blankCcItem = (item: CcItem) => !item.material && !item.description && item.quantity === null && item.unitCost === null;
/** A partir daqui os itens viram uma tabela compacta (lista vinda de planilha). */
const CC_COMPACT_FROM = 13;
/** Primeira aba da planilha que tenha Material e quantidade → itens do FO.FI.C.007. */
async function readCcSheet(file: File, defaults: Partial<CcDefaults>) {
  const x = await import("xlsx");
  let book: ReturnType<typeof x.read>;
  try {
    book = x.read(await file.arrayBuffer(), { type: "array", dense: true });
  } catch {
    throw Error(`Não consegui abrir "${file.name}". Salve como .xlsx no Excel e tente de novo.`);
  }
  let error = "";
  for (const name of book.SheetNames) {
    try {
      const rows = x.utils.sheet_to_json(book.Sheets[name], { header: 1, raw: true, defval: null }) as unknown[][];
      const found = ccFromSpreadsheet(rows, defaults);
      if (found.items.length) return found;
      error ||= `A aba "${name}" não tem nenhuma linha com material e quantidade.`;
    } catch (e) {
      error ||= (e as Error).message;
    }
  }
  throw Error(error || `"${file.name}" está vazia.`);
}
/** Itens e textos de "Remarks" a partir dos Scrap Forms escolhidos; texto editado à mão é mantido. */
function withScrapForms(data: CcFormData, add: ScrapForm[], all: ScrapForm[]): CcFormData {
  const defaults = ccDefaultsOf(data.items.filter((item) => !blankCcItem(item)).at(-1) || data.items.at(-1) || store.json<CcDefaults>(CC_DEFAULTS_KEY));
  const fresh = ccFromScrapForms([...add].sort((a, b) => a.number.localeCompare(b.number)), defaults);
  const items = [...data.items.filter((item) => !blankCcItem(item)), ...fresh.items];
  if (items.length > MAX_CC_ITEMS) throw Error(`Com estes Scrap Forms a baixa passaria de ${MAX_CC_ITEMS} itens. Escolha menos formulários e faça outra baixa para o restante.`);
  const numbers = [...new Set([...data.scrapForms, ...fresh.scrapForms])].sort();
  const linked = (list: string[]) => list.map((number) => all.find((form) => form.number === number)).filter((form): form is ScrapForm => !!form);
  const before = ccFromScrapForms(linked(data.scrapForms), defaults);
  const after = ccFromScrapForms(linked(numbers), defaults);
  const text = (key: "mainReason" | "reason" | "action") => (!data[key] || data[key] === before[key] ? after[key] : data[key]);
  return { ...data, items: items.length ? items : [emptyCcItem(defaults)], scrapForms: numbers, mainReason: text("mainReason"), reason: text("reason"), action: text("action") };
}
function newCcData(preset: string[], scrapForms: ScrapForm[]) {
  const data = emptyCcForm(store.json<Record<string, string>>(CC_APPROVERS_KEY), store.json<CcDefaults>(CC_DEFAULTS_KEY) || {});
  // Inclui os Scrap Forms prontos (do mais antigo ao mais novo), enquanto couberem no formulário.
  let next = data;
  for (const number of [...preset].sort()) {
    const form = scrapForms.find((entry) => entry.number === number);
    if (!form) continue;
    try {
      next = withScrapForms(next, [form], scrapForms);
    } catch {
      break;
    }
  }
  // Mês de referência: o do Scrap Form mais recente incluído.
  const months = scrapForms.filter((form) => next.scrapForms.includes(form.number)).map((form) => form.data.formDate.slice(0, 7)).filter((month) => /^\d{4}-\d{2}$/.test(month));
  return months.length ? { ...next, period: months.sort().at(-1)! } : next;
}
function periodOptions(current: string) {
  const now = new Date();
  const list: string[] = [];
  for (let offset = 1; offset >= -12; offset--) {
    const date = new Date(now.getFullYear(), now.getMonth() + offset, 1);
    list.push(`${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`);
  }
  if (current && !list.includes(current)) list.push(current);
  return list.sort().reverse();
}
function missingCcFields(item: CcItem) {
  const missing = new Set<string>();
  if (!item.company) missing.add("company");
  if (!item.plant) missing.add("plant");
  if (!item.wh) missing.add("wh");
  if (!item.material) missing.add("material");
  if (!item.description) missing.add("description");
  if (item.quantity === null || item.quantity === 0) missing.add("quantity");
  if (item.unitCost === null || item.unitCost <= 0) missing.add("unitCost");
  if (!item.costCenter) missing.add("costCenter");
  if (!item.costCenterDescription) missing.add("costCenterDescription");
  return missing;
}

function CcFormDialog({
  form,
  forms,
  scrapForms,
  preset,
  sheet = null,
  autoGenerate = false,
  canEdit,
  canDelete,
  onSaved,
  onDeleted,
  onClose,
}: {
  form: CcForm | null;
  forms: CcForm[];
  scrapForms: ScrapForm[];
  preset: string[];
  /** Planilha escolhida na lista ("Baixa pelo Excel"): a baixa já abre com os itens. */
  sheet?: File | null;
  /** Aberto depois de recarregar para gerar o PDF na versão nova. */
  autoGenerate?: boolean;
  canEdit: boolean;
  canDelete: boolean;
  onSaved: (form: CcForm) => void;
  onDeleted: (id: string) => void;
  onClose: () => void;
}) {
  const [data, setData] = useState<CcFormData>(() => form?.data || newCcData(preset, scrapForms));
  const [dirty, setDirty] = useState(!form);
  const [baseRevision, setBaseRevision] = useState(form?.revision ?? 0);
  const runner = useRunner();
  const { busy, run, setMessage } = runner;
  const [showProblems, setShowProblems] = useState(false),
    [sapDocument, setSapDocument] = useState(form?.data.sapDocument || ""),
    [picked, setPicked] = useState<Set<string>>(new Set()),
    [mm60, setMm60] = useState<Mm60 | null>(null);
  const sheetInput = useRef<HTMLInputElement>(null);
  const editable = canEdit && (!form || form.status === "draft" || isTranscription(form));
  const problems = useMemo(() => ccProblems(data), [data]);
  const history = useMemo(() => formHistory(scrapForms), [scrapForms]);
  const lookups = useMaterialLookups(editable ? data.items.map((item) => item.material) : []);
  const lifecycle = useLifecycle("cc", form, runner, onSaved, onDeleted);
  const totals = ccTotals(data);
  // Scrap Forms assinados que ainda não estão em nenhuma outra baixa.
  const elsewhere = useMemo(() => new Set(forms.filter((entry) => entry.id !== form?.id).flatMap((entry) => entry.data.scrapForms)), [forms, form?.id]);
  const available = scrapForms.filter((entry) => entry.status === "signed" && !elsewhere.has(entry.number) && !data.scrapForms.includes(entry.number));

  useEffect(() => {
    if (form && !dirty) {
      setData(form.data);
      setBaseRevision(form.revision);
      setSapDocument(form.data.sapDocument);
    }
  }, [form?.revision]);
  const sheetRead = useRef(false);
  useEffect(() => {
    if (!sheet || form || sheetRead.current) return;
    sheetRead.current = true;
    void importSheet(sheet);
  }, [sheet]);

  // Descrição pela BOM (ou pelos Scrap Forms) uma vez por código, só se estiver vazia.
  const filled = useRef(new Map<number, string>());
  useEffect(() => {
    if (!editable) return;
    let changed = false;
    const items = data.items.map((item, index) => {
      if (!item.material || filled.current.get(index) === item.material) return item;
      const found = lookups.found[item.material],
        past = history.materials.get(item.material),
        answered = lookups.answered.has(item.material);
      if (!(found || (answered && past))) return item;
      filled.current.set(index, item.material);
      const description = item.description || found?.description || past?.name || "";
      if (description === item.description) return item;
      changed = true;
      return { ...item, description };
    });
    if (changed) {
      setData({ ...data, items });
      setDirty(true);
    }
  }, [data, lookups, history, editable]);
  useEffect(() => {
    if (!editable || !mm60) return;
    const items = data.items.map((item) => {
      const found = item.material ? mm60.get(item.material) : undefined;
      return found && item.unitCost === null ? { ...item, unitCost: found.price, description: item.description || found.description } : item;
    });
    if (items.some((item, index) => item !== data.items[index])) {
      setData({ ...data, items });
      setDirty(true);
    }
  }, [mm60]);

  function change(next: CcFormData) {
    setData(next);
    setDirty(true);
    setMessage(null);
  }
  function setItem(index: number, patch: Partial<CcItem>) {
    change({ ...data, items: data.items.map((item, i) => (i === index ? { ...item, ...patch } : item)) });
  }
  // Tabela compacta: funções estáveis para as linhas não serem redesenhadas a cada tecla.
  const patchItem = useCallback((index: number, patch: Partial<CcItem>) => {
    setData((current) => ({ ...current, items: current.items.map((item, i) => (i === index ? { ...item, ...patch } : item)) }));
    setDirty(true);
    setMessage(null);
  }, []);
  const removeItem = useCallback((index: number) => {
    filled.current = shiftIndex(filled.current, index, -1);
    setData((current) => ({ ...current, items: current.items.length > 1 ? current.items.filter((_, i) => i !== index) : current.items }));
    setDirty(true);
    setMessage(null);
  }, []);
  function applyCostCenter(costCenter: string, costCenterDescription: string) {
    const old = data.items.at(-1);
    const action = old && data.action ? data.action.split(`${old.costCenter} - ${old.costCenterDescription}`).join(`${costCenter} - ${costCenterDescription}`) : data.action;
    change({ ...data, action, items: data.items.map((item) => ({ ...item, costCenter, costCenterDescription })) });
    setMessage({ kind: "ok", text: `Centro de custo ${costCenter} - ${costCenterDescription} aplicado aos ${data.items.length} itens.` });
  }
  function clearItems() {
    if (!window.confirm(`Tirar os ${data.items.length} itens desta baixa?`)) return;
    filled.current = new Map();
    change({ ...data, items: [emptyCcItem(CC_DEFAULTS, data.items.at(-1))] });
  }
  async function importSheet(file: File | undefined) {
    if (!file) return;
    await run("sheet", async () => {
      const kept = data.items.filter((item) => !blankCcItem(item));
      const found = await readCcSheet(file, ccDefaultsOf(kept.at(-1) || data.items.at(-1) || store.json<CcDefaults>(CC_DEFAULTS_KEY)));
      const items = [...kept, ...found.items];
      if (items.length > MAX_CC_ITEMS)
        throw Error(
          kept.length
            ? `A planilha tem ${found.items.length} itens e esta baixa já tem ${kept.length}: passaria de ${MAX_CC_ITEMS}. Faça uma baixa nova para a planilha ou divida o arquivo.`
            : `A planilha tem ${found.items.length} itens; cabem ${MAX_CC_ITEMS} por formulário. Divida o arquivo em mais de uma baixa.`,
        );
      const keptIndex = data.items.map((item, index) => (blankCcItem(item) ? -1 : index)).filter((index) => index >= 0);
      filled.current = new Map(keptIndex.flatMap((old, index) => (filled.current.has(old) ? [[index, filled.current.get(old)!] as [number, string]] : [])));
      change({ ...data, items, mainReason: data.mainReason || found.mainReason, reason: data.reason || found.reason, action: data.action || found.action });
      const total = ccTotals({ items: found.items });
      const pages = ccLayout(items.length).pages;
      setMessage({
        kind: "ok",
        text:
          `${found.items.length} itens importados de "${file.name}" · Qtd. ${qtyInput(total.quantity)} · ${brMoney(total.cost)}.` +
          (found.skipped ? ` ${found.skipped} linha(s) sem material ou quantidade ficaram de fora.` : "") +
          ` Estoque vira quantidade negativa (baixa); custo unitário = valor ÷ quantidade.` +
          (pages > 1 ? ` O PDF vai ter ${pages} páginas, com as assinaturas no fim.` : "") +
          ` Confira o centro de custo e clique em Gerar PDF para assinatura.`,
      });
    });
  }
  function close() {
    const unsaved = (editable && dirty && data.items.some((item) => item.material || item.description)) || (!editable && !!form && sapDocument !== form.data.sapDocument);
    if (unsaved && !window.confirm("Fechar sem salvar as alterações desta baixa?")) return;
    onClose();
  }
  function includePicked() {
    try {
      const chosen = available.filter((entry) => picked.has(entry.number));
      const next = withScrapForms(data, chosen, scrapForms);
      // Itens vazios saem: o que já foi preenchido sozinho acompanha o item que ficou.
      const kept = data.items.map((item, index) => (blankCcItem(item) ? -1 : index)).filter((index) => index >= 0);
      filled.current = new Map(kept.flatMap((old, index) => (filled.current.has(old) ? [[index, filled.current.get(old)!] as [number, string]] : [])));
      change(next);
      setPicked(new Set());
      setMessage({ kind: "ok", text: `${chosen.length} Scrap Form(s) incluído(s): quantidades negativas (saída do estoque) pelo custo unitário do formulário. Confira centro de custo e textos.` });
    } catch (e) {
      setMessage({ kind: "error", text: (e as Error).message });
    }
  }
  function unlink(number: string) {
    change({ ...data, scrapForms: data.scrapForms.filter((entry) => entry !== number) });
  }
  async function saveDraft(): Promise<CcForm | undefined> {
    const saved = form ? (await api<CcForm>({ action: "update", id: form.id, revision: baseRevision, data }, "cc")).form : (await api<CcForm>({ action: "create", data }, "cc")).form;
    setDirty(false);
    setBaseRevision(saved.revision);
    onSaved(saved);
    return saved;
  }
  async function generate(afterReload = false) {
    setShowProblems(true);
    await run("generate", async () => {
      const saved = dirty || !form ? await saveDraft() : form;
      if (!saved) return;
      if (problems.length) throw Error("Rascunho salvo. Complete os campos marcados para gerar o PDF.");
      if (!afterReload && (await portalOutdated())) {
        setMessage({ kind: "ok", text: "Rascunho salvo. O portal foi atualizado: recarregando para gerar o PDF na versão nova…" });
        reloadToGenerate("cc", saved.id);
        return;
      }
      store.set(CC_APPROVERS_KEY, JSON.stringify(data.approvers));
      store.set(CC_DEFAULTS_KEY, JSON.stringify(ccDefaultsOf(data.items.at(-1))));
      const { buildCcPdf } = await pdfTools();
      const bytes = await buildCcPdf({ number: saved.number, data: saved.data });
      const next = (await api<CcForm>({ action: "upload", id: saved.id, revision: saved.revision, kind: "generated", name: ccFileName({ ...saved, status: "signing", signatures: [] }), pdf: toBase64(bytes) }, "cc")).form;
      onSaved(next);
      saveFile(bytes, ccFileName(next));
      setShowProblems(false);
      setMessage({ kind: "ok", text: `PDF ${next.number} gerado e baixado. Envie para assinatura: Solicitante, Gestor, SCM e Financeiro assinam cada um no próprio quadro no Adobe.` });
    });
  }
  // Recarregou para gerar na versão nova: gera uma vez, sozinho.
  const autoRan = useRef(false);
  useEffect(() => {
    if (!autoGenerate || autoRan.current || !form || form.status !== "draft" || !canEdit) return;
    autoRan.current = true;
    void generate(true);
  }, [autoGenerate, form?.id]);
  async function readMm60() {
    await run("mm60", async () => {
      const prices = await loadMm60();
      setMm60(prices);
      const found = data.items.filter((item) => item.material && prices.has(item.material)).length;
      setMessage({ kind: found ? "ok" : "error", text: found ? `MM60 lida: custo encontrado para ${found} de ${data.items.length} item(s). Itens que já tinham custo não foram alterados.` : "A MM60 foi lida, mas nenhum código desta baixa está nela." });
    });
  }
  async function reopen() {
    const next = await lifecycle.reopen();
    if (next) {
      setDirty(false);
      setData(next.data);
    }
  }
  async function savePosting() {
    if (!form) return;
    await run("posting", async () => {
      const next = (await api<CcForm>({ action: "posting", id: form.id, revision: form.revision, sapDocument }, "cc")).form;
      onSaved(next);
      setMessage({ kind: "ok", text: "Documento SAP da baixa salvo." });
    });
  }

  const missingByItem = useMemo(() => (showProblems ? data.items.map(missingCcFields) : []), [showProblems, data]);
  const title = form ? `${form.number} · ${STATUS_LABEL[form.status]}` : "Nova baixa em CC (FO.FI.C.007)";
  const textField = (key: "mainReason" | "reason" | "action") => (showProblems && !data[key] ? "missing" : "");

  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent className="scrap-dialog cc-dialog">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {form
              ? `FO.FI.C.007 · ${periodLabel(data.period)} · criado em ${brDateTime(form.createdAt)}${form.status === "signed" && form.signedAt ? ` · assinado por todos em ${brDateTime(form.signedAt)}` : ""}${form.sentAt ? ` · enviado em ${brDateTime(form.sentAt)}` : ""}${form.data.source ? ` · importado de "${form.data.source}"` : ""}`
              : "Importe a planilha Excel, puxe os itens dos Scrap Forms assinados ou preencha à mão. Quantidade negativa = saída do estoque (baixa)."}
          </DialogDescription>
        </DialogHeader>

        <MessageBox message={runner.message} />

        {form && form.status !== "draft" && <SignatureSection kind="cc" form={form} canEdit={canEdit} runner={runner} onSaved={onSaved} />}
        {form && form.status !== "draft" && <SendPanel key={form.status} kind="cc" form={form} canEdit={canEdit} onSent={onSaved} onError={(text) => setMessage({ kind: "error", text })} />}

        <section className="scrap-section" aria-label="Origem">
          <div className="scrap-section-head">
            <h4>Origem: Scrap Forms</h4>
            <span>{data.scrapForms.length ? `${data.scrapForms.length} formulário(s) nesta baixa` : "Nenhum Scrap Form ligado"}</span>
          </div>
          {data.scrapForms.length > 0 && (
            <div className="cc-links">
              {data.scrapForms.map((number) => (
                <span key={number} className="cc-link">
                  <Link2 size={13} />
                  {number}
                  {editable && (
                    <button type="button" disabled={!!busy} onClick={() => unlink(number)} aria-label={`Tirar ${number} desta baixa`} title="Tira o vínculo; os itens continuam (apague-os se precisar)">
                      <X size={13} />
                    </button>
                  )}
                </span>
              ))}
            </div>
          )}
          {editable &&
            (available.length ? (
              <fieldset className="cc-pick scrap-fieldset" disabled={!!busy}>
                <legend>Scrap Forms assinados ainda sem baixa</legend>
                {available.map((entry) => (
                  <label key={entry.id} className="cc-pick-row">
                    <input
                      type="checkbox"
                      checked={picked.has(entry.number)}
                      onChange={(e) => {
                        const next = new Set(picked);
                        if (e.target.checked) next.add(entry.number);
                        else next.delete(entry.number);
                        setPicked(next);
                      }}
                    />
                    <b>{entry.number}</b>
                    <span>
                      {brDate(entry.data.formDate)} · {entry.data.items.length} item(s) · {entry.data.items.map((item) => item.material).filter(Boolean).slice(0, 3).join(", ")}
                      {entry.data.items.length > 3 ? "…" : ""}
                    </span>
                    <i>{brMoney(formTotal(entry.data))}</i>
                  </label>
                ))}
                <div className="scrap-actions">
                  <button className="primary" disabled={!picked.size} onClick={includePicked}>
                    <ListPlus size={16} />
                    Incluir itens dos selecionados{picked.size ? ` (${picked.size})` : ""}
                  </button>
                  <button type="button" onClick={() => setPicked(new Set(available.map((entry) => entry.number)))}>
                    Marcar todos
                  </button>
                </div>
              </fieldset>
            ) : (
              <p className="cc-empty-note">Nenhum Scrap Form assinado esperando baixa. Os itens também podem ser preenchidos à mão.</p>
            ))}
        </section>

        <section className="scrap-section" aria-label="Itens da baixa">
          <div className="scrap-section-head">
            <h4>Itens ({data.items.length})</h4>
            <span>
              Qtd. total {qtyInput(totals.quantity)} · Total {brMoney(totals.cost)}
            </span>
          </div>
          {editable ? (
            <fieldset className="scrap-fieldset" disabled={!!busy}>
              <datalist id="cc-materials">
                {[...history.materials.entries()].slice(0, 400).map(([code, entry]) => (
                  <option key={code} value={code}>
                    {entry.name}
                  </option>
                ))}
              </datalist>
              {data.items.length >= CC_COMPACT_FROM ? (
                <CcItemsGrid items={data.items} missing={missingByItem} onChange={patchItem} onRemove={removeItem} onApplyCostCenter={applyCostCenter} />
              ) : (
                data.items.map((item, index) => (
                <CcItemEditor
                  key={index}
                  index={index}
                  item={item}
                  missing={missingByItem[index] || new Set()}
                  lookup={lookups.found[item.material]}
                  suggestion={lookups.found[`${item.material}-00`] && /^\d{8}$/.test(item.material) ? `${item.material}-00` : ""}
                  mm60={mm60?.get(item.material) || null}
                  last={history.materials.get(item.material) || null}
                  canRemove={data.items.length > 1}
                  onChange={(patch) => setItem(index, patch)}
                  onRemove={() => {
                    filled.current = shiftIndex(filled.current, index, -1);
                    change({ ...data, items: data.items.filter((_, i) => i !== index) });
                  }}
                  onDuplicate={() => {
                    if (data.items.length >= MAX_CC_ITEMS) return;
                    filled.current = shiftIndex(filled.current, index, 1);
                    change({ ...data, items: [...data.items.slice(0, index + 1), { ...item }, ...data.items.slice(index + 1)] });
                  }}
                />
                ))
              )}
              <div className="scrap-actions">
                <button
                  className={data.items.every(blankCcItem) ? "primary" : ""}
                  disabled={!!busy || data.items.filter((item) => !blankCcItem(item)).length >= MAX_CC_ITEMS}
                  onClick={() => sheetInput.current?.click()}
                  title="Planilha com Material, Texto breve material, Centro, Depósito, Utilização livre e Val.utiliz.livre (ex.: LOSS 7000.xlsx). Cada linha vira um item."
                >
                  <FileSpreadsheet size={16} />
                  {busy === "sheet" ? "Lendo planilha…" : "Importar Excel"}
                </button>
                <button disabled={data.items.length >= MAX_CC_ITEMS} onClick={() => change({ ...data, items: [...data.items, emptyCcItem(CC_DEFAULTS, data.items.at(-1))] })}>
                  <Plus size={16} />
                  Adicionar item
                </button>
                <input
                  ref={sheetInput}
                  type="file"
                  accept=".xlsx,.xls,.xlsm,.csv"
                  hidden
                  aria-label="Planilha de itens da baixa"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = "";
                    void importSheet(file);
                  }}
                />
                <button disabled={!!busy} onClick={readMm60} title="Lê a aba MM60 da planilha e preenche os custos vazios">
                  <RefreshCw size={16} className={busy === "mm60" ? "spin" : ""} />
                  {busy === "mm60" ? "Lendo MM60…" : "Buscar custos na MM60"}
                </button>
                {data.items.length > 1 && (
                  <button type="button" onClick={clearItems}>
                    <Trash2 size={16} />
                    Limpar itens
                  </button>
                )}
                {data.items.length >= MAX_CC_ITEMS && <small>Máximo de {MAX_CC_ITEMS} itens: faça outra baixa para o restante.</small>}
                {ccLayout(data.items.length).pages > 1 && data.items.length < MAX_CC_ITEMS && <small>PDF com {ccLayout(data.items.length).pages} páginas: 40 itens por página e as assinaturas no fim.</small>}
              </div>
            </fieldset>
          ) : (
            <CcItemsTable items={data.items} />
          )}
        </section>

        <section className="scrap-section" aria-label="Remarks">
          <div className="scrap-section-head">
            <h4>Remarks</h4>
            <span>Vai no quadro REMARKS do PDF (em inglês, como no modelo)</span>
          </div>
          <fieldset className="cc-remarks scrap-fieldset" disabled={!editable || !!busy}>
            <label className={`cc-main ${textField("mainReason")}`}>
              Inform the main reason
              <textarea rows={3} maxLength={600} value={data.mainReason} onChange={(e) => change({ ...data, mainReason: e.target.value })} />
            </label>
            <label className={textField("reason")}>
              Reason
              <input maxLength={120} value={data.reason} placeholder="Scrap" onChange={(e) => change({ ...data, reason: e.target.value })} />
            </label>
            <label className={`cc-action ${textField("action")}`}>
              Action
              <textarea rows={3} maxLength={600} value={data.action} onChange={(e) => change({ ...data, action: e.target.value })} />
            </label>
          </fieldset>
        </section>

        <section className="scrap-section" aria-label="Aprovação">
          <div className="scrap-section-head">
            <h4>Aprovação</h4>
            <span>As quatro assinaturas são obrigatórias</span>
          </div>
          <fieldset className="scrap-approvers scrap-fieldset" disabled={!!busy}>
            {CC_SLOTS.map((slot) => (
              <label key={slot.id} className={showProblems && !data.approvers[slot.id] ? "missing" : ""}>
                {slot.order} {slot.label} ({slot.role})
                <input value={data.approvers[slot.id] || ""} disabled={!editable} maxLength={80} onChange={(e) => change({ ...data, approvers: { ...data.approvers, [slot.id]: e.target.value } })} />
              </label>
            ))}
            <label>
              Mês de referência
              <select value={data.period} disabled={!editable} onChange={(e) => change({ ...data, period: e.target.value })}>
                {periodOptions(data.period).map((value) => (
                  <option key={value} value={value}>
                    {periodLabel(value)}
                  </option>
                ))}
              </select>
            </label>
          </fieldset>
        </section>

        {form && form.status !== "draft" && (
          <section className="scrap-section" aria-label="Baixa no SAP">
            <div className="scrap-section-head">
              <h4>Baixa no SAP</h4>
              <span>{editable ? "Salva com Salvar dados" : "Fica só no portal, não altera o PDF assinado"}</span>
            </div>
            <fieldset className="scrap-approvers cc-posting scrap-fieldset" disabled={!canEdit || !!busy}>
              <label>
                Documento SAP da baixa
                <input
                  value={editable ? data.sapDocument : sapDocument}
                  maxLength={40}
                  onChange={(e) => (editable ? change({ ...data, sapDocument: e.target.value }) : setSapDocument(e.target.value))}
                />
              </label>
              {canEdit && !editable && (
                <button disabled={sapDocument === form.data.sapDocument} onClick={savePosting}>
                  <Save size={16} />
                  Salvar
                </button>
              )}
            </fieldset>
          </section>
        )}

        {form && <FileHistory kind="cc" form={form} runner={runner} />}
        {showProblems && editable && <Problems problems={problems} />}

        <DialogFooter
          form={form}
          canEdit={canEdit}
          canDelete={canDelete}
          editable={editable}
          dirty={dirty}
          runner={runner}
          onReopen={reopen}
          onDelete={lifecycle.destroy}
          onClose={close}
          onSave={() =>
            run("save", async () => {
              const saved = await saveDraft();
              if (saved && saved.status !== "draft") setMessage({ kind: "ok", text: "Dados corrigidos. O PDF e as assinaturas continuam os mesmos." });
            })
          }
          onGenerate={() => generate()}
          pending={canEdit && !editable && !!form && sapDocument !== form.data.sapDocument ? { label: "Salvar Doc SAP", onClick: savePosting } : null}
        />
      </DialogContent>
    </Dialog>
  );
}

function CcItemEditor({
  index,
  item,
  missing,
  lookup,
  suggestion,
  mm60,
  last,
  canRemove,
  onChange,
  onRemove,
  onDuplicate,
}: {
  index: number;
  item: CcItem;
  missing: Set<string>;
  lookup: Lookup | undefined;
  suggestion: string;
  mm60: { price: number; description: string } | null;
  last: { name: string; unitPrice: number | null; date: string } | null;
  canRemove: boolean;
  onChange: (patch: Partial<CcItem>) => void;
  onRemove: () => void;
  onDuplicate: () => void;
}) {
  const [cost, setCost] = useNumberText(item.unitCost, costInput);
  const [quantity, setQuantity] = useNumberText(item.quantity, qtyInput);
  const field = (name: string) => (missing.has(name) ? "missing" : "");
  const hints: Hint[] = [];
  if (suggestion) hints.push({ text: `Código com 8 dígitos. Na BOM existe ${suggestion}.`, action: () => onChange({ material: suggestion }), label: "Usar" });
  if (lookup) {
    if (item.description && lookup.description && item.description.trim().toUpperCase() !== lookup.description.trim().toUpperCase())
      hints.push({ text: `BOM: ${lookup.description}.`, action: () => onChange({ description: lookup.description }), label: "Usar a da BOM" });
  } else if (item.material.length >= 8 && !suggestion && !last) hints.push({ text: "Código não encontrado nas BOMs cadastradas: confira e preencha a descrição." });
  if (item.quantity !== null && item.quantity > 0)
    hints.push({ text: "Quantidade positiva = entrada no estoque (sobra no inventário). Para baixa, use negativo.", action: () => onChange({ quantity: -item.quantity! }), label: `Usar ${qtyInput(-item.quantity)}` });
  if (mm60 && item.unitCost !== null && Math.abs(mm60.price - item.unitCost) >= 0.01)
    hints.push({ text: `MM60: ${brMoney(mm60.price)}.`, action: () => onChange({ unitCost: mm60.price }), label: "Usar MM60" });
  if (last?.unitPrice && item.unitCost === null)
    hints.push({ text: `Último Scrap Form (${brDate(last.date)}): ${brMoney(last.unitPrice)}.`, action: () => onChange({ unitCost: last.unitPrice }), label: "Usar" });

  return (
    <article className="scrap-item" aria-label={`Item ${index + 1}`}>
      <header>
        <b>Item {index + 1}</b>
        <span>{brMoney(ccItemTotal(item)) || "sem total"}</span>
        <button type="button" onClick={onDuplicate} title="Duplicar (mesmo centro de custo)">
          <Copy size={14} />
          Duplicar
        </button>
        {canRemove && (
          <button type="button" onClick={onRemove} aria-label={`Remover item ${index + 1}`}>
            <Trash2 size={14} />
          </button>
        )}
      </header>
      <div className="scrap-item-grid cc-item-grid">
        <label className={`f-company ${field("company")}`}>
          Company
          <input value={item.company} maxLength={10} onChange={(e) => onChange({ company: e.target.value.toUpperCase() })} />
        </label>
        <label className={`f-plant ${field("plant")}`}>
          Plant
          <input value={item.plant} maxLength={10} onChange={(e) => onChange({ plant: e.target.value.toUpperCase() })} />
        </label>
        <label className={`f-wh ${field("wh")}`}>
          WH
          <input value={item.wh} maxLength={10} onChange={(e) => onChange({ wh: e.target.value.toUpperCase() })} />
        </label>
        <label className={`f-pn ${field("material")}`}>
          Material code
          <input list="cc-materials" value={item.material} placeholder="11272431-00" maxLength={40} onChange={(e) => onChange({ material: materialCode(e.target.value) })} />
        </label>
        <label className={`f-name ${field("description")}`}>
          Descrição do material
          <input value={item.description} maxLength={120} onChange={(e) => onChange({ description: e.target.value })} />
        </label>
        <label className={`f-qty ${field("quantity")}`}>
          Qtd. (− = saída)
          <input
            inputMode="decimal"
            value={quantity}
            placeholder="-1"
            onChange={(e) => {
              setQuantity(e.target.value);
              onChange({ quantity: parseBrNumber(e.target.value) });
            }}
          />
        </label>
        <label className={`f-price ${field("unitCost")}`}>
          Custo unit. (R$)
          <input
            inputMode="decimal"
            value={cost}
            placeholder="1.054,87"
            onChange={(e) => {
              setCost(e.target.value);
              onChange({ unitCost: parseBrNumber(e.target.value) });
            }}
          />
        </label>
        <label className={`f-cc ${field("costCenter")}`}>
          Centro de custo
          <input value={item.costCenter} maxLength={20} placeholder="BR000411" onChange={(e) => onChange({ costCenter: e.target.value.toUpperCase() })} />
        </label>
        <label className={`f-ccname ${field("costCenterDescription")}`}>
          Descrição do centro de custo
          <input value={item.costCenterDescription} maxLength={80} placeholder="Operational - Chassis" onChange={(e) => onChange({ costCenterDescription: e.target.value })} />
        </label>
        <div className="f-total">
          Total
          <b>{brMoney(ccItemTotal(item)) || "—"}</b>
        </div>
      </div>
      <Hints hints={hints} />
    </article>
  );
}

/** Lista longa (planilha): uma linha por item, todos os campos editáveis. */
function CcItemsGrid({
  items,
  missing,
  onChange,
  onRemove,
  onApplyCostCenter,
}: {
  items: CcItem[];
  missing: Set<string>[];
  onChange: (index: number, patch: Partial<CcItem>) => void;
  onRemove: (index: number) => void;
  onApplyCostCenter: (costCenter: string, description: string) => void;
}) {
  const last = items.at(-1);
  const [costCenter, setCostCenter] = useState(last?.costCenter || CC_DEFAULTS.costCenter),
    [description, setDescription] = useState(last?.costCenterDescription || CC_DEFAULTS.costCenterDescription);
  const mixed = new Set(items.map((item) => `${item.costCenter}|${item.costCenterDescription}`)).size > 1;
  const same = !mixed && last?.costCenter === costCenter.trim().toUpperCase() && last?.costCenterDescription === description.trim();
  return (
    <>
      <div className="cc-bulk">
        <label>
          Centro de custo de todos os itens
          <input value={costCenter} maxLength={20} placeholder="BR000411" onChange={(e) => setCostCenter(e.target.value.toUpperCase())} />
        </label>
        <label>
          Descrição do centro de custo
          <input value={description} maxLength={80} placeholder="Operational - Chassis" onChange={(e) => setDescription(e.target.value)} />
        </label>
        <button type="button" disabled={!costCenter.trim() || !description.trim() || same} onClick={() => onApplyCostCenter(costCenter.trim(), description.trim())}>
          Aplicar aos {items.length} itens
        </button>
      </div>
      <div className="scrap-items-table cc-edit-table">
        <table>
          <colgroup>
            {[34, 66, 66, 66, 130, 280, 92, 104, 112, 108, 190, 42].map((width, index) => (
              <col key={index} style={{ width }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              {["#", "Company", "Plant", "WH", "Material", "Descrição", "Qtd. (− = saída)", "Custo unit. (R$)", "Total", "Centro de custo", "Descrição CC", ""].map((label, index) => (
                <th key={index}>{label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {items.map((item, index) => (
              <CcItemRow key={index} index={index} item={item} missing={[...(missing[index] || [])].join(",")} canRemove={items.length > 1} onChange={onChange} onRemove={onRemove} />
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

const CcItemRow = memo(function CcItemRow({
  index,
  item,
  missing,
  canRemove,
  onChange,
  onRemove,
}: {
  index: number;
  item: CcItem;
  missing: string;
  canRemove: boolean;
  onChange: (index: number, patch: Partial<CcItem>) => void;
  onRemove: (index: number) => void;
}) {
  const [cost, setCost] = useNumberText(item.unitCost, costInput);
  const [quantity, setQuantity] = useNumberText(item.quantity, qtyInput);
  const missed = missing ? missing.split(",") : [];
  const field = (name: string) => (missed.includes(name) ? "missing" : undefined);
  const NAMES: Record<string, string> = { company: "Company", plant: "Plant", wh: "WH", costCenter: "Centro de custo" };
  const label = (name: string) => `${NAMES[name] || name} do item ${index + 1}`;
  const text = (key: "company" | "plant" | "wh" | "costCenter", max: number, placeholder = "") => (
    <input className={field(key)} aria-label={label(key)} value={item[key]} maxLength={max} placeholder={placeholder} onChange={(e) => onChange(index, { [key]: e.target.value.toUpperCase() })} />
  );
  return (
    <tr className={item.quantity !== null && item.quantity > 0 ? "cc-row-in" : undefined}>
      <td className="num">{index + 1}</td>
      <td>{text("company", 10)}</td>
      <td>{text("plant", 10)}</td>
      <td>{text("wh", 10)}</td>
      <td>
        <input className={field("material")} aria-label={label("Material")} list="cc-materials" value={item.material} maxLength={40} onChange={(e) => onChange(index, { material: materialCode(e.target.value) })} />
      </td>
      <td>
        <input className={field("description")} aria-label={label("Descrição")} value={item.description} maxLength={120} title={item.description} onChange={(e) => onChange(index, { description: e.target.value })} />
      </td>
      <td>
        <input
          className={field("quantity")}
          aria-label={label("Quantidade")}
          inputMode="decimal"
          value={quantity}
          title={item.quantity !== null && item.quantity > 0 ? "Positiva = entrada no estoque. Para baixa, use negativo." : undefined}
          onChange={(e) => {
            setQuantity(e.target.value);
            onChange(index, { quantity: parseBrNumber(e.target.value) });
          }}
        />
      </td>
      <td>
        <input
          className={field("unitCost")}
          aria-label={label("Custo unitário")}
          inputMode="decimal"
          value={cost}
          onChange={(e) => {
            setCost(e.target.value);
            onChange(index, { unitCost: parseBrNumber(e.target.value) });
          }}
        />
      </td>
      <td className="num">{brMoney(ccItemTotal(item)) || "—"}</td>
      <td>{text("costCenter", 20)}</td>
      <td>
        <input className={field("costCenterDescription")} aria-label={label("Descrição do centro de custo")} value={item.costCenterDescription} maxLength={80} onChange={(e) => onChange(index, { costCenterDescription: e.target.value })} />
      </td>
      <td>
        {canRemove && (
          <button type="button" className="cc-row-remove" onClick={() => onRemove(index)} aria-label={`Remover item ${index + 1}`}>
            <Trash2 size={14} />
          </button>
        )}
      </td>
    </tr>
  );
});

function CcItemsTable({ items }: { items: CcItem[] }) {
  return (
    <div className="scrap-items-table cc-items-table">
      <table>
        <thead>
          <tr>
            {["Company", "Plant", "WH", "Material", "Descrição", "Qtd.", "Custo unit.", "Total", "Centro de custo", "Descrição CC"].map((label) => (
              <th key={label}>{label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {items.map((item, index) => (
            <tr key={index}>
              <td>{item.company}</td>
              <td>{item.plant}</td>
              <td>{item.wh}</td>
              <td className="code">{item.material}</td>
              <td>{item.description}</td>
              <td className="num">{qtyInput(item.quantity)}</td>
              <td className="num">{unitCostText(item.unitCost)}</td>
              <td className="num">{brMoney(ccItemTotal(item))}</td>
              <td>{item.costCenter}</td>
              <td>{item.costCenterDescription}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/* Conferência do PDF devolvido                                              */
/* ------------------------------------------------------------------------ */

/** Qualquer PDF pode ser anexado: aqui só aparece o que ele traz (assinaturas e o que falta). */
async function reviewUpload(kind: DocKind, form: AnyForm, name: string, bytes: Uint8Array, reading: ScrapPdfReading): Promise<Review> {
  const notes: string[] = [];
  // Mesmo conteúdo do PDF guardado: fica registrado como confirmação. Diferente não impede nada.
  const imported = !form.files.some((file) => file.kind === "generated");
  const original = imported ? form.files[0] : form.files.filter((file) => file.kind === "generated").at(-1);
  if (original && (!reading.formNumber || reading.formNumber === form.number))
    try {
      const { compareWithGenerated } = await pdfTools();
      const comparison = await compareWithGenerated(await fetchPdf(form, original.version), bytes);
      if (comparison.sameContent) notes.push(`Itens, valores e nomes são os mesmos ${imported ? "do PDF importado" : "do PDF emitido pelo portal"}.`);
    } catch {
      // Sem comparação: o arquivo entra do mesmo jeito.
    }
  const after = signatureProgress(form.data, reading.signatures, kind);
  if (after.complete) notes.push("Com este arquivo, todos os quadros obrigatórios ficam assinados.");
  else notes.push(`Depois deste arquivo ainda falta: ${after.missing.map((entry) => `${entry.expected} (${entry.slot.label})`).join(", ")}.`);
  return { name, bytes, reading, notes };
}

function ReviewPanel({ review, busy, onCancel, onSave }: { review: Review; busy: boolean; onCancel: () => void; onSave: () => void }) {
  return (
    <div className="scrap-review" role="region" aria-label="PDF anexado">
      <b>
        {review.name} · {(review.bytes.length / 1024).toFixed(0)} KB · {review.reading.signatures.length} assinatura(s)
      </b>
      <SignatureList signatures={review.reading.signatures} />
      {review.notes.map((text) => (
        <p key={text} className="scrap-review-note">
          <CheckCircle2 size={14} />
          {text}
        </p>
      ))}
      <div className="scrap-actions">
        <button disabled={busy} onClick={onCancel}>
          Cancelar
        </button>
        <button className="primary" disabled={busy} onClick={onSave}>
          <Save size={16} />
          {busy ? "Salvando…" : "Salvar esta versão"}
        </button>
      </div>
    </div>
  );
}

function SignatureList({ signatures }: { signatures: ScrapSignature[] }) {
  if (!signatures.length) return null;
  return (
    <ul className="scrap-signature-list">
      {signatures.map((signature, index) => (
        <li key={index} className={signature.check}>
          {signature.check === "invalid" ? <XCircle size={15} /> : signature.check === "unchecked" ? <TriangleAlert size={15} /> : <CheckCircle2 size={15} />}
          <span>
            <b>{signature.signer || "Sem nome"}</b> · {signature.slot ? slotById(signature.slot).label : `campo ${signature.field}`} · {brDateTime(signature.signedAt) || "sem data"}
            <small>{signature.detail}</small>
          </span>
        </li>
      ))}
    </ul>
  );
}

/* ------------------------------------------------------------------------ */

function SendPanel<F extends AnyForm>({ kind, form, canEdit, onSent, onError }: { kind: DocKind; form: F; canEdit: boolean; onSent: (form: F) => void; onError: (text: string) => void }) {
  const stage = form.status === "signed" ? "signed" : "signing";
  const [to, setTo] = useState(() => store.get(EMAIL_KEY[kind][stage]));
  const [sender, setSender] = useState(
    () => store.get(SENDER_KEY) || (kind === "cc" ? (form as CcForm).data.approvers.requester : store.json<Record<string, string>>(CC_APPROVERS_KEY)?.requester) || "",
  );
  const [done, setDone] = useState("");
  const message = useMemo(() => formEmail(kind, form, { sender, link: formLink(kind, form) }), [kind, form, sender]);
  const canShareFiles = typeof navigator !== "undefined" && typeof navigator.canShare === "function";
  function remember() {
    store.set(EMAIL_KEY[kind][stage], to.trim());
    store.set(SENDER_KEY, sender.trim());
  }
  async function markSent() {
    if (stage !== "signed" || !canEdit) return;
    try {
      onSent((await api<F>({ action: "sent", id: form.id }, kind)).form);
    } catch {
      // Marcar como enviado é só informativo.
    }
  }
  async function pdfFile() {
    const bytes = await fetchPdf(form);
    return { bytes, name: fileNameOf(kind, form) };
  }
  /** Rascunho .eml: o Outlook abre como mensagem nova, com o texto formatado e o PDF anexado. */
  async function draft() {
    try {
      remember();
      const { bytes, name } = await pdfFile();
      const eml = buildEml({ to, subject: message.subject, text: message.text, html: message.html, attachment: { name, bytes } });
      saveFile(new TextEncoder().encode(eml), emailFileName(name), "message/rfc822");
      setDone("E-mail pronto baixado. Abra o arquivo baixado: o Outlook mostra a mensagem com o texto e o PDF anexado. Confira e clique em Enviar.");
      await markSent();
    } catch (e) {
      onError((e as Error).message);
    }
  }
  async function share() {
    try {
      const { bytes, name } = await pdfFile();
      const file = new File([bytes.slice().buffer as ArrayBuffer], name, { type: "application/pdf" });
      if (!navigator.canShare?.({ files: [file] })) throw Error("Este navegador não compartilha arquivos. Use E-mail pronto com PDF.");
      await navigator.share({ files: [file], title: message.subject, text: message.text });
      setDone("Compartilhado.");
      await markSent();
    } catch (e) {
      if ((e as Error).name !== "AbortError") onError((e as Error).message);
    }
  }
  /** Programa de e-mail padrão (mailto): texto mais curto, o PDF é baixado para anexar. */
  async function email() {
    try {
      remember();
      const { bytes, name } = await pdfFile();
      saveFile(bytes, name);
      const href = `mailto:${encodeURIComponent(to.trim()).replace(/%40/g, "@").replace(/%2C/gi, ",").replace(/%3B/gi, ";")}?subject=${encodeURIComponent(message.subject)}&body=${encodeURIComponent(message.short)}`;
      window.location.href = href;
      setDone(`PDF baixado (${name}). Anexe-o no e-mail que abriu.`);
      await markSent();
    } catch (e) {
      onError((e as Error).message);
    }
  }
  /** Copia formatado (cola bonito no Outlook/Teams) e em texto simples. */
  async function copy() {
    try {
      if (typeof ClipboardItem === "function" && navigator.clipboard?.write) {
        await navigator.clipboard.write([
          new ClipboardItem({
            "text/html": new Blob([message.html], { type: "text/html" }),
            "text/plain": new Blob([message.text], { type: "text/plain" }),
          }),
        ]);
      } else await navigator.clipboard.writeText(`${message.subject}\n\n${message.text}`);
      setDone("Texto copiado. Cole no e-mail ou no Teams e anexe o PDF.");
    } catch {
      onError("Não foi possível copiar. Selecione o texto e copie manualmente.");
    }
  }
  return (
    <section className={`scrap-section scrap-send ${stage}`} aria-label="Enviar">
      <div className="scrap-section-head">
        <h4>{stage === "signed" ? "Enviar o PDF assinado" : "Enviar para assinatura"}</h4>
        <span>{stage === "signed" ? (form.sentAt ? `Enviado em ${brDateTime(form.sentAt)}` : "Ainda não enviado") : "O e-mail já vem escrito, com quem falta assinar"}</span>
      </div>
      <div className="scrap-send-row">
        <label>
          Para (e-mail)
          <input type="email" multiple value={to} placeholder={stage === "signed" ? "financeiro@empresa.com" : "quem assina"} onChange={(e) => setTo(e.target.value)} />
        </label>
        <label>
          Assinar o e-mail como
          <input value={sender} maxLength={80} placeholder="Seu nome" onChange={(e) => setSender(e.target.value)} />
        </label>
      </div>
      <div className="scrap-actions">
        <button className="primary" onClick={draft} title="Baixa o e-mail pronto (.eml): abre no Outlook com o texto formatado e o PDF anexado">
          <Mail size={16} />
          E-mail pronto com PDF
        </button>
        <button onClick={email} title="Abre o programa de e-mail padrão com o texto; o PDF é baixado para anexar">
          <Send size={16} />
          Abrir no e-mail
        </button>
        <button onClick={copy}>
          <Copy size={16} />
          Copiar texto
        </button>
        {canShareFiles && (
          <button onClick={share}>
            <Share2 size={16} />
            Compartilhar…
          </button>
        )}
      </div>
      <details className="scrap-send-preview">
        <summary>
          <Mail size={13} />
          {message.subject}
        </summary>
        {/* Num iframe: a prévia fica igual ao e-mail, sem o estilo do portal. */}
        <iframe className="scrap-email-preview" title="Prévia do e-mail" sandbox="" srcDoc={`<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:16px 18px;background:#fff">${message.html}</body></html>`} />
      </details>
      {done && <p className="scrap-review-note">{done}</p>}
    </section>
  );
}

/* ------------------------------------------------------------------------ */

/** Confere qualquer PDF no próprio navegador: nada é enviado ao servidor. */
function PdfCheckDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [result, setResult] = useState<{ name: string; reading: ScrapPdfReading } | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function check(file: File) {
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const { readScrapPdf } = await pdfTools();
      setResult({ name: file.name, reading: await readScrapPdf(new Uint8Array(await file.arrayBuffer()), { maxBytes: 30_000_000, legacy: true }) });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const valid = result?.reading.signatures.filter((entry) => entry.check === "valid").length || 0;
  const unchecked = result?.reading.signatures.filter((entry) => entry.check === "unchecked").length || 0;
  const invalid = result?.reading.signatures.filter((entry) => entry.check === "invalid").length || 0;
  const empty = result?.reading.fields.filter((field) => !field.signed) || [];
  return (
    <Dialog open={open} onOpenChange={(value) => !value && onClose()}>
      <DialogContent className="scrap-dialog scrap-check-dialog">
        <DialogHeader>
          <DialogTitle>Conferir assinaturas de um PDF</DialogTitle>
          <DialogDescription>Escolha qualquer Scrap Form ou FO.FI.C.007 (mesmo os feitos no Excel). A conferência acontece só neste navegador; o arquivo não é enviado.</DialogDescription>
        </DialogHeader>
        <label className="scrap-check-file">
          <FileSearch size={18} />
          {busy ? "Lendo…" : "Escolher PDF"}
          <input type="file" accept="application/pdf,.pdf" aria-label="PDF para conferir" onChange={(e) => e.target.files?.[0] && check(e.target.files[0])} />
        </label>
        {error && (
          <p className="scrap-review-block" role="alert">
            <XCircle size={14} />
            {error}
          </p>
        )}
        {result && (
          <div className="scrap-review">
            <b>
              {result.name} · {result.reading.pages} página(s){result.reading.formNumber ? ` · ${result.reading.formNumber}` : ""}
            </b>
            <p className={invalid ? "scrap-review-block" : valid ? "scrap-review-note" : "scrap-review-warn"}>
              {invalid ? <XCircle size={14} /> : <CheckCircle2 size={14} />}
              {invalid
                ? `${invalid} assinatura(s) inválida(s): o arquivo foi alterado depois de assinado. No Adobe elas aparecem como inválidas; quem assinou precisa assinar de novo num PDF novo.`
                : valid
                  ? `${valid} assinatura(s) válida(s)${unchecked ? `; ${unchecked} não conferida(s)` : ""}.`
                  : "Nenhuma assinatura digital neste PDF."}
            </p>
            <SignatureList signatures={result.reading.signatures} />
            {empty.length > 0 && <p className="scrap-review-warn">Campos ainda sem assinatura: {empty.map((field) => field.name).join(", ")}.</p>}
          </div>
        )}
        <div className="dialog-actions">
          <button onClick={onClose}>Fechar</button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------------ */
/* Adicionar PDFs: qualquer Scrap Form ou FO.FI.C.007 (Excel, portal, assinado ou não) */
/* ------------------------------------------------------------------------ */

type ImportTarget = { type: "new" } | { type: "version"; form: AnyForm; kind: DocKind } | { type: "stored"; number: string };
type ImportRow = {
  key: string;
  file: File;
  bytes: Uint8Array;
  kind: DocKind;
  data: ScrapFormData | CcFormData;
  reading: ScrapPdfReading | null;
  target: ImportTarget;
  /** Avisos de leitura (o PDF entra mesmo assim). */
  notes: string[];
  /** Problema que impede guardar (arquivo ilegível, maior que 1,5 MB). */
  error: string;
  selected: boolean;
  state: "ready" | "saving" | "done" | "failed";
  result: string;
};

const kindOfNumber = (number: string | null | undefined): DocKind | null => (/^CC-/.test(number || "") ? "cc" : /^SCRAP-/.test(number || "") ? "scrap" : null);
const blankData = (kind: DocKind): ScrapFormData | CcFormData => (kind === "cc" ? { ...emptyCcForm(null), items: [] } : { ...emptyForm(null), items: [] });
/** Assinaturas que contam: nova versão de um formulário do portal (upload) ou formulário novo (importação). */
const importSignatures = (row: Pick<ImportRow, "reading" | "target">) =>
  row.target.type === "version" ? acceptAttached(row.reading?.signatures || []) : acceptOriginal(row.reading?.signatures || []);

async function prepareImport(file: File, forms: AnyForm[], known: Map<string, string>, defaultKind: DocKind, forced?: DocKind): Promise<ImportRow> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const [{ readLegacyPdf }, { readScrapPdf }] = await Promise.all([import("@/lib/legacy-import"), pdfTools()]);
  const notes: string[] = [];
  let error = "";
  // Tipo: o escolhido, o do PDF (dados do portal, título, nome do arquivo) ou o da aba aberta.
  let legacy: LegacyDocument | null = null;
  try {
    legacy = await readLegacyPdf(bytes, file.name, forced);
    if (!legacy.kind) legacy = await readLegacyPdf(bytes, file.name, defaultKind);
  } catch {
    legacy = null;
  }
  const kind: DocKind = legacy?.kind || forced || defaultKind;
  const data = legacy?.kind ? legacy.data : blankData(kind);
  if (legacy) notes.push(...legacy.notes.filter((note) => !/Não reconheci o formulário/.test(note)));
  let reading: ScrapPdfReading | null = null;
  try {
    reading = await readScrapPdf(bytes, { maxBytes: 30_000_000, legacy: true, kind });
  } catch (e) {
    error = (e as Error).message;
  }
  if (!error && bytes.length > MAX_PDF_BYTES) error = "O PDF passa de 1,5 MB, o limite do portal.";
  // Onde entra: o mesmo arquivo já guardado, versão nova do formulário do portal ou formulário novo.
  const stored = reading ? known.get(reading.sha256) : undefined;
  const number = reading?.formNumber || "";
  const existing = number ? forms.find((form) => form.number === number) : undefined;
  let target: ImportTarget = { type: "new" };
  if (stored) target = { type: "stored", number: stored };
  else if (existing && existing.status !== "draft") target = { type: "version", form: existing, kind: kindOfNumber(number) || kind };
  else if (existing) notes.push(`O ${number} está em rascunho no portal: este PDF entra como formulário novo.`);
  else if (number) notes.push(`PDF emitido pelo portal (${number}), mas esse número não está na lista: entra como formulário novo.`);
  let selected = !error && target.type !== "stored";
  if (target.type === "version") {
    const before = signatureProgress(target.form.data, target.form.signatures, target.kind).signed.length;
    const after = signatureProgress(target.form.data, acceptAttached(reading?.signatures || []), target.kind).signed.length;
    if (after < before) {
      notes.push(`O ${number} já tem ${before} assinatura(s) e este PDF tem ${after}. Marque se quiser guardar mesmo assim (passa a valer este arquivo).`);
      selected = false;
    }
  }
  return { key: `${file.name}:${file.size}:${file.lastModified}`, file, bytes, kind, data, reading, target, notes, error, selected, state: "ready", result: "" };
}
const importDate = (row: ImportRow) => (row.kind === "scrap" ? (row.data as ScrapFormData).formDate : `${(row.data as CcFormData).period}-01`) || "9999";

function ImportDialog({ existing, defaultKind, onImported, onClose }: { existing: AnyForm[]; defaultKind: DocKind; onImported: () => void; onClose: () => void }) {
  const [rows, setRows] = useState<ImportRow[]>([]),
    [reading, setReading] = useState(""),
    [saving, setSaving] = useState(false),
    [summary, setSummary] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const known = useMemo(() => {
    const map = new Map<string, string>();
    for (const form of existing) for (const file of form.files) map.set(file.sha256, form.number);
    return map;
  }, [existing]);
  const update = (key: string, patch: Partial<ImportRow>) => setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)));

  async function add(files: File[]) {
    const pdfs = files.filter((file) => /\.pdf$/i.test(file.name) || file.type === "application/pdf");
    const fresh = pdfs.filter((file) => !rows.some((row) => row.key === `${file.name}:${file.size}:${file.lastModified}`));
    const read: ImportRow[] = [];
    for (let i = 0; i < fresh.length; i++) {
      setReading(`Lendo ${i + 1} de ${fresh.length}: ${fresh[i].name}`);
      const row = await prepareImport(fresh[i], existing, known, defaultKind);
      // O mesmo arquivo escolhido duas vezes (nomes diferentes).
      const twin = [...rows, ...read].find((other) => other.reading && row.reading && other.reading.sha256 === row.reading.sha256);
      if (twin) {
        row.notes.push(`É o mesmo arquivo de "${twin.file.name}".`);
        row.selected = false;
      }
      read.push(row);
    }
    setReading("");
    setRows((current) => [...current, ...read].sort((a, b) => importDate(a).localeCompare(importDate(b))));
    if (input.current) input.current.value = "";
  }
  async function changeKind(row: ImportRow, kind: DocKind) {
    const next = await prepareImport(row.file, existing, known, defaultKind, kind);
    setRows((current) => current.map((entry) => (entry.key === row.key ? next : entry)));
  }
  async function importAll() {
    // Versões do mesmo formulário: a com mais assinaturas por último (fica valendo).
    const signedCount = (row: ImportRow) => importSignatures(row).length;
    const queue = rows
      .filter((row) => row.selected && !row.error && row.state !== "done" && row.target.type !== "stored")
      .sort((a, b) => importDate(a).localeCompare(importDate(b)) || signedCount(a) - signedCount(b));
    setSaving(true);
    setSummary("");
    const revisions = new Map<string, number>();
    let done = 0,
      failed = 0;
    for (const row of queue) {
      update(row.key, { state: "saving" });
      try {
        const pdf = toBase64(row.bytes);
        let form: AnyForm;
        if (row.target.type === "version") {
          const target = row.target.form;
          form = (
            await api<AnyForm>(
              { action: "upload", id: target.id, revision: revisions.get(target.id) ?? target.revision, kind: "signed", name: row.file.name, pdf, signatures: importSignatures(row) },
              row.target.kind,
            )
          ).form;
          revisions.set(target.id, form.revision);
        } else form = (await api<AnyForm>({ action: "import", name: row.file.name, data: row.data, pdf, signatures: importSignatures(row) }, row.kind)).form;
        update(row.key, { state: "done", result: form.number, selected: false });
        done++;
      } catch (e) {
        update(row.key, { state: "failed", result: (e as Error).message });
        failed++;
      }
    }
    setSaving(false);
    setSummary(`${done} PDF(s) guardado(s)${failed ? `; ${failed} com erro (veja na lista)` : ""}.`);
    if (done) onImported();
  }

  const ready = rows.filter((row) => row.selected && !row.error && row.state !== "done" && row.target.type !== "stored");
  return (
    <Dialog open onOpenChange={(open) => !open && !saving && onClose()}>
      <DialogContent className="scrap-dialog import-dialog">
        <DialogHeader>
          <DialogTitle>Adicionar PDFs</DialogTitle>
          <DialogDescription>
            Escolha qualquer Scrap Form ou FO.FI.C.007 em PDF: do Excel, do portal, assinado ou não. O portal lê os itens e as assinaturas e guarda o
            PDF. O PDF de um formulário que já está no portal entra como versão nova dele.
          </DialogDescription>
        </DialogHeader>
        <label className={`scrap-check-file${saving ? " disabled" : ""}`}>
          <Upload size={18} />
          {reading || (rows.length ? "Escolher mais PDFs" : "Escolher PDFs")}
          <input ref={input} type="file" multiple accept="application/pdf,.pdf" aria-label="PDFs para importar" disabled={saving || !!reading} onChange={(e) => e.target.files && add(Array.from(e.target.files))} />
        </label>
        {rows.length > 0 && (
          <ul className="import-list" aria-label="PDFs escolhidos">
            {rows.map((row) => (
              <ImportRowView key={row.key} row={row} disabled={saving} onToggle={(selected) => update(row.key, { selected })} onKind={(kind) => changeKind(row, kind)} />
            ))}
          </ul>
        )}
        {summary && (
          <p className="scrap-review-note" role="status">
            <CheckCircle2 size={14} />
            {summary}
          </p>
        )}
        <div className="dialog-actions scrap-footer">
          <button disabled={saving} onClick={onClose}>
            Fechar
          </button>
          <button className="primary" disabled={saving || !!reading || !ready.length} onClick={importAll}>
            <Upload size={16} />
            {saving ? "Guardando…" : `Adicionar ${ready.length} PDF(s)`}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ImportRowView({ row, disabled, onToggle, onKind }: { row: ImportRow; disabled: boolean; onToggle: (selected: boolean) => void; onKind: (kind: DocKind) => void }) {
  const { reading, target } = row;
  const kind = target.type === "version" ? target.kind : row.kind;
  // Na ordem dos quadros do formulário (Produção → Financeiro / Solicitante → Financeiro); campo fora dos quadros no fim.
  const order = (slot: ScrapSignature["slot"]) => {
    const index = (kind === "cc" ? CC_SLOTS : SLOTS).findIndex((entry) => entry.id === slot);
    return index < 0 ? 99 : index;
  };
  const signatures = [...importSignatures(row)].sort((a, b) => order(a.slot) - order(b.slot));
  const progress = signatureProgress(target.type === "version" ? target.form.data : row.data, signatures, kind);
  let summary = "";
  if (target.type === "version") summary = `${target.form.number} · ${STATUS_LABEL[target.form.status]} no portal`;
  else if (row.kind === "scrap") {
    const data = row.data as ScrapFormData;
    const first = data.items[0];
    summary = `${brDate(data.formDate)} · ${data.items.length} item(s) · ${brMoney(formTotal(data))}${first ? ` · ${first.material} ${first.name}` : ""}`;
  } else {
    const data = row.data as CcFormData;
    const first = data.items[0];
    summary = `${periodLabel(data.period)} · ${data.items.length} item(s) · ${brMoney(ccTotals(data).cost)}${first ? ` · ${first.material} ${first.description}` : ""}`;
  }
  const missing = progress.missing.map((entry) => entry.slot.label).join(", ");
  const outcome =
    target.type === "stored"
      ? `Já está guardado no portal (${target.number}).`
      : target.type === "version"
        ? `Entra como versão nova do ${target.form.number} · ${progress.complete ? "fica Assinado" : `falta ${missing}`}`
        : !signatures.length
          ? "Sem assinatura: entra aguardando assinatura, com o PDF guardado"
          : progress.complete
            ? "Entra como Assinado"
            : `Entra aguardando: falta ${missing}`;
  return (
    <li className={`import-row ${row.state}${row.error ? " blocked" : ""}`}>
      <div className="import-row-head">
        <label className="import-pick">
          <input
            type="checkbox"
            checked={row.selected}
            disabled={disabled || !!row.error || row.state === "done" || target.type === "stored"}
            onChange={(e) => onToggle(e.target.checked)}
            aria-label={`Importar ${row.file.name}`}
          />
          <b>{row.file.name}</b>
        </label>
        <select value={kind} disabled={disabled || row.state === "done" || target.type !== "new"} aria-label={`Tipo de ${row.file.name}`} onChange={(e) => onKind(e.target.value as DocKind)}>
          <option value="scrap">Scrap Form</option>
          <option value="cc">FO.FI.C.007</option>
        </select>
        {row.state === "done" && <i className="scrap-status signed">{row.result}</i>}
        {row.state === "saving" && <i className="scrap-status signing">Guardando…</i>}
      </div>
      {summary && <span className="import-summary">{summary}</span>}
      {signatures.length > 0 && (
        <span className="import-signatures">
          {signatures.map((signature, index) => (
            <i key={index} className={signature.check}>
              {signature.slot ? slotById(signature.slot).label : "fora dos quadros"}: {signature.signer || "sem nome"}
              {accepted(signature) ? " ✓" : " ?"}
            </i>
          ))}
        </span>
      )}
      {!row.error && row.state !== "done" && <span className="import-outcome">{outcome}</span>}
      {row.state === "failed" && <p className="scrap-review-block">{row.result}</p>}
      {row.error && (
        <p className="scrap-review-block">
          <XCircle size={13} />
          {row.error}
        </p>
      )}
      {row.state !== "done" &&
        row.notes.map((text) => (
          <p key={text} className="scrap-review-warn">
            <TriangleAlert size={13} />
            {text}
          </p>
        ))}
    </li>
  );
}
