import {test} from 'node:test';
import assert from 'node:assert/strict';
import {writeOffColumns,isWriteOffHeader,sheetDate,pdfLink,drivePreview,parseWriteOffs,decodeWriteOffMatrix,summarizeWriteOffs} from '../lib/write-offs.ts';
import {automaticWriteOffs} from '../worker/automatic.ts';

const HEADER=['Data','Documento','Centro de custo','Descrição do centro de custo','Material','Descrição','Quantidade','UMB','Valor','Motivo','Solicitante','PDF'];
const DRIVE='https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz/view?usp=sharing';

test('colunas da aba BAIXA CC por nome, em qualquer ordem',()=>{
 const columns=writeOffColumns(['Link PDF','CC','Nº documento','Valor total','Justificativa']);
 assert.deepEqual(columns,{pdf:0,costCenter:1,document:2,value:3,reason:4});
 assert.equal(isWriteOffHeader(HEADER),true);
 assert.equal(isWriteOffHeader(['Material','Ordem','Quantidade','Tipo de movimento']),false,'MB51 não é a aba de baixas');
 assert.equal(isWriteOffHeader(['Centro de custo','Material']),false,'Precisa de Documento ou PDF');
});

test('datas da planilha: número do Sheets, Date() do gviz, dd/mm/aaaa e ISO',()=>{
 assert.equal(sheetDate(46295),'2026-09-30');
 assert.equal(sheetDate('Date(2026,8,30)'),'2026-09-30');
 assert.equal(sheetDate('30/09/2026'),'2026-09-30');
 assert.equal(sheetDate('2026-09-30T00:00:00Z'),'2026-09-30');
 assert.equal(sheetDate('ontem'),null);assert.equal(sheetDate(null),null);
});

test('link do PDF: URL colada, =HYPERLINK e nada além de http(s)',()=>{
 assert.deepEqual(pdfLink(DRIVE),{url:DRIVE,label:'PDF'});
 assert.deepEqual(pdfLink(`=HYPERLINK("${DRIVE}";"FO 123")`),{url:DRIVE,label:'FO 123'});
 assert.deepEqual(pdfLink(`=hyperlink("${DRIVE}","FO 123")`),{url:DRIVE,label:'FO 123'});
 assert.equal(pdfLink('javascript:alert(1)').url,null);
 assert.equal(pdfLink('FO.FI.C.007 baixa.pdf').url,null);
 assert.equal(drivePreview(DRIVE),'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz/preview');
 assert.equal(drivePreview('https://drive.google.com/open?id=1AbCdEfGhIjKlMnOpQrStUvWxYz'),'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz/preview');
 assert.equal(drivePreview('https://exemplo.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz/view'),null,'Só o Drive abre dentro do site');
});

test('linhas da aba viram baixas, mais recentes primeiro, com totais por centro de custo',()=>{
 const items=parseWriteOffs([HEADER,
  [46280,'FO-001','CC1001','Montagem','11242550-00','TIRRENO',15,'KG','1.250,50','Vazamento','Wesley',DRIVE],
  [null,null,null,null,null,null,null,null,null,null,null,null],
  ['30/09/2026','FO-002','CC2002',null,'001-A','Arruela',2,'PCS',10,'Avaria','Ana','sem link'],
  [null,'FO-003','CC1001','Montagem','002-B','Parafuso',1,'PCS',null,'Teste',null,null],
 ]);
 assert.deepEqual(items.map(item=>[item.document,item.date,item.row]),[['FO-002','2026-09-30',4],['FO-001','2026-09-15',2],['FO-003',null,5]]);
 assert.equal(items[1].value,1250.5);assert.equal(items[1].pdfPreview,'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz/preview');
 assert.equal(items[0].pdfUrl,null);assert.equal(items[0].pdfLabel,'sem link');
 const summary=summarizeWriteOffs(items);
 assert.equal(summary.count,3);assert.equal(summary.documents,3);assert.equal(summary.value,1260.5);
 assert.equal(summary.withoutPdf,2);assert.equal(summary.withoutValue,1);
 assert.deepEqual(summary.centers.map(group=>[group.costCenter,group.count,group.value]),[['CC1001',2,1250.5],['CC2002',1,10]]);
 assert.throws(()=>parseWriteOffs([['Material','Quantidade']]),/Centro de custo/);
});

test('formatos de resposta do Google (gviz e Sheets API)',()=>{
 const gviz='google.visualization.Query.setResponse('+JSON.stringify({status:'ok',table:{cols:[{label:'Documento'},{label:'Centro de custo'}],rows:[{c:[{v:'FO-1'},{v:'CC1'}]}]}})+');';
 assert.deepEqual(decodeWriteOffMatrix(gviz,'gviz'),[['Documento','Centro de custo'],['FO-1','CC1']]);
 assert.deepEqual(decodeWriteOffMatrix(JSON.stringify({values:[['Documento','CC'],['FO-1','CC1']]}),'sheets-api'),[['Documento','CC'],['FO-1','CC1']]);
});

test('Worker lê a aba BAIXA CC e não confunde com a primeira aba quando ela não existe',async t=>{
 const sheets:string[]=[];
 t.mock.method(globalThis,'fetch',async (input:RequestInfo|URL)=>{
  const url=new URL(String(input)),sheet=url.searchParams.get('sheet')||'';sheets.push(sheet+(url.searchParams.get('range')?':probe':''));
  // gviz answers an unknown sheet with the FIRST tab of the spreadsheet (MB51 here).
  const header=sheet==='BAIXAS'?HEADER:['Material','Ordem','Quantidade','Tipo de movimento'];
  return new Response('google.visualization.Query.setResponse('+JSON.stringify({status:'ok',table:{cols:header.map(label=>({label})),rows:[{c:header.map(v=>({v}))}]}})+');',{headers:{'Content-Type':'text/javascript'}});
 });
 const response=await automaticWriteOffs({});
 assert.equal(response.status,200);assert.equal(decodeURIComponent(response.headers.get('X-Source-Sheet')!),'BAIXAS');
 assert.deepEqual(sheets,['BAIXA CC:probe','BAIXAS CC:probe','BAIXA CENTRO DE CUSTO:probe','BAIXAS:probe','BAIXAS']);
});

test('sem a aba, o Worker explica como criar',async t=>{
 t.mock.method(globalThis,'fetch',async ()=>new Response('google.visualization.Query.setResponse('+JSON.stringify({status:'ok',table:{cols:[{label:'Material'}],rows:[{c:[{v:'Material'}]}]}})+');'));
 const response=await automaticWriteOffs({});
 assert.equal(response.status,422);assert.match((await response.json() as any).error,/Crie na planilha uma aba chamada BAIXA CC/);
});
