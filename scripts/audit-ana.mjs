// Read-only comparison with Ana's original workbook. Never saves or recalculates it.
import fs from 'node:fs';
import XLSX from 'xlsx';
import {buildAnaCheck} from '../lib/ana-check.ts';
import {summarizeAnaAudit} from '../lib/ana-audit.ts';
const file=process.argv[2];
if(!file){console.error('Uso: pnpm audit:ana /caminho/Check-OPs.xlsx [relatorio.json]');process.exit(2);}
const workbook=XLSX.readFile(file,{dense:true});
const read=name=>{
 if(!workbook.Sheets[name])throw Error('Aba obrigatória ausente: '+name);
 return XLSX.utils.sheet_to_json(workbook.Sheets[name],{defval:null});
};
const result=buildAnaCheck(read('KOB1'),read('ZPP009'),read('MM60'),workbook.Sheets.COOIS?read('COOIS'):[]);
const index=new Map(result.rows.map(row=>[JSON.stringify([row.op,row.material]),row]));
const expected=read('Check Final');
const stats={referenceRows:expected.length,matchedPairs:0,quantityChecked:0,financialChecked:0,quantityMismatches:0,financialMismatches:0,missingPairs:0,uncalculatedQuantity:0,uncalculatedValue:0};
const examples=[];
for(const original of expected){
 const row=Object.fromEntries(Object.entries(original).map(([key,value])=>[key.trim(),value]));
 const op=String(row.Ordem??'').trim().replace(/\.0+$/,'').replace(/^0+(?=\d)/,'');
 const material=String(row['Material SAP No.']??'').trim().toUpperCase();
 const actual=index.get(JSON.stringify([op,material]));
 if(!actual){stats.missingPairs++;continue;}
 stats.matchedPairs++;
 for(const [expectedKey,actualKey,checked,mismatches,missingCache,tolerance] of [
  ['Diff.','difference','quantityChecked','quantityMismatches','uncalculatedQuantity',1e-6],
  ['Diff. R$','differenceValue','financialChecked','financialMismatches','uncalculatedValue',1e-5]
 ]){
  if(typeof row[expectedKey]!=='number'||!Number.isFinite(row[expectedKey])){stats[missingCache]++;continue;}
  stats[checked]++;
  const value=actual[actualKey];
  if(value===null||!Number.isFinite(value)||Math.abs(value-row[expectedKey])>tolerance){
   stats[mismatches]++;
   if(examples.length<20)examples.push({op,material,field:expectedKey,expected:row[expectedKey],actual:value});
  }
 }
}
const report={checkedAt:new Date().toISOString(),formula:'SUMIFS(KOB1 quantidade, OP + Material) - SUMIFS(ZPP009 BOM QTY, OP + Material)',
 scope:'Compara valores numéricos em cache do Excel. Status de cobertura permanece independente da conta bruta.',...stats,
 sourceCounts:result.sourceCounts,coverage:{both:result.orderCoverage.filter(row=>row.coverage==='both').length,missingKob:result.orderCoverage.filter(row=>row.coverage==='missing_kob').length,missingZpp:result.orderCoverage.filter(row=>row.coverage==='missing_zpp').length},
 classified:summarizeAnaAudit(result.rows),examples};
const output=JSON.stringify(report,null,2);
if(process.argv[3])fs.writeFileSync(process.argv[3],output+'\n');
console.log(output);
if(!stats.quantityChecked||!stats.financialChecked||stats.quantityMismatches||stats.financialMismatches||stats.missingPairs)process.exitCode=1;
