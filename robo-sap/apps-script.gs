/**
 * Robô SAP → planilha do Controle de Produção.
 *
 * Cole este código em Extensões → Apps Script da planilha e implante como
 * "App da Web" (Executar como: Eu · Quem pode acessar: Qualquer pessoa).
 * O robô só consegue gravar com a CHAVE abaixo, e só nas abas da lista.
 * Antes de trocar uma aba, a versão anterior fica guardada na aba
 * "<nome> (anterior)", oculta.
 */
const CHAVE = 'TROQUE-ESTA-CHAVE';
const ABAS = ['MB51', '7000', '2000', '1500', 'MM60', 'ZPP009', 'KOB1', 'COOIS'];

function doGet() {
  return saida({ ok: true, robo: 'Controle de Produção', abas: ABAS });
}

function doPost(e) {
  let pedido;
  try {
    pedido = JSON.parse(e.postData.contents);
  } catch (erro) {
    return saida({ ok: false, erro: 'Pedido inválido.' });
  }
  if (!pedido || pedido.chave !== CHAVE) return saida({ ok: false, erro: 'A chave do robô não confere com a do Apps Script.' });
  if (pedido.teste) return saida({ ok: true, planilha: SpreadsheetApp.getActive().getName() });
  return saida(gravarAba(SpreadsheetApp.getActive(), pedido));
}

/** Troca o conteúdo da aba pelo que veio do SAP; quantidades como número, o resto como texto. */
function gravarAba(planilha, pedido) {
  const aba = String(pedido.aba || '');
  if (ABAS.indexOf(aba) < 0) return { ok: false, erro: 'Aba não permitida: ' + aba };
  const linhas = pedido.linhas;
  if (!Array.isArray(linhas) || linhas.length < 2 || !Array.isArray(linhas[0])) return { ok: false, erro: 'Nenhuma linha recebida.' };
  const largura = linhas[0].length;
  if (!largura) return { ok: false, erro: 'Cabeçalho vazio.' };
  const numericas = (Array.isArray(pedido.numericas) ? pedido.numericas : []).filter((c) => Number.isInteger(c) && c >= 0 && c < largura);
  const dados = linhas.map((linha, i) => {
    const saida = [];
    for (let c = 0; c < largura; c++) {
      const valor = Array.isArray(linha) && linha[c] != null ? String(linha[c]) : '';
      saida.push(i > 0 && numericas.indexOf(c) >= 0 && /^-?\d+(\.\d+)?$/.test(valor) ? Number(valor) : valor);
    }
    return saida;
  });
  const trava = LockService.getDocumentLock();
  trava.waitLock(30000);
  try {
    let folha = planilha.getSheetByName(aba);
    if (folha) {
      const nomeCopia = aba + ' (anterior)';
      const velha = planilha.getSheetByName(nomeCopia);
      if (velha) planilha.deleteSheet(velha);
      folha.copyTo(planilha).setName(nomeCopia).hideSheet();
      folha.clear();
    } else folha = planilha.insertSheet(aba);
    if (folha.getMaxRows() < dados.length) folha.insertRowsAfter(folha.getMaxRows(), dados.length - folha.getMaxRows());
    if (folha.getMaxColumns() < largura) folha.insertColumnsAfter(folha.getMaxColumns(), largura - folha.getMaxColumns());
    // Códigos (material, ordem, documento) ficam como texto: zeros à esquerda não somem.
    for (let c = 0; c < largura; c++) if (numericas.indexOf(c) < 0) folha.getRange(1, c + 1, dados.length, 1).setNumberFormat('@');
    folha.getRange(1, 1, dados.length, largura).setValues(dados);
    folha.getRange(1, 1, 1, largura).setFontWeight('bold');
    folha.setFrozenRows(1);
    PropertiesService.getDocumentProperties().setProperty('robo:' + aba, new Date().toISOString());
    SpreadsheetApp.flush();
    return { ok: true, aba: aba, linhas: dados.length - 1 };
  } finally {
    trava.releaseLock();
  }
}

function saida(objeto) {
  return ContentService.createTextOutput(JSON.stringify(objeto)).setMimeType(ContentService.MimeType.JSON);
}
