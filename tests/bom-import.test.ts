import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import {diagnoseWorkbook,bestBomSheet,buildBomImport,parseOpList,inferModel,parseBomMatrix} from '../lib/bom-import.ts';
import {convert} from '../lib/materials.ts';

const book=(sheets:Record<string,unknown[][]>)=>{const wb=XLSX.utils.book_new();for(const [name,rows] of Object.entries(sheets))XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(rows),name);return wb;};
// Same layout as "BOM BC22S02_1363.xlsx": COMPARAÇÃO first, real BOM in "BOM SAP" without OPs, plus MB52/MM60.
const sapStyle=()=>book({
 'COMPARAÇÃO':[['MATERIAL','DESCRIÇÃO','QTD','CLASSIFICAÇÃO BOM','DIFF','CLASSIFICAÇÃO'],['15875589-00','BATERIA',2,'内部采购-Internal Purchase',0,'A']],
 'BOM SAP':[['Item lista técnica','Material','Texto breve material','Qtd.necessária','UMB','CLASSIFICAÇÃO'],['0010','15875589-00','BATERIA DE ENERGIA 3',2,'PCS','A'],['0020','10013053-00','DIVISORIA',1.5,'SET','C'],[null,null,null,null,null,null]],
 'KIT ENC':[['SAP','BYD P/N','Part Name Description (BOM)','Unit','Qty'],['11129481-00','KF1','RECORDER','PCS',1]],
 'MB52':[['Material','Texto breve material','Centro','Depósito','UMB','Utilização livre'],['15875589-00','BATERIA','BR02','7000','PCS',9]],
 'MM60':[['Material','Centro','UMB','Preço'],['15875589-00','BR02','PCS',10]],
});

test('arquivo no formato BOM SAP: escolhe a aba certa, não a primeira',()=>{
 const wb=sapStyle();assert.equal(bestBomSheet(wb),'BOM SAP');
 const info=diagnoseWorkbook(wb).find(item=>item.sheet==='BOM SAP')!;
 assert.equal(info.materials,2);assert.deepEqual(info.ops,[]);assert.match(info.summary,/sem OPs no cabeçalho/);
});

test('aba errada explica o que falta e indica a aba da BOM',()=>{
 assert.throws(()=>buildBomImport(sapStyle(),'COMPARAÇÃO',{model:'BC22S02'}),/COMPARAÇÃO" não tem coluna de unidade \(UMB\).*"BOM SAP" parece ser a BOM/);
 assert.throws(()=>buildBomImport(sapStyle(),'MB52',{model:'BC22S02'}),/MB52" não tem coluna de quantidade.*BOM SAP/);
});

test('BOM sem OPs pede as OPs e aceita as coladas',()=>{
 assert.throws(()=>buildBomImport(sapStyle(),'BOM SAP',{model:'BC22S02'}),/não tem números de OP no cabeçalho\. Cole as OPs/);
 const result=buildBomImport(sapStyle(),'BOM SAP',{model:'BC22S02',pastedOps:'19000005001\n19000005002; 19000005001 OP 123',fileName:'BOM BC22S02_1363.xlsx'});
 assert.deepEqual(result.ops,['19000005001','19000005002']);assert.equal(result.opsFrom,'pasted');
 assert.equal(result.rows.length,2);
 assert.deepEqual(result.rows[1],{id:'3',material:'10013053-00',description:'DIVISORIA',unit:'SET',item:'0020',classification:'C',required:1.5,consumption:{'19000005001':null,'19000005002':null}});
 assert.equal(result.source,'BOM BC22S02_1363.xlsx · BOM SAP');
});

test('formato CONSUMO com OPs nas colunas continua igual ao importador anterior',()=>{
 const rows=[['Material','Texto breve material','ITEM BOM SAP','CLASSIFICAÇÃO','Qtd.necessária','UMB',19000002315,'19000002316'],
  ['001-A','Arruela','10','C',3,'PCS',3,'2,5'],['002-B','Parafuso','20','B',null,'PCS',null,1]];
 const wb=book({CONSUMO:rows});
 const result=buildBomImport(wb,'CONSUMO',{model:'BC22X'});
 const legacy=convert(XLSX.utils.sheet_to_json(wb.Sheets.CONSUMO,{defval:null,raw:true}) as any,'consumo');
 assert.deepEqual(result.ops,legacy.ops);
 assert.deepEqual(result.rows.map(r=>[r.material,r.required,r.unit,r.classification,r.item,r.consumption]),legacy.rows.map(r=>[r.material,r.required,r.unit,r.classification,r.item,r.consumption]));
 assert.equal(result.opsFrom,'sheet');assert.match(result.notes.join(' '),/1 linha\(s\) sem quantidade/);
});

test('cabeçalho abaixo de um título e prioridade de Qtd.necessária sobre Quantidade',()=>{
 const parsed=parseBomMatrix([['Relatório BOM 1363'],[],['Quantidade','Material','UMB','Qtd.necessária',19000001111],[99,'X-1','PCS',2,0]]);
 assert.equal(parsed.headerRow,2);assert.equal(parsed.rows[0].required,2);assert.deepEqual(parsed.ops,['19000001111']);
});

test('MB51 do arquivo é opcional: se não cruzar, a BOM entra assim mesmo',()=>{
 const wb=book({CONSUMO:[['Material','Qtd.necessária','UMB',19000002315],['001-A',3,'PCS',1]],MB51:[['Material','Ordem','Quantidade'],['001-A','19000002315',-3]]});
 const result=buildBomImport(wb,'CONSUMO',{model:'BC22X'});
 assert.equal(result.rows[0].consumption['19000002315'],1);assert.match(result.notes.join(' '),/MB51 do arquivo não foi usada.*Tipo de movimento/);
 const ok=book({CONSUMO:[['Material','Qtd.necessária','UMB',19000002315],['001-A',3,'PCS',1]],MB51:[['Material','Ordem','Quantidade','Tipo de movimento'],['001-A','19000002315',-3,261]]});
 assert.equal(buildBomImport(ok,'CONSUMO',{model:'BC22X'}).rows.find(r=>r.material==='001-A')!.consumption['19000002315'],3);
});

test('OPs da aba Ordens do mesmo modelo são usadas quando a BOM não tem colunas de OP',()=>{
 const wb=book({'BOM SAP':[['Material','Qtd.necessária','UMB'],['001-A',1,'PCS']],Ordens:[['Modelo','Ordem'],['BC22S02','19000005001'],['BC10X','19000009999']]});
 const result=buildBomImport(wb,'BOM SAP',{model:'bc22s02'});
 assert.deepEqual(result.ops,['19000005001']);assert.equal(result.opsFrom,'orders');
});

test('lista de OPs e modelo pelo nome do arquivo',()=>{
 assert.deepEqual(parseOpList('19000005001, 19000005002\n19000005001 abc 1234'),['19000005001','19000005002']);
 assert.equal(inferModel('BOM BC22S02_1363.xlsx'),'BC22S02');assert.equal(inferModel('BOM BC22X OP1268 02.09.2026(2).xlsx'),'BC22X');assert.equal(inferModel('planilha.xlsx'),'');
});
