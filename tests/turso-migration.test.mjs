import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {prepareTurso} from '../scripts/prepare-turso.mjs';

const sql=`CREATE TABLE datasets(id TEXT PRIMARY KEY,generation TEXT,metadata TEXT,updated_at TEXT);
CREATE TABLE entries(dataset TEXT,generation TEXT,id TEXT,payload TEXT,PRIMARY KEY(dataset,generation,id));
CREATE INDEX entries_generation ON entries(dataset,generation);
INSERT INTO datasets VALUES('consumo:test','version-1','{"name":"BOM teste"}','2026-09-28');
INSERT INTO entries VALUES('consumo:test','version-1','0','{"material":"0000123-00","quantity":1.25}');
CREATE TABLE manual_checks(dataset TEXT,row_key TEXT,marked_by TEXT,updated_at TEXT,PRIMARY KEY(dataset,row_key));
INSERT INTO manual_checks VALUES('consumo:test','19000002315|0000123-00|PCS','admin','2026-09-28');
CREATE TABLE ana_notes(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE,text TEXT);
INSERT INTO ana_notes(seq,id,text) VALUES(50,'old','Nota apagada'),(1,'note-1','Observação da Ana');
DELETE FROM ana_notes WHERE seq=50;`;

test('backup conversion preserves payloads, marks, notes, indexes and the note sequence',()=>{
 const dir=mkdtempSync(join(tmpdir(),'turso-migration-')),input=join(dir,'d1.sql'),output=join(dir,'turso.sqlite');
 try{
  writeFileSync(input,sql);const manifest=prepareTurso(input,output);const db=new DatabaseSync(output);
  try{
   assert.equal(readFileSync(input,'utf8'),sql);
   assert.equal(manifest.tables.entries.count,1);
   assert.equal(db.prepare('SELECT payload FROM entries').get().payload,'{"material":"0000123-00","quantity":1.25}');
   assert.equal(db.prepare('SELECT row_key FROM manual_checks').get().row_key,'19000002315|0000123-00|PCS');
   assert.equal(db.prepare('SELECT text FROM ana_notes').get().text,'Observação da Ana');
   assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name='entries_generation'").get());
   assert.equal(db.prepare("SELECT version FROM _portal_migration WHERE id='d1-import'").get().version,1);
   db.prepare('INSERT INTO ana_notes(id,text) VALUES(?,?)').run('next','Nova observação');
   assert.equal(db.prepare("SELECT seq FROM ana_notes WHERE id='next'").get().seq,51);
  }finally{db.close();}
  assert.throws(()=>prepareTurso(input,output),/não será|sobrescrito/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('wrong or incomplete exports do not create an approved migration',()=>{
 const dir=mkdtempSync(join(tmpdir(),'turso-invalid-')),input=join(dir,'d1.sql'),output=join(dir,'turso.sqlite');
 try{
  for(const invalid of ['SELECT broken syntax;',sql+'CREATE TABLE unknown_data(id TEXT);',sql.replace(/INSERT INTO datasets[^;]+;/,'')]){
   writeFileSync(input,invalid);assert.throws(()=>prepareTurso(input,output));assert.equal(existsSync(output),false);
  }
 }finally{rmSync(dir,{recursive:true,force:true});}
});
