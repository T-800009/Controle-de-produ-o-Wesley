import {createClient} from '@libsql/client/web';
import {createHash} from 'node:crypto';
import {tursoUrl} from '../worker/database.ts';

let client;
try{
 const url=process.env.TURSO_DATABASE_URL,token=process.env.TURSO_AUTH_TOKEN;
 if(!url||!token)throw Error('Configure TURSO_DATABASE_URL e TURSO_AUTH_TOKEN no ambiente local. O token não será exibido.');
 client=createClient({url:tursoUrl(url),authToken:token,intMode:'number'});
 await client.execute('SELECT 1 AS ok');
 const marker=await client.execute("SELECT version,manifest FROM _portal_migration WHERE id='d1-import'");
 if(marker.rows[0]?.version!==1)throw Error('Falta importar a cópia validada do D1.');
 const manifest=JSON.parse(marker.rows[0].manifest);
 const allowed=new Set(['datasets','entries','manual_checks','manual_check_state','op_statuses','op_status_state','ana_notes','portal_sessions','portal_attempts']);
 const quote=name=>'"'+name.replaceAll('"','""')+'"';
 const summary=[];
 for(const [name,expected] of Object.entries(manifest.tables)){
  if(!allowed.has(name)||!Array.isArray(expected.columns)||!expected.columns.every(column=>typeof column==='string'))throw Error('Manifesto inválido.');
  const hash=createHash('sha256');let count=0,lastRowid=null;
  while(true){
   const query='SELECT rowid AS __migration_rowid,'+expected.columns.map(quote).join(',')+' FROM '+quote(name)+(lastRowid===null?'':' WHERE rowid>?')+' ORDER BY rowid LIMIT 1000';
   const batch=await client.execute({sql:query,args:lastRowid===null?[]:[lastRowid]});
   if(!batch.rows.length)break;
   for(const row of batch.rows){hash.update(JSON.stringify(expected.columns.map(column=>row[column]))+'\n');count++;lastRowid=row.__migration_rowid;}
  }
  if(count!==expected.count||hash.digest('hex')!==expected.sha256)throw Error('A tabela '+name+' difere do backup. Se o portal já estiver gravando no Turso, novas alterações também causam essa diferença.');
  summary.push({tabela:name,registros:count,resultado:'Idêntica ao backup'});
 }
 console.table(summary);
 console.log('Conexão e conteúdo conferidos. Este comando fez apenas leituras. A ativação no Worker é uma etapa separada.');
}catch(error){
 // SDK errors can include SQL/connection details. Print only our local messages.
 console.error(error?.name==='LibsqlError'?'Falha ao acessar o Turso. Confira URL, token, importação e disponibilidade do serviço.':error.message);
 process.exitCode=1;
}finally{client?.close();}
