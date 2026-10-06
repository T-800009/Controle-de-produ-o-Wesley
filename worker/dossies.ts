import type { PortalDatabase } from "./database";
import type { PortalRole } from "./auth";
import { ensureSchema, initial } from "./storage";
import {
  MAX_DATA_CHARS,
  MAX_FILES,
  MAX_FILE_BYTES,
  OUTCOME_LABELS,
  dossieSummary,
  emptyTrack,
  isOutcome,
  packData,
  sanitizeDossieData,
  sanitizeTrack,
  unpackData,
  validMaterial,
  type BomLookup,
  type BomUse,
  type Dossie,
  type DossieData,
  type DossieFileMeta,
  type DossieListItem,
  type DossieStatus,
  type DossieSummary,
  type DossieTrack,
} from "../lib/dossie";

/**
 * DOSSIÊ WAREHOUSE: cada dossiê guarda a prova da MB51 de um material (dados),
 * o andamento da cobrança (track: enviado, reforços, resposta, encerramento e
 * histórico) e os prints anexados (dossie_files, em partes de texto base64).
 * Numeração própria por ano (DOS-2026-0001…), nunca reaproveitada.
 * Toda alteração confere a revisão: duas pessoas não sobrescrevem uma à outra.
 */
const ready = new WeakMap<PortalDatabase, Promise<void>>();
export async function dossieSchema(db: PortalDatabase) {
  let promise = ready.get(db);
  if (!promise) {
    promise = db
      .batch([
        db.prepare(
          "CREATE TABLE IF NOT EXISTS dossies(id TEXT PRIMARY KEY NOT NULL,number TEXT NOT NULL UNIQUE,year INTEGER NOT NULL,seq INTEGER NOT NULL,status TEXT NOT NULL CHECK(status IN ('open','sent','answered','closed')),material TEXT NOT NULL,data TEXT NOT NULL,track TEXT NOT NULL,summary TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,created_by TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(year,seq))",
        ),
        db.prepare("CREATE INDEX IF NOT EXISTS dossies_material ON dossies(material)"),
        // Contador por ano: um número apagado nunca volta a ser usado.
        db.prepare("CREATE TABLE IF NOT EXISTS dossie_counters(year INTEGER PRIMARY KEY NOT NULL,seq INTEGER NOT NULL)"),
        db.prepare(
          "CREATE TABLE IF NOT EXISTS dossie_files(dossie_id TEXT NOT NULL,file_id TEXT NOT NULL,part INTEGER NOT NULL,name TEXT NOT NULL,type TEXT NOT NULL,size INTEGER NOT NULL,sha256 TEXT NOT NULL,data TEXT NOT NULL,created_at TEXT NOT NULL,created_by TEXT NOT NULL,PRIMARY KEY(dossie_id,file_id,part))",
        ),
      ])
      .then(() => {})
      .catch((error) => {
        ready.delete(db);
        throw error;
      });
    ready.set(db, promise);
  }
  await promise;
}

export class DossieError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}
function valid<T>(read: () => T): T {
  try {
    return read();
  } catch (error) {
    throw new DossieError((error as Error).message || "Dados inválidos.");
  }
}
const CONFLICT = "Outra pessoa alterou este dossiê. Atualize a tela antes de continuar.";
function changed(result: { meta?: { changes?: number } } | undefined) {
  if (!result?.meta?.changes) throw new DossieError(CONFLICT, 409);
}
const validId = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9-]{36}$/i.test(value);
const PART = 90_000;
const ROLE_LABEL: Record<string, string> = { admin: "Administrador", analyst: "Analista", viewer: "Consulta" };

type Row = {
  id: string;
  number: string;
  status: DossieStatus;
  material: string;
  data: string;
  track: string;
  summary: string;
  revision: number;
  created_by: string;
  created_at: string;
  updated_at: string;
};
type FileRow = { dossie_id: string; file_id: string; name: string; type: string; size: number; created_at: string; created_by: string };
const COLUMNS = "id,number,status,material,data,track,summary,revision,created_by,created_at,updated_at";

function parseTrack(raw: string): DossieTrack {
  try {
    return sanitizeTrack(JSON.parse(raw));
  } catch {
    return emptyTrack();
  }
}
function parseSummary(raw: string, fallback: () => DossieSummary): DossieSummary {
  try {
    const value = JSON.parse(raw);
    if (value && typeof value === "object" && Array.isArray(value.transfers)) return value as DossieSummary;
  } catch {}
  return fallback();
}
const fileMeta = (row: FileRow): DossieFileMeta => ({
  id: row.file_id,
  name: row.name,
  type: row.type,
  size: Number(row.size),
  createdAt: row.created_at,
  createdBy: row.created_by,
});
function toDossie(row: Row, files: DossieFileMeta[]): Dossie {
  const data = unpackData(row.data);
  return {
    id: row.id,
    number: row.number,
    status: row.status,
    data,
    track: parseTrack(row.track),
    summary: parseSummary(row.summary, () => dossieSummary(data)),
    files,
    revision: Number(row.revision) || 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by,
  };
}

export async function listDossies(db: PortalDatabase): Promise<DossieListItem[]> {
  await dossieSchema(db);
  const [rows, files] = await db.batch([
    db.prepare("SELECT id,number,status,material,track,summary,revision,created_by,created_at,updated_at FROM dossies ORDER BY year DESC,seq DESC"),
    db.prepare("SELECT dossie_id,COUNT(*) AS n FROM dossie_files WHERE part=0 GROUP BY dossie_id"),
  ]);
  const counts = new Map((files.results as { dossie_id: string; n: number }[]).map((row) => [row.dossie_id, Number(row.n)]));
  return (rows.results as Omit<Row, "data">[]).map((row) => {
    const { log, response, outcomeNote, ...track } = parseTrack(row.track);
    return {
      id: row.id,
      number: row.number,
      status: row.status,
      summary: parseSummary(row.summary, () => ({
        material: row.material,
        description: "",
        unit: "",
        target: "",
        transfers: [],
        transferred: 0,
        idle: null,
        unitPrice: null,
        value: null,
        firstDate: "",
        deadline: "",
      })),
      track: { ...track, logCount: log.length, hasResponse: !!response },
      fileCount: counts.get(row.id) || 0,
      revision: Number(row.revision) || 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      createdBy: row.created_by,
    };
  });
}

export async function getDossie(db: PortalDatabase, id: string) {
  await dossieSchema(db);
  const row = await db.prepare(`SELECT ${COLUMNS} FROM dossies WHERE id=?`).bind(id).first<Row>();
  if (!row) return null;
  const files = await db
    .prepare("SELECT dossie_id,file_id,name,type,size,created_at,created_by FROM dossie_files WHERE dossie_id=? AND part=0 ORDER BY created_at,file_id")
    .bind(id)
    .all<FileRow>();
  return toDossie(row, files.results.map(fileMeta));
}
async function current(db: PortalDatabase, id: unknown, revision: unknown) {
  if (!validId(id)) throw new DossieError("Dossiê inválido.");
  const dossie = await getDossie(db, id);
  if (!dossie) throw new DossieError("Dossiê não encontrado. Ele pode ter sido apagado; atualize a lista.", 404);
  if (dossie.revision !== revision) throw new DossieError(CONFLICT, 409);
  return dossie;
}

/** Ano no horário de Brasília. */
export function brazilYear(now: Date) {
  const year = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/Sao_Paulo", year: "numeric" }).format(now));
  return Number.isInteger(year) ? year : now.getUTCFullYear();
}
function packed(data: DossieData) {
  const raw = packData(data);
  if (raw.length > MAX_DATA_CHARS)
    throw new DossieError(
      `O dossiê de ${data.material} ficou grande demais para guardar (${Math.ceil(raw.length / 1000)} KB). Cole só os lançamentos do período que interessa.`,
      413,
    );
  return raw;
}
const logEntry = (role: PortalRole, text: string, at = new Date()) => ({ at: at.toISOString(), role: ROLE_LABEL[role] || role, text });
const withLog = (track: DossieTrack, role: PortalRole, text: string, at = new Date()) => ({ ...track, log: [...track.log, logEntry(role, text, at)].slice(-100) });

/** A mesma transferência não entra em dois dossiês. */
async function assertNotQuestioned(db: PortalDatabase, items: { data: DossieData; id?: string }[]) {
  const materials = [...new Set(items.map((item) => item.data.material))];
  if (!materials.length) return;
  const rows = await db
    .prepare(`SELECT id,number,material,summary FROM dossies WHERE material IN (${materials.map(() => "?").join(",")})`)
    .bind(...materials)
    .all<{ id: string; number: string; material: string; summary: string }>();
  const taken = new Map<string, string>();
  for (const row of rows.results) {
    let summary: DossieSummary | null = null;
    try {
      summary = JSON.parse(row.summary);
    } catch {}
    for (const transfer of summary?.transfers || []) taken.set(`${row.material}|${transfer.key}`, `${row.id}|${row.number}`);
  }
  const mine = new Set<string>();
  for (const { data, id } of items)
    for (const key of data.questioned) {
      const owner = taken.get(`${data.material}|${key}`);
      if (owner && owner.split("|")[0] !== id)
        throw new DossieError(`A transferência ${key.split("/")[0]} de ${data.material} já está no ${owner.split("|")[1]}. Abra esse dossiê em vez de criar outro.`, 409);
      if (mine.has(`${data.material}|${key}`)) throw new DossieError(`A transferência ${key.split("/")[0]} de ${data.material} aparece duas vezes nesta importação.`);
      mine.add(`${data.material}|${key}`);
    }
}

export const MAX_CREATE = 10;
/** Cria um dossiê por material (importação da MB51). Números em sequência, numa transação. */
export async function createDossies(db: PortalDatabase, inputs: unknown, role: PortalRole, now = new Date()) {
  await dossieSchema(db);
  if (!Array.isArray(inputs) || !inputs.length) throw new DossieError("Escolha pelo menos um material para abrir o dossiê.");
  // Plano gratuito do Cloudflare: até 50 consultas ao banco por envio (2 por dossiê aqui).
  if (inputs.length > MAX_CREATE) throw new DossieError(`Abra até ${MAX_CREATE} dossiês por envio.`);
  const items = inputs.map((input) => {
    const data = valid(() => sanitizeDossieData(input));
    return { data, raw: packed(data), summary: JSON.stringify(dossieSummary(data)) };
  });
  await assertNotQuestioned(db, items);
  const year = brazilYear(now),
    stamp = now.toISOString();
  const ids: string[] = [];
  const statements = items.flatMap(({ data, raw, summary }) => {
    const id = crypto.randomUUID();
    ids.push(id);
    const track = withLog(emptyTrack(), role, `Dossiê aberto com ${data.movements.length} lançamento(s) da MB51${data.source ? ` (${data.source})` : ""}.`, now);
    return [
      db
        .prepare(
          "INSERT INTO dossie_counters(year,seq) VALUES(?,(SELECT COALESCE(MAX(seq),0)+1 FROM dossies WHERE year=?)) ON CONFLICT(year) DO UPDATE SET seq=dossie_counters.seq+1",
        )
        .bind(year, year),
      db
        .prepare(
          "INSERT INTO dossies(id,number,year,seq,status,material,data,track,summary,revision,created_by,created_at,updated_at) SELECT ?,'DOS-'||?||'-'||CASE WHEN seq<10000 THEN substr('0000'||seq,-4) ELSE seq END,?,seq,'open',?,?,?,?,1,?,?,? FROM dossie_counters WHERE year=?",
        )
        .bind(id, String(year), year, data.material, raw, JSON.stringify(track), summary, role, stamp, stamp, year),
    ];
  });
  await db.batch(statements);
  const rows = await db
    .prepare(`SELECT ${COLUMNS} FROM dossies WHERE id IN (${ids.map(() => "?").join(",")}) ORDER BY seq`)
    .bind(...ids)
    .all<Row>();
  return rows.results.map((row) => toDossie(row, []));
}

/** O que mudou nos dados, em poucas palavras, para o histórico. */
function describeChange(before: DossieData, after: DossieData) {
  const parts: string[] = [];
  const diff = after.movements.length - before.movements.length;
  if (diff) parts.push(`lançamentos (${diff > 0 ? "+" : ""}${diff})`);
  if (JSON.stringify([...before.questioned].sort()) !== JSON.stringify([...after.questioned].sort())) parts.push("transferências cobradas");
  if (before.target !== after.target) parts.push(`depósito de destino (${after.target})`);
  if (before.manualPrice !== after.manualPrice) parts.push("preço unitário");
  if (before.request !== after.request) parts.push("pedido ao Warehouse");
  if (before.deadline !== after.deadline) parts.push("prazo");
  if (before.recipients !== after.recipients) parts.push("destinatários");
  if (before.notes !== after.notes) parts.push("observações");
  if (JSON.stringify(before.stockCheck) !== JSON.stringify(after.stockCheck)) parts.push("saldo atual da planilha");
  return parts;
}
async function write(db: PortalDatabase, dossie: Dossie, next: { status?: DossieStatus; data?: DossieData; track: DossieTrack }) {
  const data = next.data || dossie.data;
  const sets = ["status=?", "track=?", "revision=revision+1", "updated_at=?"];
  const values: unknown[] = [next.status || dossie.status, JSON.stringify(next.track), new Date().toISOString()];
  if (next.data) {
    sets.push("data=?", "summary=?");
    values.push(packed(data), JSON.stringify(dossieSummary(data)));
  }
  changed(await db.prepare(`UPDATE dossies SET ${sets.join(",")} WHERE id=? AND revision=?`).bind(...values, dossie.id, dossie.revision).run());
  return (await getDossie(db, dossie.id))!;
}

export async function updateDossie(db: PortalDatabase, id: unknown, revision: unknown, input: unknown, role: PortalRole) {
  await dossieSchema(db);
  const dossie = await current(db, id, revision);
  if (dossie.status === "closed") throw new DossieError("Dossiê encerrado. Reabra para alterar.", 409);
  const raw = input && typeof input === "object" ? input : {};
  const data = valid(() => sanitizeDossieData({ ...dossie.data, ...raw, material: dossie.data.material }));
  await assertNotQuestioned(db, [{ data, id: dossie.id }]);
  const parts = describeChange(dossie.data, data);
  if (!parts.length) return dossie;
  return write(db, dossie, { data, track: withLog(dossie.track, role, `Alterado: ${parts.join(", ")}.`) });
}

/** Cobrança enviada (1ª) ou reforço (2ª, 3ª…). Depois de uma resposta, nova cobrança volta para "Cobrado". */
export async function sendDossie(db: PortalDatabase, id: unknown, revision: unknown, role: PortalRole, now = new Date()) {
  await dossieSchema(db);
  const dossie = await current(db, id, revision);
  if (dossie.status === "closed") throw new DossieError("Dossiê encerrado. Reabra para cobrar de novo.", 409);
  const stamp = now.toISOString();
  const first = !dossie.track.sentAt;
  const track: DossieTrack = first ? { ...dossie.track, sentAt: stamp } : { ...dossie.track, reminders: [...dossie.track.reminders, stamp].slice(-50) };
  const count = 1 + track.reminders.length;
  const text = first ? "Cobrança enviada ao Warehouse." : `${count}ª cobrança enviada ao Warehouse${dossie.status === "answered" ? " depois da resposta" : ""}.`;
  return write(db, dossie, { status: "sent", track: withLog(track, role, text, now) });
}

export async function answerDossie(db: PortalDatabase, id: unknown, revision: unknown, input: { response?: unknown; responseBy?: unknown; respondedAt?: unknown }, role: PortalRole) {
  await dossieSchema(db);
  const dossie = await current(db, id, revision);
  if (dossie.status === "closed") throw new DossieError("Dossiê encerrado. Reabra para registrar outra resposta.", 409);
  const next = sanitizeTrack({ ...dossie.track, response: input.response, responseBy: input.responseBy, respondedAt: input.respondedAt });
  if (!next.response) throw new DossieError("Escreva a resposta do Warehouse.");
  if (input.respondedAt && !next.respondedAt) throw new DossieError("Data da resposta inválida.");
  const text = `Resposta do Warehouse registrada${next.responseBy ? ` (${next.responseBy})` : ""}.`;
  return write(db, dossie, { status: "answered", track: withLog(next, role, text) });
}

export async function closeDossie(
  db: PortalDatabase,
  id: unknown,
  revision: unknown,
  input: { outcome?: unknown; outcomeNote?: unknown; returnDocument?: unknown },
  role: PortalRole,
  now = new Date(),
) {
  await dossieSchema(db);
  const dossie = await current(db, id, revision);
  if (dossie.status === "closed") return dossie;
  if (!isOutcome(input.outcome)) throw new DossieError("Escolha como o dossiê foi resolvido.");
  const next = sanitizeTrack({ ...dossie.track, outcome: input.outcome, outcomeNote: input.outcomeNote, returnDocument: input.returnDocument, closedAt: now.toISOString() });
  if (input.returnDocument && !/^[A-Z0-9/-]{1,30}$/i.test(next.returnDocument)) throw new DossieError("Documento SAP inválido.");
  const text = `Encerrado: ${OUTCOME_LABELS[input.outcome]}${next.returnDocument ? ` (doc. ${next.returnDocument})` : ""}.`;
  return write(db, dossie, { status: "closed", track: withLog(next, role, text, now) });
}

export async function reopenDossie(db: PortalDatabase, id: unknown, revision: unknown, role: PortalRole) {
  await dossieSchema(db);
  const dossie = await current(db, id, revision);
  if (dossie.status !== "closed") return dossie;
  const status: DossieStatus = dossie.track.response ? "answered" : dossie.track.sentAt ? "sent" : "open";
  return write(db, dossie, { status, track: withLog({ ...dossie.track, closedAt: "" }, role, "Dossiê reaberto.") });
}

export async function deleteDossie(db: PortalDatabase, id: unknown, revision: unknown, role: PortalRole) {
  await dossieSchema(db);
  const dossie = await current(db, id, revision);
  if (role !== "admin" && (dossie.status !== "open" || dossie.track.sentAt || dossie.files.length))
    throw new DossieError("Somente o administrador apaga um dossiê que já foi cobrado ou tem prints.", 403);
  const results = await db.batch([
    db.prepare("DELETE FROM dossie_files WHERE dossie_id=? AND EXISTS(SELECT 1 FROM dossies WHERE id=? AND revision=?)").bind(dossie.id, dossie.id, dossie.revision),
    db.prepare("DELETE FROM dossies WHERE id=? AND revision=?").bind(dossie.id, dossie.revision),
  ]);
  changed(results[1]);
  return { deleted: dossie.id, number: dossie.number };
}

// ---------------------------------------------------------------------------
// Prints (PNG/JPEG) anexados ao dossiê
// ---------------------------------------------------------------------------

function decodeBase64(value: unknown) {
  if (typeof value !== "string" || !value) throw new DossieError("Envie a imagem.");
  if (value.length > Math.ceil(MAX_FILE_BYTES / 3) * 4 + 8) throw new DossieError("A imagem passa de 1,5 MB. Recorte o print ou salve em JPG.", 413);
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new DossieError("Imagem inválida.");
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
/** Tipo pela assinatura do arquivo, não pelo nome. */
export function imageType(bytes: Uint8Array) {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  return "";
}
async function sha256(bytes: Uint8Array) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice().buffer as ArrayBuffer));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
const safeName = (value: unknown, type: string) => {
  const name = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  const ext = type === "image/png" ? ".png" : ".jpg";
  return name ? (/\.(png|jpe?g)$/i.test(name) ? name : name + ext) : "print" + ext;
};

export async function addDossieFile(db: PortalDatabase, payload: { id?: unknown; revision?: unknown; name?: unknown; data?: unknown }, role: PortalRole) {
  await dossieSchema(db);
  const dossie = await current(db, payload.id, payload.revision);
  if (dossie.files.length >= MAX_FILES) throw new DossieError(`Cada dossiê guarda até ${MAX_FILES} prints.`, 409);
  const bytes = decodeBase64(payload.data);
  if (bytes.length > MAX_FILE_BYTES) throw new DossieError("A imagem passa de 1,5 MB. Recorte o print ou salve em JPG.", 413);
  const type = imageType(bytes);
  if (!type) throw new DossieError("Anexe um print em PNG ou JPG.");
  const hash = await sha256(bytes);
  if (await db.prepare("SELECT 1 AS present FROM dossie_files WHERE dossie_id=? AND sha256=? AND part=0").bind(dossie.id, hash).first())
    throw new DossieError("Este print já está no dossiê.", 409);
  const clean = String(payload.data);
  const fileId = crypto.randomUUID(),
    stamp = new Date().toISOString(),
    name = safeName(payload.name, type);
  const guard = "EXISTS(SELECT 1 FROM dossies WHERE id=? AND revision=?)";
  const statements = [];
  for (let part = 0; part * PART < clean.length; part++)
    statements.push(
      db
        .prepare(`INSERT INTO dossie_files(dossie_id,file_id,part,name,type,size,sha256,data,created_at,created_by) SELECT ?,?,?,?,?,?,?,?,?,? WHERE ${guard}`)
        .bind(dossie.id, fileId, part, name, type, bytes.length, hash, clean.slice(part * PART, (part + 1) * PART), stamp, role, dossie.id, dossie.revision),
    );
  const track = withLog(dossie.track, role, `Print anexado: ${name}.`);
  statements.push(
    db.prepare("UPDATE dossies SET track=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?").bind(JSON.stringify(track), stamp, dossie.id, dossie.revision),
  );
  const results = await db.batch(statements);
  changed(results.at(-1));
  return (await getDossie(db, dossie.id))!;
}

export async function deleteDossieFile(db: PortalDatabase, payload: { id?: unknown; revision?: unknown; fileId?: unknown }, role: PortalRole) {
  await dossieSchema(db);
  const dossie = await current(db, payload.id, payload.revision);
  const file = dossie.files.find((item) => item.id === payload.fileId);
  if (!file) throw new DossieError("Print não encontrado.", 404);
  const track = withLog(dossie.track, role, `Print removido: ${file.name}.`);
  const results = await db.batch([
    db.prepare("DELETE FROM dossie_files WHERE dossie_id=? AND file_id=? AND EXISTS(SELECT 1 FROM dossies WHERE id=? AND revision=?)").bind(dossie.id, file.id, dossie.id, dossie.revision),
    db.prepare("UPDATE dossies SET track=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?").bind(JSON.stringify(track), new Date().toISOString(), dossie.id, dossie.revision),
  ]);
  changed(results[1]);
  return (await getDossie(db, dossie.id))!;
}

export async function readDossieFile(db: PortalDatabase, dossieId: unknown, fileId: unknown) {
  await dossieSchema(db);
  if (!validId(dossieId) || !validId(fileId)) throw new DossieError("Arquivo inválido.");
  const rows = await db
    .prepare("SELECT part,data,name,type,size FROM dossie_files WHERE dossie_id=? AND file_id=? ORDER BY part")
    .bind(dossieId, fileId)
    .all<{ part: number; data: string; name: string; type: string; size: number }>();
  if (!rows.results.length) throw new DossieError("Arquivo não encontrado.", 404);
  const bytes = decodeBase64Unbounded(rows.results.map((row) => row.data).join(""));
  if (bytes.length !== Number(rows.results[0].size)) throw new DossieError("O arquivo guardado está incompleto.", 500);
  return { bytes, name: rows.results[0].name, type: rows.results[0].type };
}
function decodeBase64Unbounded(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ---------------------------------------------------------------------------
// Em quais BOMs do portal o material aparece (BOM × OP e BOMs do plano)
// ---------------------------------------------------------------------------

const SEED_ID = "consumo:bc22x-1268";
export async function bomLookup(db: PortalDatabase, raw: string): Promise<BomLookup> {
  await ensureSchema(db);
  const codes = [
    ...new Set(
      raw
        .split(",")
        .map((code) => code.trim().toUpperCase())
        .filter(validMaterial),
    ),
  ].slice(0, 20);
  const datasets = await db
    .prepare("SELECT id,metadata FROM datasets WHERE id LIKE 'consumo:%' OR id LIKE 'plano:%'")
    .all<{ id: string; metadata: string }>();
  const seedStored = datasets.results.some((row) => row.id === SEED_ID);
  const checked = datasets.results.length + (seedStored ? 0 : 1);
  const materials: Record<string, BomUse[]> = {};
  if (!codes.length) return { materials, checked };
  const add = (code: string, id: string, meta: Record<string, unknown>, row: Record<string, unknown>) => {
    const list = materials[code] || (materials[code] = []);
    if (list.some((use) => use.id === id)) return;
    const required = typeof row.required === "number" && Number.isFinite(row.required) ? row.required : null;
    list.push({
      id,
      name: String(meta.name || id),
      revision: String(meta.revision || ""),
      kind: id.startsWith("plano:") ? "plan" : "op",
      required,
      unit: String(row.unit || "").trim(),
      ops: Array.isArray(meta.ops) ? meta.ops.length : 0,
      units: typeof meta.units === "number" ? meta.units : null,
    });
  };
  const result = await db
    .prepare(
      `SELECT d.id,d.metadata,e.payload FROM entries e JOIN datasets d ON d.id=e.dataset AND d.generation=e.generation WHERE (e.dataset LIKE 'consumo:%' OR e.dataset LIKE 'plano:%') AND (${codes.map(() => "e.payload LIKE ?").join(" OR ")}) LIMIT 2000`,
    )
    .bind(...codes.map((code) => `%"material":${JSON.stringify(code)}%`))
    .all<{ id: string; metadata: string; payload: string }>();
  for (const row of result.results) {
    let meta: Record<string, unknown> = {},
      payload: Record<string, unknown> = {};
    try {
      meta = JSON.parse(row.metadata);
      payload = JSON.parse(row.payload);
    } catch {
      continue;
    }
    const code = String(payload.material || "").trim().toUpperCase();
    if (codes.includes(code)) add(code, row.id, meta, payload);
  }
  if (!seedStored) {
    const seed = initial(SEED_ID);
    for (const row of seed?.rows || []) {
      const code = String(row.material || "").trim().toUpperCase();
      if (codes.includes(code)) add(code, SEED_ID, { name: seed!.name, revision: seed!.revision, ops: seed!.ops }, row);
    }
  }
  for (const list of Object.values(materials)) list.sort((a, b) => a.name.localeCompare(b.name, "pt-BR") || a.revision.localeCompare(b.revision, "pt-BR"));
  return { materials, checked };
}
