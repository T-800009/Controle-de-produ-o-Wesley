import {test} from 'node:test';
import assert from 'node:assert/strict';
import {convertScrap,diagnoseScrap,applyScrapConsumption,scrapLabel} from '../lib/scrap.ts';

test('absence of SCRAP is not labeled as a duplicate or a data issue',()=>{
 const diagnosis=diagnoseScrap({material:'001-A',op:'19000002315'},[]);
 assert.equal(scrapLabel(diagnosis.scrapStatus),'SEM SCRAP');
 assert.equal(scrapLabel('duplicate'),'DUPLICIDADE · SEM SCRAP');
});

test('normalizes SCRAP material and OP columns',()=>{
 const rows=convertScrap([{Material:'10004930-00',Ordem:'19000002523',Quantidade:'2',Descrição:'peça'}]);
 assert.deepEqual(rows.map(row=>({material:row.material,op:row.op,quantity:row.quantity})),[{material:'1000493000',op:'19000002523',quantity:2}]);
});

test('reads a concatenated NEW COD key',()=>{
 const rows=convertScrap([{'NEW COD':'10004930-0019000002523','Qtd. scrap':3}]);
 assert.equal(rows[0]?.material,'1000493000');
 assert.equal(rows[0]?.op,'19000002523');
 assert.equal(rows[0]?.quantity,3);
});

test('classifies one SCRAP PROCESS and multiple rows as duplicate scrap',()=>{
 const row={material:'10004930-00',op:'19000002523',consolidationIssue:''};
 const one=convertScrap([{Material:'10004930-00',OP:'19000002523'}]);
 assert.equal(diagnoseScrap(row,one).scrapStatus,'scrap');
 const two=convertScrap([{Material:'10004930-00',OP:'19000002523'},{Material:'10004930-00',OP:'19000002523'}]);
 assert.equal(diagnoseScrap(row,two).scrapStatus,'scrap-duplicate');
});

test('keeps a repeated conflict without scrap visible as duplicate',()=>{
 const diagnosis=diagnoseScrap({material:'10004930-00',op:'19000002523',consolidationIssue:'O consumo MB51 diverge entre linhas repetidas'},[]);
 assert.equal(diagnosis.scrapStatus,'duplicate');
});

test('nets SAP 261 and 262 and ignores other centers/movements',()=>{
 const rows=convertScrap([
  {Material:'10004930-00',Ordem:'19000002523','Tipo de movimento':'261',Centro:'BR02',Quantidade:-3,'Doc.material':'1','Ano doc.material':'2026','Item doc.material':'1'},
  {Material:'10004930-00',Ordem:'19000002523','Tipo de movimento':'262',Centro:'BR02',Quantidade:1,'Doc.material':'2','Ano doc.material':'2026','Item doc.material':'1'},
  {Material:'10004930-00',Ordem:'19000002523','Tipo de movimento':'261',Centro:'BR01',Quantidade:-9,'Doc.material':'3','Ano doc.material':'2026','Item doc.material':'1'},
  {Material:'10004930-00',Ordem:'19000002523','Tipo de movimento':'201',Centro:'BR02',Quantidade:-9,'Doc.material':'4','Ano doc.material':'2026','Item doc.material':'1'},
 ]);
 const diagnosis=diagnoseScrap({material:'10004930-00',op:'19000002523'},rows);
 assert.equal(rows.length,2);
 assert.equal(diagnosis.scrapQuantity,2);
 assert.equal(diagnosis.scrapStatus,'scrap-duplicate');
});

test('a fully reversed SCRAP PROCESS does not add consumption',()=>{
 const records=convertScrap([
  {Material:'001-A',OP:'19000002523','Tipo de movimento':'261',Quantidade:-1,'Doc.material':'1','Ano doc.material':'2026','Item doc.material':'1'},
  {Material:'001-A',OP:'19000002523','Tipo de movimento':'262',Quantidade:1,'Doc.material':'2','Ano doc.material':'2026','Item doc.material':'1'},
 ]);
 const diagnosis=diagnoseScrap({material:'001-A',op:'19000002523'},records);
 assert.equal(diagnosis.scrapStatus,'scrap-reversed');
 assert.equal(diagnosis.scrapQuantity,0);
 assert.equal(applyScrapConsumption({material:'001-A',op:'19000002523',required:5,consumed:4,pending:1},records).consumedWithScrap,4);
});

import {auditScrapAgainstMB51} from '../lib/scrap.ts';
import {consumptionOf,summarizeUsage} from '../lib/usage.ts';
const evidencePosting={Material:'001-A',Ordem:'19000002315',Quantidade:-3,'Tipo de movimento':261,'Doc.material':101,'Item doc.material':1,'Data do documento':'Date(2026,8,4)'};
const evidenceBom={material:'001-A',op:'19000002315',required:5,consumed:3,pending:2,unit:'PCS'};
test('SCRAP already in MB51 is not counted again, including summary metrics',()=>{
 const records=convertScrap(auditScrapAgainstMB51([evidencePosting],[evidencePosting]));
 const r=applyScrapConsumption(evidenceBom,records);
 assert.equal(r.scrapAdjustment,0);assert.equal(r.consumedWithScrap,3);assert.equal(r.pending,2);
 const row={...evidenceBom,consumption:{'19000002315':3}};
 assert.equal(consumptionOf(row,['19000002315'],[],records).net,3);
 assert.deepEqual(summarizeUsage([row,row],['19000002315'],[],records).units,[['PCS',3]]);
});

test('a separate SCRAP document with quantity complements MB51 only once',()=>{
 const scrap={...evidencePosting,'Doc.material':102,Quantidade:-2};
 const records=convertScrap(auditScrapAgainstMB51([scrap,scrap],[evidencePosting]));
 const r=applyScrapConsumption(evidenceBom,records);
 assert.equal(r.scrapAdjustment,2);assert.equal(r.consumedWithScrap,5);assert.equal(r.pending,0);
 const row={...evidenceBom,consumption:{'19000002315':3}};
 assert.deepEqual(summarizeUsage([row,row],['19000002315'],[],records).units,[['PCS',5]]);
});

test('SCRAP without identity or quantity never invents one piece; uncertain MB51 stays unknown',()=>{
 const records=convertScrap(auditScrapAgainstMB51([{Material:'001-A',Ordem:evidenceBom.op}],[evidencePosting]));
 const r=applyScrapConsumption(evidenceBom,records);
 assert.equal(r.scrapQuantityInferred,false);assert.equal(r.scrapAdjustment,0);assert.equal(r.pending,2);
 assert.equal(applyScrapConsumption({...evidenceBom,consumed:null,pending:null},records).consumedWithScrap,null);
});

test('a conflicting identity or an incompatible SCRAP unit cannot complete an OP',()=>{
 for(const scrap of [{...evidencePosting,Quantidade:-5},{...evidencePosting,'Doc.material':102,'UM básica':'KG',Quantidade:-2}]){
  const records=convertScrap(auditScrapAgainstMB51([scrap],[evidencePosting]));
  assert.equal(applyScrapConsumption(evidenceBom,records).pending,2);
 }
 const a={...evidencePosting,'Doc.material':102,Quantidade:-2},b={...a,Quantidade:-8};
 assert.equal(applyScrapConsumption(evidenceBom,convertScrap(auditScrapAgainstMB51([a,b],[evidencePosting]))).pending,2);
});

test('a separate SCRAP reversal subtracts from consumption',()=>{
 const scrap={...evidencePosting,'Doc.material':102,'Tipo de movimento':262,Quantidade:1};
 const result=applyScrapConsumption(evidenceBom,convertScrap(auditScrapAgainstMB51([scrap],[evidencePosting])));
 assert.equal(result.scrapAdjustment,-1);assert.equal(result.consumedWithScrap,2);assert.equal(result.pending,3);
});
