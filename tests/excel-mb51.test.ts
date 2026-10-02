import {test} from 'node:test';import assert from 'node:assert/strict';
import {joinExcelMB51} from '../lib/excel-mb51.ts';import {convert} from '../lib/materials.ts';
const bom=[{material:'001-A',unit:'PCS',required:5}],op='19000000123';
test('matches movement-type consumption and reversal signs',()=>assert.equal(joinExcelMB51(bom,[op],[{Material:'001-A',Ordem:op,Quantidade:-5,'Tipo de movimento':'261'},{Material:'001-A',Ordem:op,Quantidade:2,'Tipo de movimento':'261'}]).rows[0].consumption[op],7));
test('replacing the extraction replaces consumption, rather than accumulating',()=>{const a=joinExcelMB51(bom,[op],[{Material:'001-A',Ordem:op,Quantidade:-5,'Tipo de movimento':'261'}]);const b=joinExcelMB51(a.rows,[op],[{Material:'001-A',Ordem:op,Quantidade:-2,'Tipo de movimento':'261'}]);assert.equal(b.rows[0].consumption[op],2)});
test('matches SAP material punctuation and short OP suffix',()=>assert.equal(joinExcelMB51([{material:'17329419-00',unit:'PCS',required:10}],['19000002315'],[{Material:'1732941900',Ordem:'2315',Quantidade:-10,'Tipo de movimento':'261'}]).rows[0].consumption['19000002315'],10));
test('blank BOM rows are not converted into a SAP named null',()=>assert.equal(convert([{Material:null}],'consumo').rows.length,0));
test('NEW COD never moves a real posting from one order to another',()=>{
 const orders=['19000002315','19000002316'];
 const rows=[{Material:'001-A',Ordem:orders[0],Quantidade:5,'Tipo de movimento':261,'NEW COD':'001-A'+orders[1]}];
 const result=joinExcelMB51(bom,orders,rows);
 assert.equal(result.rows[0].consumption[orders[0]],5);assert.equal(result.rows[0].consumption[orders[1]],0);
 assert.equal(result.formulaFallbacks,1);
});
test('a stale NEW COD cannot import a movement whose real OP is outside the BOM',()=>{
 const result=joinExcelMB51(bom,[op],[{Material:'001-A',Ordem:'19000000999',Quantidade:-5,'Tipo de movimento':261,'NEW COD':'001-A'+op}]);
 assert.equal(result.rows[0].consumption[op],0);assert.equal(result.matched,0);
});
test('261/262 determine net consumption even with a NEW COD and unsigned exports',()=>{
 const rows=[{Material:'001-A',Ordem:op,Quantidade:5,'Tipo de movimento':261,'NEW COD':'001-A'+op},{Material:'001-A',Ordem:op,Quantidade:2,'Tipo de movimento':262,'NEW COD':'001-A'+op}];
 assert.equal(joinExcelMB51(bom,[op],rows).rows[0].consumption[op],3);
});

test('audit proof: 261 from 2000 is cancelled by 262; no forced completion',()=>{
 const posting={Material:'20513481-00',Ordem:'19000002315',Centro:'BR02',Depósito:2000,'Item doc.material':1,'Data de lançamento':'Date(2026,8,4)','NEW COD':'BR02'};
 const result=joinExcelMB51([{material:'20513481-00',unit:'PCS',required:1}],['19000002315'],[
 {...posting,Quantidade:-2,'Tipo de movimento':261,'Doc.material':4900665403},
 {...posting,Quantidade:2,'Tipo de movimento':262,'Doc.material':4900720549},
 ]);
 const evidence=Object.values(result.mb51Evidence)[0];
 assert.equal(result.rows[0].consumption['19000002315'],0);
 assert.deepEqual([evidence.issued,evidence.reversed,evidence.net,evidence.count],[2,2,0,2]);
 assert.deepEqual(evidence.depots,['2000']);assert.equal(evidence.documents[0].year,'2026');
});

test('document + derived year + item deduplicates the extraction; conflicts stay unknown',()=>{
 const posting={Material:'001-A',Ordem:op,Quantidade:-5,'Tipo de movimento':261,'Doc.material':123,'Item doc.material':1,'Data do documento':'Date(2026,8,4)'};
 const dedup=joinExcelMB51(bom,[op],[posting,{...posting}]);
 assert.equal(dedup.rows[0].consumption[op],5);assert.equal(dedup.duplicates,1);
 assert.equal(Object.values(dedup.mb51Evidence)[0].count,1);
 const conflict=joinExcelMB51(bom,[op],[posting,{...posting,Quantidade:-9}]);
 assert.equal(conflict.rows[0].consumption[op],null);
 assert.match(Object.values(conflict.mb51Evidence)[0].issue,/valores diferentes/);
});

test('a missing posting is distinguishable from a cancelled posting in the evidence',()=>{
 const result=joinExcelMB51([...bom,{material:'NOT-IN-EXTRACT',unit:'PCS',required:1}],[op],[{Material:'001-A',Ordem:op,Quantidade:-5,'Tipo de movimento':261}]);
 assert.equal(result.rows[1].consumption[op],0);assert.equal(Object.keys(result.mb51Evidence).length,1);
});

test('full numeric suffix and leading zeros resolve the actual OP',()=>{
 const ops=['19000012315','19000002315'];
 const input={Material:'001-A',Ordem:'12315',Quantidade:-5,'Tipo de movimento':261};
 assert.equal(joinExcelMB51(bom,ops,[input]).rows[0].consumption[ops[0]],5);
 assert.equal(joinExcelMB51(bom,ops,[{...input,Ordem:'019000002315'}]).rows[0].consumption[ops[1]],5);
 assert.equal(joinExcelMB51(bom,ops,[{...input,Ordem:'2315'}]).matched,0,'ambiguous suffix is not assigned');
});

test('incompatible or mixed base units cannot be added to a BOM quantity',()=>{
 const input={Material:'001-A',Ordem:op,Quantidade:-5,'Tipo de movimento':261,'UM básica':'KG'};
 assert.equal(joinExcelMB51(bom,[op],[input]).rows[0].consumption[op],null);
 assert.equal(joinExcelMB51(bom,[op],[{...input,'UM básica':'PCS'},{...input}]).rows[0].consumption[op],null);
 assert.equal(joinExcelMB51([...bom,{...bom[0],unit:'KG'}],[op],[input]).rows[0].consumption[op],null);
});
