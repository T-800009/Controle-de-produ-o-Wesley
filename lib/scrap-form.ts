/**
 * Scrap Form (Formulário de SCRAP A-B).
 *
 * O portal preenche o formulário, gera o PDF com os quatro campos de assinatura
 * digital já nomeados (um por quadro) e acompanha as assinaturas feitas no
 * Adobe. Este arquivo é só regra: o mesmo código roda no navegador, no Worker e
 * nos testes.
 */

export const MAX_ITEMS = 18;
/** Limite por PDF: o banco guarda o arquivo em partes e o plano gratuito do Cloudflare aceita até 50 consultas por envio. */
export const MAX_PDF_BYTES = 1_500_000;

/** Quadros do Scrap Form (production…finance) e do FO.FI.C.007 (requester…finance). */
export type SlotId = "production" | "quality" | "logistics" | "finance" | "requester" | "manager" | "scm";
export type DocKind = "scrap" | "cc";
export type Slot = {
  id: SlotId;
  /** Nome do campo de assinatura no PDF. */
  field: string;
  order: string;
  /** Texto do quadro, igual ao formulário original. */
  role: string;
  /** Rótulo curto em português para a tela. */
  label: string;
  short: string;
  defaultName: string;
};
export const SLOTS: readonly Slot[] = [
  { id: "production", field: "Assinatura_Producao", order: "1ª", role: "Production Supervisor", label: "Produção", short: "P", defaultName: "André Ribeiro" },
  { id: "quality", field: "Assinatura_Qualidade", order: "2ª", role: "Responsible for Quality", label: "Qualidade", short: "Q", defaultName: "Marcus Gallo" },
  { id: "logistics", field: "Assinatura_Logistica", order: "3ª", role: "Logistics Supervisor", label: "Logística", short: "L", defaultName: "Gleiber Souza" },
  { id: "finance", field: "Assinatura_Financeiro", order: "4ª", role: "Finance Department (If Class A or B)", label: "Financeiro", short: "F", defaultName: "Rosymara Santos" },
];
/** FO.FI.C.007 (baixa / ajuste em centro de custo): as 4 assinaturas são obrigatórias. */
export const CC_SLOTS: readonly Slot[] = [
  { id: "requester", field: "Assinatura_Solicitante", order: "1ª", role: "Requester", label: "Solicitante", short: "S", defaultName: "Wesley Souza" },
  { id: "manager", field: "Assinatura_Gestor", order: "2ª", role: "Direct Manager", label: "Gestor", short: "G", defaultName: "André Ribeiro" },
  { id: "scm", field: "Assinatura_SCM", order: "3ª", role: "SCM Manager", label: "SCM", short: "M", defaultName: "Rogério Riese" },
  { id: "finance", field: "Assinatura_Financeiro", order: "4ª", role: "Finance Department", label: "Financeiro", short: "F", defaultName: "Rosymara Santos" },
];
const ALL_SLOTS: readonly Slot[] = [...SLOTS, ...CC_SLOTS.filter((slot) => slot.id !== "finance")];
export const slotsOf = (kind: DocKind) => (kind === "cc" ? CC_SLOTS : SLOTS);
export const slotById = (id: SlotId) => ALL_SLOTS.find((slot) => slot.id === id)!;

export const CAUSES = [
  { code: "A", en: "Damaged during assembly", pt: "Danificado na montagem" },
  { code: "B", en: "Improper Handling", pt: "Manuseio inadequado" },
  { code: "C", en: "Malfunctioning", pt: "Mau funcionamento" },
  { code: "D", en: "Deteriorated", pt: "Deteriorado" },
  { code: "E", en: "Supplier Defect", pt: "Defeito do fornecedor" },
  { code: "F", en: "Broken", pt: "Quebrado" },
  { code: "G", en: "Contaminated", pt: "Contaminado" },
  { code: "H", en: "Wrong Application", pt: "Aplicação errada" },
] as const;
const CAUSE_CODES = new Set<string>(CAUSES.map((cause) => cause.code));
const CLASSES = new Set(["A", "B", "C"]);

export type ScrapItem = {
  date: string;
  material: string;
  quantity: number | null;
  name: string;
  defect: string;
  cause: string;
  vin: string;
  op: string;
  unitPrice: number | null;
  classification: string;
};
export type ScrapFormData = {
  formDate: string;
  items: ScrapItem[];
  approvers: Record<string, string>;
  costCenter: string;
  sapDocument: string;
  /** Reposição da peça: requisição (PR), data da PR e pedido (PO). Não vão no PDF. */
  pr: string;
  prDate: string;
  po: string;
  notes: string;
  /** Formulário que já existia (importado): nome do PDF original. Os dados são a transcrição dele. */
  source?: string;
};
/** valid: conferida (conteúdo e criptografia). invalid: não confere. unchecked: não deu para conferir. */
/** imported: assinatura que veio no PDF de um formulário importado; conta como feita, sem conferir se o arquivo foi regravado. */
export type SignatureCheck = "valid" | "invalid" | "unchecked" | "imported";
export type ScrapSignature = {
  field: string;
  slot: SlotId | null;
  /** Nome do certificado (CN) de quem assinou. */
  signer: string;
  signedAt: string | null;
  check: SignatureCheck;
  coversWholeFile: boolean;
  detail: string;
  /** Quem emitiu o certificado (ex.: byd-PS-CA-01-CA). */
  issuer?: string;
  /** ID digital criado pela própria pessoa, sem certificadora. */
  selfSigned?: boolean;
};
export type ScrapStatus = "draft" | "signing" | "signed";
export type ScrapFileMeta = {
  version: number;
  kind: "generated" | "signed";
  name: string;
  size: number;
  sha256: string;
  createdAt: string;
  createdBy: string;
};
export type ScrapForm = {
  id: string;
  number: string;
  status: ScrapStatus;
  data: ScrapFormData;
  signatures: ScrapSignature[];
  fileVersion: number;
  files: ScrapFileMeta[];
  revision: number;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  signedAt: string | null;
  sentAt: string | null;
};

const pad = (value: number) => String(value).padStart(2, "0");
export function todayIso(now = new Date()) {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
export const isIsoDate = (value: unknown): value is string =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  !Number.isNaN(Date.parse(value + "T12:00:00Z")) &&
  new Date(value + "T12:00:00Z").toISOString().slice(0, 10) === value;

export function emptyItem(previous?: Partial<ScrapItem>, date = todayIso()): ScrapItem {
  // Peças do mesmo ônibus/defeito costumam vir juntas: repete o contexto.
  return {
    date: previous?.date || date,
    material: "",
    quantity: 1,
    name: "",
    defect: previous?.defect || "",
    cause: previous?.cause || "",
    vin: previous?.vin || "",
    op: previous?.op || "",
    unitPrice: null,
    classification: "",
  };
}
export function defaultApprovers(saved?: Partial<Record<string, string>> | null, slots: readonly Slot[] = SLOTS) {
  return Object.fromEntries(slots.map((slot) => [slot.id, String(saved?.[slot.id] || "").trim() || slot.defaultName])) as Record<string, string>;
}
export function emptyForm(approvers?: Partial<Record<string, string>> | null): ScrapFormData {
  const date = todayIso();
  return { formDate: date, items: [emptyItem(undefined, date)], approvers: defaultApprovers(approvers), costCenter: "", sapDocument: "", pr: "", prDate: "", po: "", notes: "" };
}

/** Código SAP como texto: tira espaços e põe em maiúsculas. Nunca inventa o sufixo. */
export const materialCode = (value: unknown) =>
  String(value ?? "")
    .trim()
    .replace(/\s+/g, "")
    .toUpperCase();

export const text = (value: unknown, max: number) =>
  String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
function amount(value: unknown, max: number): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : parseBrNumber(String(value));
  if (parsed === null || !Number.isFinite(parsed) || parsed < 0 || parsed > max) throw Error("Quantidade ou preço inválido.");
  return parsed;
}
/** "1.233,89", "1233.89", "R$ 1.233,89" → 1233.89 */
export function parseBrNumber(raw: string): number | null {
  let value = String(raw).trim().replace(/R\$|\s/g, "");
  if (!value) return null;
  if (value.includes(",")) value = value.replace(/\./g, "").replace(",", ".");
  else if (/^-?\d{1,3}(\.\d{3})+$/.test(value)) value = value.replace(/\./g, "");
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Normaliza o que veio da tela ou da API. Lança erro se a estrutura for inválida. */
export function sanitizeFormData(input: unknown): ScrapFormData {
  const raw = (input && typeof input === "object" ? input : null) as Record<string, any> | null;
  if (!raw || !Array.isArray(raw.items)) throw Error("Formulário inválido.");
  if (raw.items.length > MAX_ITEMS) throw Error(`Use no máximo ${MAX_ITEMS} itens por formulário. Crie outro formulário para os demais.`);
  const formDate = isIsoDate(raw.formDate) ? raw.formDate : todayIso();
  const items = raw.items.map((item: any) => {
    if (!item || typeof item !== "object") throw Error("Item inválido.");
    const cause = text(item.cause, 1).toUpperCase();
    const classification = text(item.classification, 1).toUpperCase();
    return {
      date: isIsoDate(item.date) ? item.date : "",
      material: materialCode(item.material).slice(0, 40),
      quantity: amount(item.quantity, 1_000_000),
      name: text(item.name, 120),
      defect: text(item.defect, 300),
      cause: CAUSE_CODES.has(cause) ? cause : "",
      vin: text(item.vin, 30),
      op: text(item.op, 20).replace(/\s+/g, ""),
      unitPrice: amount(item.unitPrice, 1_000_000_000),
      classification: CLASSES.has(classification) ? classification : "",
    } satisfies ScrapItem;
  });
  const approvers = defaultApprovers(null);
  for (const slot of SLOTS) {
    const value = text(raw.approvers?.[slot.id], 80);
    approvers[slot.id] = value;
  }
  return {
    formDate,
    items,
    approvers,
    costCenter: text(raw.costCenter, 40),
    sapDocument: text(raw.sapDocument, 40),
    pr: text(raw.pr, 30),
    prDate: isIsoDate(raw.prDate) ? raw.prDate : "",
    po: text(raw.po, 30),
    notes: text(raw.notes, 500),
    ...(raw.source ? { source: text(raw.source, 160) } : {}),
  };
}

/**
 * Formulário importado cujo PDF não foi emitido pelo portal: os dados são só a
 * transcrição do PDF assinado e podem ser corrigidos sem mexer nas assinaturas.
 */
export const isTranscription = (form: { data: { source?: string }; files: { kind: string }[] }) => !!form.data.source && !form.files.some((file) => file.kind === "generated");

export const cents = (value: number) => Math.round(value * 100) / 100;
export function itemTotal(item: Pick<ScrapItem, "quantity" | "unitPrice">) {
  return item.quantity === null || item.unitPrice === null ? null : cents(item.quantity * item.unitPrice);
}
export function formTotal(data: Pick<ScrapFormData, "items">) {
  return cents(data.items.reduce((sum, item) => sum + (itemTotal(item) || 0), 0));
}

/** Financeiro assina se houver classe A ou B (ou classe ainda não definida). */
export function financeRequired(data: Pick<ScrapFormData, "items">) {
  return data.items.some((item) => item.classification !== "C");
}
export function requiredSlots(data: Pick<ScrapFormData, "items">): Slot[] {
  return SLOTS.filter((slot) => slot.id !== "finance" || financeRequired(data));
}

/** O que falta para gerar o PDF. Lista vazia = pronto. */
export function pdfProblems(data: ScrapFormData): string[] {
  const problems: string[] = [];
  if (!data.items.length) problems.push("Inclua pelo menos um item.");
  data.items.forEach((item, index) => {
    const n = `Item ${index + 1}`;
    const missing: string[] = [];
    if (!item.date) missing.push("data");
    if (!item.material) missing.push("P/N SAP");
    if (item.quantity === null || item.quantity <= 0) missing.push("quantidade");
    if (!item.name) missing.push("descrição do material");
    if (!item.defect) missing.push("descrição do defeito");
    if (!item.cause) missing.push("causa (A–H)");
    if (!item.vin) missing.push("N° VIN");
    if (!item.op) missing.push("ordem de produção");
    if (item.unitPrice === null || item.unitPrice <= 0) missing.push("preço unitário");
    if (!item.classification) missing.push("classe");
    if (missing.length) problems.push(`${n}: informe ${missing.join(", ")}.`);
    else if (!/^\d{8,18}$/.test(item.op)) problems.push(`${n}: a ordem de produção deve ter só números (ex.: 19000001542).`);
  });
  for (const slot of requiredSlots(data)) if (!data.approvers[slot.id]) problems.push(`Informe o nome do responsável: ${slot.label}.`);
  return problems;
}

/** Nome do campo → quadro, só pelos nomes que o portal grava (Assinatura_Producao…). */
export function slotFromFieldName(name: string): SlotId | null {
  const key = name.trim().toLowerCase();
  return ALL_SLOTS.find((slot) => slot.field.toLowerCase() === key)?.id || null;
}
export const isSlotId = (value: unknown): value is SlotId => ALL_SLOTS.some((slot) => slot.id === value);

/** Só uma assinatura conferida preenche um quadro. */
export const accepted = (signature: ScrapSignature) => signature.check === "valid" || signature.check === "imported";
const ORIGINAL = "Assinatura do PDF original (importado).";
/** Importação: quem assinou o PDF antigo conta como assinado, mesmo que o arquivo tenha sido regravado depois. */
export const acceptOriginal = (signatures: ScrapSignature[]): ScrapSignature[] => signatures.map((signature) => ({ ...signature, check: "imported", detail: ORIGINAL }));
const sameSignature = (a: ScrapSignature, b: ScrapSignature) => a.field === b.field && a.signer === b.signer && a.signedAt === b.signedAt;
/** PDF novo de um formulário importado: as assinaturas que vieram na importação continuam aceitas; as novas são conferidas. */
export const keepOriginal = (signatures: ScrapSignature[], previous: ScrapSignature[]): ScrapSignature[] =>
  signatures.map((signature) => (previous.some((old) => old.check === "imported" && sameSignature(old, signature)) ? { ...signature, check: "imported", detail: ORIGINAL } : signature));
/** Toda assinatura "imported" que chega tem de ser uma das que vieram na importação. */
export const importedMatch = (signatures: ScrapSignature[], previous: ScrapSignature[]) =>
  signatures.every((signature) => signature.check !== "imported" || previous.some((old) => old.check === "imported" && sameSignature(old, signature)));
export type SlotProgress = { slot: Slot; required: boolean; signature: ScrapSignature | null; expected: string };
type ProgressData = { approvers: Record<string, string>; items: unknown[] };
export function signatureProgress(data: ProgressData, signatures: ScrapSignature[], kind: DocKind = "scrap") {
  const list = slotsOf(kind);
  const required = new Set((kind === "cc" ? list : requiredSlots(data as ScrapFormData)).map((slot) => slot.id));
  const slots: SlotProgress[] = list.map((slot) => {
    const candidates = signatures.filter((signature) => signature.slot === slot.id);
    const signature = candidates.find(accepted) || candidates[0] || null;
    return { slot, required: required.has(slot.id), signature, expected: data.approvers[slot.id] || slot.defaultName };
  });
  const signed = slots.filter((entry) => entry.signature && accepted(entry.signature));
  const missing = slots.filter((entry) => entry.required && !(entry.signature && accepted(entry.signature)));
  const issues: string[] = [];
  const where = (signature: ScrapSignature) => (signature.slot ? list.find((slot) => slot.id === signature.slot)?.label || slotById(signature.slot).label : signature.field);
  for (const signature of signatures) {
    const who = signature.signer || "alguém";
    if (signature.check === "invalid") issues.push(`A assinatura de ${who} (${where(signature)}) não confere: ${signature.detail || "o PDF foi alterado depois dela."}`);
    if (signature.check === "unchecked") issues.push(`Não foi possível conferir a assinatura de ${who} (${where(signature)}): ${signature.detail || "confira no Adobe."}`);
    if (signature.check === "valid" && signature.selfSigned)
      issues.push(`${who} (${where(signature)}) assinou com um ID digital próprio (autoassinado), não emitido pela certificadora da empresa.`);
    if (!signature.slot) issues.push(`${who} assinou num campo criado à parte (${signature.field}), fora dos quadros do formulário.`);
    else if (!list.some((slot) => slot.id === signature.slot)) issues.push(`${who} assinou um campo (${signature.field}) que não é deste formulário.`);
  }
  const bySigner = new Map<string, string[]>();
  for (const entry of signed) {
    const key = entry.signature!.signer.trim().toLowerCase();
    if (key) bySigner.set(key, [...(bySigner.get(key) || []), entry.slot.label]);
  }
  for (const [signer, labels] of bySigner)
    if (labels.length > 1) issues.push(`A mesma pessoa (${signer}) assinou ${labels.join(" e ")}. Confira se está certo.`);
  const latest = signatures.filter(accepted).sort((a, b) => String(b.signedAt || "").localeCompare(String(a.signedAt || "")))[0];
  // Formulário importado: alterações antigas no arquivo não interessam.
  if (signatures.length && !signatures.some((signature) => signature.coversWholeFile) && !signatures.some((signature) => signature.check === "imported"))
    issues.push(
      `O arquivo recebeu alterações depois da última assinatura${latest?.signer ? ` (${latest.signer})` : ""}. Confira no Adobe se as assinaturas aparecem como válidas.`,
    );
  return { slots, signed, missing, issues, complete: missing.length === 0 && signatures.length > 0 };
}
export function statusFromSignatures(data: ProgressData, signatures: ScrapSignature[], kind: DocKind = "scrap"): ScrapStatus {
  return signatureProgress(data, signatures, kind).complete ? "signed" : "signing";
}

/** Valida o resultado da leitura das assinaturas que chega da tela. */
export function sanitizeSignatures(input: unknown): ScrapSignature[] {
  if (!Array.isArray(input) || input.length > 20) throw Error("Leitura de assinaturas inválida.");
  const checks = new Set(["valid", "intact", "invalid", "unchecked", "imported"]);
  return input.map((raw: any) => {
    if (!raw || typeof raw !== "object" || !checks.has(raw.check)) throw Error("Leitura de assinaturas inválida.");
    const signedAt = typeof raw.signedAt === "string" && !Number.isNaN(Date.parse(raw.signedAt)) ? new Date(raw.signedAt).toISOString() : null;
    return {
      field: text(raw.field, 80),
      slot: isSlotId(raw.slot) ? raw.slot : null,
      signer: text(raw.signer, 120),
      signedAt,
      // "intact" (versões de teste) nunca conta como conferida.
      check: (raw.check === "intact" ? "unchecked" : raw.check) as SignatureCheck,
      coversWholeFile: raw.coversWholeFile === true,
      detail: text(raw.detail, 300),
      issuer: text(raw.issuer, 120),
      selfSigned: raw.selfSigned === true,
    };
  });
}

export function brDate(iso: string | null | undefined) {
  if (!iso) return "";
  const match = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : "";
}
export function brDateTime(iso: string | null | undefined) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}
export function brMoney(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "";
  return value.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

/** Nome do arquivo no padrão que a equipe já usa ("… Falta assinar Rosy"). */
export function pdfFileName(form: Pick<ScrapForm, "number" | "data" | "status" | "signatures">) {
  const date = brDate(form.data.formDate).replace(/\//g, ".");
  const base = `Scrap Form ${form.number}${date ? " " + date : ""}`;
  if (form.status === "draft") return `${base} - rascunho.pdf`;
  const progress = signatureProgress(form.data, form.signatures);
  if (progress.complete) return `${base} - ASSINADO.pdf`;
  if (!progress.signed.length) return `${base} - para assinatura.pdf`;
  const missing = progress.missing.map((entry) => entry.expected.split(/\s+/)[0] || entry.slot.label);
  return `${base} - falta assinar ${missing.join(" e ")}.pdf`.replace(/[\\/:*?"<>|]+/g, "-");
}

/** Texto para e-mail / Teams. */
export function shareMessage(form: Pick<ScrapForm, "number" | "data" | "status" | "signatures">, link = "") {
  const progress = signatureProgress(form.data, form.signatures);
  const total = brMoney(formTotal(form.data));
  const lines = form.data.items.map(
    (item) => `• ${item.material} — ${item.name} · ${item.quantity ?? "?"} un · ${brMoney(itemTotal(item)) || "sem valor"} · OP ${item.op || "—"} · VIN ${item.vin || "—"}`,
  );
  const subject = progress.complete
    ? `Scrap Form ${form.number} assinado — ${total}`
    : `Scrap Form ${form.number} para assinatura — ${progress.missing.map((entry) => entry.slot.label).join(", ")}`;
  const intro = progress.complete
    ? `Segue o Scrap Form ${form.number} com todas as assinaturas.`
    : `Segue o Scrap Form ${form.number} para assinatura digital. Falta: ${progress.missing
        .map((entry) => `${entry.expected} (${entry.slot.label})`)
        .join(", ")}.`;
  const how = progress.complete ? [] : ["", "Abra o PDF no Adobe, clique no campo do seu quadro e assine com o seu certificado. Depois devolva o PDF assinado."];
  const body = [intro, "", ...lines, `Total: ${total}`, ...how, ...(link ? ["", link] : [])].join("\n");
  return { subject, body };
}

/** Sugestões tiradas dos formulários já feitos (descrição, preço, classe, VIN por OP). */
export function formHistory(forms: Pick<ScrapForm, "data" | "updatedAt">[]) {
  const materials = new Map<string, { name: string; unitPrice: number | null; classification: string; date: string }>();
  const vinByOp = new Map<string, string>();
  const ordered = [...forms].sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)));
  for (const form of ordered)
    for (const item of form.data.items) {
      if (item.material && item.name)
        materials.set(item.material, { name: item.name, unitPrice: item.unitPrice, classification: item.classification, date: item.date });
      if (item.op && item.vin) vinByOp.set(item.op, item.vin);
    }
  return { materials, vinByOp };
}

/** Várias BOMs podem classificar o mesmo material: usa a classe mais alta (A > B > C). */
export function strongestClass(values: string[]) {
  for (const value of ["A", "B", "C"]) if (values.includes(value)) return value;
  return "";
}

export type ScrapSummary = { open: number; missingFinance: number; signedThisMonth: number; valueOpen: number; valueThisMonth: number };
export function summarizeForms(forms: ScrapForm[], month = todayIso().slice(0, 7)): ScrapSummary {
  let open = 0,
    missingFinance = 0,
    signedThisMonth = 0,
    valueOpen = 0,
    valueThisMonth = 0;
  for (const form of forms) {
    const total = formTotal(form.data);
    if (form.status === "signing") {
      open++;
      valueOpen += total;
      const progress = signatureProgress(form.data, form.signatures);
      if (progress.missing.length === 1 && progress.missing[0].slot.id === "finance") missingFinance++;
    }
    const signedDay = form.signedAt || form.updatedAt;
    if (form.status === "signed" && signedDay && todayIso(new Date(signedDay)).slice(0, 7) === month) {
      signedThisMonth++;
      valueThisMonth += total;
    }
  }
  return { open, missingFinance, signedThisMonth, valueOpen: cents(valueOpen), valueThisMonth: cents(valueThisMonth) };
}
