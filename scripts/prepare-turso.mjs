import {DatabaseSync} from 'node:sqlite';
import {readFileSync,existsSync,openSync,closeSync,unlinkSync,chmodSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';

const tables=['datasets','entries','manual_checks','manual_check_state','op_statuses','op_status_state','ana_notes','scrap_forms','scrap_counters','cc_forms','cc_counters','scrap_files','dossies','dossie_counters','dossie_files','portal_sessions','portal_attempts','portal_settings'];
const quote=name=>'"'+name.replaceAll('"','""')+'"';
export function prepareTurso(input,output){
 input=resolve(input);output=resolve(output);
 if(input===output||existsSync(output))throw Error('Escolha um arquivo de saída novo. Nenhum backup será sobrescrito.');
 const source=new DatabaseSync(':memory:');let target,created=false,completed=false;
 try{
  source.exec(readFileSync(input,'utf8'));
  if(source.prepare('PRAGMA quick_check').get().quick_check!=='ok')throw Error('O backup D1 está inconsistente. Exporte novamente.');
  const schemas=source.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
  const unknown=schemas.filter(row=>!tables.includes(row.name)&&!row.name.startsWith('_cf_')&&row.name!=='_portal_migration');
  if(unknown.length)throw Error('O backup contém tabelas adicionais que precisam ser conferidas: '+unknown.map(row=>row.name).join(', '));
  for(const required of ['datasets','entries'])if(!schemas.some(row=>row.name===required))throw Error('Este arquivo não contém a estrutura do banco do portal: falta '+required+'.');
  if(!source.prepare('SELECT 1 FROM datasets LIMIT 1').get())throw Error('O backup não tem bases cadastradas. Confira se exportou o D1 correto antes de migrar.');
  closeSync(openSync(output,'wx',0o600));created=true;target=new DatabaseSync(output);
  const manifest={version:1,preparedAt:new Date().toISOString(),tables:{}};
  target.exec('BEGIN');
  for(const name of tables){
   const schema=schemas.find(row=>row.name===name);if(!schema)continue;
   target.exec(schema.sql);
   const columns=source.prepare('PRAGMA table_info('+quote(name)+')').all().map(row=>row.name);
   const insert=target.prepare('INSERT INTO '+quote(name)+'('+columns.map(quote).join(',')+') VALUES('+columns.map(()=>'?').join(',')+')');
   const hash=createHash('sha256');let count=0;
   for(const row of source.prepare('SELECT * FROM '+quote(name)+' ORDER BY rowid').iterate()){
    const values=columns.map(column=>row[column]);insert.run(...values);hash.update(JSON.stringify(values)+'\n');count++;
   }
   manifest.tables[name]={count,columns,sha256:hash.digest('hex')};
   for(const index of source.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL").all(name))target.exec(index.sql);
  }
  // Preserve the AUTOINCREMENT high-water mark, even after old notes were deleted.
  if(source.prepare("SELECT 1 FROM sqlite_master WHERE name='sqlite_sequence'").get()&&target.prepare("SELECT 1 FROM sqlite_master WHERE name='sqlite_sequence'").get()){
   for(const row of source.prepare('SELECT name,seq FROM sqlite_sequence').all())if(tables.includes(row.name)){
    target.prepare('DELETE FROM sqlite_sequence WHERE name=?').run(row.name);
    target.prepare('INSERT INTO sqlite_sequence(name,seq) VALUES(?,?)').run(row.name,row.seq);
   }
  }
  for(const [name,expected] of Object.entries(manifest.tables)){
   const hash=createHash('sha256');let count=0;
   for(const row of target.prepare('SELECT * FROM '+quote(name)+' ORDER BY rowid').iterate()){hash.update(JSON.stringify(expected.columns.map(column=>row[column]))+'\n');count++;}
   if(count!==expected.count||hash.digest('hex')!==expected.sha256)throw Error('A cópia não corresponde ao backup na tabela '+name+'.');
  }
  target.exec('CREATE TABLE _portal_migration(id TEXT PRIMARY KEY,version INTEGER NOT NULL,manifest TEXT NOT NULL)');
  target.prepare('INSERT INTO _portal_migration VALUES(?,?,?)').run('d1-import',1,JSON.stringify(manifest));
  target.exec('COMMIT');
  if(target.prepare('PRAGMA quick_check').get().quick_check!=='ok')throw Error('A verificação final da cópia falhou.');
  chmodSync(output,0o600);completed=true;return manifest;
 }finally{target?.close();source.close();if(created&&!completed)unlinkSync(output);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{
  const [input,output]=process.argv.slice(2);
  if(!input||!output)throw Error('Uso: node scripts/prepare-turso.mjs backup-d1.sql backup-turso.sqlite');
  const manifest=prepareTurso(input,output);
  console.log('Cópia local validada. Nenhum banco online foi alterado.');
  console.table(Object.fromEntries(Object.entries(manifest.tables).map(([name,value])=>[name,{registros:value.count}])));
  console.log('Arquivo pronto para importar no Turso: '+resolve(output));
 }catch(error){console.error(error.message);process.exitCode=1;}
}
