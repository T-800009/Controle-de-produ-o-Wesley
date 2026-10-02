import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import {
  CheckCircle2,
  Clock3,
  Copy,
  Download,
  Eye,
  FilePlus2,
  FileSearch,
  FileText,
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
  XCircle,
} from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { requestJson } from "@/lib/api";
import {
  CAUSES,
  MAX_ITEMS,
  SLOTS,
  brDate,
  brDateTime,
  brMoney,
  defaultApprovers,
  emptyForm,
  emptyItem,
  formHistory,
  formTotal,
  itemTotal,
  materialCode,
  parseBrNumber,
  pdfFileName,
  pdfProblems,
  requiredSlots,
  shareMessage,
  signatureProgress,
  strongestClass,
  summarizeForms,
  type ScrapForm,
  type ScrapFormData,
  type ScrapItem,
  type ScrapSignature,
} from "@/lib/scrap-form";
import type { ScrapPdfReading } from "@/lib/scrap-pdf";

const pdfTools = () => import("@/lib/scrap-pdf");

const APPROVERS_KEY = "wbyd:scrap:responsaveis";
const EMAIL_KEY = { signing: "wbyd:scrap:email-assinatura", signed: "wbyd:scrap:email-final" } as const;
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
};

type Lookup = { description: string; unit: string; boms: { bom: string; classification: string; description: string }[] };
type ListResponse = { forms: ScrapForm[]; canEdit: boolean; canDelete: boolean; role: string };
type Review = {
  name: string;
  bytes: Uint8Array;
  reading: ScrapPdfReading;
  blockers: string[];
  warnings: string[];
  notes: string[];
};

const STATUS_LABEL: Record<ScrapForm["status"], string> = { draft: "Rascunho", signing: "Aguardando assinatura", signed: "Assinado" };
const fmt = (value: number) => value.toLocaleString("pt-BR");
const moneyInput = (value: number | null) =>
  value === null ? "" : value.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qtyInput = (value: number | null) => (value === null ? "" : value.toLocaleString("pt-BR", { maximumFractionDigits: 3 }));

function toBase64(bytes: Uint8Array) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
function saveFile(bytes: Uint8Array, name: string) {
  if (typeof URL.createObjectURL !== "function") return;
  const url = URL.createObjectURL(new Blob([bytes.slice().buffer as ArrayBuffer], { type: "application/pdf" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
async function fetchPdf(form: ScrapForm, version = form.fileVersion) {
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
const api = (body: unknown) => requestJson("/api/scrap-forms", body, 60_000) as Promise<{ form: ScrapForm }>;
const formLink = (form: ScrapForm) => {
  try {
    return `${location.origin}/?modulo=baixas&scrap=${form.id}`;
  } catch {
    return "";
  }
};

/* ------------------------------------------------------------------------ */

export default function ScrapForms() {
  return <ScrapFormList />;
}

function SignaturePills({ form }: { form: Pick<ScrapForm, "data" | "signatures" | "status"> }) {
  const progress = signatureProgress(form.data, form.signatures);
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
function statusText(form: ScrapForm) {
  if (form.status === "draft") return "Rascunho";
  if (form.status === "signed") return "Assinado";
  const missing = signatureProgress(form.data, form.signatures).missing;
  return missing.length ? `Falta ${missing.map((entry) => entry.slot.label).join(", ")}` : "Conferir assinaturas";
}

function ScrapFormList() {
  const [list, setList] = useState<ListResponse | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [query, setQuery] = useState(""),
    [status, setStatus] = useState("all"),
    [month, setMonth] = useState("all"),
    [opened, setOpened] = useState<{ id: string | null; session: number } | null>(null),
    [checking, setChecking] = useState(false),
    [ops, setOps] = useState<string[]>([]);
  const deferredQuery = useDeferredValue(query);
  const run = useRef(0),
    deepLink = useRef<string | null>(null);

  async function load() {
    const n = ++run.current;
    setBusy(true);
    setError("");
    try {
      const data = (await requestJson("/api/scrap-forms")) as ListResponse;
      if (n !== run.current) return;
      setList(data);
      if (deepLink.current && data.forms.some((form) => form.id === deepLink.current)) setOpened({ id: deepLink.current, session: Date.now() });
      deepLink.current = null;
    } catch (e) {
      if (n === run.current) setError((e as Error).message);
    } finally {
      if (n === run.current) setBusy(false);
    }
  }
  useEffect(() => {
    try {
      const id = new URLSearchParams(location.search).get("scrap");
      if (id && /^[a-f0-9-]{36}$/i.test(id)) deepLink.current = id;
    } catch {
      // Sem endereço: nada a abrir.
    }
    void load();
    // OPs das BOMs cadastradas (só metadados) para sugerir no campo Ordem.
    requestJson("/api/data")
      .then((models: { ops?: string[] }[]) => setOps([...new Set(models.flatMap((model) => model.ops || []))].sort().reverse()))
      .catch(() => {});
    return () => {
      run.current++;
    };
  }, []);

  function replace(form: ScrapForm) {
    setList((current) =>
      current ? { ...current, forms: current.forms.some((entry) => entry.id === form.id) ? current.forms.map((entry) => (entry.id === form.id ? form : entry)) : [form, ...current.forms] } : current,
    );
  }
  function remove(id: string) {
    setList((current) => (current ? { ...current, forms: current.forms.filter((form) => form.id !== id) } : current));
  }

  const forms = list?.forms || [];
  const months = useMemo(() => [...new Set(forms.map((form) => form.data.formDate.slice(0, 7)).filter(Boolean))].sort().reverse(), [forms]);
  const filtered = useMemo(() => {
    const text = deferredQuery.trim().toLowerCase();
    return forms.filter(
      (form) =>
        (status === "all" || form.status === status || (status === "finance" && form.status === "signing" && statusText(form) === "Falta Financeiro")) &&
        (month === "all" || form.data.formDate.startsWith(month)) &&
        [form.number, form.data.sapDocument, form.data.costCenter, ...form.data.items.flatMap((item) => [item.material, item.name, item.op, item.vin, item.defect])]
          .join(" ")
          .toLowerCase()
          .includes(text),
    );
  }, [forms, deferredQuery, status, month]);
  const summary = useMemo(() => summarizeForms(forms), [forms]);
  const drafts = forms.filter((form) => form.status === "draft").length;
  const current = opened ? (opened.id ? forms.find((form) => form.id === opened.id) || null : null) : null;
  // Formulário apagado por outra pessoa enquanto estava aberto.
  useEffect(() => {
    if (opened?.id && list && !list.forms.some((form) => form.id === opened.id)) {
      setOpened(null);
      setError("Este formulário foi apagado por outra pessoa.");
    }
  }, [list, opened?.id]);
  const hasFilters = !!query.trim() || status !== "all" || month !== "all";

  return (
    <section className="shortages panel scrap-forms" aria-label="Scrap Forms">
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
          <button onClick={() => setChecking(true)}>
            <FileSearch size={16} />
            Conferir um PDF
          </button>
          <button disabled={busy} onClick={load} aria-label="Atualizar lista">
            <RefreshCw size={16} className={busy ? "spin" : ""} />
            {busy ? "Lendo…" : "Atualizar"}
          </button>
        </div>
      </div>

      {error && (
        <div className="notice" role="alert">
          <TriangleAlert size={18} />
          <div>
            <b>{error}</b>
          </div>
          <button onClick={load}>Tentar novamente</button>
        </div>
      )}
      {!list && busy && (
        <div className="empty" role="status">
          <RefreshCw className="spin" />
          <h3>Carregando os formulários…</h3>
        </div>
      )}

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
                    <SignaturePills form={form} />
                    <span className="scrap-row-status">
                      <i className={`scrap-status ${form.status}`}>{statusText(form)}</i>
                      {form.status === "signed" && <small>{form.sentAt ? `Enviado ${brDate(form.sentAt.slice(0, 10))}` : "Ainda não enviado"}</small>}
                      {form.data.sapDocument && <small>Doc. SAP {form.data.sapDocument}</small>}
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
          canEdit={list.canEdit}
          canDelete={list.canDelete}
          onSaved={(form) => {
            replace(form);
            setOpened((current) => (current ? { ...current, id: form.id } : current));
          }}
          onDeleted={(id) => {
            remove(id);
            setOpened(null);
          }}
          onClose={() => setOpened(null)}
        />
      )}
      <PdfCheckDialog open={checking} onClose={() => setChecking(false)} />
    </section>
  );
}

/* ------------------------------------------------------------------------ */

function ScrapFormDialog({
  form,
  forms,
  ops,
  canEdit,
  canDelete,
  onSaved,
  onDeleted,
  onClose,
}: {
  form: ScrapForm | null;
  forms: ScrapForm[];
  ops: string[];
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
  const [busy, setBusy] = useState(""),
    [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null),
    [showProblems, setShowProblems] = useState(false),
    [review, setReview] = useState<Review | null>(null),
    [preview, setPreview] = useState<string | null>(null),
    [posting, setPosting] = useState({ costCenter: form?.data.costCenter || "", sapDocument: form?.data.sapDocument || "" });
  const fileInput = useRef<HTMLInputElement>(null);
  const editable = canEdit && (!form || form.status === "draft");
  const problems = useMemo(() => pdfProblems(data), [data]);
  const history = useMemo(() => formHistory(forms.filter((entry) => entry.id !== form?.id)), [forms, form?.id]);
  const lookups = useMaterialLookups(editable ? data.items.map((item) => item.material) : []);
  const [mm60, setMm60] = useState<Map<string, { price: number; description: string }> | null>(null);

  // Quando o form salvo muda (outra aba ou depois de salvar), a tela acompanha.
  useEffect(() => {
    if (form && !dirty) {
      setData(form.data);
      setBaseRevision(form.revision);
      setPosting({ costCenter: form.data.costCenter, sapDocument: form.data.sapDocument });
    }
  }, [form?.revision]);
  useEffect(() => () => void (preview && URL.revokeObjectURL?.(preview)), [preview]);
  // Mensagem nova (PDF gerado, versão salva, erro): leva o diálogo para o topo, onde ela aparece.
  useEffect(() => {
    if (message) document.querySelector(".scrap-dialog")?.scrollTo?.({ top: 0, behavior: "smooth" });
  }, [message]);

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

  /** Item removido/duplicado: o que já foi preenchido sozinho continua ligado ao item certo. */
  function shiftMarks(at: number, delta: 1 | -1) {
    const next = new Map<number, { material: string; op: string }>();
    for (const [index, mark] of filled.current) {
      if (index < at || (delta > 0 && index === at)) next.set(index, mark);
      else if (delta < 0 && index > at) next.set(index - 1, mark);
      else if (delta > 0 && index > at) next.set(index + 1, mark);
    }
    if (delta > 0 && filled.current.has(at)) next.set(at + 1, { ...filled.current.get(at)! });
    filled.current = next;
  }
  function change(next: ScrapFormData) {
    setData(next);
    setDirty(true);
    setMessage(null);
  }
  function setItem(index: number, patch: Partial<ScrapItem>) {
    change({ ...data, items: data.items.map((item, i) => (i === index ? { ...item, ...patch } : item)) });
  }
  function close() {
    if (editable && dirty && data.items.some((item) => item.material || item.defect) && !window.confirm("Fechar sem salvar as alterações deste formulário?")) return;
    onClose();
  }
  async function run<T>(label: string, task: () => Promise<T>) {
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
  async function saveDraft(): Promise<ScrapForm | undefined> {
    const saved = form ? (await api({ action: "update", id: form.id, revision: baseRevision, data })).form : (await api({ action: "create", data })).form;
    setDirty(false);
    setBaseRevision(saved.revision);
    onSaved(saved);
    return saved;
  }
  async function generate() {
    setShowProblems(true);
    await run("generate", async () => {
      const saved = dirty || !form ? await saveDraft() : form;
      if (!saved) return;
      if (problems.length) throw Error("Rascunho salvo. Complete os campos marcados para gerar o PDF.");
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
  async function readMm60() {
    await run("mm60", async () => {
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
      const prices = mm60Prices(decodeAnaSource(text, response.headers.get("X-Source-Format"), "MM60"));
      setMm60(prices);
      const found = data.items.filter((item) => item.material && prices.has(item.material)).length;
      setMessage({ kind: found ? "ok" : "error", text: found ? `MM60 lida: preço encontrado para ${found} de ${data.items.length} item(s). Itens que já tinham preço não foram alterados.` : "A MM60 foi lida, mas nenhum P/N deste formulário está nela." });
    });
  }
  async function chooseSigned(file: File) {
    if (!form) return;
    await run("read", async () => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const { readScrapPdf } = await pdfTools();
      const reading = await readScrapPdf(bytes);
      setReview(await reviewUpload(form, file.name, bytes, reading));
    });
    if (fileInput.current) fileInput.current.value = "";
  }
  async function saveReview() {
    if (!form || !review) return;
    await run("upload", async () => {
      const next = (await api({ action: "upload", id: form.id, revision: form.revision, kind: "signed", name: review.name, pdf: toBase64(review.bytes), signatures: review.reading.signatures })).form;
      onSaved(next);
      setReview(null);
      const progress = signatureProgress(next.data, next.signatures);
      setMessage({
        kind: "ok",
        text: progress.complete
          ? "Todas as assinaturas conferidas. O PDF final está guardado: use Enviar para mandar ao Financeiro / arquivo."
          : `Versão ${next.fileVersion} guardada. Falta: ${progress.missing.map((entry) => `${entry.expected} (${entry.slot.label})`).join(", ")}.`,
      });
    });
  }
  async function showPdf() {
    if (!form) return;
    await run("view", async () => {
      const bytes = await fetchPdf(form);
      if (typeof URL.createObjectURL !== "function") throw Error("Este navegador não mostra PDF aqui. Use Baixar PDF.");
      setPreview(URL.createObjectURL(new Blob([bytes.slice().buffer as ArrayBuffer], { type: "application/pdf" })));
    });
  }
  async function download(version?: number, name?: string) {
    if (!form) return;
    await run("download", async () => saveFile(await fetchPdf(form, version), name || pdfFileName(form)));
  }
  async function reopen() {
    if (!form || !window.confirm("Reabrir para corrigir? As assinaturas já coletadas deixam de valer: será preciso gerar um PDF novo e assinar de novo. Os PDFs atuais ficam no histórico.")) return;
    await run("reopen", async () => {
      const next = (await api({ action: "reopen", id: form.id, revision: form.revision })).form;
      setDirty(false);
      setData(next.data);
      onSaved(next);
    });
  }
  async function destroy() {
    if (!form || !window.confirm(`Apagar o ${form.number} e todos os PDFs dele? Não dá para desfazer.`)) return;
    await run("delete", async () => {
      await api({ action: "delete", id: form.id, revision: form.revision });
      onDeleted(form.id);
    });
  }
  async function savePosting() {
    if (!form) return;
    await run("posting", async () => {
      const next = (await api({ action: "posting", id: form.id, revision: form.revision, ...posting })).form;
      onSaved(next);
      setMessage({ kind: "ok", text: "Dados da baixa no SAP salvos." });
    });
  }

  const progress = form ? signatureProgress(form.data, form.signatures) : null;
  const missingByItem = useMemo(() => (showProblems ? data.items.map(missingFields) : []), [showProblems, data]);
  const title = form ? `${form.number} · ${STATUS_LABEL[form.status]}` : "Novo Scrap Form";

  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent className="scrap-dialog">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {form
              ? `Criado em ${brDateTime(form.createdAt)}${form.status === "signed" && form.signedAt ? ` · assinado por todos em ${brDateTime(form.signedAt)}` : ""}${form.sentAt ? ` · enviado em ${brDateTime(form.sentAt)}` : ""}`
              : "Preencha os itens. Descrição e classe vêm da BOM; o preço pode vir da MM60."}
          </DialogDescription>
        </DialogHeader>

        {message && (
          <div className={`scrap-message ${message.kind}`} role={message.kind === "error" ? "alert" : "status"}>
            {message.kind === "error" ? <TriangleAlert size={16} /> : <CheckCircle2 size={16} />}
            <span>{message.text}</span>
          </div>
        )}

        {form && form.status !== "draft" && progress && (
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
              <button className={progress.complete ? "primary" : ""} disabled={!!busy} onClick={() => download()}>
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
        )}

        {form && form.status !== "draft" && <SendPanel key={form.status} form={form} canEdit={canEdit} onSent={onSaved} onError={(text) => setMessage({ kind: "error", text })} />}

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
                    shiftMarks(index, -1);
                    change({ ...data, items: data.items.filter((_, i) => i !== index) });
                  }}
                  onDuplicate={() => {
                    if (data.items.length >= MAX_ITEMS) return;
                    shiftMarks(index, 1);
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

        {form && form.status === "signed" && (
          <section className="scrap-section" aria-label="Baixa no SAP">
            <div className="scrap-section-head">
              <h4>Baixa no SAP</h4>
              <span>Opcional: fica só no portal, não altera o PDF assinado</span>
            </div>
            <div className="scrap-approvers scrap-posting">
              <label>
                Centro de custo
                <input value={posting.costCenter} maxLength={40} disabled={!canEdit} onChange={(e) => setPosting({ ...posting, costCenter: e.target.value })} />
              </label>
              <label>
                Documento SAP da baixa
                <input value={posting.sapDocument} maxLength={40} disabled={!canEdit} onChange={(e) => setPosting({ ...posting, sapDocument: e.target.value })} />
              </label>
              {canEdit && (
                <button disabled={!!busy || (posting.costCenter === form.data.costCenter && posting.sapDocument === form.data.sapDocument)} onClick={savePosting}>
                  <Save size={16} />
                  Salvar baixa
                </button>
              )}
            </div>
          </section>
        )}

        {form && form.files.length > 0 && (
          <details className="scrap-history">
            <summary>Histórico de PDFs ({form.files.length})</summary>
            <ul>
              {[...form.files].reverse().map((file) => (
                <li key={file.version}>
                  <span>
                    v{file.version} · {file.kind === "generated" ? "emitido pelo portal" : "devolvido com assinaturas"} · {brDateTime(file.createdAt)} · {(file.size / 1024).toFixed(0)} KB
                  </span>
                  <button disabled={!!busy} onClick={() => download(file.version, file.name)}>
                    <Download size={14} />
                    Baixar
                  </button>
                </li>
              ))}
            </ul>
          </details>
        )}

        {showProblems && problems.length > 0 && editable && (
          <ul className="scrap-problems" role="alert" aria-label="O que falta para gerar o PDF">
            {problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        )}

        <div className="dialog-actions scrap-footer">
          {form && (canDelete || (canEdit && form.status === "draft" && !form.files.length)) && (
            <button className="scrap-delete" disabled={!!busy} onClick={destroy}>
              <Trash2 size={16} />
              Apagar
            </button>
          )}
          {form && form.status !== "draft" && canEdit && (form.status !== "signed" || canDelete) && (
            <button disabled={!!busy} onClick={reopen}>
              <RotateCcw size={16} />
              Reabrir para corrigir
            </button>
          )}
          <button disabled={!!busy} onClick={close}>
            Fechar
          </button>
          {editable && (
            <>
              <button disabled={!!busy || !dirty} onClick={() => run("save", saveDraft)}>
                <Save size={16} />
                {busy === "save" ? "Salvando…" : "Salvar rascunho"}
              </button>
              <button className="primary" disabled={!!busy} onClick={generate}>
                <FileText size={16} />
                {busy === "generate" ? "Gerando PDF…" : "Gerar PDF para assinatura"}
              </button>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function readApprovers() {
  try {
    return defaultApprovers(JSON.parse(store.get(APPROVERS_KEY) || "{}"));
  } catch {
    return defaultApprovers(null);
  }
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
    ];
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
  const [price, setPrice] = useState(moneyInput(item.unitPrice));
  const [quantity, setQuantity] = useState(qtyInput(item.quantity));
  useEffect(() => {
    if (parseBrNumber(price) !== item.unitPrice) setPrice(moneyInput(item.unitPrice));
  }, [item.unitPrice]);
  useEffect(() => {
    if (parseBrNumber(quantity) !== item.quantity) setQuantity(qtyInput(item.quantity));
  }, [item.quantity]);
  const field = (name: string) => (missing.has(name) ? "missing" : undefined);
  const bomClass = lookup ? strongestClass(lookup.boms.map((bom) => bom.classification)) : "";
  const hints: { text: string; action?: () => void; label?: string }[] = [];
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
      {hints.length > 0 && (
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
      )}
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

async function reviewUpload(form: ScrapForm, name: string, bytes: Uint8Array, reading: ScrapPdfReading): Promise<Review> {
  const blockers: string[] = [],
    warnings: string[] = [],
    notes: string[] = [];
  if (reading.formNumber && reading.formNumber !== form.number) blockers.push(`Este PDF é do formulário ${reading.formNumber}, não do ${form.number}.`);
  if (!reading.signatures.length) blockers.push("Este PDF ainda não tem nenhuma assinatura digital. Anexe o arquivo devolvido depois de assinado no Adobe.");
  const latest = form.files.at(-1);
  if (latest && latest.sha256 === reading.sha256) blockers.push("Este arquivo é igual à versão já guardada.");
  // Assinaturas já registradas precisam continuar no arquivo novo (senão é uma cópia mais antiga).
  const lost = form.signatures.filter(
    (old) => old.check === "valid" && !reading.signatures.some((entry) => entry.check === "valid" && entry.slot === old.slot && entry.signer === old.signer && entry.signedAt === old.signedAt),
  );
  for (const old of lost) blockers.push(`A assinatura de ${old.signer} (${SLOTS.find((slot) => slot.id === old.slot)?.label || old.field}) não está neste arquivo: é uma cópia mais antiga. Anexe o PDF mais recente.`);
  // A página tem de ser a mesma emitida pelo portal (itens, valores, nomes) e, por cima, só campos de assinatura.
  const generated = form.files.filter((file) => file.kind === "generated").at(-1);
  if (!generated) warnings.push("Não há PDF emitido pelo portal para comparar o conteúdo.");
  else {
    const { compareWithGenerated } = await pdfTools();
    let comparison: Awaited<ReturnType<typeof compareWithGenerated>> | null = null;
    try {
      comparison = await compareWithGenerated(await fetchPdf(form, generated.version), bytes);
    } catch {
      comparison = null;
    }
    if (!comparison) blockers.push("Não foi possível comparar este PDF com o emitido pelo portal. Tente de novo.");
    else {
      if (!comparison.sameContent)
        blockers.push(
          comparison.pages !== 1
            ? `O PDF tem ${comparison.pages} páginas: não é o formulário emitido pelo portal (que tem uma). Assinem o PDF baixado aqui.`
            : "O conteúdo da página não é o mesmo do PDF emitido pelo portal (itens, valores ou nomes diferentes, ou PDF de outra versão). Assinem o PDF baixado aqui.",
        );
      if (comparison.extraAnnotations.length)
        blockers.push(`Há desenhos ou textos colocados por cima do formulário (${comparison.extraAnnotations.join(", ")}). Só as assinaturas podem ser acrescentadas.`);
      warnings.push(...comparison.notes);
      if (comparison.sameContent && !comparison.extraAnnotations.length) notes.push("Itens, valores e nomes são os mesmos do PDF emitido pelo portal.");
    }
  }
  const after = signatureProgress(form.data, reading.signatures);
  if (after.complete) notes.push("Com este arquivo, todos os quadros obrigatórios ficam assinados.");
  else notes.push(`Depois deste arquivo ainda falta: ${after.missing.map((entry) => `${entry.expected} (${entry.slot.label})`).join(", ")}.`);
  return { name, bytes, reading, blockers, warnings: [...warnings, ...after.issues], notes };
}

function ReviewPanel({ review, busy, onCancel, onSave }: { review: Review; busy: boolean; onCancel: () => void; onSave: () => void }) {
  return (
    <div className="scrap-review" role="region" aria-label="Conferência do PDF anexado">
      <b>
        {review.name} · {(review.bytes.length / 1024).toFixed(0)} KB · {review.reading.signatures.length} assinatura(s)
      </b>
      <SignatureList signatures={review.reading.signatures} />
      {review.blockers.map((text) => (
        <p key={text} className="scrap-review-block">
          <XCircle size={14} />
          {text}
        </p>
      ))}
      {review.warnings.map((text) => (
        <p key={text} className="scrap-review-warn">
          <TriangleAlert size={14} />
          {text}
        </p>
      ))}
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
        <button className="primary" disabled={busy || review.blockers.length > 0} onClick={onSave}>
          <Save size={16} />
          {busy ? "Salvando…" : "Salvar esta versão"}
        </button>
      </div>
    </div>
  );
}

function SignatureList({ signatures }: { signatures: ScrapSignature[] }) {
  if (!signatures.length) return <p className="scrap-review-warn">Nenhuma assinatura digital no arquivo.</p>;
  return (
    <ul className="scrap-signature-list">
      {signatures.map((signature, index) => (
        <li key={index} className={signature.check}>
          {signature.check === "invalid" ? <XCircle size={15} /> : signature.check === "unchecked" ? <TriangleAlert size={15} /> : <CheckCircle2 size={15} />}
          <span>
            <b>{signature.signer || "Sem nome"}</b> · {signature.slot ? SLOTS.find((slot) => slot.id === signature.slot)!.label : `campo ${signature.field}`} · {brDateTime(signature.signedAt) || "sem data"}
            <small>{signature.detail}</small>
          </span>
        </li>
      ))}
    </ul>
  );
}

/* ------------------------------------------------------------------------ */

function SendPanel({ form, canEdit, onSent, onError }: { form: ScrapForm; canEdit: boolean; onSent: (form: ScrapForm) => void; onError: (text: string) => void }) {
  const stage = form.status === "signed" ? "signed" : "signing";
  const [to, setTo] = useState(() => store.get(EMAIL_KEY[stage]));
  const [done, setDone] = useState("");
  const message = shareMessage(form, formLink(form));
  const canShareFiles = typeof navigator !== "undefined" && typeof navigator.canShare === "function";
  async function markSent() {
    if (stage !== "signed" || !canEdit) return;
    try {
      onSent((await api({ action: "sent", id: form.id })).form);
    } catch {
      // Marcar como enviado é só informativo.
    }
  }
  async function pdfFile() {
    const bytes = await fetchPdf(form);
    return { bytes, name: pdfFileName(form) };
  }
  async function share() {
    try {
      const { bytes, name } = await pdfFile();
      const file = new File([bytes.slice().buffer as ArrayBuffer], name, { type: "application/pdf" });
      if (!navigator.canShare?.({ files: [file] })) throw Error("Este navegador não compartilha arquivos. Use E-mail ou Baixar.");
      await navigator.share({ files: [file], title: message.subject, text: message.body });
      setDone("Compartilhado.");
      await markSent();
    } catch (e) {
      if ((e as Error).name !== "AbortError") onError((e as Error).message);
    }
  }
  async function email() {
    try {
      store.set(EMAIL_KEY[stage], to.trim());
      const { bytes, name } = await pdfFile();
      saveFile(bytes, name);
      const href = `mailto:${encodeURIComponent(to.trim()).replace(/%40/g, "@").replace(/%2C/gi, ",")}?subject=${encodeURIComponent(message.subject)}&body=${encodeURIComponent(message.body)}`;
      window.location.href = href;
      setDone(`PDF baixado (${name}). Anexe-o no e-mail que abriu.`);
      await markSent();
    } catch (e) {
      onError((e as Error).message);
    }
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(`${message.subject}\n\n${message.body}`);
      setDone("Texto copiado. Cole no Teams ou no e-mail junto com o PDF.");
    } catch {
      onError("Não foi possível copiar. Selecione o texto e copie manualmente.");
    }
  }
  return (
    <section className={`scrap-section scrap-send ${stage}`} aria-label="Enviar">
      <div className="scrap-section-head">
        <h4>{stage === "signed" ? "Enviar o PDF assinado" : "Enviar para assinatura"}</h4>
        <span>{stage === "signed" ? (form.sentAt ? `Enviado em ${brDateTime(form.sentAt)}` : "Ainda não enviado") : "O texto já diz quem falta assinar"}</span>
      </div>
      <div className="scrap-send-row">
        <label>
          Para (e-mail)
          <input type="email" multiple value={to} placeholder={stage === "signed" ? "financeiro@empresa.com" : "quem assina"} onChange={(e) => setTo(e.target.value)} />
        </label>
        <button className="primary" onClick={email}>
          <Mail size={16} />
          E-mail com PDF
        </button>
        {canShareFiles && (
          <button onClick={share}>
            <Share2 size={16} />
            Compartilhar…
          </button>
        )}
        <button onClick={copy}>
          <Copy size={16} />
          Copiar texto
        </button>
      </div>
      <details className="scrap-send-preview">
        <summary>
          <Send size={13} />
          {message.subject}
        </summary>
        <pre>{message.body}</pre>
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
      setResult({ name: file.name, reading: await readScrapPdf(new Uint8Array(await file.arrayBuffer()), { maxBytes: 30_000_000 }) });
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
          <DialogDescription>Escolha qualquer Scrap Form (mesmo os feitos no Excel). A conferência acontece só neste navegador; o arquivo não é enviado.</DialogDescription>
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
            {result.reading.pages > 1 && <p className="scrap-review-warn">O PDF tem {result.reading.pages} páginas; o Scrap Form gerado pelo portal tem uma só.</p>}
          </div>
        )}
        <div className="dialog-actions">
          <button onClick={onClose}>Fechar</button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

