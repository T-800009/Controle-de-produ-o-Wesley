#!/usr/bin/env node
// Copia o banco do portal de uma conta Cloudflare para outra.
//
// Entrada: o arquivo gerado por `wrangler d1 export ... --remote` na conta antiga.
// Saída:   um SQL que pode ser aplicado na conta nova com `wrangler d1 execute`,
//          mesmo que o site novo já tenha criado as tabelas (CREATE ... IF NOT
//          EXISTS) e sem apagar nada que já exista lá (INSERT OR IGNORE).
//
// Não copia sessões de login nem tentativas de senha: cada pessoa entra de novo.
// Só usa o Node (node:sqlite); não precisa da pasta do projeto nem de internet.
//
//   node copiar-banco-d1.mjs backup-d1.sql copia-d1.sql
import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SKIP = new Set(["portal_sessions", "portal_attempts", "_portal_migration"]);
const ORDER = ["datasets", "entries", "manual_checks", "manual_check_state", "op_statuses", "op_status_state", "ana_notes", "scrap_forms", "scrap_counters", "cc_forms", "cc_counters", "scrap_files"];
const quote = (name) => '"' + String(name).replaceAll('"', '""') + '"';

function literal(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw Error("Valor numérico inválido no backup.");
    return String(value);
  }
  if (value instanceof Uint8Array) return "X'" + Buffer.from(value).toString("hex") + "'";
  return "'" + String(value).replaceAll("'", "''") + "'";
}

export function copySql(exportSql) {
  const source = new DatabaseSync(":memory:");
  try {
    source.exec(exportSql);
    const tables = source
      .prepare(
        "SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'",
      )
      .all()
      .filter((table) => !SKIP.has(table.name));
    if (!tables.some((table) => table.name === "datasets"))
      throw Error("Este arquivo não é o backup do portal: falta a tabela datasets.");
    tables.sort(
      (a, b) =>
        (ORDER.indexOf(a.name) + 1 || 99) - (ORDER.indexOf(b.name) + 1 || 99) || a.name.localeCompare(b.name),
    );
    const out = [];
    const summary = {};
    for (const table of tables) {
      out.push(table.sql.replace(/^\s*CREATE\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?/i, "CREATE TABLE IF NOT EXISTS ") + ";");
      for (const index of source
        .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL")
        .all(table.name))
        out.push(
          index.sql.replace(/^\s*CREATE\s+(UNIQUE\s+)?INDEX\s+(IF\s+NOT\s+EXISTS\s+)?/i, (_, unique) => `CREATE ${unique || ""}INDEX IF NOT EXISTS `) + ";",
        );
      // ana_notes: the note id is the identity; seq is renumbered in the same
      // order so notes written on the new site are never overwritten.
      const columns = source
        .prepare("PRAGMA table_info(" + quote(table.name) + ")")
        .all()
        .map((column) => column.name)
        .filter((column) => !(table.name === "ana_notes" && column === "seq"));
      const orderBy = table.name === "ana_notes" ? "seq" : "rowid";
      let count = 0;
      for (const row of source.prepare("SELECT * FROM " + quote(table.name) + " ORDER BY " + orderBy).iterate()) {
        out.push(
          `INSERT OR IGNORE INTO ${quote(table.name)}(${columns.map(quote).join(",")}) VALUES(${columns
            .map((column) => literal(row[column]))
            .join(",")});`,
        );
        count++;
      }
      summary[table.name] = count;
    }
    return { sql: out.join("\n") + "\n", summary };
  } finally {
    source.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) {
    console.error("Uso: node copiar-banco-d1.mjs backup-d1.sql copia-d1.sql");
    process.exit(1);
  }
  if (resolve(input) === resolve(output) || existsSync(output)) {
    console.error("Escolha um arquivo de saída novo. Nenhum arquivo é sobrescrito.");
    process.exit(1);
  }
  try {
    const { sql, summary } = copySql(readFileSync(input, "utf8"));
    writeFileSync(output, sql, { flag: "wx" });
    console.log("Cópia pronta: " + output);
    for (const [table, count] of Object.entries(summary)) console.log(`  ${table}: ${count} linha(s)`);
    console.log("Sessões de login não foram copiadas: cada pessoa entra de novo com a senha.");
  } catch (error) {
    console.error("Não foi possível preparar a cópia: " + error.message);
    process.exit(1);
  }
}
