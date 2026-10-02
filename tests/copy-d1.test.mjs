import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {copySql} from '../scripts/copiar-banco-d1.mjs';

// Same shape as `wrangler d1 export --remote` (CREATE TABLE without IF NOT EXISTS).
const EXPORT=`PRAGMA defer_foreign_keys=TRUE;
CREATE TABLE datasets (id TEXT PRIMARY KEY NOT NULL,generation TEXT NOT NULL,metadata TEXT NOT NULL,updated_at TEXT NOT NULL);
INSERT INTO "datasets" VALUES('consumo:1363','g1','{"name":"BC22X","revision":"BOM 1363"}','2026-09-30');
CREATE TABLE entries (dataset TEXT NOT NULL,generation TEXT NOT NULL,id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(dataset,generation,id));
INSERT INTO "entries" VALUES('consumo:1363','g1','0','{"material":"A-1","description":"D''ÁGUA"}');
CREATE INDEX entries_generation ON entries(dataset,generation);
CREATE TABLE ana_notes(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,op TEXT NOT NULL,material TEXT NOT NULL DEFAULT '',text TEXT NOT NULL,author_role TEXT NOT NULL,created_at TEXT NOT NULL);
INSERT INTO "ana_notes" VALUES(7,'n1','190','A-1','linha 1
linha 2; com '' aspas','analyst','2026-09-29');
INSERT INTO "ana_notes" VALUES(9,'n2','190','','segunda','admin','2026-09-30');
CREATE TABLE portal_sessions(token_hash TEXT PRIMARY KEY, password_tag TEXT NOT NULL, expires INTEGER NOT NULL);
INSERT INTO "portal_sessions" VALUES('h','t',1);
CREATE TABLE _cf_KV (key TEXT PRIMARY KEY, value BLOB);
DELETE FROM sqlite_sequence;
INSERT INTO "sqlite_sequence" VALUES('ana_notes',9);
`;

test('cópia entre contas: aplica sobre tabelas já existentes, duas vezes, sem apagar o que o site novo gravou',()=>{
 const {sql,summary}=copySql(EXPORT);
 assert.deepEqual(summary,{datasets:1,entries:1,ana_notes:2});
 assert.doesNotMatch(sql,/portal_sessions|_cf_KV|BEGIN|COMMIT/);
 const target=new DatabaseSync(':memory:');
 target.exec("CREATE TABLE IF NOT EXISTS ana_notes(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,op TEXT NOT NULL,material TEXT NOT NULL DEFAULT '',text TEXT NOT NULL,author_role TEXT NOT NULL,created_at TEXT NOT NULL)");
 target.exec("INSERT INTO ana_notes(id,op,text,author_role,created_at) VALUES('novo','1','do site novo','admin','x')");
 target.exec(sql);target.exec(sql);
 assert.equal(target.prepare('SELECT COUNT(*) n FROM datasets').get().n,1);
 assert.equal(JSON.parse(target.prepare('SELECT payload FROM entries').get().payload).description,"D'ÁGUA");
 const notes=target.prepare('SELECT id,text FROM ana_notes ORDER BY seq').all().map(row=>[row.id,row.text]);
 assert.deepEqual(notes,[['novo','do site novo'],['n1',"linha 1\nlinha 2; com ' aspas"],['n2','segunda']]);
 assert.equal(target.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='entries_generation'").get().n,1);
});

test('recusa um arquivo que não é o backup do portal',()=>{
 assert.throws(()=>copySql('CREATE TABLE outra(a);'),/não é o backup do portal/);
});
