// In-memory DOM tests. No production API, Google Sheet, browser session or
// live database is modified. Unlike a build, these tests actually mount React
// and deliver the asynchronous data that used to crash the hidden table.
const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {JSDOM}=require('jsdom');
const React=require('react');
const {act}=React;
const rootDir=path.resolve(__dirname,'..');
const {build}=require(require.resolve('esbuild',{paths:[require.resolve('wrangler')]}));
const temp=fs.mkdtempSync(path.join(rootDir,'.ui-tests-'));
let Portal,ErrorBoundary,createRoot;
const xlsx=require('xlsx'),originalWriteFile=xlsx.writeFile;
let excelDownloadHandler=null;

before(async()=>{
 // Dynamic import caches the CJS namespace: keep one capture bridge for all exports.
 xlsx.writeFile=(book,name)=>{assert.ok(excelDownloadHandler,'Unexpected Excel export');excelDownloadHandler(book,name);};
 await build({entryPoints:[rootDir+'/app/portal.tsx',rootDir+'/app/error-boundary.tsx'],bundle:true,
  platform:'node',format:'cjs',outdir:temp,outExtension:{'.js':'.cjs'},tsconfig:rootDir+'/tsconfig.json',jsx:'automatic',
  external:['react','react-dom','radix-ui','sonner','lucide-react','xlsx','clsx','tailwind-merge','class-variance-authority']});
 ErrorBoundary=require(temp+'/error-boundary.cjs').default;
});
after(()=>{xlsx.writeFile=originalWriteFile;fs.rmSync(temp,{recursive:true,force:true});});

const bom={id:'consumo:bc22x-1268',name:'BOM de teste',revision:'Teste 39',source:'Fixture local',version:'test',
 ops:['19000002315','19000002316'],rows:[{id:'1',material:'001-A',description:'Material de teste',unit:'PCS',
 classification:'C',required:3,consumption:{'19000002315':3,'19000002316':2}}]};
function stock(id){return {id,name:'Depósito '+id,revision:'',source:'Fixture local',version:'test',
 rows:[{id:'s1',material:'001-A',description:'Material de teste',unit:'PCS',center:'BR02',depot:id,quantity:9,value:18}]};}
function gviz(headers,rows){
 return new Response('google.visualization.Query.setResponse('+JSON.stringify({status:'ok',table:{
  cols:headers.map(label=>({label})),rows:rows.map(values=>({c:values.map(v=>({v}))}))}})+');',{
  headers:{'X-Source-Format':'gviz','X-Source-Read-At':'2026-09-25T10:00:00Z','Content-Type':'application/javascript'}});
}
function apiResponse(url){
 if(url.pathname==='/api/data'){
  const id=url.searchParams.get('id');
  return Response.json(id?(id.startsWith('consumo:')?bom:stock(id)):[{...bom,rows:undefined}]);
 }
 if(url.pathname==='/api/ana-notes')return Response.json({notes:[],revision:0,canWrite:false,nextBefore:null});
 if(url.pathname==='/api/plan-boms')return Response.json(url.searchParams.get('id')?{error:'x'}:{plans:[],canEdit:false});
 if(url.pathname==='/api/session')return Response.json({role:'viewer'});
 if(url.pathname==='/api/op-status')return Response.json({statuses:{},revision:0,canEdit:false});
 if(url.pathname==='/api/checks')return Response.json({role:'viewer',revision:1,checks:{}});
 if(url.pathname==='/api/coois')return Response.json({error:'A planilha precisa ter uma aba COOIS'},{status:422});
 if(url.pathname==='/api/automatic'){
  const id=url.searchParams.get('id');
  if(id==='scrap')return Response.json({error:'A aba SCRAP não está disponível.'},{status:422});
  if(id.startsWith('consumo:'))return gviz(['Material','Ordem','Quantidade','Tipo de movimento','Centro'],[
   ['001-A','19000002315',-3,261,'BR02'],['001-A','19000002316',-2,261,'BR02']]);
  return gviz(['Material','Texto breve material','UM básica','Centro','Utilização livre','Val.utiliz.livre'],[
   ['001-A','Material de teste','PCS','BR02',9,18]]);
 }
 if(url.pathname==='/api/ana-source'){
  const sheet=url.searchParams.get('sheet');
  if(sheet==='KOB1')return gviz(['Ordem','Material','Qtd.total entrada'],[['19000002315','001-A',3]]);
  if(sheet==='ZPP009')return gviz(['Ordem','Material','BOM QTY'],[['19000002315','001-A',3]]);
  if(sheet==='MM60')return gviz(['Material','Preço'],[['001-A',2]]);
  return Response.json({error:'COOIS não configurada no teste'},{status:422});
 }
 throw Error('Request inesperado: '+url.href);
}

async function mount(t,{url='https://portal.test/',respond=apiResponse,element}={}){
 const dom=new JSDOM('<!doctype html><div id="root"></div>',{url,pretendToBeVisual:true});
 const win=dom.window,previous=new Map();
 function install(key,value){previous.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});}
 for(const key of ['window','document','navigator','location','history','Document','Element','Node','NodeFilter','DocumentFragment','MutationObserver','CustomEvent','Event','MouseEvent','KeyboardEvent','FocusEvent',...Object.getOwnPropertyNames(win).filter(key=>/^(HTML|SVG).*Element$/.test(key))]){
  install(key,key==='window'?win:win[key]);
 }
 install('getComputedStyle',win.getComputedStyle.bind(win));
 install('requestAnimationFrame',win.requestAnimationFrame.bind(win));
 install('cancelAnimationFrame',win.cancelAnimationFrame.bind(win));
 install('IS_REACT_ACT_ENVIRONMENT',true);
 win.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){},addListener(){},removeListener(){}});
 if(!Portal){
  // Radix and React inspect DOM availability at module initialization.
  createRoot=require('react-dom/client').createRoot;
  Portal=require(temp+'/portal.cjs').default;
 }
 const requests=[],errors=[];
 install('fetch',async(input,init)=>{const parsed=new URL(String(input),url);requests.push(parsed.pathname+parsed.search);return respond(parsed,init);});
 t.mock.method(console,'error',(...args)=>errors.push(args.map(String).join(' ')));
 const container=win.document.getElementById('root'),root=createRoot(container);
 t.after(async()=>{
  await act(async()=>root.unmount());dom.window.close();
  for(const [key,descriptor] of previous){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}
 });
 await act(async()=>root.render(element||React.createElement(ErrorBoundary,null,React.createElement(Portal))));
 if(!element&&container.querySelector('.app-recovery'))assert.fail(errors.join('\n'));
 async function settle(predicate=()=>true){
  for(let i=0;i<40;i++){
   await act(async()=>{await new Promise(resolve=>setTimeout(resolve,5));});
   if(predicate())return;
  }
  assert.fail('A interface não chegou ao estado esperado: '+container.textContent.slice(0,600)+'\n'+errors.join('\n'));
 }
 async function click(selector,label){
  const button=[...container.querySelectorAll(selector)].find(node=>label?node.textContent.trim()===label:true);
  assert.ok(button,`Botão ausente: ${selector} ${label||''}`);
  await act(async()=>{button.dispatchEvent(new win.MouseEvent('mousedown',{bubbles:true,button:0}));button.dispatchEvent(new win.MouseEvent('click',{bubbles:true,button:0}));});
  await settle();
 }
 function assertHealthy(){
  assert.equal(container.querySelector('.app-recovery'),null,'A interface caiu no tratamento de erro');
  assert.equal(errors.filter(message=>/TypeError|ReferenceError|Falha ao exibir|not wrapped in act/.test(message)).length,0,errors.join('\n'));
 }
 return {container,requests,errors,settle,click,assertHealthy};
}

async function openConsumption(ui){
 await ui.settle(()=>ui.container.querySelector('.op-progress-mode'));
 await ui.click('.op-progress-mode button','Consumo por classe');
 await ui.settle(()=>ui.container.querySelector('.op-progress-svg'));
}

test('a BOM não derruba a tela inicial após a resposta da API',async t=>{
 const ui=await mount(t);await ui.settle(()=>ui.container.querySelector('.op-status-svg'));
 assert.match(ui.container.textContent,/BOM de teste/);
 assert.equal(ui.container.querySelector('.main-nav [data-state=active]').textContent,'GRÁFICO');
 assert.match(ui.container.querySelector('button[aria-label="Atualizar dados"]').textContent,/Atualizar dados/);
 assert.equal(ui.container.querySelector('.main-panel'),null,'A tabela inativa não deve ser montada');
 assert.equal(ui.requests.some(url=>/automatic|coois|ana-source/.test(url)),false,'A atualização permanece manual');
 ui.assertHealthy();
});

test('BOM, visão geral, pendências, depósitos e CHECK ANA navegam sem erro',async t=>{
 const ui=await mount(t);
 await ui.click('.main-nav [role="tab"]','BOM × OP');
 await ui.click('.view-tabs button','BOM × OP');
 assert.match(ui.container.querySelector('.main-panel').textContent,/001-A/);
 await ui.click('.view-tabs button','Pendências por OP');
 assert.equal(ui.container.querySelector('.main-panel'),null);
 await ui.click('.view-tabs button','Visão geral');
 assert.equal([...ui.container.querySelectorAll('.main-nav [role="tab"]')].some(tab=>/1300|ADITIVOS/.test(tab.textContent)),false,'Aba 1300 removida');
 for(const depot of ['7000','2000','1500']){
  await ui.click('[role="tab"]',depot);
  assert.equal(ui.container.querySelector('h1').textContent,'DEPÓSITO '+depot);
  assert.match(ui.container.querySelector('.main-panel').textContent,/001-A/);
 }
 await ui.click('[role="tab"]','CHECK ANA');
 await ui.settle(()=>ui.container.textContent.includes('Check da Ana ainda não foi carregado'));
 assert.equal(ui.container.querySelector('.main-panel'),null);
 assert.equal(ui.requests.some(url=>/automatic|coois|ana-source/.test(url)),false);
 await ui.click('[role="tab"]','BOM × OP');
 ui.assertHealthy();
});

test('a atualização manual monta as pendências e o check da Ana',async t=>{
 const ui=await mount(t);
 await ui.click('button[aria-label="Atualizar dados"]');
 await openConsumption(ui);
 assert.ok(ui.requests.some(url=>url.startsWith('/api/automatic')));
 await ui.click('[role="tab"]','CHECK ANA');
 await ui.settle(()=>ui.container.textContent.includes('Atualizar conferência'));
 await ui.click('.ana-actions button','Atualizar conferência');
 await ui.settle(()=>ui.container.querySelector('.ana-table tbody tr'));
 assert.match(ui.container.querySelector('.ana-table tbody').textContent,/Sem diferenças/);
 ui.assertHealthy();
});

test('erro na API é exibido e permite tentar novamente',async t=>{
 let fail=true;
 const ui=await mount(t,{respond(url){return fail&&url.pathname==='/api/data'&&url.search?Response.json({error:'Banco indisponível'},{status:503}):apiResponse(url);}});
 assert.match(ui.container.textContent,/Banco indisponível/);
 fail=false;await ui.click('[role="alert"] button','Tentar novamente');
 assert.match(ui.container.textContent,/BOM de teste/);
 ui.assertHealthy();
});

test('gráfico consolidado usa a leitura manual e abre apenas os materiais da OP clicada',async t=>{
 const ui=await mount(t,{respond(url){
  if(url.pathname==='/api/automatic'&&url.searchParams.get('id')?.startsWith('consumo:'))return gviz(['Material','Ordem','Quantidade','Tipo de movimento','Centro'],[
   ['001-A','19000002315',-3,261,'BR02'],['001-A','19000002316',-2,261,'BR02'],
   ['11242550-00','19000002315',-15,261,'BR02'],['11242550-00','19000002316',-15,261,'BR02']]);
  return apiResponse(url);
 }});
 await ui.click('button[aria-label="Atualizar dados"]');
 await openConsumption(ui);
 const before=ui.requests.filter(url=>/automatic|coois/.test(url)).length;
 await ui.click('.main-nav [role="tab"]','GRÁFICO');
 await openConsumption(ui);
 assert.equal(ui.container.querySelectorAll('.op-progress-group').length,2);
 assert.equal(ui.container.querySelectorAll('.op-progress-svg').length,1);
 assert.match(ui.container.querySelector('.op-progress-svg').textContent,/100%/);
 assert.equal(ui.container.querySelector('.op-rail'),null);
 assert.equal(ui.requests.filter(url=>/automatic|coois/.test(url)).length,before);
 await ui.click('.op-progress-group[aria-label^="Abrir OP 19000002316"]');
 assert.equal(ui.container.querySelector('.main-nav [data-state=active]').textContent,'BOM × OP');
 assert.match(location.search,/modulo=consumo/);
 const rows=ui.container.querySelectorAll('.shortage-scroll tbody tr');
 assert.equal(rows.length,1);assert.match(rows[0].textContent,/19000002316/);assert.match(rows[0].textContent,/001-A/);
 await ui.click('.main-nav [role="tab"]','GRÁFICO');
 await openConsumption(ui);
 assert.equal(ui.container.querySelectorAll('.op-progress-group').length,2);
 assert.match(location.search,/modulo=grafico/);
 await ui.click('.op-progress-group[aria-label^="Abrir OP 19000002315"]');
 assert.equal(ui.container.querySelectorAll('.shortage-scroll tbody tr').length,2);
 assert.match(ui.container.querySelector('.shortages .panel-head h2').textContent,/Atendidos/);
 ui.assertHealthy();
});

test('o gráfico limita a renderização e permite filtrar todas as OPs',async t=>{
 const ops=Array.from({length:20},(_,i)=>String(19000002315+i));
 const source={...bom,ops};
 const ui=await mount(t,{respond(url){
  if(url.pathname==='/api/data'&&url.searchParams.get('id')?.startsWith('consumo:'))return Response.json(source);
  if(url.pathname==='/api/automatic'&&url.searchParams.get('id')?.startsWith('consumo:'))return gviz(['Material','Ordem','Quantidade','Tipo de movimento','Centro'],ops.map(op=>['001-A',op,-2,261,'BR02']));
  return apiResponse(url);
 }});
 await ui.click('button[aria-label="Atualizar dados"]');
 await openConsumption(ui);
 await ui.click('.main-nav [role="tab"]','GRÁFICO');
 assert.equal(ui.container.querySelectorAll('.op-progress-group').length,16);
 await ui.click('button[aria-label="Próximas OPs no gráfico"]');
 assert.equal(ui.container.querySelectorAll('.op-progress-group').length,4);
 const select=ui.container.querySelector('select[aria-label="Situação das OPs no gráfico"]');
 await act(async()=>{select.value='pending';select.dispatchEvent(new Event('change',{bubbles:true}));});
 assert.equal(ui.container.querySelectorAll('.op-progress-group').length,16);
 ui.assertHealthy();
});

test('CHECK ANA aceita os grupos nativos do SAP, filtra OP e funciona sem MM60',async t=>{
 const ui=await mount(t,{url:'https://portal.test/?modulo=ana',respond(url){
  if(url.pathname!=='/api/ana-source')return apiResponse(url);
  const sheet=url.searchParams.get('sheet');
  if(sheet==='KOB1')return gviz(['Ordem','Material','Qtd.total entrada','Unid.medida lançamento'],[
   [19000002315,'',387,'MIN'],[19000002315,'15875588-00',5,'PCS'],[19000002316,'15875588-00',4,'PCS']]);
  if(sheet==='ZPP009')return gviz(['WERKS','Pro. No.','SAP No.','Description','Planning QTY','Issued QTY','BOM QTY'],[
   ['BR02',19000002315,'19006834-00','CHASSIS',1,1,0],[null,null,'15875588-00','Bateria',0,0,5],
   ['BR02',19000002316,'19006834-00','CHASSIS',1,1,0],[null,null,'15875588-00','Bateria',0,0,5]]);
  return Response.json({error:'Aba opcional indisponível'},{status:422});
 }});
 await ui.settle(()=>ui.container.textContent.includes('Atualizar conferência'));
 assert.equal(ui.requests.some(url=>url.includes('ana-source')),false);
 await ui.click('.ana-actions button','Atualizar conferência');
 await ui.settle(()=>ui.container.querySelectorAll('.ana-table tbody tr').length===2);
 assert.equal(ui.container.querySelectorAll('.ana-row.complete').length,1);
 assert.equal(ui.container.querySelectorAll('.ana-row.shortage').length,1);
 assert.equal(ui.container.querySelector('.ana-stats article:last-child strong').textContent,'—');
 assert.match(ui.container.textContent,/MM60 indisponível/);
 assert.match(ui.container.querySelector('.ana-reading').textContent,/2 componentes associados/);
 const orderSelect=ui.container.querySelector('.ana-select select');
 await act(async()=>{orderSelect.value='19000002315';orderSelect.dispatchEvent(new Event('change',{bubbles:true}));});
 assert.equal(ui.container.querySelectorAll('.ana-table tbody tr').length,1);
 assert.match(ui.container.querySelector('.ana-table tbody').textContent,/Sem diferenças/);
 assert.equal(ui.container.querySelector('.ana-stats article:first-child strong').textContent,'1');
 ui.assertHealthy();
});

test('resposta antiga da BOM não sobrescreve o CHECK ANA',async t=>{
 let resolveBom;
 const ui=await mount(t,{respond(url){return url.pathname==='/api/data'&&url.search?new Promise(resolve=>{resolveBom=resolve;}):apiResponse(url);}});
 assert.match(ui.container.textContent,/Carregando a BOM salva/);
 await ui.click('[role="tab"]','CHECK ANA');
 await act(async()=>resolveBom(Response.json(bom)));
 await ui.settle(()=>ui.container.textContent.includes('Check da Ana ainda não foi carregado'));
 assert.equal(ui.container.querySelector('.main-panel'),null);
 assert.equal(ui.container.querySelector('h1').textContent,'CHECK ANA · ZPP009 × KOB1');
 ui.assertHealthy();
});

test('CHECK ANA apresenta o valor calculado da KOB1 e identifica a moeda ausente da ZPP009',async t=>{
 const ui=await mount(t,{url:'https://portal.test/?modulo=ana',respond(url){
  if(url.pathname!=='/api/ana-source')return apiResponse(url);
  const sheet=url.searchParams.get('sheet');
  if(sheet==='KOB1')return gviz(['Ordem','Material','Qtd.total entrada','Valor/moed.transação','Moeda da transação'],[
   [2315,'PART',4,40,'BRL'],[2315,'',387,33088.50,'BRL']]);
  if(sheet==='ZPP009')return gviz(['Ordem','Material','BOM QTY','Input Cost','Actual input of raw material'],[
   [2315,'PART',5,-40,-4],[2315,'ZPP-PART',2,-5,-1]]);
  return Response.json({error:'Aba opcional indisponível'},{status:422});
 }});
 await ui.settle(()=>ui.container.textContent.includes('Atualizar conferência'));
 await ui.click('.ana-actions button','Atualizar conferência');
 await ui.settle(()=>ui.container.querySelectorAll('.ana-table tbody tr').length===2);
 const rows=[...ui.container.querySelectorAll('.ana-table tbody tr')];
 const part=rows.find(row=>row.querySelector('td span').textContent==='PART');
 const zpp=rows.find(row=>row.querySelector('td span').textContent==='ZPP-PART');
 assert.match(part.textContent,/R\$\s*10,00/);assert.match(part.textContent,/KOB1 · estimativa/);
 assert.match(part.textContent,/-R\$\s*10,00/);
 assert.match(zpp.textContent,/Moeda não informada/);assert.doesNotMatch(zpp.textContent,/R\$/);
 assert.match(ui.container.querySelector('.ana-financial').textContent,/-R\$\s*10,00/);
 assert.match(ui.container.querySelector('.ana-financial').textContent,/fora dos totais/);
 const details=part.querySelector('.ana-price details');await act(async()=>details.querySelector('summary').click());
 assert.equal(details.open,true);assert.match(details.textContent,/Valor\/moed.transação/);
 ui.assertHealthy();
});

test('falha de renderização apresenta recuperação, nunca só fundo vazio',async t=>{
 function Broken(){throw Error('Falha de teste');}
 const ui=await mount(t,{element:React.createElement(ErrorBoundary,null,React.createElement(Broken))});
 assert.match(ui.container.textContent,/Não foi possível exibir esta tela/);
 assert.match(ui.container.textContent,/Recarregar site/);
});

test('a barra superior acompanha a tabela e desaparece quando as colunas cabem',async t=>{
 const ui=await mount(t,{url:'https://portal.test/?modulo=7000'});
 const body=ui.container.querySelector('.table-scroll-body'),top=ui.container.querySelector('.table-scroll-top');
 assert.ok(body&&top);
 let available=700;
 Object.defineProperty(body,'clientWidth',{configurable:true,get:()=>available});
 Object.defineProperty(body,'scrollWidth',{configurable:true,get:()=>1450});
 await act(async()=>{window.dispatchEvent(new Event('resize'));});
 assert.equal(ui.container.querySelector('.table-scroll-controls').hidden,false);
 assert.equal(top.firstElementChild.style.width,'1450px');
 await act(async()=>{top.scrollLeft=350;top.dispatchEvent(new Event('scroll'));});
 assert.equal(body.scrollLeft,350);
 await act(async()=>{body.scrollLeft=620;body.dispatchEvent(new Event('scroll'));});
 assert.equal(top.scrollLeft,620);
 available=1500;
 await act(async()=>{window.dispatchEvent(new Event('resize'));});
 assert.equal(ui.container.querySelector('.table-scroll-controls').hidden,true);
 ui.assertHealthy();
});

test('o gráfico adapta a quantidade de OPs à largura sem novas consultas',async t=>{
 const ops=Array.from({length:20},(_,i)=>String(19000002315+i));
 const ui=await mount(t,{respond(url){
  if(url.pathname==='/api/data'&&url.searchParams.get('id')?.startsWith('consumo:'))return Response.json({...bom,ops});
  return apiResponse(url);
 }});
 await ui.click('button[aria-label="Atualizar dados"]');
 await openConsumption(ui);
 const before=ui.requests.filter(url=>/automatic|coois/.test(url)).length;
 const area=ui.container.querySelector('.op-progress-scroll');
 area.getBoundingClientRect=()=>({width:416});
 await act(async()=>{window.dispatchEvent(new Event('resize'));});
 assert.equal(ui.container.querySelectorAll('.op-progress-group').length,5);
 assert.match(ui.container.querySelector('.op-progress-svg').getAttribute('viewBox'),/^0 0 416 /);
 await ui.click('button[aria-label="Próximas OPs no gráfico"]');
 assert.equal(ui.container.querySelectorAll('.op-progress-group').length,5);
 assert.match(ui.container.querySelector('.op-progress-pagination').textContent,/6–10 de 20/);
 assert.equal(ui.requests.filter(url=>/automatic|coois/.test(url)).length,before);
 ui.assertHealthy();
});


test('falha ao atualizar MB51 esconde o gráfico antigo e não consulta COOIS',async t=>{
 let fail=false;
 const ui=await mount(t,{respond:url=>{
  if(fail&&url.pathname==='/api/automatic'&&url.searchParams.get('id')?.startsWith('consumo:'))return Response.json({error:'Extração indisponível'},{status:502});
  return apiResponse(url);
 }});
 await ui.click('button[aria-label="Atualizar dados"]');await openConsumption(ui);
 fail=true;await ui.click('button[aria-label="Atualizar dados"]');
 assert.equal(ui.container.querySelector('.op-progress-svg'),null);assert.match(ui.container.textContent,/Extração indisponível/);
 assert.equal(ui.requests.some(url=>url.startsWith('/api/coois')),false);ui.assertHealthy();
});

test('administrador colore uma OP e o status persiste ao trocar de tela',async t=>{
 let saved={},revision=0;
 const respond=(url,init)=>{
  if(url.pathname==='/api/op-status'){
   if(init?.method==='POST'){const body=JSON.parse(init.body);saved={...saved,[body.op]:{status:body.status,updatedAt:'2026-09-25'}};revision++;}
   return Response.json({statuses:saved,revision,canEdit:true});
  }
  return apiResponse(url);
 };
 const ui=await mount(t,{respond});await ui.click('button[aria-label="Atualizar dados"]');
 await ui.click('.main-nav [role="tab"]','BOM × OP');
 const first=()=>ui.container.querySelector('.op-card');
 assert.ok(first().classList.contains('status-not_started'));
 await ui.click('.op-card .op-status-button');await ui.click('.op-status-menu button','Aguardando Warehouse');
 assert.ok(first().classList.contains('status-waiting'));assert.equal(saved['19000002315'].status,'waiting');
 await ui.click('.op-card .op-status-button');await ui.click('.op-status-menu button','Concluída');
 assert.ok(first().classList.contains('status-complete'));
 await ui.click('.main-nav [role="tab"]','GRÁFICO');assert.match(ui.container.querySelector('.op-manual-summary').textContent,/Concluída/);
 await ui.click('.main-nav [role="tab"]','BOM × OP');assert.ok(first().classList.contains('status-complete'));
 await ui.click('.op-card .op-status-button');await ui.click('.op-status-menu button','Não iniciada');assert.ok(first().classList.contains('status-not_started'));
 ui.assertHealthy();
});

test('falha ao salvar status não apresenta uma OP como concluída',async t=>{
 const ui=await mount(t,{respond:(url,init)=>{
  if(url.pathname==='/api/op-status')return init?.method==='POST'?Response.json({error:'Falha ao salvar status'},{status:503}):Response.json({statuses:{},revision:0,canEdit:true});
  return apiResponse(url);
 }});
 await ui.click('button[aria-label="Atualizar dados"]');await ui.click('.main-nav [role="tab"]','BOM × OP');
 await ui.click('.op-card .op-status-button');await ui.click('.op-status-menu button','Concluída');
 assert.ok(ui.container.querySelector('.op-card').classList.contains('status-not_started'));assert.match(ui.container.textContent,/Falha ao salvar status/);ui.assertHealthy();
});

test('CHECK ANA não conta OP sem KOB1 como falta e mostra os pares e códigos únicos',async t=>{
 const ui=await mount(t,{url:'https://portal.test/?modulo=ana',respond(url){
  if(url.pathname!=='/api/ana-source')return apiResponse(url);
  const sheet=url.searchParams.get('sheet');
  if(sheet==='KOB1')return gviz(['Ordem','Material','Qtd.total entrada'],[[2315,'A',1],[2316,'A',1]]);
  if(sheet==='ZPP009')return gviz(['Ordem','Material','BOM QTY'],[[2315,'A',2],[2316,'A',2],[2317,'A',100]]);
  if(sheet==='MM60')return gviz(['Material','Preço','Moeda'],[['A',10,'BRL']]);
  return Response.json({error:'COOIS opcional'},{status:422});
 }});
 await ui.click('.ana-actions button','Atualizar conferência');
 await ui.settle(()=>ui.container.querySelectorAll('.ana-table tbody tr').length===3);
 assert.equal(ui.container.querySelectorAll('.ana-row.shortage').length,2);
 assert.equal(ui.container.querySelectorAll('.ana-row.incomplete').length,1);
 assert.match(ui.container.querySelector('.ana-coverage-score').textContent,/2 \/ 3/);
 assert.match(ui.container.querySelector('.ana-stats .featured').textContent,/1 códigos únicos/);
 assert.equal(ui.container.querySelector('.ana-stats .featured strong').textContent,'2');
 assert.match(ui.container.querySelector('.ana-financial').textContent,/-R\$\s*20,00/);
 const absent=ui.container.querySelector('.ana-row.incomplete');
 assert.match(absent.textContent,/Base incompleta/);
 assert.equal(absent.querySelectorAll('td')[6].textContent,'—');
 assert.match(absent.querySelector('.ana-formula').textContent,/0 − 100 = -100/);
 await ui.click('.ana-coverage-alert button','Ver base incompleta');
 assert.equal(ui.container.querySelectorAll('.ana-table tbody tr').length,1);
 assert.match(ui.container.querySelector('.ana-table tbody').textContent,/2317/);
 ui.assertHealthy();
});

test('atualização malsucedida identifica claramente os resultados antigos do CHECK ANA',async t=>{
 let fail=false;
 const ui=await mount(t,{url:'https://portal.test/?modulo=ana',respond(url){
  if(fail&&url.pathname==='/api/ana-source')return Response.json({error:'Fonte indisponível'},{status:502});
  return apiResponse(url);
 }});
 await ui.click('.ana-actions button','Atualizar conferência');
 await ui.settle(()=>ui.container.querySelector('.ana-row.complete'));
 fail=true;await ui.click('.ana-actions button','Atualizar conferência');
 await ui.settle(()=>ui.container.querySelector('[role="alert"]'));
 assert.match(ui.container.querySelector('[role="alert"]').textContent,/leitura anterior/);
 assert.match(ui.container.querySelector('[role="alert"]').textContent,/não foram atualizados/);
 assert.equal(ui.container.querySelectorAll('.ana-row.complete').length,1);
 ui.assertHealthy();
});

test('uma OP concluída fica verde enquanto os 65% medem somente a BOM, sem forçar consumo',async t=>{
 const op='19000002315';
 const rows=[...Array.from({length:19},(_,i)=>({material:'C-'+i,classification:'C',required:1,unit:'PCS'})),
  {material:'11242550-00',classification:'C',required:15,unit:'KG'}].map((row,i)=>({...row,id:String(i),consumption:{[op]:0}}));
 const ui=await mount(t,{respond(url){
  if(url.pathname==='/api/data'&&url.searchParams.get('id')?.startsWith('consumo:'))return Response.json({...bom,ops:[op],rows});
  if(url.pathname==='/api/op-status')return Response.json({statuses:{[op]:{status:'complete',updatedAt:'2026-09-25T12:00:00Z'}},revision:1,canEdit:false});
  if(url.pathname==='/api/automatic'&&url.searchParams.get('id')?.startsWith('consumo:'))return gviz(['Material','Ordem','Quantidade','Tipo de movimento','Centro'],[
   ...Array.from({length:12},(_,i)=>['C-'+i,op,-1,261,'BR02']),['11242550-00',op,-15,261,'BR02']]);
  return apiResponse(url);
 }});
 await ui.click('button[aria-label="Atualizar dados"]');
 await ui.settle(()=>ui.container.querySelector('.op-status-board'));
 const card=ui.container.querySelector('.op-status-board .status-complete');
 assert.ok(card);assert.match(card.textContent,/Concluída/);assert.match(card.textContent,/100%/);assert.doesNotMatch(card.textContent,/materiais|diferenças/);
 assert.match(ui.container.querySelector('.op-status-svg').textContent,/100%/);
 assert.equal(ui.container.querySelector('.operational-totals .status-complete strong').textContent,'1');
 assert.equal(ui.container.querySelector('.op-progress-svg'),null,'Status da equipe não é um percentual de consumo');
 const requests=ui.requests.filter(url=>url.includes('/api/automatic')).length;
 await openConsumption(ui);
 assert.match(ui.container.querySelector('.op-progress-group').textContent,/65%/);
 assert.match(ui.container.querySelector('.op-progress-group').textContent,/Concluída\*/);
 assert.equal(ui.requests.filter(url=>url.includes('/api/automatic')).length,requests,'Trocar a visualização não relê a planilha');
 ui.assertHealthy();
});

function visualAnaSource(url){
 const sheet=url.searchParams.get('sheet');
 if(sheet==='KOB1')return gviz(['Ordem','Material','Qtd.total entrada'],[['2315','12943277-00',0],['2316','12943277-00',1]]);
 if(sheet==='ZPP009')return gviz(['Ordem','Material','BOM QTY','Description'],[['2315','12943277-00',1,'BMK9NA-3509030_空压机出气口消声器_M00666'],['2316','12943277-00',1,'BMK9NA-3509030_空压机出气口消声器_M00666'],['2317','12943277-00',1,'BMK9NA-3509030_空压机出气口消声器_M00666']]);
 if(sheet==='COOIS')return gviz(['Ordem','Status do sistema'],[['2315','REL CONF FORN'],['2316','REL'],['2317','CNF']]);
 return Response.json({error:'MM60 opcional não fornecida'},{status:422});
}
async function selectNoteOrder(ui,op){
 const select=ui.container.querySelector('[aria-label="OP das observações"]');
 await act(async()=>{select.value=op;select.dispatchEvent(new Event('change',{bubbles:true}));});await ui.settle();
}
async function typeAnaNote(ui,text){
 const input=ui.container.querySelector('#ana-note-text');assert.ok(input,'O campo de escrita deve estar disponível');
 await act(async()=>{Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,text);input.dispatchEvent(new Event('input',{bubbles:true}));});
}

test('gráficos contam OPs, destacam COOIS em amarelo e abrem descrição em português e anotações sem reler SAP',async t=>{
 const ui=await mount(t,{url:'https://portal.test/?modulo=ana',respond:url=>url.pathname==='/api/ana-source'?visualAnaSource(url):apiResponse(url)});
 await ui.click('.ana-actions button','Atualizar conferência');await ui.settle(()=>ui.container.querySelector('.ana-charts'));
 assert.equal(ui.container.querySelector('.ana-donut-number').textContent,'3');
 assert.match(ui.container.querySelector('.ana-charts svg').getAttribute('aria-label'),/Apontada · consumo pendente: 1 ordens/);
 assert.equal(ui.container.querySelectorAll('.ana-op-bar.posted_pending').length,1);
 assert.equal(ui.container.querySelectorAll('.ana-row.posted-pending').length,1);
 assert.match(ui.container.querySelector('.ana-description').textContent,/Silenciador da saída de ar/);
 assert.match(ui.container.querySelector('.ana-description details').textContent,/空压机/);
 await ui.click('.ana-op-bar.posted_pending');
 assert.equal(ui.container.querySelectorAll('.ana-table tbody tr').length,1);
 assert.equal(ui.container.querySelector('[aria-label="OP das observações"]').value,'2315');
 assert.match(ui.container.querySelector('.ana-selected-order').textContent,/Confirmação final na COOIS/);
 assert.equal(ui.container.querySelector('#ana-note-text'),null,'Perfil consulta não edita notas');
 const sourceReads=ui.requests.filter(url=>url.includes('ana-source')).length;
 await ui.click('.ana-components-chart header button','Todas as OPs');
 await ui.click('.ana-chart-legend button','Base incompleta1');
 assert.equal(ui.container.querySelectorAll('.ana-table tbody tr').length,1);
 assert.equal(ui.container.querySelector('.ana-row').classList.contains('incomplete'),true);
 assert.equal(ui.requests.filter(url=>url.includes('ana-source')).length,sourceReads);
 ui.assertHealthy();
});

test('observações são salvas por OP/material, mantêm rascunho em falha e preservam o id no retry',async t=>{
 let notes=[],fail=true;const sent=[];
 const ui=await mount(t,{url:'https://portal.test/?modulo=ana',respond(url,init){
  if(url.pathname==='/api/ana-source')return visualAnaSource(url);
  if(url.pathname==='/api/ana-notes'){
   if(init?.method==='POST'){
    const value=JSON.parse(init.body);sent.push(value);
    if(fail)return Response.json({error:'Falha temporária de gravação'},{status:503});
    const note={...value,seq:notes.length+1,created_at:'2026-09-26T10:00:00Z',author_role:'analyst'};notes.push(note);return Response.json({note,canWrite:true});
   }
   const op=url.searchParams.get('op'),material=url.searchParams.get('material');
   return Response.json({notes:notes.filter(note=>note.op===op&&(!material||note.material===material)),revision:notes.length,canWrite:true,nextBefore:null});
  }
  return apiResponse(url);
 }});
 await ui.click('.ana-actions button','Atualizar conferência');await ui.settle(()=>ui.container.querySelector('.ana-charts'));
 await selectNoteOrder(ui,'2315');await ui.settle(()=>ui.container.querySelector('#ana-note-text'));
 await typeAnaNote(ui,'Verificado com a Ana. Falta conciliar o lançamento.');
 await ui.click('.ana-notes form button','Salvar observação');
 assert.match(ui.container.querySelector('.ana-notes [role="alert"]').textContent,/Falha temporária/);
 assert.match(ui.container.querySelector('#ana-note-text').value,/Verificado com a Ana/);
 fail=false;await ui.click('.ana-notes form button','Salvar observação');
 assert.equal(sent[0].id,sent[1].id);assert.equal(ui.container.querySelector('#ana-note-text').value,'');
 assert.match(ui.container.querySelector('.ana-note-list').textContent,/Verificado com a Ana/);
 await ui.click('.ana-add-note','Anotar material');await ui.settle(()=>ui.container.querySelector('#ana-note-text'));
 assert.match(ui.container.querySelector('.ana-note-context').textContent,/12943277-00/);
 await typeAnaNote(ui,'Observação específica.');await ui.click('.ana-notes form button','Salvar observação');
 assert.equal(sent.at(-1).material,'12943277-00');
 await selectNoteOrder(ui,'2316');await ui.settle(()=>ui.container.querySelector('#ana-note-text'));
 assert.doesNotMatch(ui.container.querySelector('.ana-note-list').textContent,/Verificado com a Ana|Observação específica/);
 await selectNoteOrder(ui,'2315');await ui.settle(()=>ui.container.querySelectorAll('.ana-note-list article').length===2);
 assert.match(ui.container.querySelector('.ana-note-list').textContent,/Verificado com a Ana/);
 assert.equal(ui.requests.filter(url=>url.includes('ana-source')).length,4);
 ui.assertHealthy();
});

test('leitura lenta das notas de uma OP não contamina as notas da próxima OP',async t=>{
 let finishOld;
 const ui=await mount(t,{url:'https://portal.test/?modulo=ana',respond(url){
  if(url.pathname==='/api/ana-source')return visualAnaSource(url);
  if(url.pathname==='/api/ana-notes'){
   if(url.searchParams.get('op')==='2315')return new Promise(resolve=>{finishOld=resolve;});
   return Response.json({notes:[{id:'new',seq:2,text:'Nota da OP 2316',material:'',author_role:'admin',created_at:'2026-09-26T10:00:00Z'}],revision:2,canWrite:false,nextBefore:null});
  }
  return apiResponse(url);
 }});
 await ui.click('.ana-actions button','Atualizar conferência');await ui.settle(()=>ui.container.querySelector('.ana-charts'));
 await selectNoteOrder(ui,'2315');await selectNoteOrder(ui,'2316');
 await act(async()=>finishOld(Response.json({notes:[{id:'old',seq:1,text:'Não mostrar: OP 2315',material:'',author_role:'admin',created_at:'2026-09-26T10:00:00Z'}],revision:1,canWrite:true,nextBefore:null})));
 assert.match(ui.container.querySelector('.ana-note-list').textContent,/Nota da OP 2316/);
 assert.doesNotMatch(ui.container.querySelector('.ana-note-list').textContent,/Não mostrar/);
 assert.equal(ui.container.querySelector('#ana-note-text'),null);
 ui.assertHealthy();
});

test('recolher as observações amplia a conferência sem perder o rascunho ou reler as fontes',async t=>{
 const ui=await mount(t,{url:'https://portal.test/?modulo=ana',respond(url){
  if(url.pathname==='/api/ana-source')return visualAnaSource(url);
  if(url.pathname==='/api/ana-notes')return Response.json({notes:[],revision:0,canWrite:true,nextBefore:null});
  return apiResponse(url);
 }});
 await ui.click('.ana-actions button','Atualizar conferência');await ui.settle(()=>ui.container.querySelector('.ana-charts'));
 await ui.click('.ana-op-bar.posted_pending');await ui.settle(()=>ui.container.querySelector('#ana-note-text'));
 await typeAnaNote(ui,'Conferência em andamento, manter este rascunho.');
 const sourceReads=ui.requests.filter(url=>url.includes('ana-source')).length;
 const note=ui.container.querySelector('#ana-note-text');
 await ui.click('.ana-notes-toggle','Recolher observações');
 assert.equal(ui.container.querySelector('#ana-notes-panel').hidden,true);
 assert.equal(ui.container.querySelector('.ana-notes-toggle').getAttribute('aria-expanded'),'false');
 await ui.click('.ana-notes-toggle','Abrir observações');
 assert.equal(ui.container.querySelector('#ana-notes-panel').hidden,false);
 assert.equal(ui.container.querySelector('#ana-note-text'),note,'Reabrir deve preservar o formulário e seu rascunho');
 assert.match(note.value,/manter este rascunho/);
 await ui.click('.ana-notes-toggle','Recolher observações');
 await ui.click('.ana-add-note','Anotar material');
 assert.equal(ui.container.querySelector('#ana-notes-panel').hidden,false,'Anotar material reabre o painel');
 assert.equal(ui.container.querySelector('[aria-label="OP das observações"]').value,'2315');
 assert.equal(ui.requests.filter(url=>url.includes('ana-source')).length,sourceReads);
 for(const link of ui.container.querySelectorAll('.ana-quick-nav a'))assert.ok(ui.container.querySelector(link.getAttribute('href')),'O atalho deve apontar para uma seção existente');
 ui.assertHealthy();
});

test('7000 e 2000 aparecem lado a lado; saldo no Warehouse exige transferência e não apaga diferença SAP',async t=>{
 const source={...bom,ops:['19000002315'],rows:['A','B','C','D'].map((code,i)=>({id:code,material:code+'-1',description:'Peça '+code,unit:'PCS',classification:['A','B','C','C'][i],required:5,consumption:{'19000002315':0}}))};
 const ui=await mount(t,{respond(url){
  const id=url.searchParams.get('id');
  if(url.pathname==='/api/data'&&id?.startsWith('consumo:'))return Response.json(source);
  if(url.pathname==='/api/automatic'&&id?.startsWith('consumo:'))return gviz(['Material','Ordem','Quantidade','Tipo de movimento','Centro'],[
   ['A-1','19000002315',-1,261,'BR02'],['B-1','19000002315',-1,261,'BR02'],['C-1','19000002315',-1,261,'BR02'],['D-1','19000002315',-5,261,'BR02'],['11242550-00','19000002315',-15,261,'BR02']]);
  if(url.pathname==='/api/automatic'&&(id==='7000'||id==='2000'))return gviz(['Material','Texto breve material','UM básica','Centro','Depósito','Utilização livre','Val.utiliz.livre'],['A','B','C','D'].map((code,i)=>[code+'-1','Peça '+code,'PCS','BR02',id,(id==='7000'?[6,1,1,0]:[100,3,1,0])[i],0]));
  return apiResponse(url);
 }});
 await ui.click('button[aria-label="Atualizar dados"]');await ui.click('.main-nav [role="tab"]','BOM × OP');
 await ui.settle(()=>ui.container.querySelector('.op-select'));
 await ui.click('.op-select');await ui.settle(()=>ui.container.querySelectorAll('.shortage-scroll tbody tr').length===3);
 const find=code=>[...ui.container.querySelectorAll('.shortage-scroll tbody tr')].find(row=>row.querySelector('.code')?.textContent===code);
 const a=find('A-1'),b=find('B-1'),c=find('C-1');
 assert.match(a.querySelector('.stock-7000').textContent,/^6 PCS/);assert.match(a.querySelector('.stock-2000').textContent,/^100 PCS/);
 assert.match(a.querySelector('.shortage-action').textContent,/Não precisa solicitar ao 2000/);assert.equal(a.querySelector('.stock-request').textContent.trim(),'0 PCS');
 assert.ok(a.classList.contains('covered-pending-row'));assert.ok(b.classList.contains('transfer-pending-row'));assert.ok(c.classList.contains('pending-row'));
 assert.equal(b.querySelector('.stock-request').textContent.trim(),'3 PCS');assert.equal(b.querySelector('.stock-uncovered').textContent.trim(),'0 PCS');
 assert.match(b.querySelector('.shortage-action').textContent,/transferência de 3 PCS do 2000 para o 7000/);
 assert.equal(c.querySelector('.stock-uncovered').textContent.trim(),'2 PCS');
 assert.match(c.querySelector('.stock-proof').textContent,/Necessário do 2000: 4 − 1 = 3/);
 const before=ui.requests.filter(url=>url.includes('/api/automatic')).length;
 await ui.click('.stock-filter-tabs .covered_7000');assert.equal(ui.container.querySelectorAll('.shortage-scroll tbody tr').length,1);assert.ok(find('A-1'));
 await ui.click('.stock-filter-tabs .short_both');assert.equal(ui.container.querySelectorAll('.shortage-scroll tbody tr').length,1);assert.ok(find('C-1'));
 assert.equal(ui.requests.filter(url=>url.includes('/api/automatic')).length,before);
 ui.assertHealthy();
});

test('OP que não veio na MB51 fica a conferir e não vira uma lista de faltas nem percentual zero',async t=>{
 const source={...bom,rows:[{...bom.rows[0],classification:'A'}]};
 const ui=await mount(t,{respond(url){
  if(url.pathname==='/api/data'&&url.searchParams.get('id')?.startsWith('consumo:'))return Response.json(source);
  if(url.pathname==='/api/automatic'&&url.searchParams.get('id')?.startsWith('consumo:'))return gviz(['Material','Ordem','Quantidade','Tipo de movimento','Centro'],[['001-A','19000002315',-3,261,'BR02'],['11242550-00','19000002315',-15,261,'BR02']]);
  return apiResponse(url);
 }});
 await ui.click('button[aria-label="Atualizar dados"]');await openConsumption(ui);
 const missing=ui.container.querySelector('.op-progress-group[aria-label^="Abrir OP 19000002316"]');
 assert.match(missing.getAttribute('aria-label'),/0 diferenças SAP/);assert.doesNotMatch(missing.textContent,/0%/);assert.match(ui.container.querySelector('.mb51-coverage-note').textContent,/1 OPs sem movimentos/);
 await ui.click('.op-progress-group[aria-label^="Abrir OP 19000002316"]');
 const rows=[...ui.container.querySelectorAll('.shortage-scroll tbody tr')];assert.equal(rows.length,2);assert.ok(rows.every(row=>row.classList.contains('review-row')));
 assert.ok(rows.every(row=>/não é uma falta confirmada/.test(row.textContent)));
 assert.ok(rows.every(row=>row.querySelector('.stock-request').textContent.includes('—')));
 ui.assertHealthy();
});

test('gráfico operacional abre sem ler planilhas e muda para 100% logo após o admin salvar',async t=>{
 let statuses={'19000002315':{status:'waiting',updatedAt:'2026-09-28T10:00:00Z'}},revision=1;
 const ui=await mount(t,{url:'https://portal.test/?modulo=grafico',respond(url,init){
  if(url.pathname==='/api/op-status'){
   if(init?.method==='POST'){const body=JSON.parse(init.body);statuses={...statuses,[body.op]:{status:body.status,updatedAt:'2026-09-28T12:00:00Z'}};revision++;}
   return Response.json({statuses,revision,canEdit:true});
  }
  return apiResponse(url);
 }});
 await ui.settle(()=>ui.container.querySelector('.op-status-svg'));
 assert.equal(ui.requests.some(url=>/automatic|coois/.test(url)),false);
 const graphic=()=>ui.container.querySelector('.op-status-svg [data-op="19000002315"]');
 assert.equal(graphic().getAttribute('data-status'),'waiting');assert.doesNotMatch(graphic().textContent,/108|%/);
 await ui.click('.op-status-tile[data-op="19000002315"] .op-status-button');await ui.click('.op-status-menu button','Concluída');
 assert.equal(graphic().getAttribute('data-status'),'complete');assert.match(graphic().textContent,/100%/);
 assert.equal(ui.container.querySelector('.operational-totals .status-complete strong').textContent,'1');
 assert.doesNotMatch(ui.container.querySelector('.op-status-board').textContent,/diferenças|materiais atendidos|108/);
 assert.equal(ui.requests.some(url=>/automatic|coois/.test(url)),false);
 await ui.click('.op-status-tile[data-op="19000002315"] .op-status-button');await ui.click('.op-status-menu button','Aguardando Warehouse');
 assert.equal(graphic().getAttribute('data-status'),'waiting');assert.doesNotMatch(graphic().textContent,/100%/);
 ui.assertHealthy();
});

function warehouseApi(url){
 if(url.pathname==='/api/automatic'){
  const id=url.searchParams.get('id');
  if(id.startsWith('consumo:'))return gviz(['Material','Ordem','Quantidade','Tipo de movimento','Centro'],[
   ['001-A','19000002315',-1,261,'BR02'],['001-A','19000002316',-1,261,'BR02'],
   ['11242550-00','19000002315',-15,261,'BR02'],['11242550-00','19000002316',-15,261,'BR02']]);
  if(['7000','2000','1500'].includes(id))return gviz(['Material','Texto breve material','UM básica','Centro','Utilização livre'],[['001-A','Material de teste','PCS','BR02',id==='7000'?3:id==='2000'?2:999]]);
 }
 return apiResponse(url);
}

test('Warehouse consolida saldo uma vez e retira OP encerrada sem reler as fontes',async t=>{
 let statuses={},revision=0;
 const ui=await mount(t,{url:'https://portal.test/?modulo=warehouse',respond(url,init){
  if(url.pathname==='/api/op-status'){
   if(init?.method==='POST'){const body=JSON.parse(init.body);statuses={...statuses,[body.op]:{status:body.status,updatedAt:'2026-09-28'}};revision++;}
   return Response.json({statuses,revision,canEdit:true});
  }
  return warehouseApi(url);
 }});
 assert.equal(ui.container.querySelector('h1').textContent,'RESUMO WAREHOUSE');
 assert.equal(ui.requests.some(url=>/automatic|coois/.test(url)),false);
 await ui.click('button[aria-label="Atualizar dados"]');await ui.settle(()=>ui.container.querySelector('.warehouse-table tbody tr'));
 const row=()=>ui.container.querySelector('.warehouse-table tbody tr');
 assert.equal(ui.container.querySelectorAll('.warehouse-table tbody tr').length,1);
 assert.match(row().querySelectorAll('td')[2].textContent,/^4/);assert.match(row().querySelectorAll('td')[3].textContent,/^3/);
 assert.match(row().querySelector('.warehouse-request').textContent,/^1/);
 await ui.click('.warehouse-table summary');await ui.settle(()=>ui.container.querySelector('.warehouse-table li'));
 assert.equal(ui.container.querySelectorAll('.warehouse-table li').length,2);
 const reads=ui.requests.filter(url=>url.includes('/api/automatic')).length;
 await ui.click('.main-nav [role="tab"]','GRÁFICO');
 await ui.click('.op-status-tile[data-op="19000002316"] .op-status-button');await ui.click('.op-status-menu button','Concluída');
 await ui.click('.main-nav [role="tab"]','WAREHOUSE');
 assert.match(row().querySelectorAll('td')[2].textContent,/^2/);assert.match(row().querySelector('.warehouse-request').textContent,/^0/);
 assert.match(ui.container.querySelector('.warehouse-criteria').textContent,/1 OPs concluídas/);
 assert.equal(ui.requests.filter(url=>url.includes('/api/automatic')).length,reads);
 await ui.click('.main-nav [role="tab"]','BOM × OP');
 assert.doesNotMatch(ui.container.querySelector('.op-rail').textContent,/diferenças|atendidos|conferir/);
 ui.assertHealthy();
});

test('Warehouse respeita marcações OK compartilhadas e consulta não consegue alterá-las',async t=>{
 const ui=await mount(t,{url:'https://portal.test/?modulo=warehouse',respond(url){
  if(url.pathname==='/api/checks')return Response.json({role:'viewer',revision:1,checks:{'19000002316|001-A|PCS':true}});
  return warehouseApi(url);
 }});
 await ui.click('button[aria-label="Atualizar dados"]');await ui.settle(()=>ui.container.querySelector('.warehouse-table tbody tr'));
 const row=ui.container.querySelector('.warehouse-table tbody tr');
 assert.match(row.querySelectorAll('td')[2].textContent,/^2/);assert.match(row.querySelector('.warehouse-request').textContent,/^0/);
 assert.match(ui.container.querySelector('.warehouse-criteria').textContent,/1 itens OK/);
 await ui.click('.main-nav [role="tab"]','GRÁFICO');
 assert.ok([...ui.container.querySelectorAll('.op-status-button')].every(button=>button.disabled));
 ui.assertHealthy();
});

test('viewer recebe conclusão compartilhada em até 5 segundos sem atualizar MB51',async t=>{
 let saved=false;
 const ui=await mount(t,{respond(url){
  if(url.pathname==='/api/op-status')return Response.json({revision:saved?1:0,canEdit:false,statuses:saved?{'19000002315':{status:'complete',updatedAt:'2026-09-28'}}:{}});
  return apiResponse(url);
 }});
 await ui.settle(()=>ui.container.querySelector('.op-status-svg'));
 const graphic=()=>ui.container.querySelector('.op-status-svg [data-op="19000002315"]');
 assert.equal(graphic().getAttribute('data-status'),'not_started');saved=true;
 await act(async()=>{await new Promise(resolve=>setTimeout(resolve,5_150));});
 assert.equal(graphic().getAttribute('data-status'),'complete');assert.match(graphic().textContent,/100%/);
 assert.equal(ui.requests.some(url=>/automatic|coois/.test(url)),false);
 assert.ok([...ui.container.querySelectorAll('.op-status-button')].every(button=>button.disabled));
 ui.assertHealthy();
});

test('Excel do Warehouse leva todos os materiais e OPs, inclusive os de outra página',async t=>{
 const x=require('xlsx');let downloaded=null;
 excelDownloadHandler=(book,name)=>{downloaded={bytes:x.write(book,{type:'buffer',bookType:'xlsx'}),name};};t.after(()=>{excelDownloadHandler=null;});
 const parts=Array.from({length:26},(_,i)=>({...bom.rows[0],id:String(i),material:'PART'+String(i).padStart(2,'0'),required:2}));
 const ui=await mount(t,{url:'https://portal.test/?modulo=warehouse',respond(url){
  if(url.pathname==='/api/data'&&url.searchParams.get('id')?.startsWith('consumo:'))return Response.json({...bom,rows:parts});
  if(url.pathname==='/api/automatic'){
   const id=url.searchParams.get('id');
   if(id.startsWith('consumo:'))return gviz(['Material','Ordem','Quantidade','Tipo de movimento','Centro'],[
    ...parts.flatMap(row=>bom.ops.map(op=>[row.material,op,-1,261,'BR02'])),...bom.ops.map(op=>['11242550-00',op,-15,261,'BR02'])]);
   if(['7000','2000','1500'].includes(id))return gviz(['Material','Texto breve material','UM básica','Centro','Utilização livre'],parts.map(row=>[row.material,'Peça de teste','PCS','BR02',id==='7000'?1:2]));
  }
  return apiResponse(url);
 }});
 await ui.click('button[aria-label="Atualizar dados"]');await ui.settle(()=>ui.container.querySelectorAll('.warehouse-table tbody tr').length===25);
 await ui.click('.warehouse-heading button');await ui.settle(()=>downloaded!==null);
 assert.match(downloaded.name,/Resumo_Warehouse/);
 const book=x.read(downloaded.bytes,{type:'buffer'});
 assert.deepEqual(book.SheetNames,['Total_por_Item','Falta_por_OP','Criterios']);
 const totals=x.utils.sheet_to_json(book.Sheets.Total_por_Item),detail=x.utils.sheet_to_json(book.Sheets.Falta_por_OP);
 assert.equal(totals.length,26);assert.equal(detail.length,52);
 assert.ok(totals.every(row=>row['Solicitar ao Warehouse (2000)']===1));
 assert.ok(detail.every(row=>!('Saldo 7000' in row)));assert.ok(totals.some(row=>row.SAP==='PART25'));
 ui.assertHealthy();
});

test('marcação de item altera Warehouse somente depois de salvar; falha não retira a falta',async t=>{
 let fail=true,checks={},revision=1;
 const ui=await mount(t,{respond(url,init){
  if(url.pathname==='/api/checks'){
   if(init?.method==='POST'){
    if(fail)return Response.json({error:'Falha ao salvar marcação'},{status:503});
    const body=JSON.parse(init.body);for(const key of body.keys)checks[key]=body.checked;revision++;
   }
   return Response.json({role:'admin',revision,checks});
  }
  return warehouseApi(url);
 }});
 await ui.click('button[aria-label="Atualizar dados"]');await ui.click('.main-nav [role="tab"]','BOM × OP');
 await ui.click('.op-card .op-select');
 await ui.click('.shortage-scroll .manual-toggle');
 assert.equal(ui.container.querySelector('.manual-toggle').getAttribute('aria-pressed'),'false');
 assert.match(ui.container.textContent,/Falha ao salvar marcação/);
 fail=false;await ui.click('.shortage-scroll .manual-toggle');
 assert.doesNotMatch(ui.container.textContent,/Falha ao salvar marcação/);
 assert.equal(ui.container.querySelector('.manual-toggle').getAttribute('aria-pressed'),'true');
 await ui.click('.main-nav [role="tab"]','WAREHOUSE');await ui.settle(()=>ui.container.querySelector('.warehouse-table tbody tr'));
 assert.match(ui.container.querySelector('.warehouse-table tbody tr td:nth-child(3)').textContent,/^2/);
 assert.match(ui.container.querySelector('.warehouse-request').textContent,/^0/);
 ui.assertHealthy();
});

test('Warehouse filtra classes, combina situação e exporta o mesmo recorte sem reler estoque',async t=>{
 const x=require('xlsx');let downloaded;
 excelDownloadHandler=book=>{downloaded=x.read(x.write(book,{type:'buffer',bookType:'xlsx'}),{type:'buffer'});};t.after(()=>{excelDownloadHandler=null;});
 const parts=['A','B','C','C'].map((classification,i)=>({...bom.rows[0],id:String(i),material:'PART'+i,classification}));
 const ui=await mount(t,{url:'https://portal.test/?modulo=warehouse',respond(url){
  if(url.pathname==='/api/data'&&url.searchParams.get('id')?.startsWith('consumo:'))return Response.json({...bom,rows:parts});
  if(url.pathname==='/api/automatic'){
   const id=url.searchParams.get('id');
   if(id.startsWith('consumo:'))return gviz(['Material','Ordem','Quantidade','Tipo de movimento','Centro'],[
    ...parts.flatMap(row=>bom.ops.map(op=>[row.material,op,-1,261,'BR02'])),...bom.ops.map(op=>['11242550-00',op,-15,261,'BR02'])]);
   if(['7000','2000','1500'].includes(id))return gviz(['Material','Texto breve material','UM básica','Centro','Utilização livre'],parts.map((row,i)=>[row.material,'Peça de teste','PCS','BR02',id==='7000'?(i===3?99:1):10]));
  }
  return apiResponse(url);
 }});
 await ui.click('button[aria-label="Atualizar dados"]');await ui.settle(()=>ui.container.querySelectorAll('.warehouse-table tbody tr').length===4);
 const reads=ui.requests.filter(url=>url.includes('/api/automatic')).length;
 const choose=async(label,value)=>{
  const select=ui.container.querySelector(`select[aria-label="${label}"]`);assert.ok(select);
  await act(async()=>{select.value=value;select.dispatchEvent(new Event('change',{bubbles:true}));});
 };
 const codes=()=>[...ui.container.querySelectorAll('.warehouse-table tbody .code')].map(cell=>cell.textContent);
 const metrics=()=>[...ui.container.querySelectorAll('.warehouse-metrics strong')].map(cell=>cell.textContent);
 await choose('Classe no Warehouse','A');assert.deepEqual(codes(),['PART0']);
 await choose('Classe no Warehouse','B');assert.deepEqual(codes(),['PART1']);
 await choose('Classe no Warehouse','AB');assert.deepEqual(codes(),['PART0','PART1']);
 await choose('Classe no Warehouse','C');assert.deepEqual(codes(),['PART2','PART3']);assert.deepEqual(metrics(),['1','1','2','0']);
 await choose('Situação no Warehouse','request');assert.deepEqual(codes(),['PART2']);assert.deepEqual(metrics(),['1','0','2','0']);
 assert.match(ui.container.querySelector('.warehouse-request').textContent,/^3/,'One shared balance across both OPs');
 await ui.click('.warehouse-heading button');await ui.settle(()=>!!downloaded);
 const totals=x.utils.sheet_to_json(downloaded.Sheets.Total_por_Item),details=x.utils.sheet_to_json(downloaded.Sheets.Falta_por_OP);
 assert.equal(totals.length,1);assert.equal(totals[0].SAP,'PART2');assert.equal(totals[0].Classes,'C');assert.equal(totals[0]['Solicitar ao Warehouse (2000)'],3);
 assert.equal(details.length,2);assert.ok(details.every(row=>row.Classe==='C'));
 const criteria=x.utils.sheet_to_json(downloaded.Sheets.Criterios,{header:1});assert.ok(criteria.some(row=>row[0]==='Classe selecionada'&&row[1]==='Classe C'));
 await ui.click('.warehouse-clear-filters');assert.equal(codes().length,4);assert.deepEqual(metrics(),['3','1','2','0']);
 assert.equal(ui.requests.filter(url=>url.includes('/api/automatic')).length,reads);
 ui.assertHealthy();
});

test('OP concluída mantém a prova da MB51 e atualiza a diferença após um novo documento',async t=>{
 let newPosting=false;
 const source={...bom,ops:['19000002315'],rows:[{id:'proof',material:'20513481-00',description:'Peça de conferência',unit:'PCS',classification:'A',required:1,consumption:{'19000002315':0}}]};
 const ui=await mount(t,{respond(url){
  const id=url.searchParams.get('id');
  if(url.pathname==='/api/data'&&id?.startsWith('consumo:'))return Response.json(source);
  if(url.pathname==='/api/op-status')return Response.json({statuses:{'19000002315':{status:'complete'}},revision:1,canEdit:false});
  if(url.pathname==='/api/automatic'&&id?.startsWith('consumo:'))return gviz(['Material','Ordem','Quantidade','Tipo de movimento','Centro','Depósito','Doc.material','Item doc.material','Data de lançamento'],[
   ['20513481-00','19000002315',-2,261,'BR02',2000,4900665403,1,'Date(2026,8,4)'],
   ['20513481-00','19000002315',2,262,'BR02',2000,4900720549,1,'Date(2026,8,4)'],
   ['11242550-00','19000002315',-15,261,'BR02',7000,4900900383,1,'Date(2026,8,25)'],
   ...(newPosting?[['20513481-00','19000002315',-1,261,'BR02',2000,4900999999,1,'Date(2026,8,28)']]:[])]);
  return apiResponse(url);
 }});
 await ui.click('button[aria-label="Atualizar dados"]');await ui.click('.main-nav [role="tab"]','BOM × OP');await ui.click('.op-select');
 assert.equal(ui.container.querySelectorAll('.shortage-scroll thead th').length,8);
 assert.match(ui.container.querySelector('.selected-op-status').textContent,/não entra nos pedidos Warehouse/);
 const proof=ui.container.querySelector('.movement-proof');assert.ok(proof);
 await ui.click('.movement-proof summary');assert.equal(proof.open,true);
 assert.match(proof.textContent,/Saídas 261: 2 − estornos 262: 2 = 0 PCS/);
 assert.match(proof.textContent,/4900665403/);assert.match(proof.textContent,/4900720549/);
 assert.match(ui.container.querySelector('.shortage-scroll tbody tr').textContent,/Consumo estornado/);
 newPosting=true;await ui.click('button[aria-label="Atualizar dados"]');
 await ui.click('.op-select');
 assert.match(ui.container.querySelector('.shortage-view-tabs [aria-selected="true"]').textContent,/Atendidos/);
 assert.equal(ui.container.querySelectorAll('.shortage-scroll .complete-row').length,2);
 assert.match(ui.container.querySelector('.movement-proof').textContent,/Saídas 261: 3 − estornos 262: 2 = 1 PCS/);
 ui.assertHealthy();
});

test('erro do banco aparece com código e Tentar novamente recupera BOM e status juntos',async t=>{
 let failing=true;
 const ui=await mount(t,{respond(url){
  if(failing&&['/api/data','/api/op-status'].includes(url.pathname))return Response.json({error:'O banco atingiu a cota diária. Código: D1_DAILY_READ_LIMIT',code:'D1_DAILY_READ_LIMIT',retryAfter:3600},{status:503,headers:{'Retry-After':'3600'}});
  return apiResponse(url);
 }});
 assert.match(ui.container.textContent,/D1_DAILY_READ_LIMIT/);
 assert.equal(ui.container.querySelector('.op-status-board'),null);
 const before=ui.requests.filter(url=>url.includes('/api/op-status')).length;
 failing=false;await ui.click('button','Tentar novamente');
 await ui.settle(()=>ui.container.querySelector('.op-status-board'));
 assert.ok(ui.container.querySelector('.op-status-board'));
 assert.ok(ui.requests.filter(url=>url.includes('/api/op-status')).length>before);
 assert.doesNotMatch(ui.container.textContent,/D1_DAILY_READ_LIMIT/);
 ui.assertHealthy();
});

// MB51-56 · SALDO 7000 × PROJETOS
const nextBom={id:'consumo:bc10x-1400',name:'BC10X',revision:'BOM 1400',source:'Fixture local',version:'test',
 ops:['19000009001'],rows:[{id:'1',material:'002-B',description:'Peça do novo projeto',unit:'PCS',classification:'B',required:5,consumption:{'19000009001':null}}]};
function projectsApi(url,{mb51Fails=false}={}){
 if(url.pathname==='/api/data'){
  const id=url.searchParams.get('id');
  if(!id)return Response.json([{...bom,rows:undefined},{...nextBom,rows:undefined}]);
  if(id===nextBom.id)return Response.json(nextBom);
 }
 if(url.pathname==='/api/automatic'){
  const id=url.searchParams.get('id');
  if(id.startsWith('consumo:'))return mb51Fails?Response.json({error:'Falha na leitura Google. Confira a conexão e tente novamente.'},{status:502})
   :gviz(['Material','Ordem','Quantidade','Tipo de movimento','Centro'],[['001-A','19000002315',-3,261,'BR02'],['001-A','19000002316',-2,261,'BR02']]);
  if(id==='7000')return gviz(['Material','Texto breve material','UM básica','Centro','Utilização livre','Val.utiliz.livre'],[
   ['001-A','Material de teste','PCS','BR02',9,18],['002-B','Peça do novo projeto','PCS','BR02',12,24],
   ['999-Z','Sobra de projeto antigo','PCS','BR02',4,40],['11242550-00','TIRRENO','KG','BR02',40,400],['000-0','Zerado','PCS','BR02',0,0]]);
 }
 return apiResponse(url);
}
const projectRow=(ui,material)=>[...ui.container.querySelectorAll('.stock-projects-table tbody tr')].find(row=>row.querySelector('.code')?.textContent===material);
const cells=row=>[...row.querySelectorAll('td')].map(cell=>cell.textContent);

test('7000 × PROJETOS cruza o saldo com todas as BOMs, respeita os papéis e só lê fontes no clique',async t=>{
 const x=require('xlsx');let downloaded=null;
 excelDownloadHandler=(book,name)=>{downloaded={bytes:x.write(book,{type:'buffer',bookType:'xlsx'}),name};};t.after(()=>{excelDownloadHandler=null;});
 const ui=await mount(t,{url:'https://portal.test/?modulo=projetos',respond:url=>projectsApi(url)});
 await ui.settle(()=>ui.container.querySelectorAll('.stock-project-card').length===2);
 assert.equal(ui.container.querySelector('h1').textContent,'SALDO 7000 × PROJETOS');
 assert.equal(ui.container.querySelector('.main-nav [aria-selected="true"]').textContent,'7000 × PROJETOS');
 assert.equal(ui.requests.some(url=>/automatic/.test(url)),false,'Abrir a aba não lê Google Sheets');
 assert.equal(ui.requests.some(url=>/^\/api\/(data\?id=|op-status|checks)/.test(url)),false,'Link direto não baixa a BOM padrão antes do clique');
 await ui.click('.stock-projects-actions button','Analisar saldo 7000');
 await ui.settle(()=>ui.container.querySelectorAll('.stock-projects-table tbody tr').length===4);
 assert.equal(ui.requests.filter(url=>url.startsWith('/api/automatic?id=consumo')).length,1,'MB51 lida uma única vez para as duas BOMs');
 assert.equal(projectRow(ui,'000-0'),undefined,'Saldo zero fica fora');
 const old=projectRow(ui,'999-Z');
 assert.equal(old.className,'stock-project-return_all');assert.match(cells(old)[5],/^4/);assert.match(cells(old)[2],/Nenhum projeto considerado/);
 const current=projectRow(ui,'001-A');
 // OP 2315 consumiu 3/3; OP 2316 consumiu 2/3 → falta 1. Saldo 9 → manter 1, devolver 8.
 assert.equal(current.className,'stock-project-return_excess');assert.match(cells(current)[3],/^1/);assert.match(cells(current)[5],/^8/);
 const incoming=projectRow(ui,'002-B');
 // OP do projeto novo sem MB51 = não iniciada → BOM cheia 5.
 assert.match(cells(incoming)[2],/BC10X · BOM 1400/);assert.match(cells(incoming)[4],/^5/);assert.match(cells(incoming)[5],/^7/);
 assert.match(ui.container.querySelector('.stock-projects-metrics').textContent,/Devolver ao 2000\s*3/);
 const reads=ui.requests.length;
 await ui.click('.stock-project-card:nth-child(2) .stock-project-role button','Fora da análise');
 const excluded=projectRow(ui,'002-B');
 assert.equal(excluded.className,'stock-project-return_all');assert.match(cells(excluded)[5],/^12/);
 assert.match(cells(excluded)[2],/Também em: BC10X · BOM 1400 \(fora da análise\)/);
 assert.equal(ui.requests.length,reads,'Trocar o papel recalcula sem nova consulta');
 await ui.click('.stock-project-card:nth-child(2) .stock-project-role button','Vai entrar');
 assert.match(cells(projectRow(ui,'002-B'))[4],/^5/);
 await ui.click('.stock-projects-actions button','Baixar planilha de devolução');await ui.settle(()=>downloaded!==null);
 assert.match(downloaded.name,/Saldo_7000_x_Projetos/);
 const book=x.read(downloaded.bytes,{type:'buffer'});
 assert.deepEqual(book.SheetNames,['Devolucao_2000','Uso_por_Projeto','Criterios']);
 const totals=x.utils.sheet_to_json(book.Sheets.Devolucao_2000);
 assert.equal(totals.length,4);assert.equal(totals.find(row=>row.SAP==='999-Z')['Devolver ao 2000'],4);
 assert.match(x.utils.sheet_to_csv(book.Sheets.Criterios),/BC10X · BOM 1400 — Vai entrar/);
 ui.assertHealthy();
});

test('7000 × PROJETOS sem MB51 usa a BOM cheia das OPs abertas e avisa',async t=>{
 const ui=await mount(t,{url:'https://portal.test/?modulo=projetos',respond:url=>projectsApi(url,{mb51Fails:true})});
 await ui.settle(()=>ui.container.querySelectorAll('.stock-project-card').length===2);
 await ui.click('.stock-projects-actions button','Analisar saldo 7000');
 await ui.settle(()=>ui.container.querySelectorAll('.stock-projects-table tbody tr').length===4);
 assert.match(ui.container.querySelector('.stock-projects [role="alert"]').textContent,/MB51 indisponível/);
 const current=projectRow(ui,'001-A');
 // 2 OPs abertas × 3 PCS = 6 → manter 6, devolver 3.
 assert.match(cells(current)[3],/^6/);assert.match(cells(current)[5],/^3/);
 ui.assertHealthy();
});

// MB51-66 · BOM do plano (OEBOM): qtd. por ônibus × ônibus restantes, editável sem nova leitura.
test('7000 × PROJETOS soma a BOM do plano e recalcula ao mudar os ônibus restantes',async t=>{
 const plan={id:'plano:bc10s01-dwb1391',name:'BC10S01 · DWB1391',revision:'A7_V9',units:4,version:'p1',
  rows:[{id:'1',material:'999-Z',description:'Sobra',unit:'PCS',required:1,source:'Stats'}]};
 const posts=[];
 const respond=(url,init)=>{
  if(url.pathname==='/api/plan-boms'){
   if(init?.method==='POST'){const body=JSON.parse(init.body);posts.push(body);plan.units=body.units;return Response.json({...plan,rows:undefined});}
   const id=url.searchParams.get('id');
   return Response.json(id?plan:{plans:[{...plan,rows:undefined}],canEdit:true});
  }
  return projectsApi(url);
 };
 const ui=await mount(t,{url:'https://portal.test/?modulo=projetos',respond});
 await ui.settle(()=>ui.container.querySelectorAll('.stock-project-card').length===3);
 assert.match(ui.container.querySelector('.stock-plan-list').textContent,/BC10S01 · DWB1391.*4 ônibus restantes/);
 await ui.click('.stock-projects-actions button','Analisar saldo 7000');
 await ui.settle(()=>ui.container.querySelectorAll('.stock-projects-table tbody tr').length===4);
 let row=projectRow(ui,'999-Z');
 // saldo 4, 1/ônibus × 4 ônibus → manter 4, devolver 0
 assert.match(cells(row)[2],/1 PCS\/ônibus × 4 ônibus/);assert.match(cells(row)[4],/^4/);assert.match(cells(row)[5],/^0/);
 const input=ui.container.querySelector('.stock-plan-edit input');
 await typeInto(input,'1');
 await ui.click('.stock-plan-edit button','Salvar');
 await ui.settle(()=>/^3/.test(cells(projectRow(ui,'999-Z'))[5]));
 assert.deepEqual(posts,[{action:'units',id:plan.id,units:1}]);
 ui.assertHealthy();
});

// MB51-57 · apagar BOM errada e isolamento por BOM
const wrongBom={id:'consumo:bc99-errada',name:'BC99',revision:'CONSUMO',source:'Fixture local',version:'gen-1',
 ops:['19000008001'],rows:[{id:'1',material:'777-B',description:'Peça só da BOM errada',unit:'PCS',classification:'A',required:4,consumption:{'19000008001':null}}]};
function bomsApi({role='admin',boms=[bom,wrongBom],deleted=[]}={}){
 return (url,init)=>{
  if(url.pathname==='/api/session')return Response.json({role});
  if(url.pathname==='/api/data-meta'){const body=JSON.parse(init.body);const target=boms.find(item=>item.id===body.id);Object.assign(target,{name:body.name.trim(),revision:body.revision.trim()});return Response.json({id:target.id,name:target.name,revision:target.revision,version:target.version,updatedAt:'2026-09-30T13:00:00Z'});}
  if(url.pathname==='/api/data'){
   const id=url.searchParams.get('id');
   if(init?.method==='DELETE'){deleted.push(url.search);boms.splice(boms.findIndex(item=>item.id===id),1);return Response.json({deleted:id,rows:1,statuses:2,checks:3});}
   if(!id)return Response.json(boms.map(item=>({...item,rows:undefined})));
   const found=boms.find(item=>item.id===id);
   if(id.startsWith('consumo:'))return found?Response.json(found):Response.json({error:'BOM não encontrada. Ela pode ter sido apagada; escolha outra BOM ativa.'},{status:404});
  }
  if(url.pathname==='/api/automatic'&&url.searchParams.get('id').startsWith('consumo:'))
   return gviz(['Material','Ordem','Quantidade','Tipo de movimento','Centro'],[
    ['001-A','19000002315',-3,261,'BR02'],['001-A','19000002316',-2,261,'BR02'],['777-B','19000008001',-1,261,'BR02'],['777-B','19000002315',-9,261,'BR02']]);
  return apiResponse(url);
 };
}

test('BOM selecionada pelo endereço puxa somente as próprias linhas, OPs, status e marcações',async t=>{
 const ui=await mount(t,{url:'https://portal.test/?modulo=consumo&bom='+encodeURIComponent(wrongBom.id),respond:bomsApi()});
 await ui.settle(()=>ui.container.querySelector('.active-bom'));
 const bomReads=ui.requests.filter(url=>/^\/api\/(data\?id=consumo|op-status|checks)/.test(url));
 assert.ok(bomReads.length>=2);
 assert.ok(bomReads.every(url=>url.includes(encodeURIComponent(wrongBom.id))),'Nenhuma leitura da outra BOM: '+bomReads.join(' '));
 assert.match(ui.container.querySelector('.active-bom').textContent,/BC99 · CONSUMO/);
 await ui.click('button[aria-label="Atualizar dados"]');
 await ui.click('.view-tabs button','BOM × OP');
 await ui.settle(()=>ui.container.querySelector('.main-panel tbody tr'));
 const text=ui.container.querySelector('.main-panel tbody').textContent;
 assert.match(text,/777-B/);assert.doesNotMatch(text,/001-A/,'Material de outra BOM não aparece');
 // A MB51 traz 9 PCS do 777-B na OP de outra BOM: só a OP desta BOM conta.
 const row=[...ui.container.querySelectorAll('.main-panel tbody tr')].find(tr=>tr.textContent.includes('777-B'));
 assert.match(row.querySelector('.consumption').textContent,/^1$/);
 ui.assertHealthy();
});

test('administrador apaga a BOM errada com confirmação; a do pacote e o perfil consulta não apagam',async t=>{
 const deleted=[],boms=[bom,wrongBom];
 const ui=await mount(t,{url:'https://portal.test/?modulo=consumo&bom='+encodeURIComponent(wrongBom.id),respond:bomsApi({boms,deleted})});
 await ui.settle(()=>ui.container.querySelector('.bom-remove')&&!ui.container.querySelector('.bom-remove').disabled);
 await ui.click('.bom-remove');
 await ui.settle(()=>document.querySelector('.remove-dialog'));
 const dialog=document.querySelector('.remove-dialog');
 assert.match(dialog.textContent,/BC99 — CONSUMO · 1 OP(?!s)/);assert.match(dialog.textContent,/status das OPs/);
 assert.equal(deleted.length,0,'Abrir a confirmação não apaga');
 const confirm=[...dialog.querySelectorAll('button')].find(button=>button.textContent.includes('Apagar definitivamente'));
 await act(async()=>{confirm.click();});
 await ui.settle(()=>deleted.length===1&&!document.querySelector('.remove-dialog'));
 assert.equal(deleted[0],'?id='+encodeURIComponent(wrongBom.id)+'&version=gen-1');
 await ui.settle(()=>new URL(location.href).searchParams.get('bom')===bom.id);
 await ui.settle(()=>ui.container.querySelector('.bom-remove')?.disabled===true);
 assert.match(ui.container.querySelector('.bom-remove').title,/pacote não pode ser apagada/);
 ui.assertHealthy();
});

test('perfil consulta não vê o botão de apagar BOM',async t=>{
 const ui=await mount(t,{url:'https://portal.test/?modulo=consumo&bom='+encodeURIComponent(wrongBom.id),respond:bomsApi({role:'viewer'})});
 await ui.settle(()=>ui.container.querySelector('.active-bom'));
 assert.equal(ui.container.querySelector('.bom-remove'),null);
 ui.assertHealthy();
});

test('link com BOM inexistente volta para uma BOM válida',async t=>{
 const ui=await mount(t,{url:'https://portal.test/?modulo=consumo&bom=consumo:apagada',respond:bomsApi({boms:[bom]})});
 await ui.settle(()=>new URL(location.href).searchParams.get('bom')===bom.id&&ui.container.querySelector('.active-bom'));
 assert.match(ui.container.querySelector('.active-bom').textContent,/BOM de teste/);
 ui.assertHealthy();
});

test('Marcar tudo como OK envia listas grandes em partes e ignora itens já atendidos',async t=>{
 const rows=Array.from({length:600},(_,i)=>({id:String(i),material:'M'+String(i).padStart(4,'0'),description:'Peça',unit:'PCS',classification:'C',required:1,consumption:{'19000002315':0,'19000002316':0}}));
 rows.push({id:'done',material:'001-A',description:'Já atendido',unit:'PCS',classification:'C',required:3,consumption:{}});
 const posts=[];let checks={},revision=0;
 const ui=await mount(t,{url:'https://portal.test/?modulo=consumo',respond(url,init){
  if(url.pathname==='/api/session')return Response.json({role:'admin'});
  if(url.pathname==='/api/data'&&url.searchParams.get('id')?.startsWith('consumo:'))return Response.json({...bom,rows});
  if(url.pathname==='/api/checks'){
   if(init?.method==='POST'){const body=JSON.parse(init.body);posts.push(body.keys.length);for(const key of body.keys)checks[key]=true;revision++;return Response.json({revision,count:Object.keys(checks).length});}
   return Response.json({role:'admin',revision,checks});
  }
  if(url.pathname==='/api/automatic'&&url.searchParams.get('id').startsWith('consumo:'))return gviz(['Material','Ordem','Quantidade','Tipo de movimento','Centro'],[
   ['001-A','19000002315',-3,261,'BR02'],['001-A','19000002316',-3,261,'BR02'],['11242550-00','19000002315',-15,261,'BR02'],['11242550-00','19000002316',-15,261,'BR02']]);
  return apiResponse(url);
 }});
 window.confirm=()=>true;
 await ui.click('button[aria-label="Atualizar dados"]');
 await ui.settle(()=>/Marcar tudo como OK \(1\.200\)/.test(ui.container.querySelector('.manual-bulk')?.textContent||''));
 await ui.click('.manual-bulk');
 await ui.settle(()=>posts.length===2&&/Tudo marcado como OK/.test(ui.container.querySelector('.manual-bulk').textContent));
 assert.deepEqual(posts,[1000,200],'Duas partes; os 2 itens já atendidos pela MB51 não são gravados');
 ui.assertHealthy();
});

test('administrador corrige nome e revisão da BOM sem reimportar',async t=>{
 const boms=[bom,{...wrongBom}];
 const ui=await mount(t,{url:'https://portal.test/?modulo=consumo&bom='+encodeURIComponent(wrongBom.id),respond:bomsApi({boms})});
 await ui.settle(()=>ui.container.querySelector('.bom-edit')&&!ui.container.querySelector('.bom-edit').disabled);
 await ui.click('.bom-edit');await ui.settle(()=>document.querySelector('[role="dialog"] input'));
 const [name,revision]=document.querySelectorAll('[role="dialog"] input');
 await act(async()=>{const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;set.call(name,'BC22X');name.dispatchEvent(new Event('input',{bubbles:true}));set.call(revision,'BOM 1339');revision.dispatchEvent(new Event('input',{bubbles:true}));});
 const save=[...document.querySelectorAll('[role="dialog"] button')].find(button=>button.textContent==='Salvar');
 await act(async()=>{save.click();});
 await ui.settle(()=>/BC22X · BOM 1339/.test(ui.container.querySelector('.active-bom')?.textContent||''));
 assert.match(ui.container.querySelector('[data-slot="select-value"]').textContent,/BC22X — BOM 1339 · 1 OP(?!s)/);
 assert.equal(ui.requests.filter(url=>url.startsWith('/api/data?id=')).length,1,'Renomear não recarrega as linhas');
 ui.assertHealthy();
});

test('cadastro de BOM no formato SAP (aba BOM SAP, sem OPs) mostra o erro na janela e salva com OPs coladas',async t=>{
 const x=require('xlsx');const wb=x.utils.book_new();
 x.utils.book_append_sheet(wb,x.utils.aoa_to_sheet([['MATERIAL','DESCRIÇÃO','QTD'],['15875589-00','BATERIA',2]]),'COMPARAÇÃO');
 x.utils.book_append_sheet(wb,x.utils.aoa_to_sheet([['Item lista técnica','Material','Texto breve material','Qtd.necessária','UMB','CLASSIFICAÇÃO'],['0010','15875589-00','BATERIA DE ENERGIA 3',2,'PCS','A'],['0020','001-A','Material de teste',3,'PCS','C']]),'BOM SAP');
 x.utils.book_append_sheet(wb,x.utils.aoa_to_sheet([['Material','UMB','Utilização livre'],['001-A','PCS',9]]),'MB52');
 const bytes=x.write(wb,{type:'buffer',bookType:'xlsx'});
 const saved=[];const boms=[bom];
 const ui=await mount(t,{url:'https://portal.test/?modulo=consumo',respond(url,init){
  if(url.pathname==='/api/session')return Response.json({role:'admin'});
  if(url.pathname==='/api/data'&&init?.method==='POST'){const body=JSON.parse(init.body);saved.push(body);const stored={...body,version:'g-new',updatedAt:'2026-09-30T17:00:00Z'};boms.push(stored);return Response.json(stored);}
  if(url.pathname==='/api/data'&&!url.searchParams.get('id'))return Response.json(boms.map(item=>({...item,rows:undefined})));
  if(url.pathname==='/api/data'&&url.searchParams.get('id')!==bom.id){const found=boms.find(item=>item.id===url.searchParams.get('id'));if(found)return Response.json(found);}
  return apiResponse(url);
 }});
 await ui.settle(()=>ui.container.querySelector('.bom-add .text-button'));
 const input=ui.container.querySelector('input[type=file]');
 const file=new window.File([bytes],'BOM BC22S02_1363.xlsx',{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
 if(!file.arrayBuffer)file.arrayBuffer=async()=>bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);
 await ui.click('.bom-add .text-button','Cadastrar nova BOM');
 Object.defineProperty(input,'files',{value:[file],configurable:true});
 await act(async()=>{input.dispatchEvent(new window.Event('change',{bubbles:true}));});
 await ui.settle(()=>document.querySelector('.import-dialog [data-slot="select-value"]'));
 assert.match(document.querySelector('.import-dialog [data-slot="select-value"]').textContent,/^BOM SAP · 2 materiais · sem OPs/,'Abre na aba da BOM, não na primeira');
 const dialogInputs=[...document.querySelectorAll('.import-dialog input')];assert.equal(dialogInputs[0].value,'BC22S02');assert.equal(dialogInputs[1].value,'BOM 1363');
 await act(async()=>{await new Promise(resolve=>setTimeout(resolve,450));});
 await ui.settle(()=>document.querySelector('.import-error'));
 assert.match(document.querySelector('.import-error').textContent,/não tem números de OP no cabeçalho/);
 const confirm=()=>[...document.querySelectorAll('.import-dialog button')].find(button=>button.textContent==='Confirmar importação');
 assert.equal(confirm().disabled,true);
 const textarea=document.querySelector('.import-ops textarea');
 await act(async()=>{Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(textarea,'19000005001\n19000005002');textarea.dispatchEvent(new window.Event('input',{bubbles:true}));});
 await act(async()=>{await new Promise(resolve=>setTimeout(resolve,450));});
 await ui.settle(()=>!confirm().disabled);
 assert.equal(document.querySelector('.import-error'),null);
 assert.match(document.querySelector('.import-preview').textContent,/2 linhas prontas.*2 OPs identificadas.*BC22S02 — BOM 1363/);
 await act(async()=>{confirm().click();});
 await ui.settle(()=>saved.length===1&&!document.querySelector('.import-dialog'));
 assert.deepEqual(saved[0].ops,['19000005001','19000005002']);assert.equal(saved[0].name,'BC22S02');assert.equal(saved[0].revision,'BOM 1363');
 assert.equal(saved[0].rows.length,2);assert.equal(saved[0].rows[0].consumption['19000005001'],null);
 assert.ok(!('mb51Evidence' in saved[0])&&!('scrap' in saved[0]),'Nada da BOM aberta vai junto');
 await ui.settle(()=>new URL(location.href).searchParams.get('bom')===saved[0].id);
 ui.assertHealthy();
});

test('Tudo OK deixa todas as OPs verdes e todos os itens OK com uma gravação; Reabrir desfaz',async t=>{
 let statuses={},revision=0;const posts=[],checkPosts=[];
 const ui=await mount(t,{url:'https://portal.test/?modulo=consumo',respond(url,init){
  if(url.pathname==='/api/session')return Response.json({role:'admin'});
  if(url.pathname==='/api/op-status'){
   if(init?.method==='POST'){const body=JSON.parse(init.body);posts.push(body);for(const op of body.ops||[body.op])statuses={...statuses,[op]:{status:body.status,updatedAt:'2026-09-30'}};revision++;}
   return Response.json({statuses,revision,canEdit:true});
  }
  if(url.pathname==='/api/checks'){if(init?.method==='POST'){checkPosts.push(JSON.parse(init.body));return Response.json({revision:2});}return Response.json({role:'admin',revision:1,checks:{}});}
  return apiResponse(url);
 }});
 window.confirm=()=>true;
 await ui.click('button[aria-label="Atualizar dados"]');
 await ui.settle(()=>ui.container.querySelector('.shortages .all-ok'));
 assert.match(ui.container.querySelector('.shortages .all-ok').textContent,/Tudo OK \(2 OPs\)/);
 const tab=[...ui.container.querySelectorAll('.shortage-view-tabs button')].find(button=>/Diferenças BOM × SAP/.test(button.textContent));
 await act(async()=>{tab.click();});
 await ui.settle(()=>ui.container.querySelectorAll('.shortage-scroll tbody tr').length===3);
 assert.match(ui.container.querySelector('.manual-bulk').textContent,/Marcar tudo como OK \(3\)/);
 await ui.click('.shortages .all-ok');
 await ui.settle(()=>posts.length===1&&/Reabrir todas as OPs \(2\)/.test(ui.container.querySelector('.shortages .all-ok').textContent));
 assert.deepEqual(posts[0],{id:bom.id,ops:['19000002315','19000002316'],status:'complete'},'Uma gravação para todas as OPs');
 const rows=[...ui.container.querySelectorAll('.shortage-scroll tbody tr')];
 assert.equal(rows.length,3);
 assert.ok(rows.every(row=>row.classList.contains('op-complete-row')),'Todas as linhas verdes');
 assert.ok(rows.every(row=>/OK · OP concluída/.test(row.querySelector('.manual-toggle').textContent)&&row.querySelector('.manual-toggle').getAttribute('aria-pressed')==='true'),'Todos os itens aparecem como OK');
 assert.ok([...ui.container.querySelectorAll('.op-rail .op-card')].every(card=>card.classList.contains('status-complete')),'Todas as OPs verdes');
 assert.equal(checkPosts.length,0,'Nenhuma gravação por material');
 assert.match(ui.container.querySelector('.manual-bulk').textContent,/\(0\)/,'Nada mais para marcar item a item');
 await ui.click('.shortages .all-ok');
 await ui.settle(()=>posts.length===2&&/Tudo OK/.test(ui.container.querySelector('.shortages .all-ok').textContent));
 assert.equal(posts[1].status,'not_started');
 assert.ok([...ui.container.querySelectorAll('.shortage-scroll tbody tr')].every(row=>!row.classList.contains('op-complete-row')));
 ui.assertHealthy();
});

test('perfil consulta não vê o botão Tudo OK',async t=>{
 const ui=await mount(t,{url:'https://portal.test/?modulo=grafico'});
 await ui.settle(()=>ui.container.querySelector('.op-progress-toolbar'));
 assert.equal(ui.container.querySelector('.all-ok'),null);
 ui.assertHealthy();
});

// MB51-63/64 · a aba SCRAP FORM não lê a planilha (a aba BAIXA CC fica só no Sheets): Scrap Forms | Baixa em CC.
test('SCRAP FORM abre direto nos formulários e nunca lê a aba BAIXA CC',async t=>{
 const ui=await mount(t,{url:'https://portal.test/?modulo=baixas',respond:url=>url.pathname==='/api/scrap-forms'?Response.json({forms:[],canEdit:false,canDelete:false,role:'viewer'}):apiResponse(url)});
 await ui.settle(()=>ui.container.querySelector('.scrap-forms .empty'));
 assert.equal(ui.container.querySelector('h1').textContent,'SCRAP FORM');
 assert.equal(ui.container.querySelector('.main-nav [aria-selected="true"]').textContent,'SCRAP FORM');
 assert.equal(ui.container.querySelector('.scrap-tabs'),null,'Sem a visão da planilha');
 const tabs=[...ui.container.querySelectorAll('.scrap-doc-tabs [role="tab"]')];
 assert.deepEqual(tabs.map(tab=>tab.querySelector('b').textContent),['Scrap Forms','Baixa em CC · FO.FI.C.007']);
 assert.equal(tabs[0].getAttribute('aria-selected'),'true');
 assert.ok(ui.requests.includes('/api/scrap-forms?doc=cc'),'Lista das baixas lida do banco');
 await ui.click('.scrap-doc-tabs [role="tab"]','Baixa em CC · FO.FI.C.007');
 await ui.settle(()=>/Nenhum FO\.FI\.C\.007 ainda/.test(ui.container.querySelector('.scrap-forms .empty')?.textContent||''));
 assert.equal(ui.requests.some(url=>url.startsWith('/api/automatic')),false,'Nenhuma leitura do Google Sheets');
 ui.assertHealthy();
});

// MB51-62 · SCRAP FORM: preencher, gerar o PDF com campos de assinatura, anexar o assinado e conferir.
const scrapFixture=name=>new Uint8Array(fs.readFileSync(path.join(__dirname,'fixtures','scrap',name)));
const sha256=bytes=>require('node:crypto').createHash('sha256').update(bytes).digest('hex');
const scrapItem={date:'2026-09-24',material:'11272431-00',quantity:1,name:'UNID DE CONTROLE ELETR EBS 5S',defect:'Componente queimado durante o debug.',cause:'F',vin:'1076',op:'19000002673',unitPrice:1054.87,classification:'B'};
const scrapApprovers={production:'Pessoa Produção',quality:'Pessoa Qualidade',logistics:'Pessoa Logística',finance:'Pessoa Financeiro'};
function scrapServer({role='admin',forms=[],cc=[]}={}){
 const state={forms:structuredClone(forms),cc:structuredClone(cc),posts:[]};
 const strip=({files,...form})=>({...form,files:files.map(({bytes,...meta})=>meta)});
 const respond=async(url,init)=>{
  if(url.pathname==='/api/scrap-forms'){
   if(url.searchParams.has('lookup'))return Response.json({materials:{'11272431-00':{description:'UNID DE CONTROLE ELETR EBS 5S',unit:'PCS',boms:[{bom:'BC22X — 1268',classification:'B',description:'UNID DE CONTROLE ELETR EBS 5S'}]}}});
   if(url.searchParams.has('file')){
    const form=[...state.forms,...state.cc].find(entry=>entry.id===url.searchParams.get('file'));
    const file=form?.files.find(entry=>entry.version===Number(url.searchParams.get('version')));
    return file?new Response(file.bytes,{headers:{'Content-Type':'application/pdf'}}):Response.json({error:'Arquivo não encontrado.'},{status:404});
   }
   if(!init?.method)return Response.json({forms:(url.searchParams.get('doc')==='cc'?state.cc:state.forms).map(strip),canEdit:role!=='viewer',canDelete:role==='admin',role});
   const body=JSON.parse(init.body);state.posts.push(body);
   const isCc=body.doc==='cc',list=isCc?state.cc:state.forms;
   const now=new Date('2026-09-24T12:00:00Z').toISOString();
   if(body.action==='create'||body.action==='import'){
    const seq=String(list.length+1).padStart(4,'0'),id=(isCc?'7a2c1b4d':'5d1f6a3e')+'-0000-4000-8000-00000000'+seq;
    const form={id,number:(isCc?'CC-2026-':'SCRAP-2026-')+seq,status:'draft',data:body.data,signatures:[],fileVersion:0,files:[],revision:1,createdAt:now,updatedAt:now,createdBy:role,signedAt:null,sentAt:null};
    if(body.action==='import'){
     const bytes=new Uint8Array(Buffer.from(body.pdf,'base64'));
     form.data={...body.data,source:body.name};form.signatures=body.signatures;form.fileVersion=1;
     form.files=[{version:1,kind:'signed',name:body.name,size:bytes.length,sha256:sha256(bytes),createdAt:now,createdBy:role,bytes}];
     form.status=body.signatures.filter(entry=>entry.slot&&(entry.check==='valid'||entry.check==='imported')).length>=4?'signed':'signing';
    }
    list.unshift(form);return Response.json({form:strip(form)});
   }
   const form=list.find(entry=>entry.id===body.id);
   if(!form)return Response.json({error:'Formulário não encontrado.'},{status:404});
   if(body.revision!==undefined&&body.revision!==form.revision)return Response.json({error:'Outra pessoa alterou este formulário.'},{status:409});
   if(body.action==='update'){form.data=body.data;form.revision++;}
   if(body.action==='upload'){
    const bytes=new Uint8Array(Buffer.from(body.pdf,'base64'));
    const version=form.files.length+1;
    form.files.push({version,kind:body.kind,name:body.name,size:bytes.length,sha256:sha256(bytes),createdAt:now,createdBy:role,bytes});
    form.fileVersion=version;form.revision++;
    if(body.kind==='generated'){form.status='signing';form.signatures=[];}
    else{form.signatures=body.signatures;form.status=body.signatures.filter(entry=>entry.slot&&(entry.check==='valid'||entry.check==='imported')).length>=4?'signed':'signing';form.signedAt=form.status==='signed'?now:null;}
   }
   if(body.action==='posting'){const {action,id,revision,doc,...rest}=body;form.data={...form.data,...rest};form.revision++;}
   if(body.action==='sent')form.sentAt=now;
   return Response.json({form:strip(form)});
  }
  if(url.pathname==='/api/session')return Response.json({role});
  if(url.pathname==='/api/data'&&!url.searchParams.get('id'))return Response.json([{...bom,rows:undefined,ops:['19000002673','19000002674']}]);
  return apiResponse(url);
 };
 return {state,respond};
}
const wait=ms=>act(async()=>{await new Promise(resolve=>setTimeout(resolve,ms));});
async function typeInto(element,value){
 const proto=element.tagName==='SELECT'?window.HTMLSelectElement.prototype:window.HTMLInputElement.prototype;
 await act(async()=>{Object.getOwnPropertyDescriptor(proto,'value').set.call(element,value);element.dispatchEvent(new window.Event(element.tagName==='SELECT'?'change':'input',{bubbles:true}));});
}
async function pressIn(ui,selector,label){
 const button=[...document.querySelectorAll(selector)].find(node=>label?node.textContent.trim()===label:true);
 assert.ok(button,`Botão ausente: ${selector} ${label||''}`);
 await act(async()=>{button.dispatchEvent(new window.MouseEvent('click',{bubbles:true,button:0}));});
 await ui.settle();
}
/** Fecha o diálogo antes do fim do teste: o Radix agenda eventos de foco ao desmontar. */
async function closeDialog(ui){
 await pressIn(ui,'.scrap-dialog .scrap-footer button','Fechar');
 await ui.settle(()=>!document.querySelector('.scrap-dialog'));
 await wait(20);
}
async function attach(input,bytes,name){
 const {File}=require('node:buffer');
 Object.defineProperty(input,'files',{configurable:true,value:[new File([bytes],name,{type:'application/pdf'})]});
 await act(async()=>{input.dispatchEvent(new window.Event('change',{bubbles:true}));});
}

test('SCRAP FORM: preenche pela BOM, aponta o que falta e gera o PDF com um campo de assinatura por quadro',async t=>{
 const server=scrapServer();
 const ui=await mount(t,{url:'https://portal.test/?modulo=baixas',respond:server.respond});
 await ui.settle(()=>ui.container.querySelector('.scrap-forms .empty'));
 assert.equal(ui.container.querySelector('h1').textContent,'SCRAP FORM');
 assert.match(ui.container.querySelector('.scrap-forms .empty').textContent,/Nenhum Scrap Form ainda/);
 await ui.click('.scrap-forms button','Novo Scrap Form');
 await ui.settle(()=>document.querySelector('.scrap-dialog .scrap-item'));
 const field=name=>document.querySelector(`.scrap-dialog .scrap-item .${name} input, .scrap-dialog .scrap-item .${name} select`);
 await typeInto(field('f-pn'),'11272431-00');
 await wait(650);
 await ui.settle(()=>field('f-name').value==='UNID DE CONTROLE ELETR EBS 5S');
 assert.equal(field('f-class').value,'B','Classe vem da BOM');
 assert.match(document.querySelector('.scrap-hints').textContent,/BC22X — 1268: B/);
 // Sem defeito/causa/VIN/OP/preço: salva o rascunho e mostra o que falta.
 await pressIn(ui,'.scrap-dialog button','Gerar PDF para assinatura');
 await ui.settle(()=>document.querySelector('.scrap-problems'));
 assert.match(document.querySelector('.scrap-problems').textContent,/Item 1: informe descrição do defeito, causa \(A–H\), N° VIN, ordem de produção, preço unitário/);
 assert.ok(document.querySelector('.scrap-dialog .f-cause.missing'),'Campo pendente destacado');
 assert.equal(server.state.posts[0].action,'create');assert.equal(server.state.posts[0].data.items[0].classification,'B');
 assert.equal(server.state.forms[0].status,'draft');
 await typeInto(field('f-defect'),'Componente queimado durante o debug.');
 await typeInto(field('f-cause'),'F');
 await typeInto(field('f-vin'),'1076');
 await typeInto(field('f-op'),'19000002673');
 await typeInto(field('f-price'),'1.054,87');
 assert.match(document.querySelector('.scrap-item header').textContent,/R\$\s1\.054,87/);
 await pressIn(ui,'.scrap-dialog button','Gerar PDF para assinatura');
 await ui.settle(()=>/Aguardando assinatura/.test(document.querySelector('.scrap-dialog [data-slot="dialog-title"], .scrap-dialog h2')?.textContent||''));
 const update=server.state.posts.find(post=>post.action==='update');
 assert.equal(update.data.items[0].unitPrice,1054.87);assert.equal(update.data.items[0].cause,'F');
 const upload=server.state.posts.find(post=>post.action==='upload');
 assert.equal(upload.kind,'generated');
 const pdf=Buffer.from(upload.pdf,'base64').toString('latin1');
 assert.ok(pdf.startsWith('%PDF-'));
 for(const name of ['(SCRAP-2026-0001)','(Assinatura_Producao)','(Assinatura_Qualidade)','(Assinatura_Logistica)','(Assinatura_Financeiro)'])assert.ok(pdf.includes(name),name);
 assert.match(upload.name,/^Scrap Form SCRAP-2026-0001 \d{2}\.\d{2}\.\d{4} - para assinatura\.pdf$/);
 assert.match(document.querySelector('.scrap-message').textContent,/PDF SCRAP-2026-0001 gerado/);
 assert.equal(document.querySelectorAll('.scrap-slot.missing').length,4);
 assert.match(document.querySelector('.scrap-send').textContent,/Enviar para assinatura/);
 assert.ok(document.querySelector('.scrap-items-table'),'Emitido: itens só para leitura');
 await closeDialog(ui);
 ui.assertHealthy();
});

test('SCRAP FORM: anexar o PDF devolvido confere as assinaturas, guarda a versão e libera o envio do PDF final',async t=>{
 const generated=scrapFixture('gerado.pdf');
 const form={id:'5d1f6a3e-0000-4000-8000-000000000001',number:'SCRAP-2026-0001',status:'signing',data:{formDate:'2026-09-24',items:[scrapItem],approvers:scrapApprovers,costCenter:'',sapDocument:'',notes:''},signatures:[],fileVersion:1,
  files:[{version:1,kind:'generated',name:'Scrap Form SCRAP-2026-0001.pdf',size:generated.length,sha256:sha256(generated),createdAt:'2026-09-24T12:00:00Z',createdBy:'admin',bytes:generated}],revision:2,createdAt:'2026-09-24T12:00:00Z',updatedAt:'2026-09-24T12:00:00Z',createdBy:'admin',signedAt:null,sentAt:null};
 const server=scrapServer({forms:[form]});
 const ui=await mount(t,{url:'https://portal.test/?modulo=baixas&scrap='+form.id,respond:server.respond});
 await ui.settle(()=>document.querySelector('.scrap-dialog .scrap-slots'));
 assert.match(ui.container.querySelector('.scrap-row').textContent,/SCRAP-2026-0001.*Falta Produção, Qualidade, Logística, Financeiro/);
 // Qualquer PDF entra: até o próprio PDF emitido, sem assinatura, pode ser salvo (sem erros na tela).
 const input=document.querySelector('.scrap-dialog input[aria-label="PDF assinado"]');
 await attach(input,generated,'mesmo.pdf');
 await ui.settle(()=>document.querySelector('.scrap-review'));
 assert.match(document.querySelector('.scrap-review').textContent,/0 assinatura\(s\).*ainda falta/);
 assert.equal(document.querySelector('.scrap-review .scrap-review-block, .scrap-review .scrap-review-warn'),null,'Nenhum erro nem aviso');
 assert.equal([...document.querySelectorAll('.scrap-review button')].find(button=>/Salvar esta versão/.test(button.textContent)).disabled,false);
 await attach(input,scrapFixture('assinado-completo.pdf'),'assinado.pdf');
 await ui.settle(()=>/4 assinatura/.test(document.querySelector('.scrap-review')?.textContent||''));
 const review=document.querySelector('.scrap-review').textContent;
 assert.match(review,/Itens, valores e nomes são os mesmos do PDF emitido pelo portal/);
 assert.match(review,/todos os quadros obrigatórios ficam assinados/);
 assert.match(review,/Pessoa Logística · Logística/);
 await pressIn(ui,'.scrap-review button','Salvar esta versão');
 await ui.settle(()=>document.querySelector('.scrap-send.signed'));
 const upload=server.state.posts.find(post=>post.action==='upload');
 assert.equal(upload.kind,'signed');assert.equal(upload.signatures.length,4);assert.ok(upload.signatures.every(entry=>entry.check==='valid'));
 assert.equal(document.querySelectorAll('.scrap-slot.signed').length,4);
 assert.match(document.querySelector('.scrap-message').textContent,/Todos os quadros assinados/);
 assert.match(document.querySelector('.scrap-send-preview').textContent,/Scrap Form nº SCRAP-2026-0001 assinado \(24\/09\/2026\)/);
 assert.match(document.querySelector('.scrap-email-preview').getAttribute('srcdoc'),/Encaminho, em anexo, o <b>Formulário de Scrap A-B nº SCRAP-2026-0001<\/b>, de <b>24\/09\/2026<\/b>, devidamente assinado por todos os responsáveis/);
 assert.match(ui.container.querySelector('.scrap-row').textContent,/Assinado.*Ainda não enviado/);
 await closeDialog(ui);
 ui.assertHealthy();
});

test('Conferir um PDF mostra assinatura inválida de arquivo regravado; perfil Consulta não edita',async t=>{
 const form={id:'5d1f6a3e-0000-4000-8000-000000000002',number:'SCRAP-2026-0002',status:'signing',data:{formDate:'2026-09-24',items:[scrapItem],approvers:scrapApprovers,costCenter:'',sapDocument:'',notes:''},signatures:[],fileVersion:1,files:[],revision:2,createdAt:'2026-09-24T12:00:00Z',updatedAt:'2026-09-24T12:00:00Z',createdBy:'admin',signedAt:null,sentAt:null};
 const server=scrapServer({role:'viewer',forms:[form]});
 const ui=await mount(t,{url:'https://portal.test/?modulo=baixas',respond:server.respond});
 await ui.settle(()=>ui.container.querySelector('.scrap-row'));
 assert.equal([...ui.container.querySelectorAll('button')].some(button=>/Novo Scrap Form/.test(button.textContent)),false);
 await ui.click('.scrap-forms button','Conferir um PDF');
 await ui.settle(()=>document.querySelector('.scrap-check-dialog input[type="file"]'));
 await attach(document.querySelector('.scrap-check-dialog input[type="file"]'),scrapFixture('alterado.pdf'),'antigo.pdf');
 await ui.settle(()=>document.querySelector('.scrap-check-dialog .scrap-review'));
 assert.match(document.querySelector('.scrap-check-dialog .scrap-review').textContent,/4 assinatura\(s\) inválida\(s\)/);
 await pressIn(ui,'.scrap-check-dialog button','Fechar');
 await wait(20);
 await ui.click('.scrap-row');
 await ui.settle(()=>document.querySelector('.scrap-dialog .scrap-slots'));
 assert.equal(document.querySelector('.scrap-dialog input[aria-label="PDF assinado"]'),null,'Consulta não anexa');
 assert.equal([...document.querySelectorAll('.scrap-dialog button')].some(button=>/Reabrir|Apagar|Salvar rascunho/.test(button.textContent)),false);
 assert.equal(server.state.posts.length,0);
 await closeDialog(ui);
 ui.assertHealthy();
});

// MB51-64 · Baixa em CC (FO.FI.C.007): puxa os itens dos Scrap Forms assinados, gera o PDF com 4 quadros obrigatórios e confere as assinaturas.
const ccFixture=name=>new Uint8Array(fs.readFileSync(path.join(__dirname,'fixtures','cc',name)));
const ccApprovers={requester:'Pessoa Solicitante',manager:'Pessoa Gestor',scm:'Pessoa SCM',finance:'Pessoa Financeiro'};
const ccData={period:'2026-09',items:[{company:'BR00',plant:'BR02',wh:'7000',material:'11272431-00',description:'UNID DE CONTROLE ELETR EBS 5S',quantity:-1,unitCost:1054.87,costCenter:'BR000411',costCenterDescription:'Operational - Chassis'}],mainReason:'Scrapped materials approved in Scrap Form SCRAP-2026-0001. Parts damaged or defective in production, not repairable.',reason:'Scrap',action:'Write off the scrapped quantities from warehouse 7000 through cost center BR000411 - Operational - Chassis.',approvers:ccApprovers,scrapForms:['SCRAP-2026-0001'],sapDocument:'',notes:''};
const signedScrap={id:'5d1f6a3e-0000-4000-8000-000000000001',number:'SCRAP-2026-0001',status:'signed',data:{formDate:'2026-09-24',items:[scrapItem],approvers:scrapApprovers,costCenter:'',sapDocument:'',pr:'',prDate:'',po:'',notes:''},signatures:[],fileVersion:2,files:[],revision:3,createdAt:'2026-09-24T12:00:00Z',updatedAt:'2026-09-25T12:00:00Z',createdBy:'admin',signedAt:'2026-09-25T12:00:00Z',sentAt:null};

test('BAIXA EM CC: puxa os itens do Scrap Form assinado e gera o FO.FI.C.007 com os quatro quadros de assinatura',async t=>{
 const server=scrapServer({forms:[signedScrap]});
 const ui=await mount(t,{url:'https://portal.test/?modulo=baixas&doc=cc',respond:server.respond});
 await ui.settle(()=>/Criar baixa com eles/.test(ui.container.querySelector('.cc-ready')?.textContent||''));
 assert.equal(ui.container.querySelector('.scrap-doc-tabs [aria-selected="true"] b').textContent,'Baixa em CC · FO.FI.C.007');
 assert.equal(ui.container.querySelector('.cc-ready strong').textContent,'1');
 await ui.click('.scrap-forms button','Nova baixa em CC');
 await ui.settle(()=>document.querySelector('.cc-dialog .cc-pick-row'));
 assert.match(document.querySelector('.cc-pick-row').textContent,/SCRAP-2026-0001.*24\/09\/2026.*R\$\s1\.054,87/);
 await pressIn(ui,'.cc-pick-row input');
 await pressIn(ui,'.cc-dialog button','Incluir itens dos selecionados (1)');
 await ui.settle(()=>document.querySelector('.cc-dialog .cc-link'));
 const field=name=>document.querySelector(`.cc-dialog .scrap-item .${name} input`);
 assert.equal(field('f-pn').value,'11272431-00');
 assert.equal(field('f-name').value,'UNID DE CONTROLE ELETR EBS 5S');
 assert.equal(field('f-qty').value,'-1','Saída do estoque = quantidade negativa');
 assert.equal(field('f-price').value,'1.054,87');
 assert.equal(field('f-cc').value,'BR000411');
 assert.equal(field('f-ccname').value,'Operational - Chassis');
 assert.match(document.querySelector('.cc-dialog .scrap-item header').textContent,/-R\$\s1\.054,87/);
 assert.match(document.querySelector('.cc-remarks .cc-main textarea').value,/Scrap Form SCRAP-2026-0001/);
 assert.equal(document.querySelector('.cc-dialog .cc-pick-row'),null,'O formulário incluído sai da lista');
 await pressIn(ui,'.cc-dialog button','Gerar PDF para assinatura');
 await ui.settle(()=>/CC-2026-0001 · Aguardando assinatura/.test(document.querySelector('.cc-dialog h2')?.textContent||''));
 const create=server.state.posts.find(post=>post.action==='create');
 assert.equal(create.doc,'cc');assert.deepEqual(create.data.scrapForms,['SCRAP-2026-0001']);assert.equal(create.data.items[0].quantity,-1);
 const upload=server.state.posts.find(post=>post.action==='upload');
 assert.equal(upload.doc,'cc');assert.equal(upload.kind,'generated');
 const pdf=Buffer.from(upload.pdf,'base64').toString('latin1');
 for(const name of ['(CC-2026-0001)','(Assinatura_Solicitante)','(Assinatura_Gestor)','(Assinatura_SCM)','(Assinatura_Financeiro)'])assert.ok(pdf.includes(name),name);
 assert.match(upload.name,/^FO\.FI\.C\.007 CC-2026-0001 \S+-\d{4} - para assinatura\.pdf$/);
 assert.equal(document.querySelectorAll('.cc-dialog .scrap-slot.missing').length,4,'Os quatro quadros são obrigatórios');
 assert.ok(document.querySelector('.cc-dialog .cc-items-table'),'Emitido: itens só para leitura');
 assert.equal(server.state.posts.filter(post=>post.doc!=='cc').length,0,'Nada é gravado no Scrap Form');
 await closeDialog(ui);
 assert.match(ui.container.querySelector('.cc-row').textContent,/CC-2026-0001.*BR000411.*SCRAP-2026-0001.*Falta Solicitante, Gestor, SCM, Financeiro/);
 await pressIn(ui,'.scrap-doc-tabs [role="tab"]','Scrap Forms');
 await ui.settle(()=>ui.container.querySelector('.scrap-row .scrap-row-link'));
 assert.equal(ui.container.querySelector('.scrap-row .scrap-row-link').textContent,'Baixa CC-2026-0001');
 ui.assertHealthy();
});

test('BAIXA EM CC: o PDF devolvido só fica assinado com Solicitante, Gestor, SCM e Financeiro',async t=>{
 const generated=ccFixture('gerado.pdf');
 const form={id:'7a2c1b4d-0000-4000-8000-000000000001',number:'CC-2026-0001',status:'signing',data:ccData,signatures:[],fileVersion:1,
  files:[{version:1,kind:'generated',name:'FO.FI.C.007 CC-2026-0001 Setembro-2026 - para assinatura.pdf',size:generated.length,sha256:sha256(generated),createdAt:'2026-09-24T12:00:00Z',createdBy:'admin',bytes:generated}],revision:2,createdAt:'2026-09-24T12:00:00Z',updatedAt:'2026-09-24T12:00:00Z',createdBy:'admin',signedAt:null,sentAt:null};
 const server=scrapServer({forms:[signedScrap],cc:[form]});
 const ui=await mount(t,{url:'https://portal.test/?modulo=baixas&cc='+form.id,respond:server.respond});
 await ui.settle(()=>document.querySelector('.cc-dialog .scrap-slots'));
 assert.match(ui.container.querySelector('.cc-row').textContent,/CC-2026-0001.*Setembro\/2026.*Falta Solicitante, Gestor, SCM, Financeiro/);
 assert.equal(ui.container.querySelector('.cc-ready strong').textContent,'0','O Scrap Form já está nesta baixa');
 const input=document.querySelector('.cc-dialog input[aria-label="PDF assinado"]');
 await attach(input,ccFixture('assinado-parcial.pdf'),'parcial.pdf');
 await ui.settle(()=>/2 assinatura/.test(document.querySelector('.scrap-review')?.textContent||''));
 let review=document.querySelector('.scrap-review').textContent;
 assert.match(review,/Itens, valores e nomes são os mesmos do PDF emitido pelo portal/);
 assert.match(review,/ainda falta: Pessoa SCM \(SCM\), Pessoa Financeiro \(Financeiro\)/);
 assert.match(review,/Pessoa Gestor · Gestor/);
 await pressIn(ui,'.scrap-review button','Salvar esta versão');
 await ui.settle(()=>/Versão 2 guardada/.test(document.querySelector('.scrap-message')?.textContent||''));
 assert.equal(document.querySelectorAll('.cc-dialog .scrap-slot.signed').length,2);
 await attach(input,ccFixture('assinado-completo.pdf'),'completo.pdf');
 await ui.settle(()=>/4 assinatura/.test(document.querySelector('.scrap-review')?.textContent||''));
 review=document.querySelector('.scrap-review').textContent;
 assert.match(review,/todos os quadros obrigatórios ficam assinados/);
 assert.doesNotMatch(review,/cópia mais antiga/,'Mantém as assinaturas já guardadas');
 await pressIn(ui,'.scrap-review button','Salvar esta versão');
 await ui.settle(()=>document.querySelector('.cc-dialog .scrap-send.signed'));
 const uploads=server.state.posts.filter(post=>post.action==='upload');
 assert.equal(uploads.length,2);assert.ok(uploads.every(post=>post.doc==='cc'));
 assert.deepEqual(uploads[1].signatures.map(entry=>entry.slot),['requester','manager','scm','finance']);
 assert.equal(document.querySelectorAll('.cc-dialog .scrap-slot.signed').length,4);
 assert.match(document.querySelector('.scrap-send-preview').textContent,/FO\.FI\.C\.007 nº CC-2026-0001 assinado – Ajuste de inventário de Setembro\/2026/);
 // E-mail pronto: rascunho .eml com o texto formal e o PDF assinado anexado.
 const saved=[];t.mock.method(URL,'createObjectURL',blob=>{saved.push(blob);return 'blob:teste';});t.mock.method(URL,'revokeObjectURL',()=>{});
 const recipient=[...document.querySelectorAll('.cc-dialog .scrap-send label')].find(label=>/Para/.test(label.textContent)).querySelector('input');
 await typeInto(recipient,'financeiro@empresa.test');
 const signer=[...document.querySelectorAll('.cc-dialog .scrap-send label')].find(label=>/Assinar o e-mail como/.test(label.textContent)).querySelector('input');
 assert.equal(signer.value,'Pessoa Solicitante','Assina como o Solicitante');
 await pressIn(ui,'.cc-dialog .scrap-send button','E-mail pronto com PDF');
 await ui.settle(()=>saved.some(blob=>blob.type==='message/rfc822'));
 const eml=Buffer.from(await saved.find(blob=>blob.type==='message/rfc822').arrayBuffer()).toString('latin1');
 assert.match(eml,/^X-Unsent: 1\r\nTo: financeiro@empresa\.test\r\nSubject: =\?UTF-8\?B\?/);
 const parts=[...eml.matchAll(/Content-Type: (text\/plain|text\/html|application\/pdf)[^\r]*\r\n(?:[^\r]+\r\n)*\r\n([A-Za-z0-9+\/=\r\n]+?)\r\n(?:\r\n)?--/g)].map(match=>[match[1],Buffer.from(match[2].replace(/\r\n/g,''),'base64')]);
 const text=parts.find(([type])=>type==='text/plain')[1].toString('utf8'),html=parts.find(([type])=>type==='text/html')[1].toString('utf8');
 assert.match(text,/^Prezados, (bom dia|boa tarde|boa noite)\.\n\nEncaminho, em anexo, o formulário FO\.FI\.C\.007 – Inventory Adjustment nº CC-2026-0001/);
 assert.match(text,/Solicito, por gentileza, a efetivação do ajuste no SAP/);
 assert.match(text,/Atenciosamente,\nPessoa Solicitante$/);
 assert.match(html,/<b>FO\.FI\.C\.007 – Inventory Adjustment nº CC-2026-0001<\/b>/);
 assert.deepEqual(parts.find(([type])=>type==='application/pdf')[1],Buffer.from(ccFixture('assinado-completo.pdf')),'PDF assinado anexado');
 assert.match(eml,/filename="FO\.FI\.C\.007 CC-2026-0001 Setembro-2026 - ASSINADO\.pdf"/);
 assert.match(document.querySelector('.cc-dialog .scrap-send').textContent,/E-mail pronto baixado/);
 await ui.settle(()=>server.state.posts.some(post=>post.action==='sent'));
 const sap=[...document.querySelectorAll('.cc-dialog .cc-posting label')].find(label=>/Documento SAP/.test(label.textContent)).querySelector('input');
 await typeInto(sap,'4900012345');
 await pressIn(ui,'.cc-dialog .cc-posting button','Salvar');
 await ui.settle(()=>server.state.posts.some(post=>post.action==='posting'));
 const posting=server.state.posts.find(post=>post.action==='posting');
 assert.equal(posting.doc,'cc');assert.equal(posting.sapDocument,'4900012345');
 await ui.settle(()=>/Doc\. SAP 4900012345/.test(ui.container.querySelector('.cc-row').textContent));
 await closeDialog(ui);
 ui.assertHealthy();
});

// MB51-71 · Aba aberta antes de uma atualização: nunca gera PDF com o código antigo.
const draftCc={id:'7a2c1b4d-0000-4000-8000-000000000003',number:'CC-2026-0003',status:'draft',data:ccData,signatures:[],fileVersion:0,files:[],revision:1,createdAt:'2026-10-07T09:00:00Z',updatedAt:'2026-10-07T09:00:00Z',createdBy:'admin',signedAt:null,sentAt:null};
test('BAIXA EM CC: com versão nova publicada, Gerar PDF recarrega a página em vez de usar o código antigo',async t=>{
 const server=scrapServer({cc:[draftCc]});
 const ui=await mount(t,{url:'https://portal.test/?modulo=baixas&cc='+draftCc.id,respond:(url,init)=>url.pathname==='/api/version'?Response.json({version:'MB51-00'}):server.respond(url,init)});
 await ui.settle(()=>[...document.querySelectorAll('.cc-dialog button')].some(button=>/Gerar PDF para assinatura/.test(button.textContent)));
 await pressIn(ui,'.cc-dialog button','Gerar PDF para assinatura');
 await ui.settle(()=>/recarregando para gerar o PDF na versão nova/.test(document.querySelector('.cc-dialog .scrap-message')?.textContent||''));
 assert.equal(server.state.posts.filter(post=>post.action==='upload').length,0,'Nenhum PDF gerado pela versão antiga');
 // A faixa avisa quando a aba volta a ficar em foco.
 await act(async()=>{window.dispatchEvent(new window.Event('focus'));});
 await ui.settle(()=>document.querySelector('.update-banner'));
 assert.match(document.querySelector('.update-banner').textContent,/O portal foi atualizado.*Atualizar agora/);
 await closeDialog(ui);
});
test('BAIXA EM CC: depois de recarregar (gerar=1) o PDF é gerado sozinho, uma vez',async t=>{
 const server=scrapServer({cc:[draftCc]});
 const ui=await mount(t,{url:'https://portal.test/?modulo=baixas&cc='+draftCc.id+'&gerar=1',respond:server.respond});
 await ui.settle(()=>server.state.posts.some(post=>post.action==='upload'&&post.kind==='generated'));
 assert.equal(new URL(location.href).searchParams.get('gerar'),null,'O endereço perde o gerar=1');
 await ui.settle(()=>/CC-2026-0003 · Aguardando assinatura/.test(document.querySelector('.cc-dialog h2')?.textContent||''));
 assert.equal(server.state.posts.filter(post=>post.action==='upload').length,1);
 await closeDialog(ui);
 ui.assertHealthy();
});

// MB51-68 · Baixa em CC a partir de uma planilha (ex.: LOSS 7000.xlsx): todos os itens de uma vez, PDF com páginas de continuação.
function lossWorkbook(count){
 const x=require('xlsx');const book=x.utils.book_new();
 const rows=[['Material','Texto breve material','Centro','Depósito','UM básica','Utilização livre','Val.utiliz.livre','Comentários']];
 for(let i=1;i<=count;i++)rows.push([`2000${String(i).padStart(4,'0')}-00`,`PECA PERDIDA ${i}`,'BR02','7000','PC',i,i*10.5,'LOSS']);
 rows.push([null,null,null,null,null,count*(count+1)/2,null,null]);
 x.utils.book_append_sheet(book,x.utils.aoa_to_sheet(rows),'Sheet1');
 return x.write(book,{type:'buffer',bookType:'xlsx'});
}
async function attachSheet(input,bytes,name){
 const {File}=require('node:buffer');
 Object.defineProperty(input,'files',{configurable:true,value:[new File([bytes],name,{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'})]});
 await act(async()=>{input.dispatchEvent(new window.Event('change',{bubbles:true}));});
}
test('BAIXA EM CC: Importar Excel preenche todos os itens, aplica o centro de custo e gera o PDF com páginas de continuação',async t=>{
 const server=scrapServer();
 const ui=await mount(t,{url:'https://portal.test/?modulo=baixas&doc=cc',respond:server.respond});
 await ui.settle(()=>[...ui.container.querySelectorAll('.scrap-forms button')].some(button=>button.textContent.trim()==='Nova baixa em CC'));
 await ui.click('.scrap-forms button','Nova baixa em CC');
 await ui.settle(()=>document.querySelector('.cc-dialog input[aria-label="Planilha de itens da baixa"]'));
 assert.ok([...document.querySelectorAll('.cc-dialog button')].some(button=>button.textContent.trim()==='Importar Excel'));
 const input=document.querySelector('.cc-dialog input[aria-label="Planilha de itens da baixa"]');
 // Planilha sem a coluna Material: erro claro, nada muda.
 const x=require('xlsx');const wrong=x.utils.book_new();x.utils.book_append_sheet(wrong,x.utils.aoa_to_sheet([['Peça','Qtd'],['1',2]]),'A');
 await attachSheet(input,x.write(wrong,{type:'buffer',bookType:'xlsx'}),'errada.xlsx');
 await ui.settle(()=>/coluna Material/.test(document.querySelector('.cc-dialog .scrap-message.error')?.textContent||''));
 assert.equal(document.querySelectorAll('.cc-dialog .scrap-item').length,1);
 await attachSheet(input,lossWorkbook(45),'LOSS 7000.xlsx');
 await ui.settle(()=>/45 itens importados de "LOSS 7000\.xlsx"/.test(document.querySelector('.cc-dialog .scrap-message.ok')?.textContent||''));
 const message=document.querySelector('.cc-dialog .scrap-message.ok').textContent;
 assert.match(message,/1 linha\(s\) sem material ou quantidade ficaram de fora/,'Linha de total da planilha');
 assert.match(message,/O PDF vai ter 2 páginas, com as assinaturas no fim/);
 assert.equal(document.querySelector('.cc-dialog .scrap-item'),null,'Lista longa vira tabela compacta (o item vazio sai)');
 const rows=()=>[...document.querySelectorAll('.cc-dialog .cc-edit-table tbody tr')];
 assert.equal(rows().length,45);
 const cell=(row,label)=>rows()[row].querySelector(`input[aria-label="${label} do item ${row+1}"]`).value;
 assert.equal(cell(0,'Material'),'20000001-00');
 assert.equal(cell(0,'Quantidade'),'-1','Estoque livre vira saída');
 assert.equal(cell(0,'Custo unitário'),'10,50');
 assert.equal(cell(24,'Quantidade'),'-25');
 assert.equal(cell(24,'Centro de custo'),'BR000411');
 assert.match(document.querySelector('.cc-dialog [aria-label="Itens da baixa"] .scrap-section-head').textContent,/Itens \(45\).*-R\$\s10\.867,50/);
 assert.equal(document.querySelector('.cc-remarks input').value,'LOSS');
 assert.equal(document.querySelector('.cc-remarks .cc-main textarea').value,'Materials listed as LOSS in warehouse 7000.');
 // Centro de custo de todos de uma vez (a Action acompanha).
 const bulk=[...document.querySelectorAll('.cc-dialog .cc-bulk input')];
 await typeInto(bulk[0],'BR000999');await typeInto(bulk[1],'Perdas de inventario');
 await pressIn(ui,'.cc-dialog .cc-bulk button','Aplicar aos 45 itens');
 assert.equal(cell(13,'Centro de custo'),'BR000999');
 assert.equal(cell(13,'Descrição do centro de custo'),'Perdas de inventario');
 assert.match(document.querySelector('.cc-remarks .cc-action textarea').value,/through cost center BR000999 - Perdas de inventario\./);
 // Tirar uma linha e editar outra direto na tabela.
 await pressIn(ui,'.cc-dialog .cc-edit-table button[aria-label="Remover item 45"]');
 assert.equal(rows().length,44);
 await typeInto(rows()[0].querySelector('input[aria-label="Quantidade do item 1"]'),'-2');
 await pressIn(ui,'.cc-dialog button','Gerar PDF para assinatura');
 await ui.settle(()=>/CC-2026-0001 · Aguardando assinatura/.test(document.querySelector('.cc-dialog h2')?.textContent||''));
 const create=server.state.posts.find(post=>post.action==='create');
 assert.equal(create.data.items.length,44);
 assert.equal(create.data.items[0].quantity,-2);
 assert.ok(create.data.items.every(item=>item.costCenter==='BR000999'&&item.quantity<0));
 const upload=server.state.posts.find(post=>post.action==='upload');
 const {PDFDocument}=require('pdf-lib');
 const doc=await PDFDocument.load(Buffer.from(upload.pdf,'base64'));
 assert.equal(doc.getPageCount(),2,'40 itens na 1ª página, 4 na 2ª com as assinaturas');
 assert.deepEqual(doc.getPages().map(page=>page.node.Annots()?.size()??0),[0,4],'Assinaturas embaixo do último item');
 assert.ok(document.querySelector('.cc-dialog .cc-items-table'),'Emitido: tabela só para leitura');
 assert.equal(document.querySelectorAll('.cc-dialog .cc-items-table tbody tr').length,44);
 await closeDialog(ui);
 ui.assertHealthy();
});

test('BAIXA EM CC: Baixa pelo Excel na lista já abre a baixa preenchida, pronta para gerar o PDF',async t=>{
 const server=scrapServer();
 const ui=await mount(t,{url:'https://portal.test/?modulo=baixas&doc=cc',respond:server.respond});
 await ui.settle(()=>[...ui.container.querySelectorAll('.scrap-forms button')].some(button=>button.textContent.trim()==='Baixa pelo Excel'));
 assert.equal(document.querySelector('.cc-dialog'),null);
 await attachSheet(ui.container.querySelector('input[aria-label="Planilha para nova baixa"]'),lossWorkbook(8),'LOSS 7000.xlsx');
 await ui.settle(()=>/8 itens importados de "LOSS 7000\.xlsx"/.test(document.querySelector('.cc-dialog .scrap-message.ok')?.textContent||''));
 assert.match(document.querySelector('.cc-dialog .scrap-message.ok').textContent,/clique em Gerar PDF para assinatura/);
 assert.equal(document.querySelectorAll('.cc-dialog .scrap-item').length,8,'Lista curta: um cartão por item');
 assert.equal(document.querySelector('.cc-dialog .scrap-item .f-pn input').value,'20000001-00');
 assert.equal(document.querySelector('.cc-remarks input').value,'LOSS');
 await pressIn(ui,'.cc-dialog button','Gerar PDF para assinatura');
 await ui.settle(()=>/CC-2026-0001 · Aguardando assinatura/.test(document.querySelector('.cc-dialog h2')?.textContent||''));
 const create=server.state.posts.find(post=>post.action==='create');
 assert.equal(create.data.items.length,8);assert.equal(create.data.reason,'LOSS');
 await closeDialog(ui);
 ui.assertHealthy();
});

// MB51-70 · Anexar aceita qualquer PDF (de outro formulário, sem assinatura, outro número de páginas) sem erro na tela.
test('BAIXA EM CC: anexar qualquer PDF não mostra erro e guarda a versão',async t=>{
 const generated=ccFixture('gerado.pdf');
 const form={id:'7a2c1b4d-0000-4000-8000-000000000004',number:'CC-2026-0004',status:'signing',data:ccData,signatures:[],fileVersion:1,
  files:[{version:1,kind:'generated',name:'FO.FI.C.007 CC-2026-0004 Outubro-2026 - para assinatura.pdf',size:generated.length,sha256:sha256(generated),createdAt:'2026-10-07T09:25:00Z',createdBy:'admin',bytes:generated}],revision:2,createdAt:'2026-10-07T09:25:00Z',updatedAt:'2026-10-07T09:25:00Z',createdBy:'admin',signedAt:null,sentAt:null};
 const server=scrapServer({cc:[form]});
 const ui=await mount(t,{url:'https://portal.test/?modulo=baixas&cc='+form.id,respond:server.respond});
 await ui.settle(()=>document.querySelector('.cc-dialog .scrap-slots'));
 const input=document.querySelector('.cc-dialog input[aria-label="PDF assinado"]');
 // PDF de outro formulário (Scrap Form), sem assinatura.
 await attach(input,scrapFixture('gerado.pdf'),'FO.FI.C.007 CC-2026-0003 Outubro-2026 - UMA PAGINA FINAL.pdf');
 await ui.settle(()=>/UMA PAGINA FINAL/.test(document.querySelector('.scrap-review')?.textContent||''));
 // PDF qualquer, de duas páginas, sem nada do portal.
 const {PDFDocument}=require('pdf-lib');const blank=await PDFDocument.create();blank.addPage();blank.addPage();
 await attach(input,await blank.save(),'qualquer.pdf');
 await ui.settle(()=>/qualquer\.pdf/.test(document.querySelector('.scrap-review')?.textContent||''));
 const review=document.querySelector('.scrap-review');
 assert.equal(review.querySelector('.scrap-review-block, .scrap-review-warn'),null,'Nenhum erro nem aviso');
 assert.doesNotMatch(review.textContent,/não é do|página\(s\)|Assinem|nenhuma assinatura digital|cópia mais antiga/);
 assert.match(review.textContent,/0 assinatura\(s\).*ainda falta: Pessoa Solicitante/);
 await pressIn(ui,'.scrap-review button','Salvar esta versão');
 await ui.settle(()=>/Versão 2 guardada/.test(document.querySelector('.cc-dialog .scrap-message')?.textContent||''));
 const upload=server.state.posts.find(post=>post.action==='upload');
 assert.equal(upload.kind,'signed');assert.deepEqual(upload.signatures,[]);assert.equal(upload.name,'qualquer.pdf');
 assert.match(document.querySelector('.cc-dialog .scrap-history').textContent,/v2 · anexado · qualquer\.pdf/);
 assert.equal(document.querySelector('.cc-dialog h2').textContent,'CC-2026-0004 · Aguardando assinatura');
 await closeDialog(ui);
 ui.assertHealthy();
});

// MB51-65 · Importar os formulários que já existiam (Excel → PDF assinado no Adobe).
const legacyFixture=name=>new Uint8Array(fs.readFileSync(path.join(__dirname,'fixtures','legado',name)));
async function attachMany(input,files){
 const {File}=require('node:buffer');
 Object.defineProperty(input,'files',{configurable:true,value:files.map(([bytes,name])=>new File([bytes],name,{type:'application/pdf',lastModified:1}))});
 await act(async()=>{input.dispatchEvent(new window.Event('change',{bubbles:true}));});
}
test('ADICIONAR PDFs: lê itens e assinaturas e guarda qualquer PDF, até sem assinatura ou emitido pelo portal',async t=>{
 const server=scrapServer();
 const ui=await mount(t,{url:'https://portal.test/?modulo=baixas',respond:server.respond});
 await ui.settle(()=>ui.container.querySelector('.scrap-forms .empty'));
 await ui.click('.scrap-forms button','Adicionar PDFs');
 await ui.settle(()=>document.querySelector('.import-dialog input[aria-label="PDFs para importar"]'));
 await attachMany(document.querySelector('.import-dialog input[aria-label="PDFs para importar"]'),[
  [legacyFixture('legado-scrap-assinado.pdf'),'Formulario de SCRAP A-B 22.09.2026 Falta assinar Rosy.pdf'],
  [legacyFixture('legado-scrap.pdf'),'Formulario de SCRAP A-B 22.09.2026 sem assinatura.pdf'],
  [legacyFixture('legado-cc-assinado.pdf'),'Ajuste Inventario Agosto 2026.pdf'],
  [ccFixture('gerado.pdf'),'FO.FI.C.007 do portal.pdf'],
  [legacyFixture('legado-scrap-regravado.pdf'),'Formulario de SCRAP A-B 21.09.2026 regravado.pdf'],
 ]);
 await ui.settle(()=>document.querySelectorAll('.import-row').length===5&&!/Lendo/.test(document.querySelector('.import-dialog .scrap-check-file').textContent));
 const row=name=>[...document.querySelectorAll('.import-row')].find(entry=>entry.textContent.includes(name));
 const signed=row('Falta assinar Rosy').textContent;
 assert.match(signed,/22\/09\/2026 · 2 item\(s\) · R\$\s3\.467,97 · 11272431-00 UNID DE CONTROLE ELETR EBS 5S/);
 assert.match(signed,/Produção: Pessoa Producao ✓/);assert.match(signed,/Qualidade: Pessoa Qualidade ✓/);assert.match(signed,/Logística: Pessoa Logistica ✓/);
 assert.match(signed,/Entra aguardando: falta Financeiro/);
 assert.match(row('sem assinatura').textContent,/Sem assinatura: entra aguardando assinatura, com o PDF guardado/);
 const cc=row('Ajuste Inventario').textContent;
 assert.match(cc,/Agosto\/2026 · 2 item\(s\)/);assert.match(cc,/Solicitante: Pessoa Solicitante ✓/);assert.match(cc,/falta SCM, Financeiro/);
 assert.equal(row('Ajuste Inventario').querySelector('select').value,'cc');
 assert.match(row('do portal').textContent,/PDF emitido pelo portal \(CC-2026-0001\), mas esse número não está na lista: entra como formulário novo/);
 assert.equal(row('do portal').querySelector('input[type="checkbox"]').checked,true,'PDF do portal também entra');
 assert.equal(document.querySelector('.import-list .scrap-review-block'),null,'Nenhum erro');
 // Regravado depois de assinado: quem assinou conta, sem aviso.
 const rewritten=row('regravado').textContent;
 assert.match(rewritten,/Produção: Pessoa Producao ✓/);assert.match(rewritten,/Entra aguardando: falta Financeiro/);
 assert.doesNotMatch(document.querySelector('.import-list').textContent,/regravado depois|não confere|alterações depois|autoassinado/);
 await act(async()=>{row('regravado').querySelector('input[type="checkbox"]').click();});
 await ui.settle(()=>!row('regravado').querySelector('input[type="checkbox"]').checked);
 await pressIn(ui,'.import-dialog button','Adicionar 4 PDF(s)');
 await ui.settle(()=>document.querySelectorAll('.import-row.done').length===4);
 const imports=server.state.posts.filter(post=>post.action==='import');
 assert.equal(imports.length,4,'Todos entram pela importação, com o PDF guardado');
 assert.equal(server.state.posts.filter(post=>post.action==='create').length,0,'Nada vira rascunho sem PDF');
 assert.equal(imports[0].doc,'cc','Em ordem de data: agosto antes de setembro');
 const scrapImport=imports.find(post=>post.name==='Formulario de SCRAP A-B 22.09.2026 Falta assinar Rosy.pdf');
 assert.equal(scrapImport.name,'Formulario de SCRAP A-B 22.09.2026 Falta assinar Rosy.pdf');
 assert.deepEqual(scrapImport.signatures.map(entry=>[entry.slot,entry.check]),[['production','imported'],['quality','imported'],['logistics','imported']]);
 assert.equal(scrapImport.data.items.length,2);assert.equal(scrapImport.data.items[0].unitPrice,1233.89);assert.equal(scrapImport.data.items[1].cause,'C');
 assert.deepEqual(Buffer.from(scrapImport.pdf,'base64'),Buffer.from(legacyFixture('legado-scrap-assinado.pdf')),'PDF original, sem alteração');
 const unsigned=imports.find(post=>/sem assinatura/.test(post.name));
 assert.deepEqual(unsigned.signatures,[]);assert.equal(unsigned.data.items.length,2);
 assert.deepEqual(Buffer.from(unsigned.pdf,'base64'),Buffer.from(legacyFixture('legado-scrap.pdf')),'PDF sem assinatura também fica guardado');
 const portal=imports.find(post=>post.name==='FO.FI.C.007 do portal.pdf');
 assert.equal(portal.doc,'cc');assert.equal(portal.data.items[0].material,'11272431-00');assert.equal(portal.data.approvers.requester,'Pessoa Solicitante');
 assert.match(document.querySelector('.import-dialog [role="status"]').textContent,/4 PDF\(s\) guardado\(s\)/);
 await pressIn(ui,'.import-dialog .scrap-footer button','Fechar');
 await ui.settle(()=>!document.querySelector('.import-dialog')&&ui.container.querySelectorAll('.scrap-row').length===2);
 await wait(20);
 const imported=[...ui.container.querySelectorAll('.scrap-row')].find(entry=>/Importado/.test(entry.textContent)&&/Falta Financeiro/.test(entry.textContent));
 assert.match(imported.textContent,/Falta Financeiro/);
 // Corrigir a transcrição sem mexer nas assinaturas.
 await act(async()=>{imported.dispatchEvent(new window.MouseEvent('click',{bubbles:true,button:0}));});
 await ui.settle(()=>document.querySelector('.scrap-dialog .scrap-slots')&&document.querySelector('.scrap-dialog .scrap-item'));
 assert.match(document.querySelector('.scrap-dialog [data-slot="dialog-description"], .scrap-dialog p').textContent,/importado de "Formulario de SCRAP A-B 22.09.2026 Falta assinar Rosy.pdf"/);
 assert.equal([...document.querySelectorAll('.scrap-dialog .scrap-footer button')].some(button=>/Gerar PDF/.test(button.textContent)),false,'O PDF já existe: não gera outro');
 await typeInto(document.querySelector('.scrap-dialog .scrap-item .f-defect input'),'Fuga de tensão (corrigido)');
 await pressIn(ui,'.scrap-dialog .scrap-footer button','Salvar dados');
 await ui.settle(()=>/Dados corrigidos/.test(document.querySelector('.scrap-message')?.textContent||''));
 assert.equal(server.state.posts.at(-1).action,'update');assert.equal(server.state.posts.at(-1).data.items[0].defect,'Fuga de tensão (corrigido)');
 // A Rosy assina o PDF importado: confere contra o PDF original e fecha o formulário.
 await attach(document.querySelector('.scrap-dialog input[aria-label="PDF assinado"]'),legacyFixture('legado-scrap-completo.pdf'),'assinado-rosy.pdf');
 await ui.settle(()=>/4 assinatura/.test(document.querySelector('.scrap-review')?.textContent||''));
 const review=document.querySelector('.scrap-review').textContent;
 assert.match(review,/Itens, valores e nomes são os mesmos do PDF importado/);
 assert.match(review,/todos os quadros obrigatórios ficam assinados/);
 assert.doesNotMatch(review,/cópia mais antiga/);
 await pressIn(ui,'.scrap-review button','Salvar esta versão');
 await ui.settle(()=>document.querySelector('.scrap-dialog .scrap-send.signed'));
 assert.equal(document.querySelectorAll('.scrap-dialog .scrap-slot.signed').length,4);
 await closeDialog(ui);
 ui.assertHealthy();
});

// MB51-71 · Baixa em CC: qualquer PDF entra — versão nova do formulário do portal, FO.FI.C.007 antigo de 2 páginas, PDF sem texto.
test('ADICIONAR PDFs na Baixa em CC: versão nova do próprio formulário, PDF longo de outro número e PDF sem texto',async t=>{
 const generated=ccFixture('gerado.pdf');
 const form={id:'7a2c1b4d-0000-4000-8000-000000000001',number:'CC-2026-0001',status:'signing',data:ccData,signatures:[],fileVersion:1,
  files:[{version:1,kind:'generated',name:'FO.FI.C.007 CC-2026-0001 Setembro-2026 - para assinatura.pdf',size:generated.length,sha256:sha256(generated),createdAt:'2026-09-24T12:00:00Z',createdBy:'admin',bytes:generated}],revision:2,createdAt:'2026-09-24T12:00:00Z',updatedAt:'2026-09-24T12:00:00Z',createdBy:'admin',signedAt:null,sentAt:null};
 const server=scrapServer({cc:[form]});
 const ui=await mount(t,{url:'https://portal.test/?modulo=baixas&doc=cc',respond:server.respond});
 await ui.settle(()=>ui.container.querySelector('.cc-row'));
 await ui.click('.scrap-forms button','Adicionar PDFs');
 await ui.settle(()=>document.querySelector('.import-dialog input[aria-label="PDFs para importar"]'));
 const {PDFDocument}=require('pdf-lib');const blank=await PDFDocument.create();blank.addPage([842,595]);
 await attachMany(document.querySelector('.import-dialog input[aria-label="PDFs para importar"]'),[
  [ccFixture('assinado-completo.pdf'),'FO.FI.C.007 CC-2026-0001 ASSINADO.pdf'],
  [generated,'FO.FI.C.007 CC-2026-0001 para assinatura.pdf'],
  [new Uint8Array(fs.readFileSync(path.join(__dirname,'fixtures','cc','portal-antigo-57.pdf'))),'FO.FI.C.007 CC-2026-0005 Outubro-2026 - para assinatura.pdf'],
  [await blank.save(),'baixa escaneada.pdf'],
 ]);
 await ui.settle(()=>document.querySelectorAll('.import-row').length===4&&!/Lendo/.test(document.querySelector('.import-dialog .scrap-check-file').textContent));
 const row=name=>[...document.querySelectorAll('.import-row')].find(entry=>entry.textContent.includes(name));
 assert.match(row('ASSINADO').textContent,/Entra como versão nova do CC-2026-0001 · fica Assinado/);
 assert.match(row('para assinatura.pdf').textContent,/Já está guardado no portal \(CC-2026-0001\)/);
 assert.equal(row('para assinatura.pdf').querySelector('input[type="checkbox"]').disabled,true);
 const long=row('CC-2026-0005').textContent;
 assert.match(long,/Outubro\/2026 · 57 item\(s\) · -R\$\s948\.348,81/,'As duas páginas do PDF antigo');
 assert.match(long,/Sem assinatura: entra aguardando assinatura/);
 assert.match(row('escaneada').textContent,/PDF sem texto/);
 assert.equal(row('escaneada').querySelector('select').value,'cc','Sem texto: vale a aba aberta');
 assert.equal(document.querySelector('.import-list .scrap-review-block'),null,'Nenhum erro');
 await pressIn(ui,'.import-dialog button','Adicionar 3 PDF(s)');
 await ui.settle(()=>document.querySelectorAll('.import-row.done').length===3);
 const upload=server.state.posts.find(post=>post.action==='upload');
 assert.equal(upload.id,form.id);assert.equal(upload.doc,'cc');assert.equal(upload.kind,'signed');
 assert.deepEqual(upload.signatures.map(entry=>[entry.slot,entry.check]),[['requester','valid'],['manager','valid'],['scm','valid'],['finance','valid']]);
 const imports=server.state.posts.filter(post=>post.action==='import');
 assert.equal(imports.length,2);assert.ok(imports.every(post=>post.doc==='cc'));
 const old=imports.find(post=>/CC-2026-0005/.test(post.name));
 assert.equal(old.data.items.length,57);assert.equal(old.data.reason,'LOSS');assert.equal(old.data.approvers.finance,'Pessoa Financeiro');
 assert.equal(old.data.items[4].description,'CONJUNTO DE TESTE COM DESCRICAO MUITO LONGA PARA QUEBRAR EM DUAS LINHAS NA CELULA DO FORMULARIO 5','Descrição em duas linhas vem inteira');
 const scanned=imports.find(post=>post.name==='baixa escaneada.pdf');
 assert.deepEqual(scanned.data.items,[]);assert.deepEqual(scanned.signatures,[]);
 await pressIn(ui,'.import-dialog .scrap-footer button','Fechar');
 await ui.settle(()=>!document.querySelector('.import-dialog')&&ui.container.querySelectorAll('.cc-row').length===3);
 assert.match([...ui.container.querySelectorAll('.cc-row')].find(entry=>/CC-2026-0001/.test(entry.textContent)).textContent,/Assinad/);
 ui.assertHealthy();
});

// MB51-67 · PR e PO: no rascunho e no importado vão com os dados; no emitido pelo portal, botão no rodapé.
test('PR e PO: rascunho e importado salvam junto; emitido pelo portal salva pelo rodapé',async t=>{
 const generated=scrapFixture('gerado.pdf');
 const issued={id:'5d1f6a3e-0000-4000-8000-000000000009',number:'SCRAP-2026-0009',status:'signing',data:{formDate:'2026-09-24',items:[scrapItem],approvers:scrapApprovers,costCenter:'',sapDocument:'',pr:'',prDate:'',po:'',notes:''},signatures:[],fileVersion:1,
  files:[{version:1,kind:'generated',name:'x.pdf',size:generated.length,sha256:sha256(generated),createdAt:'2026-09-24T12:00:00Z',createdBy:'admin',bytes:generated}],revision:2,createdAt:'2026-09-24T12:00:00Z',updatedAt:'2026-09-24T12:00:00Z',createdBy:'admin',signedAt:null,sentAt:null};
 const legacy=legacyFixture('legado-scrap-assinado.pdf');
 const imported={...issued,id:'5d1f6a3e-0000-4000-8000-000000000008',number:'SCRAP-2026-0008',data:{...issued.data,source:'antigo.pdf'},signatures:[{field:'Signature3',slot:'production',signer:'Pessoa Producao',signedAt:'2026-09-22T12:00:00.000Z',check:'imported',coversWholeFile:false,detail:''}],
  files:[{version:1,kind:'signed',name:'antigo.pdf',size:legacy.length,sha256:sha256(legacy),createdAt:'2026-09-24T12:00:00Z',createdBy:'admin',bytes:legacy}]};
 const server=scrapServer({forms:[issued,imported]});
 const ui=await mount(t,{url:'https://portal.test/?modulo=baixas',respond:server.respond});
 await ui.settle(()=>ui.container.querySelectorAll('.scrap-row').length===2);
 const posting=label=>[...document.querySelectorAll('.scrap-dialog [aria-label="Reposição e baixa no SAP"] label')].find(entry=>entry.textContent.trim().startsWith(label)).querySelector('input');
 // Novo (rascunho): PR e PO vão com o rascunho.
 await ui.click('.scrap-forms button','Novo Scrap Form');
 await ui.settle(()=>document.querySelector('.scrap-dialog [aria-label="Reposição e baixa no SAP"]'));
 await typeInto(posting('PR'),'6000014878');await typeInto(posting('PO'),'9900029259');
 await pressIn(ui,'.scrap-dialog .scrap-footer button','Salvar rascunho');
 await ui.settle(()=>server.state.posts.some(post=>post.action==='create'));
 const created=server.state.posts.find(post=>post.action==='create');
 assert.equal(created.data.pr,'6000014878');assert.equal(created.data.po,'9900029259');
 await closeDialog(ui);
 // Importado: PR habilita "Salvar dados".
 await act(async()=>{[...ui.container.querySelectorAll('.scrap-row')].find(entry=>/SCRAP-2026-0008/.test(entry.textContent)).dispatchEvent(new window.MouseEvent('click',{bubbles:true,button:0}));});
 await ui.settle(()=>document.querySelector('.scrap-dialog .scrap-slots'));
 await typeInto(posting('PR'),'6000099999');
 await pressIn(ui,'.scrap-dialog .scrap-footer button','Salvar dados');
 await ui.settle(()=>server.state.posts.some(post=>post.action==='update'&&post.id===imported.id));
 assert.equal(server.state.posts.find(post=>post.action==='update'&&post.id===imported.id).data.pr,'6000099999');
 await closeDialog(ui);
 // Emitido pelo portal: o botão aparece no rodapé quando muda.
 await act(async()=>{[...ui.container.querySelectorAll('.scrap-row')].find(entry=>/SCRAP-2026-0009/.test(entry.textContent)).dispatchEvent(new window.MouseEvent('click',{bubbles:true,button:0}));});
 await ui.settle(()=>document.querySelector('.scrap-dialog .scrap-slots'));
 assert.equal([...document.querySelectorAll('.scrap-dialog .scrap-footer button')].some(button=>/Salvar PR e PO/.test(button.textContent)),false);
 await typeInto(posting('PO'),'9900011111');
 await pressIn(ui,'.scrap-dialog .scrap-footer button','Salvar PR e PO');
 await ui.settle(()=>server.state.posts.some(post=>post.action==='posting'));
 assert.equal(server.state.posts.find(post=>post.action==='posting').po,'9900011111');
 await ui.settle(()=>/PR, PO e baixa no SAP salvos/.test(document.querySelector('.scrap-message')?.textContent||''));
 await closeDialog(ui);
 ui.assertHealthy();
});

test('GRÁFICO: Enviar por e-mail leva os gráficos no corpo, as faltas do Warehouse e a planilha',async t=>{
 const x=require('xlsx');
 const ui=await mount(t,{url:'https://portal.test/?modulo=grafico',respond:warehouseApi});
 await ui.settle(()=>ui.container.querySelector('.op-progress-heading .grafico-email-open'));
 const boxes=()=>[...document.querySelectorAll('.grafico-email-include input')];
 const close=async()=>{await pressIn(ui,'.grafico-email-dialog [data-slot="dialog-close"]');await ui.settle(()=>!document.querySelector('.grafico-email-dialog'));await wait(20);};
 // Antes de Atualizar dados: só o status das OPs (sem MB51 não há consumo nem lista de faltas)
 await ui.click('.grafico-email-open');await ui.settle(()=>document.querySelector('.grafico-email-dialog'));
 assert.deepEqual(boxes().map(box=>box.disabled),[false,true,true,true]);
 assert.match(document.querySelector('.grafico-email-note').textContent,/Atualizar dados/);
 assert.match(document.querySelector('.grafico-email-preview summary').textContent,/^Acompanhamento das OPs BOM de teste · Teste 39 \(\d\d\/\d\d\/\d{4}\)$/);
 await close();
 // Depois da MB51 e dos saldos: os dois gráficos, a lista e a planilha
 await ui.click('button[aria-label="Atualizar dados"]');
 await ui.click('.grafico-email-open');
 await ui.settle(()=>boxes().length===4&&boxes().every(box=>!box.disabled&&box.checked));
 assert.match(document.querySelector('.grafico-email-include').textContent,/1 material que o 7000 não cobre/);
 const preview=document.querySelector('.grafico-email-preview iframe').getAttribute('srcdoc');
 assert.equal((preview.match(/<img src="data:image\/svg\+xml;base64,/g)||[]).length,2,'prévia com os dois gráficos');
 assert.match(preview,/Materiais a enviar pelo Warehouse/);
 // PNG sem canvas de verdade: o teste só confere o caminho até o .eml
 const png=Buffer.from('89504e470d0a1a0a0000000d4948445200000001','hex');
 const saved=[];t.mock.method(URL,'createObjectURL',blob=>{saved.push(blob);return 'blob:teste';});t.mock.method(URL,'revokeObjectURL',()=>{});
 t.mock.method(window.HTMLCanvasElement.prototype,'getContext',()=>({fillRect(){},scale(){},drawImage(){},fillStyle:''}));
 t.mock.method(window.HTMLCanvasElement.prototype,'toBlob',function(done){done(new Blob([png],{type:'image/png'}));});
 const RealImage=globalThis.Image;globalThis.Image=class{set src(value){this.value=value;setTimeout(()=>this.onload?.(),0);}get src(){return this.value;}};t.after(()=>{globalThis.Image=RealImage;});
 const [to,cc]=document.querySelectorAll('.grafico-email-fields input[type=email]');
 await typeInto(to,'warehouse@empresa.test');await typeInto(cc,'pcp@empresa.test');
 await typeInto([...document.querySelectorAll('.grafico-email-fields label')].find(label=>/Assinar/.test(label.textContent)).querySelector('input'),'Pessoa do PCP');
 await pressIn(ui,'.grafico-email-dialog .scrap-actions button','E-mail pronto (Outlook)');
 await ui.settle(()=>saved.some(blob=>blob.type==='message/rfc822')||document.querySelector('.grafico-email-dialog .scrap-message.error'));
 assert.equal(document.querySelector('.grafico-email-dialog .scrap-message.error')?.textContent,undefined,'sem erro ao montar o e-mail');
 const eml=Buffer.from(await saved.find(blob=>blob.type==='message/rfc822').arrayBuffer()).toString('latin1');
 assert.match(eml,/^X-Unsent: 1\r\nTo: warehouse@empresa\.test\r\nCc: pcp@empresa\.test\r\nSubject: =\?UTF-8\?B\?/);
 assert.deepEqual([...eml.matchAll(/Content-ID: <([^>]+)>/g)].map(match=>match[1]),['grafico-status@wbyd','grafico-consumo@wbyd']);
 const part=type=>{const match=new RegExp(`Content-Type: ${type.replace(/[/.+]/g,'\\$&')}[^\\r]*\\r\\n(?:[^\\r]+\\r\\n)*\\r\\n([A-Za-z0-9+/=\\r\\n]+?)\\r\\n(?:\\r\\n)?--`).exec(eml);assert.ok(match,type);return Buffer.from(match[1].replace(/\r\n/g,''),'base64');};
 assert.deepEqual(part('image/png'),png);
 const text=part('text/plain').toString('utf8'),html=part('text/html').toString('utf8');
 assert.match(text,/^Prezados, (bom dia|boa tarde|boa noite)\.\n\nSegue o acompanhamento das ordens de produção da BOM de teste · Teste 39/);
 assert.match(text,/• 001-A · Material de teste · Classe C · enviar 1 PCS · saldo 2000: 2 PCS · Transferir do 2000 · OPs 2315, 2316/);
 assert.match(text,/Solicito, por gentileza, a transferência dos materiais listados do depósito 2000 para o 7000\./);
 assert.match(text,/Atenciosamente,\nPessoa do PCP$/);
 assert.match(html,/<img src="cid:grafico-status@wbyd" width="720"/);
 const book=x.read(part('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),{type:'buffer'});
 assert.deepEqual(book.SheetNames,['Total_por_Item','Falta_por_OP','Criterios']);
 const totals=x.utils.sheet_to_json(book.Sheets.Total_por_Item);
 assert.deepEqual(totals.map(row=>[row.SAP,row['Solicitar ao Warehouse (2000)'],row['Pode transferir do 2000']]),[['001-A',1,1]]);
 assert.match(eml,/Content-Disposition: attachment; filename="Materiais a enviar BOM de teste Teste 39 \d\d-\d\d-\d{4}\.xlsx"/);
 assert.match(eml,/Content-Disposition: inline; filename="Status das OPs\.png"/);
 assert.match(document.querySelector('.grafico-email-done').textContent,/E-mail pronto baixado/);
 await close();
 ui.assertHealthy();
});

test('modo consulta: faixa de aviso, Entrar como ADM e nenhum botão de alterar; ADM vê Acesso e os cadastros',async t=>{
 const as=(session)=>url=>url.pathname==='/api/session'?Response.json(session):apiResponse(url);
 const viewer=await mount(t,{respond:as({role:'viewer',via:'open',mode:'open',adminConfigured:true,canEdit:false})});
 await viewer.settle(()=>viewer.container.querySelector('.readonly-bar'));
 assert.equal(viewer.container.querySelector('.role-badge').textContent,'CONSULTA');
 assert.match(viewer.container.querySelector('.readonly-bar').textContent,/Modo consulta\..*não altera nada/);
 assert.ok(viewer.container.querySelector('a.header-login[href="/entrar"]'),'botão Entrar como ADM');
 assert.equal(viewer.container.querySelector('form[action="/auth/logout"]'),null,'consulta aberta não tem Sair');
 assert.equal([...viewer.container.querySelectorAll('button')].some(b=>/Cadastrar nova BOM|Acesso$/.test(b.textContent.trim())),false,'sem cadastro nem Acesso');
 await viewer.click('[role="tab"]','7000');
 await viewer.settle(()=>viewer.container.querySelector('h1')?.textContent==='DEPÓSITO 7000');
 assert.equal([...viewer.container.querySelectorAll('button')].some(b=>b.textContent.includes('Importar Excel')),false,'consulta não importa Excel');
 viewer.assertHealthy();
});

test('ADM: Acesso, Sair e cadastros visíveis; sem senha cadastrada a consulta avisa',async t=>{
 const as=(session)=>url=>url.pathname==='/api/session'?Response.json(session):apiResponse(url);
 const admin=await mount(t,{respond:as({role:'admin',via:'password',mode:'open',adminConfigured:true,canEdit:true})});
 await admin.settle(()=>admin.container.querySelector('.role-badge')?.textContent==='ADM');
 assert.equal(admin.container.querySelector('.readonly-bar'),null);
 assert.ok([...admin.container.querySelectorAll('button')].some(b=>b.textContent.trim()==='Acesso'));
 assert.ok(admin.container.querySelector('form[action="/auth/logout"] button'));
 assert.ok([...admin.container.querySelectorAll('button')].some(b=>b.textContent.includes('Cadastrar nova BOM')));
 admin.assertHealthy();
});

test('consulta sem senha de ADM cadastrada mostra o aviso em vez do botão de entrar',async t=>{
 const ui=await mount(t,{respond:url=>url.pathname==='/api/session'?Response.json({role:'viewer',via:'open',mode:'open',adminConfigured:false}):apiResponse(url)});
 await ui.settle(()=>ui.container.querySelector('.readonly-bar'));
 assert.match(ui.container.querySelector('.readonly-bar').textContent,/ainda não foi cadastrada/);
 assert.equal(ui.container.querySelector('a.header-login'),null);
 ui.assertHealthy();
});
