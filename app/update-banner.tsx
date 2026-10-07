import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { PORTAL_VERSION } from "@/lib/version";

/** Versão publicada no servidor; null quando não deu para saber (sem rede, teste). */
async function serverVersion(): Promise<string | null> {
  try {
    const response = await fetch("/api/version", { cache: "no-store" });
    if (!response.ok) return null;
    const data = (await response.json()) as { version?: unknown };
    return typeof data?.version === "string" ? data.version : null;
  } catch {
    return null;
  }
}
/** A aba está com o código de uma versão anterior à publicada. */
export async function portalOutdated() {
  const version = await serverVersion();
  return !!version && version !== PORTAL_VERSION;
}

/** Faixa no topo quando sai uma versão nova com a aba aberta. */
export function UpdateBanner() {
  const [outdated, setOutdated] = useState(false);
  useEffect(() => {
    let stopped = false;
    const check = async () => {
      if (stopped || document.visibilityState === "hidden") return;
      if (await portalOutdated()) setOutdated(true);
    };
    const onVisible = () => void check();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    const timer = setInterval(check, 5 * 60_000);
    return () => {
      stopped = true;
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
      clearInterval(timer);
    };
  }, []);
  if (!outdated) return null;
  return (
    <div className="update-banner" role="status">
      <span>O portal foi atualizado. Recarregue para usar a versão nova.</span>
      <button type="button" onClick={() => location.reload()}>
        <RefreshCw size={14} />
        Atualizar agora
      </button>
    </div>
  );
}
