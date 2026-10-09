import { useEffect, useState } from "react";
import { Copy, KeyRound, Link2, LockKeyhole, LockKeyholeOpen, RefreshCw, ShieldCheck, TriangleAlert, UserX } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { requestJson } from "@/lib/api";

type Summary = { mode: "open" | "closed"; link: string | null; linkCreatedAt: string | null; activeSessions: number; analystConfigured: boolean; viewerPasswordConfigured: boolean };
const when = (value: string | null) => (value ? new Date(value).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }) : "");

/** Janela "Acesso" (só ADM): consulta aberta ou fechada, link de consulta e sessões. */
export default function AccessDialog({ onClose, onChanged }: { onClose: () => void; onChanged: (mode: "open" | "closed") => void }) {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [busy, setBusy] = useState(""),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  useEffect(() => {
    requestJson("/api/access").then(setSummary).catch((e) => setError((e as Error).message));
  }, []);
  async function act(label: string, body: Record<string, string>, done: (next: Summary) => string) {
    setBusy(label);
    setError("");
    setNotice("");
    try {
      const next: Summary = await requestJson("/api/access", body);
      setSummary(next);
      onChanged(next.mode);
      setNotice(done(next));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  async function copy() {
    if (!summary?.link) return;
    try {
      await navigator.clipboard.writeText(summary.link);
      setNotice("Link copiado. Mande para quem só precisa consultar.");
    } catch {
      setNotice("Selecione o link e copie com Ctrl+C.");
    }
  }
  const mode = summary?.mode;
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="import-dialog access-dialog">
        <DialogHeader>
          <DialogTitle>Acesso ao portal</DialogTitle>
          <DialogDescription>Quem não tem a senha de administrador só consegue ver. Importar, marcar, editar e apagar exigem a senha.</DialogDescription>
        </DialogHeader>
        {!summary && !error && (
          <p className="access-loading" role="status">
            <RefreshCw size={15} className="spin" />
            Lendo a configuração…
          </p>
        )}
        {summary && (
          <div className="access-body">
            <fieldset className="access-modes">
              <legend>Quem pode consultar</legend>
              <label className={mode === "open" ? "selected" : ""}>
                <input type="radio" name="access-mode" checked={mode === "open"} disabled={!!busy} onChange={() => act("mode", { action: "mode", mode: "open" }, () => "Consulta aberta: quem tem o endereço vê o portal, sem alterar nada.")} />
                <LockKeyholeOpen size={18} />
                <span>
                  <b>Aberto para consulta</b>
                  <small>Qualquer pessoa com o endereço do portal vê tudo, sem poder alterar.</small>
                </span>
              </label>
              <label className={mode === "closed" ? "selected" : ""}>
                <input type="radio" name="access-mode" checked={mode === "closed"} disabled={!!busy} onChange={() => act("mode", { action: "mode", mode: "closed" }, () => "Consulta fechada: só entra quem abrir o link de consulta ou tiver uma senha.")} />
                <LockKeyhole size={18} />
                <span>
                  <b>Fechado (recomendado)</b>
                  <small>Para ver, a pessoa abre o link de consulta abaixo. O endereço sozinho pede senha.</small>
                </span>
              </label>
            </fieldset>
            {mode === "open" && (
              <p className="access-warning">
                <TriangleAlert size={16} />
                <span>Os dados são sensíveis: no modo aberto, qualquer pessoa que receber o endereço vê BOMs, saldos, valores e os PDFs assinados (o certificado digital traz os dados de quem assinou).</span>
              </p>
            )}
            <section className="access-link">
              <h3>
                <Link2 size={16} />
                Link de consulta
              </h3>
              {summary.link ? (
                <>
                  <div className="access-link-row">
                    <input readOnly value={summary.link} aria-label="Link de consulta" onFocus={(event) => event.currentTarget.select()} />
                    <button type="button" onClick={copy} disabled={!!busy}>
                      <Copy size={15} />
                      Copiar
                    </button>
                  </div>
                  <small>
                    Criado em {when(summary.linkCreatedAt)}. Quem abrir o link fica 30 dias no modo consulta naquele navegador. Gerar um link novo desliga o anterior e quem entrou por ele.
                  </small>
                </>
              ) : (
                <small>Ainda não há link. Gere um para mandar a quem só precisa consultar quando o portal estiver fechado.</small>
              )}
              <button type="button" className="text-button" disabled={!!busy} onClick={() => act("link", { action: "link" }, () => (summary.link ? "Link novo gerado. O anterior parou de funcionar." : "Link gerado. Copie e mande para quem só consulta."))}>
                <KeyRound size={15} />
                {summary.link ? "Gerar link novo" : "Gerar link de consulta"}
              </button>
            </section>
            <section className="access-sessions">
              <h3>
                <ShieldCheck size={16} />
                Sessões abertas: {summary.activeSessions}
              </h3>
              <small>Se a senha ou o link vazou, troque a senha no Cloudflare (Secret PORTAL_PASSWORD), gere um link novo e encerre as sessões.</small>
              <button type="button" className="text-button" disabled={!!busy || summary.activeSessions <= 1} onClick={() => act("sessions", { action: "end-sessions" }, () => "Todas as outras sessões foram encerradas. A sua continua.")}>
                <UserX size={15} />
                Encerrar as outras sessões
              </button>
            </section>
          </div>
        )}
        {busy && (
          <p className="access-loading" role="status">
            <RefreshCw size={15} className="spin" />
            Salvando…
          </p>
        )}
        {notice && <p className="access-notice" role="status">{notice}</p>}
        {error && (
          <p className="scrap-message error" role="alert">
            <TriangleAlert size={15} />
            <span>{error}</span>
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
