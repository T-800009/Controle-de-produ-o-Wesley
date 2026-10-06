// Robo SAP -> planilha do Controle de Producao
// Roda no Windows Script Host (JScript, ES3): sem instalar nada.
// Usa o SAP GUI que ja esta aberto e logado; nao guarda senha.
// Abra pelo "Robo SAP.cmd". Configuracoes no arquivo config.txt da mesma pasta.

var MOVIMENTOS = { de: "261", ate: "262" };
var FORMATOS_DATA = ["dd.mm.yyyy", "mm/dd/yyyy", "mm-dd-yyyy", "yyyy.mm.dd", "yyyy/mm/dd", "yyyy-mm-dd"];
// Mesmos nomes que o portal aceita na aba MB51 (lib/mb51-columns.ts).
var COLUNAS_MB51 = [
  { nome: "Ordem", obrigatoria: true, apelidos: ["Ordem", "Ordem de produção", "Ordem de producao", "OP", "Order"] },
  { nome: "Material", obrigatoria: true, apelidos: ["Material", "SAP", "Código SAP", "Código", "Part Number"] },
  { nome: "Quantidade", obrigatoria: true, apelidos: ["Quantidade", "Qtd.", "Qtd", "Quantity", "Quantidade em UM básica", "Qtd.em UM básica", "Qtd. em UM básica"] },
  { nome: "Tipo de movimento", obrigatoria: true, apelidos: ["Tipo de movimento", "Tipo movimento", "Tipo mov.", "Tipo de mov.", "Tipo movim.", "Mov. tipo", "TMv", "Mvt", "MvT", "Movement type", "Movement Type", "Tipo de movimiento"] }
];

/* ------------------------------------------------------------------ */
/* Funcoes puras (testadas no Node: tests/robo-sap.test.cjs)            */
/* ------------------------------------------------------------------ */

function aparar(texto) {
  return String(texto == null ? "" : texto).replace(/^[\s ]+|[\s ]+$/g, "");
}

var ACENTOS = { "á": "a", "à": "a", "â": "a", "ã": "a", "ä": "a", "é": "e", "è": "e", "ê": "e", "ë": "e", "í": "i", "ì": "i", "î": "i", "ï": "i", "ó": "o", "ò": "o", "ô": "o", "õ": "o", "ö": "o", "ú": "u", "ù": "u", "û": "u", "ü": "u", "ç": "c", "ñ": "n" };
function normalizar(texto) {
  return aparar(texto)
    .toLowerCase()
    .replace(/[^\u0000-\u007f]/g, function (c) {
      return ACENTOS[c] || "";
    })
    .replace(/[^a-z0-9]/g, "");
}

function contem(lista, valor) {
  for (var i = 0; i < lista.length; i++) if (lista[i] === valor) return true;
  return false;
}

/** Lista exportada do SAP (com "|" ou com tabulacao) -> cabecalho e linhas. */
function lerLista(texto, conhecidas) {
  var linhas = String(texto || "").replace(/\r\n?/g, "\n").split("\n");
  var tabelas = [];
  for (var i = 0; i < linhas.length; i++) {
    var linha = linhas[i];
    if (!/\S/.test(linha)) continue;
    if (/^[\s\-|+]*$/.test(linha)) continue;
    var celulas;
    if (linha.indexOf("\t") >= 0) celulas = linha.split("\t");
    else if (/^\s*\|/.test(linha)) celulas = linha.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|");
    else continue; // titulo do relatorio, data, usuario
    for (var j = 0; j < celulas.length; j++) celulas[j] = aparar(celulas[j]);
    tabelas.push(celulas);
  }
  // Cabecalho: a primeira linha com algum nome de coluna conhecido; senao, a primeira linha.
  var inicio = -1;
  for (var k = 0; k < tabelas.length && inicio < 0; k++)
    for (var c = 0; c < tabelas[k].length; c++)
      if (contem(conhecidas, normalizar(tabelas[k][c]))) {
        inicio = k;
        break;
      }
  if (inicio < 0) inicio = tabelas.length ? 0 : -1;
  if (inicio < 0) return { cabecalho: [], linhas: [] };
  var cabecalho = tabelas[inicio];
  while (cabecalho.length && cabecalho[cabecalho.length - 1] === "") cabecalho.pop();
  var chave = cabecalho.join("\t");
  var dados = [];
  for (var m = inicio + 1; m < tabelas.length; m++) {
    var linhaDados = tabelas[m];
    if (linhaDados.slice(0, cabecalho.length).join("\t") === chave) continue; // cabecalho repetido
    var completa = [];
    for (var n = 0; n < cabecalho.length; n++) completa.push(n < linhaDados.length ? linhaDados[n] : "");
    var temValor = false;
    for (var p = 0; p < completa.length; p++) if (completa[p] !== "") temValor = true;
    if (temValor) dados.push(completa);
  }
  return { cabecalho: cabecalho, linhas: dados };
}

function nomesConhecidos(colunas) {
  var lista = [];
  for (var i = 0; i < colunas.length; i++) for (var j = 0; j < colunas[i].apelidos.length; j++) lista.push(normalizar(colunas[i].apelidos[j]));
  return lista;
}

/** Onde esta cada coluna exigida pelo portal; faltando ou repetida = problema. */
function conferirColunas(cabecalho, colunas) {
  var indices = {},
    problemas = [];
  for (var i = 0; i < colunas.length; i++) {
    var apelidos = [];
    for (var a = 0; a < colunas[i].apelidos.length; a++) apelidos.push(normalizar(colunas[i].apelidos[a]));
    var achadas = [];
    for (var c = 0; c < cabecalho.length; c++) if (contem(apelidos, normalizar(cabecalho[c]))) achadas.push(c);
    if (!achadas.length && colunas[i].obrigatoria) problemas.push("falta a coluna " + colunas[i].nome);
    if (achadas.length > 1) problemas.push("a coluna " + colunas[i].nome + " aparece " + achadas.length + " vezes");
    if (achadas.length) indices[colunas[i].nome] = achadas[0];
  }
  return { indices: indices, problemas: problemas };
}

/** Colunas de quantidade/valor: vao como numero para a planilha. */
function colunasNumericas(cabecalho) {
  var lista = [];
  for (var i = 0; i < cabecalho.length; i++) if (/^(qtd|quantidade|quantity|montante|valor)/.test(normalizar(cabecalho[i]))) lista.push(i);
  return lista;
}

/** O SAP escreve 1.234,500 (Brasil) ou 1,234.500; decide pelo que aparece nos valores. */
function decimalComVirgula(valores, padrao) {
  for (var i = 0; i < valores.length; i++) {
    var s = aparar(valores[i]).replace(/^-|-$/g, "");
    if (!/^[\d.,]+$/.test(s)) continue;
    var virgula = s.lastIndexOf(","),
      ponto = s.lastIndexOf(".");
    if (virgula >= 0 && ponto >= 0) return virgula > ponto;
    if (/,\d{1,2}$/.test(s) || /,\d{4,}$/.test(s)) return true;
    if (/\.\d{1,2}$/.test(s) || /\.\d{4,}$/.test(s)) return false;
  }
  return padrao;
}

/** "1.234,500-" -> "-1234.5"; texto que nao e numero -> null. */
function numeroSap(valor, virgula) {
  var s = aparar(valor).replace(/\s/g, "");
  if (s === "") return "";
  var negativo = false;
  if (/-$/.test(s)) {
    negativo = true;
    s = s.slice(0, -1);
  } else if (/^-/.test(s)) {
    negativo = true;
    s = s.slice(1);
  }
  if (!/^[\d.,]+$/.test(s)) return null;
  s = virgula ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  s = s.replace(/^0+(?=\d)/, "");
  if (s.indexOf(".") >= 0) s = s.replace(/0+$/, "").replace(/\.$/, "");
  if (s === "0") negativo = false;
  return (negativo ? "-" : "") + s;
}

function doisDigitos(n) {
  return (n < 10 ? "0" : "") + n;
}
function formatarData(data, formato) {
  return formato
    .replace("dd", doisDigitos(data.getDate()))
    .replace("mm", doisDigitos(data.getMonth() + 1))
    .replace("yyyy", String(data.getFullYear()));
}
/** Do dia 1 de (mes atual - mesesAtras) ate hoje. */
function periodo(hoje, mesesAtras) {
  return { de: new Date(hoje.getFullYear(), hoje.getMonth() - mesesAtras, 1), ate: new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate()) };
}

function jsonTexto(valor) {
  var s = String(valor == null ? "" : valor);
  if (!/[\\"\u0000-\u001f\u007f-￿]/.test(s)) return '"' + s + '"';
  return (
    '"' +
    s.replace(/[\\"\u0000-\u001f\u007f-￿]/g, function (c) {
      if (c === '"') return '\\"';
      if (c === "\\") return "\\\\";
      if (c === "\n") return "\\n";
      if (c === "\r") return "\\r";
      if (c === "\t") return "\\t";
      return "\\u" + ("000" + c.charCodeAt(0).toString(16)).slice(-4);
    }) +
    '"'
  );
}
function jsonLinha(celulas) {
  var partes = [];
  for (var i = 0; i < celulas.length; i++) partes.push(jsonTexto(celulas[i]));
  return "[" + partes.join(",") + "]";
}

/** Tabela pronta para a aba MB51: confere colunas, tira totais, quantidades como numero. */
function montarMb51(texto, formatoData) {
  var lista = lerLista(texto, nomesConhecidos(COLUNAS_MB51));
  if (!lista.cabecalho.length) throw new Error("A lista da MB51 veio vazia.");
  var conferencia = conferirColunas(lista.cabecalho, COLUNAS_MB51);
  if (conferencia.problemas.length)
    throw new Error(
      "A MB51 saiu sem o que o portal precisa (" +
        conferencia.problemas.join("; ") +
        "). Colunas que vieram: " +
        lista.cabecalho.join(", ") +
        ". Na MB51, monte um layout com Ordem, Material, Quantidade e Tipo de movimento, salve como padrão ou escreva o nome dele em LAYOUT_MB51 no config.txt."
    );
  var material = conferencia.indices["Material"];
  var linhas = [];
  for (var i = 0; i < lista.linhas.length; i++) if (aparar(lista.linhas[i][material]) !== "" && !/^\*+$/.test(aparar(lista.linhas[i][0]))) linhas.push(lista.linhas[i]);
  if (!linhas.length) throw new Error("A MB51 não trouxe nenhum movimento no período.");
  var numericas = colunasNumericas(lista.cabecalho);
  var amostra = [];
  for (var a = 0; a < linhas.length && amostra.length < 2000; a++) for (var n = 0; n < numericas.length; n++) amostra.push(linhas[a][numericas[n]]);
  var virgula = decimalComVirgula(amostra, formatoData !== "mm/dd/yyyy" && formatoData !== "mm-dd-yyyy");
  for (var l = 0; l < linhas.length; l++)
    for (var k = 0; k < numericas.length; k++) {
      var convertido = numeroSap(linhas[l][numericas[k]], virgula);
      if (convertido !== null) linhas[l][numericas[k]] = convertido;
    }
  return { cabecalho: lista.cabecalho, linhas: linhas, numericas: numericas, virgula: virgula };
}

function corpoEnvio(chave, aba, tabela) {
  var linhas = [jsonLinha(tabela.cabecalho)];
  for (var i = 0; i < tabela.linhas.length; i++) linhas.push(jsonLinha(tabela.linhas[i]));
  return "{" + '"chave":' + jsonTexto(chave) + ',"aba":' + jsonTexto(aba) + ',"numericas":[' + tabela.numericas.join(",") + '],"linhas":[' + linhas.join(",") + "]}";
}

/** Resposta do Apps Script: {"ok":true,...} ou {"ok":false,"erro":"..."}. */
function lerResposta(texto) {
  var t = String(texto || "");
  if (/"ok"\s*:\s*true/.test(t)) {
    var linhas = /"linhas"\s*:\s*(\d+)/.exec(t),
      planilha = /"planilha"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(t);
    return { ok: true, linhas: linhas ? Number(linhas[1]) : null, planilha: planilha ? desfazerJson(planilha[1]) : "" };
  }
  var erro = /"erro"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(t);
  if (erro) return { ok: false, erro: desfazerJson(erro[1]) };
  if (/<html|<!doctype/i.test(t))
    return { ok: false, erro: "A planilha respondeu com uma página de login. Na implantação do Apps Script, escolha \"Quem pode acessar: Qualquer pessoa\"." };
  return { ok: false, erro: "Resposta inesperada da planilha: " + t.slice(0, 200) };
}
function desfazerJson(s) {
  return s.replace(/\\u([0-9a-fA-F]{4})|\\(["\\\/bfnrt])/g, function (tudo, hex, simples) {
    if (hex) return String.fromCharCode(parseInt(hex, 16));
    return { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" }[simples];
  });
}

/** config.txt: CHAVE=valor por linha; # comenta. */
function lerConfig(texto) {
  var config = {};
  var linhas = String(texto || "").replace(/\r\n?/g, "\n").split("\n");
  for (var i = 0; i < linhas.length; i++) {
    var m = /^\s*([A-Z_0-9]+)\s*=(.*)$/.exec(linhas[i]);
    if (m) config[m[1]] = aparar(m[2]);
  }
  return config;
}

/* ------------------------------------------------------------------ */
/* Windows + SAP GUI (so roda no Windows Script Host)                   */
/* ------------------------------------------------------------------ */

var fso, pasta, arquivoLog;
function iniciarArquivos() {
  fso = new ActiveXObject("Scripting.FileSystemObject");
  pasta = fso.GetParentFolderName(WScript.ScriptFullName);
  arquivoLog = pasta + "\\robo-sap.log";
}
function registrar(texto) {
  try {
    var f = fso.OpenTextFile(arquivoLog, 8, true, -1);
    var agora = new Date();
    f.WriteLine(formatarData(agora, "yyyy-mm-dd") + " " + doisDigitos(agora.getHours()) + ":" + doisDigitos(agora.getMinutes()) + ":" + doisDigitos(agora.getSeconds()) + "  " + texto);
    f.Close();
  } catch (e) {
    // Sem log nao impede o robo.
  }
}
function passo(texto) {
  WScript.Echo(texto);
  registrar(texto);
}
function lerArquivo(caminho) {
  if (!fso.FileExists(caminho)) return "";
  var f = fso.OpenTextFile(caminho, 1, false, -2);
  var texto = f.AtEndOfStream ? "" : f.ReadAll();
  f.Close();
  return texto;
}
function gravarConfig(caminho, chave, valor) {
  var texto = lerArquivo(caminho);
  var linhas = texto.replace(/\r\n?/g, "\n").split("\n");
  var achou = false;
  for (var i = 0; i < linhas.length; i++)
    if (new RegExp("^\\s*" + chave + "\\s*=").test(linhas[i])) {
      linhas[i] = chave + "=" + valor;
      achou = true;
    }
  if (!achou) linhas.push(chave + "=" + valor);
  var f = fso.OpenTextFile(caminho, 2, true, 0);
  f.Write(linhas.join("\r\n"));
  f.Close();
}

function carregarConfig() {
  var caminho = pasta + "\\config.txt";
  var config = lerConfig(lerArquivo(caminho));
  if (!config.CHAVE || /TROQUE/.test(config.CHAVE)) throw new Error("O config.txt está sem a CHAVE do robô.");
  if (!/^https:\/\/script\.google\.com\//.test(config.URL_PLANILHA || "")) {
    WScript.Echo("");
    WScript.Echo("Primeira vez: cole aqui a URL do App da Web da planilha (termina em /exec) e aperte Enter:");
    var url = aparar(WScript.StdIn.ReadLine());
    if (!/^https:\/\/script\.google\.com\/.+\/exec$/.test(url)) throw new Error("Essa não é a URL do App da Web (começa com https://script.google.com/ e termina com /exec).");
    gravarConfig(caminho, "URL_PLANILHA", url);
    config.URL_PLANILHA = url;
  }
  return {
    url: config.URL_PLANILHA,
    chave: config.CHAVE,
    centro: config.CENTRO || "BR02",
    mesesAtras: /^\d+$/.test(config.MESES_ATRAS || "") ? Number(config.MESES_ATRAS) : 1,
    layout: config.LAYOUT_MB51 || "",
    aba: config.ABA_MB51 || "MB51"
  };
}

function postar(url, corpo) {
  var erros = [];
  var tipos = ["MSXML2.ServerXMLHTTP.6.0", "MSXML2.XMLHTTP.6.0", "MSXML2.XMLHTTP"];
  for (var i = 0; i < tipos.length; i++) {
    try {
      var http = new ActiveXObject(tipos[i]);
      http.open("POST", url, false);
      try {
        http.setTimeouts(30000, 30000, 300000, 300000);
      } catch (semTempo) {
        // So o ServerXMLHTTP tem prazo configuravel.
      }
      http.setRequestHeader("Content-Type", "text/plain; charset=utf-8");
      http.send(corpo);
      if (http.status === 200) return http.responseText;
      erros.push("HTTP " + http.status);
    } catch (e) {
      erros.push(e.message);
    }
  }
  throw new Error("Não consegui falar com a planilha (" + erros.join(" | ") + "). Confira a internet e a URL no config.txt.");
}

// ---- SAP GUI ----
function item(colecao, indice) {
  try {
    return colecao.Item(indice);
  } catch (e) {
    try {
      return colecao.ElementAt(indice);
    } catch (e2) {
      return colecao(indice);
    }
  }
}
function quantos(objeto) {
  try {
    return objeto.Children.Count;
  } catch (e) {
    return -1;
  }
}
function aguardar(sessao) {
  for (var i = 0; i < 3000; i++) {
    var ocupado = false;
    try {
      ocupado = sessao.Busy;
    } catch (e) {
      ocupado = false;
    }
    if (!ocupado) return;
    WScript.Sleep(200);
  }
}
function achar(sessao, id) {
  try {
    return sessao.findById(id, false);
  } catch (e) {
    return null;
  }
}
function barra(sessao) {
  var sb = achar(sessao, "wnd[0]/sbar");
  if (!sb) return { tipo: "", texto: "" };
  return { tipo: String(sb.MessageType || ""), texto: String(sb.Text || "") };
}
function comando(sessao, codigo) {
  sessao.findById("wnd[0]/tbar[0]/okcd").Text = codigo;
  sessao.findById("wnd[0]").sendVKey(0);
  aguardar(sessao);
}
function campo(sessao, nome) {
  return achar(sessao, "wnd[0]/usr/ctxt" + nome) || achar(sessao, "wnd[0]/usr/txt" + nome);
}
function preencher(sessao, nome, valor) {
  var c = campo(sessao, nome);
  if (!c) return false;
  c.Text = valor;
  return true;
}
function filhos(objeto) {
  var lista = [];
  try {
    var colecao = objeto.Children;
    for (var i = 0; i < colecao.Count; i++) lista.push(item(colecao, i));
  } catch (e) {
    // Sem filhos.
  }
  return lista;
}
function procurar(objeto, teste, profundidade) {
  if (profundidade > 12 || !objeto) return null;
  try {
    if (teste(objeto)) return objeto;
  } catch (e) {
    // Elemento sem a propriedade testada.
  }
  var lista = filhos(objeto);
  for (var i = 0; i < lista.length; i++) {
    var achado = procurar(lista[i], teste, profundidade + 1);
    if (achado) return achado;
  }
  return null;
}

function conectarSap() {
  var gui;
  try {
    gui = GetObject("SAPGUI");
  } catch (e) {
    throw new Error("Abra o SAP e entre com o seu usuário antes de rodar o robô.");
  }
  var app = null;
  try {
    app = gui.GetScriptingEngine;
  } catch (e) {
    app = null;
  }
  if (quantos(app) < 0) {
    try {
      app = gui.GetScriptingEngine();
    } catch (e) {
      app = null;
    }
  }
  if (quantos(app) < 0) throw new Error("O SAP não liberou o scripting. Em Opções > Acessibilidade e scripting > Scripting, marque \"Ativar scripting\".");
  if (quantos(app) === 0) throw new Error("Nenhuma conexão aberta no SAP. Entre no SAP (BRP) e rode o robô de novo.");
  var conexao = item(app.Children, 0);
  var bloqueado = false;
  try {
    bloqueado = conexao.DisabledByServer;
  } catch (e) {
    bloqueado = false;
  }
  if (bloqueado) throw new Error("O scripting está desligado no servidor do SAP. Quem libera é o Basis (parâmetro sapgui/user_scripting).");
  if (quantos(conexao) <= 0) throw new Error("Nenhuma janela do SAP aberta. Entre no SAP e rode o robô de novo.");
  var base = item(conexao.Children, 0);
  var antes = conexao.Children.Count;
  // Janela nova: o robo nao mexe na tela em que voce esta trabalhando.
  if (antes < 6) {
    try {
      base.createSession();
      for (var t = 0; t < 75 && conexao.Children.Count <= antes; t++) WScript.Sleep(200);
    } catch (e) {
      // Sem janela nova: usa a primeira.
    }
  }
  if (conexao.Children.Count > antes) {
    var nova = item(conexao.Children, conexao.Children.Count - 1);
    aguardar(nova);
    return { sessao: nova, nova: true };
  }
  aguardar(base);
  return { sessao: base, nova: false };
}

function preencherDatas(sessao, de, ate) {
  var ultima = "";
  for (var i = 0; i < FORMATOS_DATA.length; i++) {
    preencher(sessao, "BUDAT-LOW", formatarData(de, FORMATOS_DATA[i]));
    preencher(sessao, "BUDAT-HIGH", formatarData(ate, FORMATOS_DATA[i]));
    sessao.findById("wnd[0]").sendVKey(0);
    aguardar(sessao);
    var b = barra(sessao);
    if (b.tipo !== "E" && b.tipo !== "A") return FORMATOS_DATA[i];
    ultima = b.texto;
  }
  throw new Error("A MB51 não aceitou a data de lançamento: " + ultima);
}

function rodarMb51(sessao, config) {
  comando(sessao, "/nMB51");
  if (!campo(sessao, "WERKS-LOW")) {
    var b = barra(sessao);
    throw new Error("A MB51 não abriu" + (b.texto ? ": " + b.texto : ". Você tem acesso a ela?"));
  }
  var limpar = ["MATNR-LOW", "MATNR-HIGH", "WERKS-HIGH", "LGORT-LOW", "LGORT-HIGH", "CHARG-LOW", "CHARG-HIGH", "LIFNR-LOW", "LIFNR-HIGH", "KUNNR-LOW", "KUNNR-HIGH", "SOBKZ-LOW", "SOBKZ-HIGH", "USNAM-LOW", "USNAM-HIGH", "VGART-LOW", "VGART-HIGH", "XBLNR-LOW", "XBLNR-HIGH"];
  for (var i = 0; i < limpar.length; i++) preencher(sessao, limpar[i], "");
  preencher(sessao, "WERKS-LOW", config.centro);
  if (!preencher(sessao, "BWART-LOW", MOVIMENTOS.de)) throw new Error("Não achei o campo Tipo de movimento na MB51.");
  preencher(sessao, "BWART-HIGH", MOVIMENTOS.ate);
  if (config.layout) preencher(sessao, "ALV_DEF", config.layout);
  var listaSimples = achar(sessao, "wnd[0]/usr/radRFLAT_L");
  if (listaSimples) listaSimples.select();
  var p = periodo(new Date(), config.mesesAtras);
  var formato = preencherDatas(sessao, p.de, p.ate);
  passo("MB51: centro " + config.centro + ", movimentos 261/262, de " + formatarData(p.de, "dd/mm/yyyy") + " a " + formatarData(p.ate, "dd/mm/yyyy") + "...");
  sessao.findById("wnd[0]/tbar[1]/btn[8]").press();
  aguardar(sessao);
  if (campo(sessao, "WERKS-LOW")) {
    var b2 = barra(sessao);
    throw new Error(b2.texto ? "A MB51 respondeu: " + b2.texto : "A MB51 não mostrou a lista.");
  }
  return { texto: exportarLista(sessao), formato: formato };
}

function limparClipboard() {
  try {
    new ActiveXObject("htmlfile").parentWindow.clipboardData.setData("Text", "");
  } catch (e) {
    // Sem acesso: so nao limpa.
  }
}
function lerClipboard() {
  var texto = new ActiveXObject("htmlfile").parentWindow.clipboardData.getData("Text");
  return texto == null ? "" : String(texto);
}

/** Lista ou grade ALV -> "Salvar lista em arquivo" -> "Na área de transferência". */
function exportarLista(sessao) {
  limparClipboard();
  var grade = procurar(
    achar(sessao, "wnd[0]/usr"),
    function (o) {
      return o.Type === "GuiShell" && o.SubType === "GridView";
    },
    0
  );
  var abriu = false;
  if (grade) {
    try {
      grade.pressToolbarContextButton("&MB_EXPORT");
      grade.selectContextMenuItem("&PC");
      abriu = true;
    } catch (e) {
      abriu = false;
    }
  }
  if (!abriu) comando(sessao, "%pc");
  aguardar(sessao);
  var janela = achar(sessao, "wnd[1]");
  if (!janela) throw new Error("Não abriu a janela de exportação da lista.");
  var opcao = procurar(
    janela,
    function (o) {
      return o.Type === "GuiRadioButton" && /transfer|clipboard|zwischenablage/i.test(String(o.Text));
    },
    0
  );
  if (!opcao) throw new Error("Na janela de exportação não achei a opção \"Na área de transferência\".");
  opcao.select();
  sessao.findById("wnd[1]/tbar[0]/btn[0]").press();
  aguardar(sessao);
  var texto = "";
  for (var t = 0; t < 50 && !texto; t++) {
    texto = lerClipboard();
    if (!texto) WScript.Sleep(200);
  }
  if (!texto) throw new Error("A lista não chegou na área de transferência.");
  return texto;
}

function fecharSessao(sessao) {
  try {
    comando(sessao, "/i");
  } catch (e) {
    // Janela ja fechada.
  }
}

/** Arquivo com os campos da tela atual, para ajustar o robo quando o SAP for diferente. */
function diagnostico(sessao) {
  var linhas = [];
  function listar(objeto, nivel) {
    if (!objeto || linhas.length > 2500 || nivel > 12) return;
    try {
      linhas.push(objeto.Id + " | " + objeto.Type + " | " + (objeto.Name || "") + " | " + String(objeto.Text || "").slice(0, 80));
    } catch (e) {
      // Elemento sem texto.
    }
    var lista = filhos(objeto);
    for (var i = 0; i < lista.length; i++) listar(lista[i], nivel + 1);
  }
  try {
    var b = barra(sessao);
    linhas.push("Barra de status: [" + b.tipo + "] " + b.texto);
    try {
      linhas.push("Transacao: " + sessao.Info.Transaction + " | Programa: " + sessao.Info.Program + " | Tela: " + sessao.Info.ScreenNumber);
    } catch (e) {
      // Sem Info.
    }
    listar(achar(sessao, "wnd[0]"), 0);
    listar(achar(sessao, "wnd[1]"), 0);
    var f = fso.OpenTextFile(pasta + "\\robo-sap-diagnostico.txt", 2, true, -1);
    f.Write(linhas.join("\r\n"));
    f.Close();
    return true;
  } catch (e) {
    return false;
  }
}

function aviso(texto, icone) {
  try {
    new ActiveXObject("WScript.Shell").Popup(texto, 0, "Robô SAP", icone);
  } catch (e) {
    WScript.Echo(texto);
  }
}

function principal() {
  iniciarArquivos();
  var silencioso = false;
  for (var a = 0; a < WScript.Arguments.length; a++) if (/silencioso/i.test(WScript.Arguments(a))) silencioso = true;
  var conexao = null;
  try {
    var config = carregarConfig();
    passo("Conferindo a planilha...");
    var teste = lerResposta(postar(config.url, "{" + '"chave":' + jsonTexto(config.chave) + ',"teste":true}'));
    if (!teste.ok) throw new Error(teste.erro);
    passo("Planilha: " + teste.planilha);
    passo("Conectando no SAP...");
    conexao = conectarSap();
    var resultado = rodarMb51(conexao.sessao, config);
    passo("Lendo a lista...");
    var tabela = montarMb51(resultado.texto, resultado.formato);
    passo(tabela.linhas.length + " movimentos (" + tabela.cabecalho.length + " colunas). Enviando para a aba " + config.aba + "...");
    var resposta = lerResposta(postar(config.url, corpoEnvio(config.chave, config.aba, tabela)));
    if (!resposta.ok) throw new Error(resposta.erro);
    if (conexao.nova) fecharSessao(conexao.sessao);
    var mensagem = "Pronto: " + tabela.linhas.length + " movimentos da MB51 na aba " + config.aba + ".\n\nNo portal, clique em Atualizar dados.";
    passo(mensagem.replace(/\n+/g, " "));
    if (!silencioso) aviso(mensagem, 64);
    return 0;
  } catch (e) {
    var texto = e && e.message ? e.message : String(e);
    registrar("ERRO: " + texto);
    var comArquivo = conexao && diagnostico(conexao.sessao);
    if (conexao && conexao.nova) fecharSessao(conexao.sessao);
    WScript.Echo("ERRO: " + texto);
    if (!silencioso) aviso(texto + (comArquivo ? "\n\nSe não souber resolver, mande para o Claude o arquivo robo-sap-diagnostico.txt (está na pasta do robô)." : ""), 16);
    return 1;
  }
}

if (typeof WScript !== "undefined") WScript.Quit(principal());
else if (typeof module !== "undefined")
  module.exports = { aparar: aparar, normalizar: normalizar, lerLista: lerLista, conferirColunas: conferirColunas, colunasNumericas: colunasNumericas, decimalComVirgula: decimalComVirgula, numeroSap: numeroSap, formatarData: formatarData, periodo: periodo, jsonTexto: jsonTexto, montarMb51: montarMb51, corpoEnvio: corpoEnvio, lerResposta: lerResposta, lerConfig: lerConfig, nomesConhecidos: nomesConhecidos, COLUNAS_MB51: COLUNAS_MB51 };
