import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { Download, ExternalLink, FileText, RefreshCw, TriangleAlert } from "lucide-react";
import TableViewport from "@/components/table-viewport";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { decodeWriteOffMatrix, parseWriteOffs, summarizeWriteOffs, type WriteOff } from "@/lib/write-offs";

const PAGE = 25;
const fmt = (value: number | null) =>
  value === null ? "—" : value.toLocaleString("pt-BR", { maximumFractionDigits: 3 });
const money = (value: number | null) =>
  value === null ? "—" : value.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const day = (value: string | null) => (value ? value.split("-").reverse().join("/") : "—");
const monthLabel = (value: string) => {
  const [year, month] = value.split("-");
  return `${["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"][Number(month) - 1] || month}/${year}`;
};

export default function WriteOffs() {
  const [items, setItems] = useState<WriteOff[] | null>(null),
    [readAt, setReadAt] = useState(""),
    [sheet, setSheet] = useState("BAIXA CC"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [query, setQuery] = useState(""),
    [center, setCenter] = useState("all"),
    [month, setMonth] = useState("all"),
    [pdfFilter, setPdfFilter] = useState("all"),
    [page, setPage] = useState(0),
    [viewing, setViewing] = useState<WriteOff | null>(null);
  const run = useRef(0);
  const deferredQuery = useDeferredValue(query);

  async function load() {
    const n = ++run.current;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/automatic?id=baixas", { signal: AbortSignal.timeout(30_000) });
      const body = await response.text();
      if (!response.ok) {
        let message = "Não foi possível ler a aba BAIXA CC.";
        try {
          message = JSON.parse(body).error || message;
        } catch {
          // Plain-text error from the platform.
        }
        throw Error(message);
      }
      const parsed = parseWriteOffs(decodeWriteOffMatrix(body, response.headers.get("X-Source-Format")));
      if (n !== run.current) return;
      setItems(parsed);
      setSheet(decodeURIComponent(response.headers.get("X-Source-Sheet") || "BAIXA CC"));
      setReadAt(response.headers.get("X-Source-Read-At") || new Date().toISOString());
      setPage(0);
    } catch (e) {
      if (n === run.current)
        setError(
          (e as Error).name === "TimeoutError"
            ? "A planilha demorou mais de 30 segundos para responder. Tente Atualizar de novo."
            : (e as Error).message,
        );
    } finally {
      if (n === run.current) setBusy(false);
    }
  }
  // The tab is small: read once when the module opens; afterwards only on click.
  useEffect(() => {
    void load();
    return () => {
      run.current++;
    };
  }, []);

  const centers = useMemo(
    () =>
      [...new Map((items || []).map((item) => [item.costCenter, item.costCenterName])).entries()]
        .filter(([code]) => code)
        .sort((a, b) => a[0].localeCompare(b[0])),
    [items],
  );
  const months = useMemo(
    () => [...new Set((items || []).map((item) => item.month).filter(Boolean))].sort().reverse(),
    [items],
  );
  const filtered = useMemo(() => {
    const text = deferredQuery.trim().toLowerCase();
    return (items || []).filter(
      (item) =>
        (center === "all" || item.costCenter === center) &&
        (month === "all" || item.month === month) &&
        (pdfFilter === "all" || (pdfFilter === "missing" ? !item.pdfUrl : !!item.pdfUrl)) &&
        [item.document, item.costCenter, item.costCenterName, item.material, item.description, item.reason, item.requester, item.op, item.status]
          .join(" ")
          .toLowerCase()
          .includes(text),
    );
  }, [items, deferredQuery, center, month, pdfFilter]);
  const summary = useMemo(() => summarizeWriteOffs(filtered), [filtered]);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE)),
    current = Math.min(page, pages - 1);
  const hasFilters = !!query.trim() || center !== "all" || month !== "all" || pdfFilter !== "all";
  const filter = (setter: (value: string) => void) => (value: string) => {
    setter(value);
    setPage(0);
  };

  async function exportExcel() {
    const x = await import("xlsx");
    const sheetRows = filtered.map((item) => ({
      Data: day(item.date),
      Documento: item.document,
      "Centro de custo": item.costCenter,
      "Descrição do centro de custo": item.costCenterName,
      Material: item.material,
      Descrição: item.description,
      Quantidade: item.quantity,
      UMB: item.unit,
      "Valor (R$)": item.value,
      Motivo: item.reason,
      Solicitante: item.requester,
      OP: item.op,
      Status: item.status,
      PDF: item.pdfUrl || "",
      "Linha na planilha": item.row,
    }));
    const book = x.utils.book_new();
    const list = x.utils.json_to_sheet(sheetRows);
    list["!cols"] = [12, 16, 14, 26, 16, 40, 12, 8, 14, 44, 18, 16, 14, 60, 10].map((wch) => ({ wch }));
    if (list["!ref"]) list["!autofilter"] = { ref: list["!ref"] };
    x.utils.book_append_sheet(book, list, "Baixas_CC");
    const totals = x.utils.json_to_sheet(
      summary.centers.map((group) => ({
        "Centro de custo": group.costCenter,
        Descrição: group.name,
        Baixas: group.count,
        "Valor (R$)": group.value,
        "Sem valor informado": group.withoutValue,
      })),
    );
    totals["!cols"] = [16, 32, 10, 16, 18].map((wch) => ({ wch }));
    x.utils.book_append_sheet(book, totals, "Por_centro_de_custo");
    x.writeFile(book, `Baixas_centro_de_custo_${new Date().toISOString().slice(0, 10)}.xlsx`);
  }

  return (
    <section className="shortages panel write-offs" aria-label="Baixas de centro de custo">
      <div className="warehouse-heading">
        <div>
          <p className="eyebrow">ABA {sheet.toUpperCase()} DA PLANILHA</p>
          <h3>Baixas de centro de custo</h3>
          <p>Uma linha por baixa (FO.FI.C.007), com o PDF no Google Drive. O portal só consulta: não altera a planilha nem o SAP.</p>
        </div>
        <div className="stock-projects-actions">
          <button className="primary" disabled={busy} onClick={load}>
            <RefreshCw size={16} className={busy ? "spin" : ""} />
            {busy ? "Lendo…" : "Atualizar"}
          </button>
          <button disabled={busy || !filtered.length} onClick={exportExcel}>
            <Download size={16} />
            Baixar Excel
          </button>
        </div>
      </div>

      {error && (
        <div className="notice" role="alert">
          <TriangleAlert size={18} />
          <div>
            <b>{error}</b>
            <p>
              Na planilha do portal, crie a aba <b>BAIXA CC</b> com os títulos na primeira linha: <i>Data · Documento ·
              Centro de custo · Material · Descrição · Quantidade · UMB · Valor · Motivo · Solicitante · PDF</i>. Só
              Centro de custo e Documento (ou PDF) são obrigatórios. Na coluna PDF, cole o link de compartilhamento do
              arquivo no Google Drive.
            </p>
          </div>
        </div>
      )}
      {busy && !items && (
        <div className="empty" role="status">
          <RefreshCw className="spin" />
          <h3>Lendo a aba BAIXA CC…</h3>
        </div>
      )}

      {items && (
        <>
          <div className="warehouse-metrics write-off-metrics">
            <article>
              <FileText size={19} />
              <span>Baixas</span>
              <strong>{fmt(summary.count)}</strong>
              <small>{fmt(summary.documents)} documento(s) diferentes</small>
            </article>
            <article className="metric-return">
              <span>Valor baixado</span>
              <strong className="write-off-money">{money(summary.value)}</strong>
              <small>{summary.withoutValue ? `${fmt(summary.withoutValue)} sem valor informado` : "soma da coluna Valor"}</small>
            </article>
            <article>
              <span>Centros de custo</span>
              <strong>{fmt(summary.centers.length)}</strong>
              <small>no filtro atual</small>
            </article>
            <article>
              <span>Sem PDF</span>
              <strong>{fmt(summary.withoutPdf)}</strong>
              <small>linhas sem link válido do Drive</small>
            </article>
          </div>

          <div className="warehouse-filter-panel" role="search" aria-label="Filtros das baixas">
            <div className="warehouse-filter-heading">
              <b>Encontre as baixas</b>
              <button
                className="warehouse-clear-filters"
                disabled={!hasFilters}
                onClick={() => {
                  setQuery("");
                  setCenter("all");
                  setMonth("all");
                  setPdfFilter("all");
                  setPage(0);
                }}
              >
                Limpar filtros
              </button>
            </div>
            <div className="warehouse-filters write-off-filters">
              <label>
                Busca
                <input
                  aria-label="Buscar baixas"
                  placeholder="Documento, material, motivo, solicitante…"
                  value={query}
                  onChange={(e) => filter(setQuery)(e.target.value)}
                />
              </label>
              <label>
                Centro de custo
                <select aria-label="Centro de custo" value={center} onChange={(e) => filter(setCenter)(e.target.value)}>
                  <option value="all">Todos</option>
                  {centers.map(([code, name]) => (
                    <option key={code} value={code}>
                      {name ? `${code} · ${name}` : code}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Mês
                <select aria-label="Mês da baixa" value={month} onChange={(e) => filter(setMonth)(e.target.value)}>
                  <option value="all">Todos</option>
                  {months.map((value) => (
                    <option key={value} value={value}>
                      {monthLabel(value)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                PDF
                <select aria-label="PDF da baixa" value={pdfFilter} onChange={(e) => filter(setPdfFilter)(e.target.value)}>
                  <option value="all">Todos</option>
                  <option value="with">Com PDF</option>
                  <option value="missing">Sem PDF</option>
                </select>
              </label>
            </div>
            <div className="warehouse-filter-summary" aria-live="polite">
              <span>
                <b>{fmt(filtered.length)}</b> de {fmt(items.length)} baixas
              </span>
              <span>Lido em {readAt ? new Date(readAt).toLocaleString("pt-BR") : "—"}</span>
            </div>
          </div>

          {summary.centers.length > 1 && (
            <div className="write-off-centers" aria-label="Valor por centro de custo">
              {summary.centers.slice(0, 8).map((group) => (
                <button
                  key={group.costCenter}
                  type="button"
                  aria-pressed={center === group.costCenter}
                  onClick={() => filter(setCenter)(center === group.costCenter ? "all" : group.costCenter)}
                >
                  <b>{group.costCenter}</b>
                  <span>{group.name || `${fmt(group.count)} baixa(s)`}</span>
                  <strong>{money(group.value)}</strong>
                </button>
              ))}
            </div>
          )}

          {!filtered.length ? (
            <div className="empty">
              <h3>{hasFilters ? "Nenhuma baixa neste filtro" : "A aba BAIXA CC ainda não tem linhas"}</h3>
              <p>{hasFilters ? "Ajuste os filtros." : "Preencha uma linha por baixa e clique em Atualizar."}</p>
            </div>
          ) : (
            <TableViewport className="warehouse-table write-off-table" label="Baixas de centro de custo">
              <table>
                <thead>
                  <tr>
                    {["Data / documento", "Centro de custo", "Material", "Qtd.", "Valor", "Motivo", "PDF"].map((label) => (
                      <th key={label}>{label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filtered.slice(current * PAGE, current * PAGE + PAGE).map((item) => (
                    <tr key={item.row}>
                      <td>
                        <b className="code">{day(item.date)}</b>
                        <span className="description">{item.document || "Sem nº de documento"}</span>
                        {item.status && <small>{item.status}</small>}
                      </td>
                      <td>
                        <b>{item.costCenter || "—"}</b>
                        {item.costCenterName && <small>{item.costCenterName}</small>}
                      </td>
                      <td>
                        <b className="code">{item.material || "—"}</b>
                        <span className="description">{item.description}</span>
                        {item.op && <small>OP {item.op}</small>}
                      </td>
                      <td className="num">
                        {fmt(item.quantity)}
                        <small>{item.unit}</small>
                      </td>
                      <td className="num">{money(item.value)}</td>
                      <td>
                        <span className="write-off-reason">{item.reason || "—"}</span>
                        {item.requester && <small>{item.requester}</small>}
                      </td>
                      <td>
                        {item.pdfUrl ? (
                          item.pdfPreview ? (
                            <button type="button" className="write-off-pdf" onClick={() => setViewing(item)}>
                              <FileText size={15} />
                              Ver PDF
                            </button>
                          ) : (
                            <a className="write-off-pdf" href={item.pdfUrl} target="_blank" rel="noopener noreferrer">
                              <ExternalLink size={15} />
                              Abrir PDF
                            </a>
                          )
                        ) : (
                          <small className="write-off-missing">{item.pdfLabel ? "Link inválido" : "Sem PDF"}</small>
                        )}
                        <small>Linha {item.row}</small>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableViewport>
          )}
          <div className="table-footer">
            <span>O Excel leva todas as {fmt(filtered.length)} baixas do filtro.</span>
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

      <Dialog open={!!viewing} onOpenChange={(open) => !open && setViewing(null)}>
        <DialogContent className="write-off-viewer">
          <DialogHeader>
            <DialogTitle>
              {viewing?.document || "Baixa"} · {viewing?.costCenter}
            </DialogTitle>
            <DialogDescription>
              {day(viewing?.date || null)} · {viewing?.material} {viewing?.description} · {money(viewing?.value ?? null)}
            </DialogDescription>
          </DialogHeader>
          {viewing?.pdfPreview && (
            <iframe
              title={`PDF da baixa ${viewing.document}`}
              src={viewing.pdfPreview}
              allow="autoplay"
              referrerPolicy="no-referrer"
            />
          )}
          <p className="write-off-viewer-note">
            Se aparecer "Acesso negado", entre no Google com a conta que tem acesso ao arquivo ou peça o
            compartilhamento.{" "}
            {viewing?.pdfUrl && (
              <a href={viewing.pdfUrl} target="_blank" rel="noopener noreferrer">
                Abrir no Drive
              </a>
            )}
          </p>
        </DialogContent>
      </Dialog>
    </section>
  );
}
