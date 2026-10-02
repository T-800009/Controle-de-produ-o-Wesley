import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDownToLine, Download, FileSpreadsheet, PackageCheck, RefreshCw, Trash2, TriangleAlert, Undo2 } from "lucide-react";
import { parsePlanBom, type PlanBom } from "@/lib/oebom";
import TableViewport from "@/components/table-viewport";
import { requestJson } from "@/lib/api";
import type { Dataset, Row } from "@/lib/materials";
import type { OpStatuses } from "@/lib/op-status";
import { readAutomatic, readConsumptionMany, clearAutomaticCache } from "@/lib/automatic-worker-client";
import { shortageReport } from "@/lib/shortages";
import {
  PROJECT_ROLES,
  PROJECT_ROLE_LABELS,
  STOCK_PROJECT_LABELS,
  isProjectRole,
  projectLabel,
  stockProjectsExportRows,
  stockProjectsReport,
  type ProjectInput,
  type ProjectRole,
  type StockProjectItem,
} from "@/lib/stock-projects";

type BomMeta = { id: string; name: string; revision: string; ops?: string[] };
type PlanMeta = { id: string; name: string; revision: string; units: number; model?: string; dwb?: string; source?: string; version: string; updatedAt?: string };
type PendingPlan = { file: string; bom: PlanBom; units: string; existing: PlanMeta | null };
type LoadedProject = {
  id: string;
  name: string;
  revision: string;
  ops: string[];
  rows: Row[];
  consumption: Row[] | null;
  mb51Error: string;
  statuses: OpStatuses;
  statusError: string;
  checks: Record<string, boolean>;
  checksError: string;
  /** BOM do plano (OEBOM): sem OPs; a demanda usa os ônibus restantes. */
  plan: boolean;
};
type Loaded = {
  projects: LoadedProject[];
  stock: Dataset;
  mb51: { readAt: string; source: string; scrapSource: string; error: string } | null;
  loadErrors: string[];
  analyzedAt: string;
};

const ROLE_STORAGE = "wbyd:7000-projetos:papeis";
const PAGE = 25;
const fmt = (value: number | null | undefined) =>
  value === null || value === undefined ? "—" : value.toLocaleString("pt-BR", { maximumFractionDigits: 3 });
const money = (value: number | null | undefined) =>
  value === null || value === undefined
    ? "—"
    : value.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const stamp = (value?: string) =>
  value && Number.isFinite(Date.parse(value))
    ? new Date(value).toLocaleString("pt-BR")
    : "Sem leitura confirmada";

function storedRoles(): Record<string, ProjectRole> {
  try {
    const parsed = JSON.parse(localStorage.getItem(ROLE_STORAGE) || "{}");
    return Object.fromEntries(Object.entries(parsed).filter(([, role]) => isProjectRole(role))) as Record<
      string,
      ProjectRole
    >;
  } catch {
    return {};
  }
}

export default function StockProjects() {
  const [boms, setBoms] = useState<BomMeta[]>([]),
    [bomsError, setBomsError] = useState(""),
    [roles, setRoles] = useState<Record<string, ProjectRole>>(storedRoles),
    [useMb51, setUseMb51] = useState(true),
    [loaded, setLoaded] = useState<Loaded | null>(null),
    [busy, setBusy] = useState(false),
    [step, setStep] = useState(""),
    [error, setError] = useState(""),
    [query, setQuery] = useState(""),
    [stateFilter, setStateFilter] = useState("all"),
    [projectFilter, setProjectFilter] = useState("all"),
    [page, setPage] = useState(0),
    [exporting, setExporting] = useState(false),
    [plans, setPlans] = useState<PlanMeta[]>([]),
    [canEditPlans, setCanEditPlans] = useState(false),
    [planBusy, setPlanBusy] = useState(""),
    [planError, setPlanError] = useState(""),
    [planNotice, setPlanNotice] = useState(""),
    [pending, setPending] = useState<PendingPlan[]>([]),
    [unitDrafts, setUnitDrafts] = useState<Record<string, string>>({});
  const fileInput = useRef<HTMLInputElement>(null);
  const run = useRef(0);
  const deferredQuery = useDeferredValue(query);

  useEffect(() => {
    requestJson("/api/data")
      .then((list: BomMeta[]) => setBoms(Array.isArray(list) ? list : []))
      .catch((e) => setBomsError((e as Error).message));
    loadPlans();
    return () => {
      run.current++;
    };
  }, []);
  const roleOf = (id: string): ProjectRole => roles[id] || "active";
  const planUnits = useMemo(() => new Map(plans.map((plan) => [plan.id, plan.units])), [plans]);

  async function loadPlans() {
    try {
      const payload = await requestJson("/api/plan-boms");
      setPlans(Array.isArray(payload?.plans) ? payload.plans : []);
      setCanEditPlans(!!payload?.canEdit);
    } catch (e) {
      setPlanError((e as Error).message);
    }
  }

  async function choosePlanFiles(files: FileList | null) {
    if (!files?.length) return;
    setPlanError("");
    setPlanNotice("");
    setPlanBusy("Lendo os arquivos OEBOM…");
    try {
      const x = await import("xlsx");
      const parsed: PendingPlan[] = [],
        errors: string[] = [];
      for (const file of Array.from(files)) {
        try {
          const book = x.read(await file.arrayBuffer(), { type: "array", dense: true });
          // Só as abas usadas (Stats e KD): o resto do OEBOM é ignorado.
          const sheets = Object.fromEntries(
            book.SheetNames.filter((name) => /Stats|KD/i.test(name)).map((name) => [
              name,
              x.utils.sheet_to_json(book.Sheets[name], { header: 1, defval: null }) as unknown[][],
            ]),
          );
          const bom = parsePlanBom(file.name, sheets);
          const existing = plans.find((plan) => plan.id === bom.id) || null;
          parsed.push({ file: file.name, bom, units: existing ? String(existing.units) : "", existing });
        } catch (e) {
          errors.push((e as Error).message);
        }
      }
      setPending((current) => [...current.filter((item) => !parsed.some((p) => p.bom.id === item.bom.id)), ...parsed]);
      if (errors.length) setPlanError(errors.join(" "));
    } finally {
      setPlanBusy("");
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  async function savePending() {
    const missing = pending.filter((item) => !/^\d+$/.test(item.units.trim()));
    if (missing.length) {
      setPlanError(`Informe os ônibus restantes de: ${missing.map((item) => item.bom.name).join(", ")} (use 0 para projeto concluído).`);
      return;
    }
    setPlanError("");
    const saved: string[] = [],
      errors: string[] = [];
    for (const [index, item] of pending.entries()) {
      setPlanBusy(`Salvando ${item.bom.name} (${index + 1}/${pending.length})…`);
      try {
        await requestJson(
          "/api/plan-boms",
          {
            action: "save",
            data: {
              id: item.bom.id,
              name: item.bom.name,
              revision: item.bom.revision,
              model: item.bom.model,
              dwb: item.bom.dwb,
              units: Number(item.units),
              source: item.file,
              rows: item.bom.rows,
              version: item.existing?.version ?? "new",
            },
          },
          60_000,
        );
        saved.push(item.bom.name);
      } catch (e) {
        errors.push(`${item.bom.name}: ${(e as Error).message}`);
      }
    }
    setPlanBusy("");
    setPending((current) => current.filter((item) => !saved.includes(item.bom.name)));
    if (saved.length) setPlanNotice(`${saved.length} BOM(s) do plano salva(s): ${saved.join(", ")}. Clique em Analisar saldo 7000.`);
    if (errors.length) setPlanError(errors.join(" "));
    await loadPlans();
  }

  async function saveUnits(plan: PlanMeta) {
    const draft = (unitDrafts[plan.id] ?? String(plan.units)).trim();
    if (!/^\d+$/.test(draft)) {
      setPlanError(`${plan.name}: informe um número inteiro de ônibus (0 = concluído).`);
      return;
    }
    setPlanError("");
    setPlanBusy(`Salvando ${plan.name}…`);
    try {
      await requestJson("/api/plan-boms", { action: "units", id: plan.id, units: Number(draft) });
      setPlans((current) => current.map((item) => (item.id === plan.id ? { ...item, units: Number(draft) } : item)));
      setUnitDrafts(({ [plan.id]: _, ...rest }) => rest);
    } catch (e) {
      setPlanError(`${plan.name}: ${(e as Error).message}`);
    } finally {
      setPlanBusy("");
    }
  }

  async function deletePlan(plan: PlanMeta) {
    if (!confirm(`Apagar a BOM do plano ${plan.name}? Ela sai da análise; dá para cadastrar de novo com o arquivo OEBOM.`)) return;
    setPlanError("");
    setPlanBusy(`Apagando ${plan.name}…`);
    try {
      await requestJson(
        `/api/plan-boms?id=${encodeURIComponent(plan.id)}&version=${encodeURIComponent(plan.version)}`,
        undefined,
        30_000,
        "DELETE",
      );
      setLoaded((current) =>
        current ? { ...current, projects: current.projects.filter((project) => project.id !== plan.id) } : current,
      );
      await loadPlans();
    } catch (e) {
      setPlanError(`${plan.name}: ${(e as Error).message}`);
    } finally {
      setPlanBusy("");
    }
  }
  function changeRole(id: string, role: ProjectRole) {
    setRoles((current) => {
      const next = { ...current, [id]: role };
      try {
        localStorage.setItem(ROLE_STORAGE, JSON.stringify(next));
      } catch {
        // Preference only; the analysis keeps working without browser storage.
      }
      return next;
    });
    setPage(0);
  }

  async function analyze() {
    const n = ++run.current;
    setBusy(true);
    setError("");
    clearAutomaticCache();
    try {
      setStep("Lendo as BOMs cadastradas…");
      const list: BomMeta[] = await requestJson("/api/data");
      if (n !== run.current) return;
      setBoms(list);
      const loadErrors: string[] = [];
      const bases = (
        await Promise.all(
          list.map(async (meta) => {
            try {
              const [data, statuses, checks] = await Promise.all([
                requestJson("/api/data?id=" + encodeURIComponent(meta.id)) as Promise<Dataset>,
                requestJson("/api/op-status?id=" + encodeURIComponent(meta.id)).then(
                  (payload) => ({ value: (payload.statuses || {}) as OpStatuses, error: "" }),
                  (e) => ({ value: {} as OpStatuses, error: (e as Error).message }),
                ),
                requestJson("/api/checks?id=" + encodeURIComponent(meta.id)).then(
                  (payload) => ({ value: (payload.checks || {}) as Record<string, boolean>, error: "" }),
                  (e) => ({ value: {} as Record<string, boolean>, error: (e as Error).message }),
                ),
              ]);
              if (!Array.isArray(data?.rows)) throw Error("BOM sem linhas.");
              return { data, statuses, checks };
            } catch (e) {
              loadErrors.push(`${projectLabel(meta)}: ${(e as Error).message}`);
              return null;
            }
          }),
        )
      ).filter(Boolean) as {
        data: Dataset;
        statuses: { value: OpStatuses; error: string };
        checks: { value: Record<string, boolean>; error: string };
      }[];
      if (n !== run.current) return;
      setStep("Lendo as BOMs do plano…");
      const planList: PlanMeta[] = await requestJson("/api/plan-boms").then(
        (payload) => (Array.isArray(payload?.plans) ? payload.plans : []),
        (e) => {
          loadErrors.push(`BOMs do plano: ${(e as Error).message}`);
          return [];
        },
      );
      setPlans(planList);
      const planBases = (
        await Promise.all(
          planList.map(async (meta) => {
            try {
              const data: Dataset = await requestJson("/api/plan-boms?id=" + encodeURIComponent(meta.id));
              if (!Array.isArray(data?.rows)) throw Error("BOM sem linhas.");
              return data;
            } catch (e) {
              loadErrors.push(`${projectLabel(meta)}: ${(e as Error).message}`);
              return null;
            }
          }),
        )
      ).filter(Boolean) as Dataset[];
      if (n !== run.current) return;
      if (!bases.length && !planBases.length) throw Error("Nenhuma BOM pôde ser carregada. " + loadErrors.join(" "));
      setStep("Lendo o saldo livre do 7000…");
      const stockBase: Dataset = await requestJson("/api/data?id=7000");
      const stock = await readAutomatic(stockBase);
      if (n !== run.current) return;
      let mb51: Loaded["mb51"] = null;
      const consumption = new Map<string, { rows: Row[] | null; error: string }>();
      if (useMb51) {
        setStep("Lendo a MB51 uma vez para todas as BOMs…");
        try {
          const results = await readConsumptionMany(bases.map((base) => base.data));
          if (n !== run.current) return;
          setStep("Conciliando o consumo de cada projeto…");
          let readAt = "",
            source = "",
            scrapSource = "";
          for (const result of results) {
            if (result.data) {
              readAt ||= result.data.updatedAt || "";
              source ||= result.data.source;
              scrapSource ||= result.data.scrapSource || "";
              consumption.set(result.id, {
                rows: shortageReport(result.data, null, null, null).allRows,
                error: "",
              });
            } else consumption.set(result.id, { rows: null, error: result.error || "Falha na conciliação." });
          }
          mb51 = { readAt, source, scrapSource, error: "" };
        } catch (e) {
          mb51 = { readAt: "", source: "", scrapSource: "", error: (e as Error).message };
        }
      }
      if (n !== run.current) return;
      setLoaded({
        projects: [
          ...bases.map(({ data, statuses, checks }) => ({
          id: data.id,
          name: data.name,
          revision: data.revision,
          ops: (data.ops || []).map(String),
          rows: data.rows,
          consumption: consumption.get(data.id)?.rows ?? null,
          mb51Error: consumption.get(data.id)?.error || "",
          statuses: statuses.value,
          statusError: statuses.error,
          checks: checks.value,
          checksError: checks.error,
          plan: false,
        })),
          ...planBases.map((data) => ({
            id: data.id,
            name: data.name,
            revision: data.revision,
            ops: [],
            rows: data.rows,
            consumption: null,
            mb51Error: "",
            statuses: {},
            statusError: "",
            checks: {},
            checksError: "",
            plan: true,
          })),
        ],
        stock,
        mb51,
        loadErrors,
        analyzedAt: new Date().toISOString(),
      });
      setPage(0);
    } catch (e) {
      if (n === run.current) setError((e as Error).message);
    } finally {
      if (n === run.current) {
        setBusy(false);
        setStep("");
      }
    }
  }

  const inputs = useMemo<ProjectInput[]>(
    () =>
      (loaded?.projects || []).map((project) => ({
        id: project.id,
        name: project.name,
        revision: project.revision,
        role: roleOf(project.id),
        ops: project.ops,
        rows: project.rows,
        consumption: useMb51 ? project.consumption : null,
        statuses: project.statuses,
        checks: project.checks,
        units: project.plan ? (planUnits.get(project.id) ?? 0) : undefined,
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [loaded, roles, useMb51, planUnits],
  );
  const report = useMemo(
    () => (loaded ? stockProjectsReport(loaded.stock, inputs) : null),
    [loaded, inputs],
  );
  const filtered = useMemo(() => {
    if (!report) return [];
    const text = deferredQuery.trim().toLowerCase();
    return report.items.filter(
      (item) =>
        (stateFilter === "all" ||
          (stateFilter === "return" && (item.returnQty || 0) > 0) ||
          item.state === stateFilter) &&
        (projectFilter === "all" ||
          (projectFilter === "none"
            ? !item.uses.length
            : item.uses.some((use) => use.projectId === projectFilter) ||
              item.excludedUses.some((use) => use.projectId === projectFilter))) &&
        `${item.material} ${item.description} ${[...item.uses, ...item.excludedUses].map((use) => use.label).join(" ")}`
          .toLowerCase()
          .includes(text),
    );
  }, [report, deferredQuery, stateFilter, projectFilter]);
  const metrics = useMemo(() => {
    const returning = filtered.filter((item) => (item.returnQty || 0) > 0);
    return {
      returning: returning.length,
      returnValue: returning.reduce((sum, item) => sum + (item.returnValue || 0), 0),
      withoutValue: returning.filter((item) => item.returnValue === null).length,
      unused: filtered.filter((item) => item.state === "return_all" && !item.uses.length).length,
      keep: filtered.filter((item) => item.state === "keep").length,
      review: filtered.filter((item) => item.state === "review").length,
    };
  }, [filtered]);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE)),
    current = Math.min(page, pages - 1);
  const hasFilters = !!query.trim() || stateFilter !== "all" || projectFilter !== "all";
  const considered = (loaded?.projects || boms).filter((project) => roleOf(project.id) !== "excluded");
  const duplicateNotes = (report?.projects || [])
    .filter((project) => project.duplicateOps.length)
    .map(
      (project) =>
        `${project.label}: ${project.duplicateOps.length} de ${project.totalOps} OP(s) repetem outra BOM de maior prioridade e foram contadas só uma vez (${project.duplicateOps.slice(0, 4).join(", ")}${project.duplicateOps.length > 4 ? "…" : ""}).${project.duplicateOps.length === project.totalOps ? " Parece uma BOM duplicada: se foi cadastro errado, apague-a em BOM × OP → Apagar esta BOM." : ""}`,
    );
  const planOverlap = (loaded?.projects || [])
    .filter((project) => project.plan && roleOf(project.id) !== "excluded" && (planUnits.get(project.id) ?? 0) > 0)
    .flatMap((plan) => {
      const dwb = plan.name.match(/DWB(\d{3,5})/i)?.[1];
      const twin = dwb
        ? (loaded?.projects || []).find(
            (other) =>
              !other.plan && roleOf(other.id) !== "excluded" && new RegExp(`(^|\\D)${dwb}(\\D|$)`).test(`${other.name} ${other.revision}`),
          )
        : undefined;
      return twin
        ? [`${projectLabel(plan)} e ${projectLabel(twin)} parecem o mesmo projeto: a demanda seria contada duas vezes. Deixe um deles como “Fora da análise”.`]
        : [];
    });
  const projectWarnings = (loaded?.projects || []).flatMap((project) => [
    ...(project.statusError
      ? [`${projectLabel(project)}: status das OPs indisponível (${project.statusError}); todas contam como abertas.`]
      : []),
    ...(project.checksError
      ? [`${projectLabel(project)}: itens OK indisponíveis (${project.checksError}); nenhum item foi retirado.`]
      : []),
    ...(useMb51 && loaded?.mb51 && !loaded.mb51.error && project.mb51Error
      ? [`${projectLabel(project)}: MB51 não conciliada (${project.mb51Error}); usando a BOM cheia das OPs abertas.`]
      : []),
  ]);

  function clearFilters() {
    setQuery("");
    setStateFilter("all");
    setProjectFilter("all");
    setPage(0);
  }

  async function exportExcel() {
    if (!report || !loaded) return;
    setExporting(true);
    try {
      const x = await import("xlsx"),
        book = x.utils.book_new(),
        output = stockProjectsExportRows(filtered);
      const totals = x.utils.json_to_sheet(output.totals),
        detail = x.utils.json_to_sheet(output.details);
      totals["!cols"] = [18, 42, 8, 10, 12, 14, 60, 30, 14, 14, 14, 16, 16, 26, 80].map((wch) => ({ wch }));
      detail["!cols"] = [18, 42, 8, 28, 16, 14, 14, 40, 16, 16, 28, 16, 18].map((wch) => ({ wch }));
      for (const sheet of [totals, detail]) if (sheet["!ref"]) sheet["!autofilter"] = { ref: sheet["!ref"] };
      x.utils.book_append_sheet(book, totals, "Devolucao_2000");
      x.utils.book_append_sheet(book, detail, "Uso_por_Projeto");
      const criteria = x.utils.aoa_to_sheet([
        ["Saldo 7000 × Projetos", "MB51-66"],
        ["Gerado em", new Date().toLocaleString("pt-BR")],
        ["7000", loaded.stock.source, stamp(loaded.stock.updatedAt)],
        [
          "MB51",
          !useMb51
            ? "Não usada: demanda = BOM cheia das OPs abertas"
            : loaded.mb51?.error
              ? "Indisponível: " + loaded.mb51.error
              : loaded.mb51?.source || "—",
          stamp(loaded.mb51?.readAt),
        ],
        ["SCRAP", useMb51 ? loaded.mb51?.scrapSource || "—" : "Não usada"],
        ...report.projects.map((project) => [
          "Projeto",
          `${project.label} — ${PROJECT_ROLE_LABELS[project.role]}`,
          project.basis === "plan"
            ? `BOM do plano · ${project.units ?? 0} ônibus restantes · qtd. por ônibus × ônibus`
            : `${project.openOps} OPs abertas · ${project.closedOps} concluídas · base ${project.basis === "mb51" ? "BOM − MB51/SCRAP" : "BOM cheia"}`,
        ]),
        ["Prioridade", "O saldo é reservado primeiro para Em produção e depois para Vai entrar, na ordem da lista."],
        [
          "Demanda",
          "OPs abertas: BOM − consumo efetivo MB51/SCRAP (mínimo zero). OP sem movimento conta a BOM cheia. OP concluída e item OK não contam.",
        ],
        ["Devolver ao 2000", "Saldo livre 7000 − quantidade reservada para os projetos considerados."],
        [
          "Conferir",
          "Saldo negativo/desconhecido, unidade diferente da BOM ou BOM sem quantidade: não há sugestão automática.",
        ],
        ["Fora da análise", "Projeto informativo: não segura saldo no 7000."],
        ["Filtros", stateFilter, projectFilter, query],
        ["Reserva", "Esta consulta não reserva nem movimenta estoque e não altera o SAP."],
      ]);
      criteria["!cols"] = [{ wch: 22 }, { wch: 110 }, { wch: 60 }];
      x.utils.book_append_sheet(book, criteria, "Criterios");
      x.writeFile(book, `Saldo_7000_x_Projetos_${new Date().toISOString().slice(0, 10)}.xlsx`);
    } catch (e) {
      setError("Não foi possível exportar a planilha. " + (e as Error).message);
    } finally {
      setExporting(false);
    }
  }

  return (
    <section className="shortages panel stock-projects" aria-label="Saldo 7000 por projeto">
      <div className="warehouse-heading">
        <div>
          <p className="eyebrow">TODAS AS BOMs CADASTRADAS</p>
          <h3>Onde o saldo do 7000 será usado</h3>
          <p>
            Cada BOM é um projeto. Defina quem está em produção e quem vai entrar: o que nenhum deles precisa
            volta para o 2000.
          </p>
        </div>
        <div className="stock-projects-actions">
          <button className="primary" disabled={busy} onClick={analyze}>
            <RefreshCw size={16} className={busy ? "spin" : ""} />
            {busy ? "Analisando…" : loaded ? "Atualizar análise" : "Analisar saldo 7000"}
          </button>
          <button disabled={busy || exporting || !filtered.length} onClick={exportExcel}>
            <Download size={16} />
            {exporting ? "Exportando…" : "Baixar planilha de devolução"}
          </button>
        </div>
      </div>

      <div className="stock-projects-roles" aria-label="Projetos considerados">
        <div className="stock-projects-roles-head">
          <div>
            <b>Projetos (BOMs)</b>
            <span>O saldo é reservado primeiro para “Em produção”, depois para “Vai entrar”.</span>
          </div>
          <label className="stock-projects-toggle">
            <input type="checkbox" checked={useMb51} onChange={(e) => setUseMb51(e.target.checked)} />
            Descontar o que a MB51 já consumiu
          </label>
        </div>
        {bomsError && (
          <p className="notice" role="alert">
            {bomsError}
          </p>
        )}
        <div className="stock-projects-role-grid">
          {(loaded?.projects || [...boms, ...plans.map((plan) => ({ ...plan, ops: [], plan: true }))]).map((project) => {
            const role = roleOf(project.id),
              summary = report?.projects.find((item) => item.id === project.id),
              isPlan = "plan" in project && project.plan === true;
            return (
              <article className={`stock-project-card role-${role}`} key={project.id}>
                <div>
                  <b>{projectLabel(project)}</b>
                  <small>
                    {isPlan
                      ? `BOM do plano · ${fmt(planUnits.get(project.id) ?? 0)} ônibus restantes${summary ? ` · usa ${fmt(summary.stockMaterials)} materiais do 7000` : ""}`
                      : summary
                        ? `${fmt(summary.openOps)} OPs abertas · ${fmt(summary.closedOps)} concluídas · usa ${fmt(summary.stockMaterials)} materiais do 7000`
                        : `${fmt(project.ops?.length || 0)} OPs cadastradas`}
                  </small>
                  {isPlan && role !== "excluded" && <small>Base: qtd. por ônibus (OEBOM) × ônibus restantes</small>}
                  {summary && !isPlan && role !== "excluded" && (
                    <small>
                      Base:{" "}
                      {summary.basis === "mb51"
                        ? "BOM − consumo MB51/SCRAP" +
                          (summary.notStartedOps
                            ? ` · ${fmt(summary.notStartedOps)} OP(s) sem movimento contam a BOM cheia`
                            : "")
                        : useMb51
                          ? "BOM cheia (MB51 indisponível)"
                          : "BOM cheia das OPs abertas"}
                    </small>
                  )}
                </div>
                <div className="stock-project-role" role="group" aria-label={`Papel de ${projectLabel(project)}`}>
                  {PROJECT_ROLES.map((value) => (
                    <button
                      key={value}
                      type="button"
                      className={"role-" + value}
                      aria-pressed={role === value}
                      onClick={() => changeRole(project.id, value)}
                    >
                      {PROJECT_ROLE_LABELS[value]}
                    </button>
                  ))}
                </div>
              </article>
            );
          })}
        </div>
        <small className="stock-projects-note">
          A escolha fica salva neste navegador e só muda esta análise: não altera BOMs, status das OPs nem o
          SAP.{" "}
          {considered.length
            ? `${considered.length} projeto(s) seguram saldo no 7000.`
            : "Nenhum projeto segura saldo: todo o 7000 aparecerá para devolução."}
        </small>
      </div>

      <div className="stock-projects-roles stock-plan-boms" aria-label="BOMs do plano de produção">
        <div className="stock-projects-roles-head">
          <div>
            <b>BOMs do plano de produção (OEBOM)</b>
            <span>
              Arquivo OEBOM da China (aba Stats + KD list). Demanda = quantidade usada no Brasil por ônibus × ônibus
              restantes do plano. Use 0 para projeto concluído.
            </span>
          </div>
          {canEditPlans && (
            <>
              <input
                ref={fileInput}
                type="file"
                accept=".xlsx,.xls"
                multiple
                hidden
                aria-label="Arquivos OEBOM"
                onChange={(e) => choosePlanFiles(e.target.files)}
              />
              <button disabled={!!planBusy} onClick={() => fileInput.current?.click()}>
                <FileSpreadsheet size={16} />
                Adicionar BOMs (OEBOM)
              </button>
            </>
          )}
        </div>
        {planBusy && (
          <p className="stock-plan-status" role="status">
            <RefreshCw size={14} className="spin" /> {planBusy}
          </p>
        )}
        {planError && (
          <p className="notice" role="alert">
            {planError}
          </p>
        )}
        {planNotice && <p className="stock-plan-status">{planNotice}</p>}
        {pending.length > 0 && (
          <div className="stock-plan-pending">
            <b>Conferir antes de salvar</b>
            <table>
              <thead>
                <tr>
                  <th>Projeto</th>
                  <th>Arquivo</th>
                  <th>Materiais</th>
                  <th>Ônibus restantes</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {pending.map((item) => (
                  <tr key={item.bom.id}>
                    <td>
                      <b>{item.bom.name}</b>
                      <small>
                        {item.bom.revision || "sem revisão"}
                        {item.existing ? " · substitui a BOM já cadastrada" : " · nova"}
                      </small>
                      {item.bom.warnings.map((warning) => (
                        <small key={warning}>{warning}</small>
                      ))}
                    </td>
                    <td className="stock-plan-file">{item.file}</td>
                    <td>
                      {fmt(item.bom.rows.length)}
                      <small>
                        Stats {fmt(item.bom.statsRows)} · KD {fmt(item.bom.kdRows)}
                      </small>
                    </td>
                    <td>
                      <input
                        inputMode="numeric"
                        aria-label={`Ônibus restantes de ${item.bom.name}`}
                        placeholder="ex.: 40"
                        value={item.units}
                        onChange={(e) =>
                          setPending((current) =>
                            current.map((p) => (p.bom.id === item.bom.id ? { ...p, units: e.target.value } : p)),
                          )
                        }
                      />
                    </td>
                    <td>
                      <button
                        type="button"
                        onClick={() => setPending((current) => current.filter((p) => p.bom.id !== item.bom.id))}
                      >
                        Remover
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="stock-projects-actions">
              <button className="primary" disabled={!!planBusy} onClick={savePending}>
                Salvar {pending.length} BOM(s) do plano
              </button>
              <button disabled={!!planBusy} onClick={() => setPending([])}>
                Cancelar
              </button>
            </div>
          </div>
        )}
        {plans.length > 0 ? (
          <div className="stock-plan-list">
            {plans.map((plan) => {
              const draft = unitDrafts[plan.id] ?? String(plan.units);
              const changed = draft !== String(plan.units);
              return (
                <article key={plan.id} className={plan.units > 0 ? "" : "is-done"}>
                  <div>
                    <b>{plan.name}</b>
                    <small>
                      {plan.revision || "sem revisão"} · {plan.units > 0 ? `${fmt(plan.units)} ônibus restantes` : "concluído (0)"}
                    </small>
                  </div>
                  {canEditPlans ? (
                    <div className="stock-plan-edit">
                      <input
                        inputMode="numeric"
                        aria-label={`Ônibus restantes de ${plan.name}`}
                        value={draft}
                        onChange={(e) => setUnitDrafts((current) => ({ ...current, [plan.id]: e.target.value }))}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && changed) saveUnits(plan);
                        }}
                      />
                      <button disabled={!changed || !!planBusy} onClick={() => saveUnits(plan)}>
                        Salvar
                      </button>
                      <button
                        className="icon-only"
                        title={`Apagar ${plan.name}`}
                        aria-label={`Apagar ${plan.name}`}
                        disabled={!!planBusy}
                        onClick={() => deletePlan(plan)}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  ) : null}
                </article>
              );
            })}
          </div>
        ) : (
          !pending.length && (
            <small className="stock-projects-note">
              Nenhuma BOM do plano cadastrada.{" "}
              {canEditPlans ? "Clique em Adicionar BOMs (OEBOM) e informe quantos ônibus faltam de cada projeto." : ""}
            </small>
          )
        )}
        <small className="stock-projects-note">
          Os ônibus restantes ficam salvos no portal para todos. Mudou o plano? Altere o número e clique em Salvar: a
          análise já carregada recalcula na hora.
        </small>
      </div>

      <div className="stock-rule-banner">
        <div>
          <b>1 · Saldo livre do 7000</b>
          <span>Material + unidade, centro BR02</span>
        </div>
        <div>
          <b>2 · Reservar para as OPs abertas</b>
          <span>Em produção → Vai entrar</span>
        </div>
        <div>
          <b>3 · O que sobra volta ao 2000</b>
          <span>Unidade diferente ou saldo duvidoso: conferir</span>
        </div>
      </div>

      {error && (
        <div className="notice" role="alert">
          <TriangleAlert size={18} />
          <div>{error}</div>
        </div>
      )}
      {busy && (
        <div className="empty" role="status">
          <RefreshCw className="spin" />
          <h3>{step || "Analisando…"}</h3>
          <p>A análise lê o 7000 e a MB51 somente neste clique. Filtros e papéis usam os dados já carregados.</p>
        </div>
      )}
      {!busy && !loaded && !error && (
        <div className="empty source-wait" role="status">
          <Undo2 size={30} />
          <h3>Clique em Analisar saldo 7000</h3>
          <p>
            A análise cruza todo o saldo livre do 7000 com as BOMs cadastradas e mostra o que pode voltar ao 2000
            antes da entrada do próximo projeto.
          </p>
        </div>
      )}
      {loaded && report && !busy && (
        <>
          {useMb51 && loaded.mb51?.error && (
            <div className="notice" role="alert">
              <TriangleAlert size={18} />
              <div>
                <b>MB51 indisponível.</b> {loaded.mb51.error} A demanda foi calculada pela BOM cheia das OPs
                abertas (lado seguro: devolve menos).
              </div>
            </div>
          )}
          {[...loaded.loadErrors, ...projectWarnings, ...duplicateNotes, ...planOverlap].length > 0 && (
            <div className="notice">
              <TriangleAlert size={18} />
              <div>
                {[...loaded.loadErrors, ...projectWarnings, ...duplicateNotes, ...planOverlap].map((text) => (
                  <p key={text}>{text}</p>
                ))}
              </div>
            </div>
          )}
          <div className="warehouse-metrics stock-projects-metrics">
            <article className="metric-return">
              <ArrowDownToLine size={19} />
              <span>Devolver ao 2000</span>
              <strong>{fmt(metrics.returning)}</strong>
              <small>
                materiais · {money(metrics.returnValue)} em valor livre
                {metrics.withoutValue ? ` · ${metrics.withoutValue} sem valor informado` : ""}
              </small>
            </article>
            <article>
              <Undo2 size={19} />
              <span>Sem uso nos projetos</span>
              <strong>{fmt(metrics.unused)}</strong>
              <small>nenhuma BOM considerada usa · saldo inteiro volta</small>
            </article>
            <article>
              <PackageCheck size={19} />
              <span>Manter no 7000</span>
              <strong>{fmt(metrics.keep)}</strong>
              <small>todo o saldo está reservado para as OPs abertas</small>
            </article>
            <article>
              <TriangleAlert size={19} />
              <span>Conferir antes de mover</span>
              <strong>{fmt(metrics.review)}</strong>
              <small>unidade diferente, saldo negativo ou BOM incompleta</small>
            </article>
          </div>

          <div className="warehouse-filter-panel" role="search" aria-label="Filtros do saldo 7000">
            <div className="warehouse-filter-heading">
              <b>Encontre os materiais</b>
              <button className="warehouse-clear-filters" disabled={!hasFilters} onClick={clearFilters}>
                Limpar filtros
              </button>
            </div>
            <div className="warehouse-filters">
              <label>
                Material ou projeto
                <input
                  aria-label="Buscar no saldo 7000"
                  placeholder="Código SAP, descrição ou projeto"
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setPage(0);
                  }}
                />
              </label>
              <label>
                Situação
                <select
                  aria-label="Situação do saldo 7000"
                  value={stateFilter}
                  onChange={(e) => {
                    setStateFilter(e.target.value);
                    setPage(0);
                  }}
                >
                  <option value="all">Todos os materiais</option>
                  <option value="return">Devolver ao 2000 (tudo + excedente)</option>
                  <option value="return_all">{STOCK_PROJECT_LABELS.return_all}</option>
                  <option value="return_excess">{STOCK_PROJECT_LABELS.return_excess}</option>
                  <option value="keep">{STOCK_PROJECT_LABELS.keep}</option>
                  <option value="review">{STOCK_PROJECT_LABELS.review}</option>
                </select>
              </label>
              <label>
                Projeto
                <select
                  aria-label="Projeto no saldo 7000"
                  value={projectFilter}
                  onChange={(e) => {
                    setProjectFilter(e.target.value);
                    setPage(0);
                  }}
                >
                  <option value="all">Todos os projetos</option>
                  {loaded.projects.map((project) => (
                    <option key={project.id} value={project.id}>
                      Usado em {projectLabel(project)}
                    </option>
                  ))}
                  <option value="none">Sem uso nos projetos considerados</option>
                </select>
              </label>
            </div>
            <div className="warehouse-filter-summary" aria-live="polite">
              <span>
                <b>{fmt(filtered.length)}</b> de {fmt(report.items.length)} materiais com saldo no 7000
              </span>
              <span>
                {fmt(report.zeroBalance)} códigos com saldo zero ficaram fora · 7000 lido em{" "}
                {stamp(loaded.stock.updatedAt)}
              </span>
            </div>
          </div>

          <details className="warehouse-criteria">
            <summary>
              Fontes e critérios da análise<span>reserva: Em produção → Vai entrar → sobra volta ao 2000</span>
            </summary>
            <div>
              <p>
                <b>Demanda restante</b> = soma, nas OPs abertas, de máximo(BOM − consumo efetivo MB51/SCRAP, 0).
                OP sem movimento 261/262 conta a BOM cheia (ainda não iniciada). OP Concluída e item marcado
                como OK não contam. Sem MB51, a demanda é a BOM cheia das OPs abertas.
              </p>
              <p>
                <b>Devolver ao 2000</b> = saldo livre do 7000 − quantidade reservada. O saldo é reservado uma
                única vez, primeiro para os projetos Em produção e depois para Vai entrar. Projeto “Fora da
                análise” não segura saldo. A mesma OP em duas BOMs conta só na primeira.
              </p>
              <p>
                Materiais com unidade diferente da BOM, saldo negativo ou desconhecido, ou BOM sem quantidade
                ficam em <b>Conferir</b>. Nada é reservado, movimentado ou lançado no SAP por esta tela.
              </p>
              <small>
                7000: {loaded.stock.source} · {stamp(loaded.stock.updatedAt)} · MB51:{" "}
                {!useMb51
                  ? "não usada"
                  : loaded.mb51?.error
                    ? "indisponível"
                    : `${loaded.mb51?.source || "—"} · ${stamp(loaded.mb51?.readAt)}`}{" "}
                · SCRAP: {useMb51 ? loaded.mb51?.scrapSource || "—" : "não usada"} · análise em{" "}
                {stamp(loaded.analyzedAt)}
              </small>
            </div>
          </details>

          <div className="warehouse-list-heading">
            <div>
              <h4>Materiais do 7000</h4>
              <p>Devoluções primeiro. Abra “Ver conta” para conferir a reserva de cada projeto.</p>
            </div>
            <span>
              {fmt(report.counts.return_all + report.counts.return_excess)} para devolver ·{" "}
              {fmt(report.counts.keep)} manter · {fmt(report.counts.review)} conferir
            </span>
          </div>
          {!filtered.length ? (
            <div className="empty">
              <h3>{hasFilters ? "Nenhum material neste filtro" : "Nenhum saldo positivo no 7000"}</h3>
              <p>
                {hasFilters
                  ? "Ajuste os filtros para ver outros materiais."
                  : "A aba 7000 não trouxe materiais com saldo livre maior que zero."}
              </p>
            </div>
          ) : (
            <TableViewport className="warehouse-table stock-projects-table" label="Saldo 7000 por projeto">
              <table>
                <thead>
                  <tr>
                    {[
                      "Material",
                      "Saldo 7000",
                      "Usado nos projetos",
                      "Demanda restante",
                      "Manter no 7000",
                      "Devolver ao 2000",
                      "Situação",
                    ].map((label) => (
                      <th key={label}>{label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filtered.slice(current * PAGE, current * PAGE + PAGE).map((item) => (
                    <StockProjectRow key={item.key} item={item} />
                  ))}
                </tbody>
              </table>
            </TableViewport>
          )}
          <div className="table-footer">
            <span>O Excel inclui todos os {fmt(filtered.length)} materiais deste filtro, não apenas esta página.</span>
            <div>
              <button disabled={current === 0} onClick={() => setPage(current - 1)}>
                Anterior
              </button>
              <span>
                {current + 1} / {pages}
              </span>
              <button disabled={current + 1 >= pages} onClick={() => setPage(current + 1)}>
                Próxima
              </button>
            </div>
          </div>
        </>
      )}
    </section>
  );
}

function StockProjectRow({ item }: { item: StockProjectItem }) {
  const unit = item.unit;
  return (
    <tr className={"stock-project-" + item.state}>
      <td>
        <b className="code">{item.material}</b>
        <span className="description">{item.description || "Sem descrição"}</span>
        {item.classes.length > 0 && (
          <span className="warehouse-class-tags">
            {item.classes.map((cls) => (
              <b key={cls} className={"warehouse-class-tag class-" + cls}>
                {cls}
              </b>
            ))}
          </span>
        )}
      </td>
      <td className="num">
        {fmt(item.balance)}
        <small>
          {unit || "sem unidade"}
          {item.value !== null ? ` · ${money(item.value)}` : ""}
        </small>
      </td>
      <td>
        {item.uses.length ? (
          <ul className="stock-project-uses">
            {item.uses.map((use) => (
              <li key={use.projectId} className={"role-" + use.role}>
                <b>{use.label}</b>
                <span>
                  {PROJECT_ROLE_LABELS[use.role]} ·{" "}
                  {use.basis === "plan"
                    ? `${fmt(use.perOp)} ${use.unit}/ônibus × ${fmt(use.units)} ônibus`
                    : `${fmt(use.perOp)} ${use.unit}/OP · ${use.openOps.length ? `${use.openOps.length} OP(s) com demanda` : "sem demanda nas OPs abertas"}`}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <span className="stock-project-none">Nenhum projeto considerado</span>
        )}
        {item.excludedUses.length > 0 && (
          <small>Também em: {item.excludedUses.map((use) => use.label).join(", ")} (fora da análise)</small>
        )}
        {item.unitMismatch.length > 0 && <small>Unidade diferente: {item.unitMismatch.join("; ")}</small>}
      </td>
      <td className="num">
        {fmt(item.demand)}
        <small>{unit}</small>
      </td>
      <td className="num">
        {fmt(item.keep)}
        <small>
          {unit}
          {item.shortfall ? ` · faltam ${fmt(item.shortfall)}` : ""}
        </small>
      </td>
      <td className="num warehouse-request">
        <b className="warehouse-quantity">{fmt(item.returnQty)}</b>
        <small>
          {unit}
          {item.returnValue !== null && (item.returnQty || 0) > 0 ? ` · ${money(item.returnValue)}` : ""}
        </small>
      </td>
      <td>
        <span className="warehouse-badge">{STOCK_PROJECT_LABELS[item.state]}</span>
        <small>{item.reason}</small>
        {item.balance !== null && item.balance > 0 && item.state !== "review" && item.uses.length > 0 && (
          <details>
            <summary>Ver conta</summary>
            <ul>
              <li>
                Saldo livre 7000: <b>{fmt(item.balance)}</b> {unit}
              </li>
              {item.uses.map((use) => (
                <li key={use.projectId}>
                  {use.label}: demanda {fmt(use.demand)} → reserva <b>{fmt(use.allocated)}</b> {unit}
                  {use.basis === "plan" ? ` (${fmt(use.perOp)} × ${fmt(use.units)} ônibus)` : ""}
                  {use.notStartedOps ? ` · ${use.notStartedOps} OP(s) sem MB51 (BOM cheia)` : ""}
                </li>
              ))}
              <li>
                Devolver: {fmt(item.balance)} − {fmt(item.keep)} = <b>{fmt(item.returnQty)}</b> {unit}
              </li>
            </ul>
          </details>
        )}
      </td>
    </tr>
  );
}
