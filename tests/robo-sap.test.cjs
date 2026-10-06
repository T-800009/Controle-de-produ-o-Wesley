// Robô SAP: funções puras do robo-sap.js (JScript ES3) e o Apps Script da planilha.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
// O projeto é "type": "module": o robô (JScript do Windows) é carregado num contexto à parte.
const robo = (() => {
  const modulo = { exports: {} };
  new Function("module", fs.readFileSync(path.join(__dirname, "../robo-sap/robo-sap.js"), "utf8"))(modulo);
  return modulo.exports;
})();

const LISTA = [
  "06.10.2026                 Lista de documentos de material                 1",
  "----------------------------------------------------------------------------",
  "|Material     |Centro|Dep.|TMv|Ordem       |Quantidade |UMB|Data lçto. |",
  "|--------------------------------------------------------------------------|",
  "|11272431-00  |BR02  |7000|261|19000002673 |     2,000-|PC |01.10.2026|",
  "|17120732-00  |BR02  |7000|262|19000002673 |     1,000 |PC |02.10.2026|",
  "|11839404-00  |BR02  |7000|261|19000002674 | 1.250,500-|KG |03.10.2026|",
  "|Material     |Centro|Dep.|TMv|Ordem       |Quantidade |UMB|Data lçto. |",
  "|000000012345 |BR02  |7000|261|19000002674 |    10     |PC |03.10.2026|",
  "|*            |      |    |   |            | 2.251,500-|   |          |",
  "----------------------------------------------------------------------------",
].join("\r\n");

test("lista do SAP com | : cabeçalho, linhas, total e cabeçalho repetido fora; quantidade como número", () => {
  const tabela = robo.montarMb51(LISTA, "dd.mm.yyyy");
  assert.deepEqual(tabela.cabecalho, ["Material", "Centro", "Dep.", "TMv", "Ordem", "Quantidade", "UMB", "Data lçto."]);
  assert.equal(tabela.linhas.length, 4);
  assert.deepEqual(
    tabela.linhas.map((linha) => [linha[0], linha[4], linha[5]]),
    [
      ["11272431-00", "19000002673", "-2"],
      ["17120732-00", "19000002673", "1"],
      ["11839404-00", "19000002674", "-1250.5"],
      ["000000012345", "19000002674", "10"],
    ],
  );
  assert.deepEqual(tabela.numericas, [5]);
  assert.equal(tabela.virgula, true);
});

test("lista com tabulação (grade ALV) e números no formato americano", () => {
  const texto = ["Ordem\tMaterial\tQtd.\tTipo de movimento\tUM básica", "19000002673\t11272431-00\t1,250.500-\t261\tKG", "19000002673\t17120732-00\t2.000\t262\tPC", ""].join("\n");
  const tabela = robo.montarMb51(texto, "mm/dd/yyyy");
  assert.equal(tabela.virgula, false);
  assert.deepEqual(
    tabela.linhas.map((linha) => linha[2]),
    ["-1250.5", "2"],
  );
});

test("sem a coluna Ordem o robô para com a lista do que veio", () => {
  const texto = "|Material|Quantidade|TMv|\n|11272431-00|1|261|";
  assert.throws(() => robo.montarMb51(texto, "dd.mm.yyyy"), /falta a coluna Ordem.*Colunas que vieram: Material, Quantidade, TMv/);
  assert.throws(() => robo.montarMb51("|Material|Ordem|Qtd|Quantidade|TMv|\n|1|2|3|4|261|", "dd.mm.yyyy"), /a coluna Quantidade aparece 2 vezes/);
  assert.throws(() => robo.montarMb51("", "dd.mm.yyyy"), /veio vazia/);
  assert.throws(() => robo.montarMb51("|Material|Ordem|Quantidade|TMv|\n|*||1|261|", "dd.mm.yyyy"), /nenhum movimento/);
});

test("números do SAP: sinal no fim, milhar e decimal", () => {
  assert.equal(robo.numeroSap("1.234,500-", true), "-1234.5");
  assert.equal(robo.numeroSap("1,234.500-", false), "-1234.5");
  assert.equal(robo.numeroSap("0,000", true), "0");
  assert.equal(robo.numeroSap("-0,500", true), "-0.5");
  assert.equal(robo.numeroSap("", true), "");
  assert.equal(robo.numeroSap("PC", true), null);
  assert.equal(robo.decimalComVirgula(["2,000", "15,5"], false), true);
  assert.equal(robo.decimalComVirgula(["2.000", "1,234.5"], true), false);
  assert.equal(robo.decimalComVirgula(["2,000", "10"], false), false, "Ambíguo: vale o formato de data do usuário");
});

test("datas no formato do usuário e período desde o mês anterior", () => {
  const data = new Date(2026, 9, 6);
  assert.equal(robo.formatarData(data, "dd.mm.yyyy"), "06.10.2026");
  assert.equal(robo.formatarData(data, "mm/dd/yyyy"), "10/06/2026");
  assert.equal(robo.formatarData(data, "yyyy-mm-dd"), "2026-10-06");
  const janeiro = robo.periodo(new Date(2026, 0, 15), 1);
  assert.equal(robo.formatarData(janeiro.de, "yyyy-mm-dd"), "2025-12-01");
  assert.equal(robo.formatarData(janeiro.ate, "yyyy-mm-dd"), "2026-01-15");
});

test("envio em JSON só com ASCII; resposta da planilha", () => {
  const tabela = robo.montarMb51(LISTA, "dd.mm.yyyy");
  const corpo = robo.corpoEnvio('chave "x"', "MB51", tabela);
  assert.match(corpo, /^[\x20-\x7e]*$/, "Acentos viram \\u: sem problema de codificação no Windows");
  const lido = JSON.parse(corpo);
  assert.equal(lido.chave, 'chave "x"');
  assert.equal(lido.linhas[0][7], "Data lçto.");
  assert.equal(lido.linhas.length, 5);
  assert.deepEqual(lido.numericas, [5]);
  assert.deepEqual(robo.lerResposta('{"ok":true,"aba":"MB51","linhas":4}'), { ok: true, linhas: 4, planilha: "" });
  assert.equal(robo.lerResposta('{"ok":true,"planilha":"Controle de Produ\\u00e7\\u00e3o"}').planilha, "Controle de Produção");
  assert.deepEqual(robo.lerResposta('{"ok":false,"erro":"A chave do rob\\u00f4 n\\u00e3o confere."}'), { ok: false, erro: "A chave do robô não confere." });
  assert.match(robo.lerResposta("<!DOCTYPE html><html>login</html>").erro, /Qualquer pessoa/);
});

test("config.txt", () => {
  const config = robo.lerConfig("# comentário\r\nURL_PLANILHA=https://script.google.com/macros/s/x/exec\r\nCHAVE= abc \r\nLAYOUT_MB51=\r\n");
  assert.deepEqual(config, { URL_PLANILHA: "https://script.google.com/macros/s/x/exec", CHAVE: "abc", LAYOUT_MB51: "" });
});

test("o robô usa só JScript ES3 (Windows Script Host)", () => {
  const codigo = fs.readFileSync(path.join(__dirname, "../robo-sap/robo-sap.js"), "utf8");
  for (const proibido of [/\blet\s/, /\bconst\s/, /=>/, /\.forEach\(/, /\.map\(/, /\.filter\(/, /\.trim\(\)/, /\bJSON\./, /Array\.isArray/, /Object\.keys/, /`/, /,\s*\n\s*[\]}]/])
    assert.doesNotMatch(codigo, proibido, String(proibido));
  // Arrays não têm indexOf no JScript: só em texto.
  for (const uso of codigo.match(/[\w\]\)]+\.indexOf\(/g) || []) assert.match(uso, /^(linha|s)\.indexOf\(/, uso);
});

/* ------------------------------------------------------------------ */

function appsScript() {
  const props = {};
  const planilha = {
    nome: "Controle de Produção",
    folhas: new Map(),
    getName() {
      return this.nome;
    },
    getSheetByName(nome) {
      return this.folhas.get(nome) || null;
    },
    insertSheet(nome) {
      const folha = criarFolha(nome, this);
      this.folhas.set(nome, folha);
      return folha;
    },
    deleteSheet(folha) {
      this.folhas.delete(folha.nome);
    },
  };
  function criarFolha(nome, dono) {
    return {
      nome,
      linhas: 1000,
      colunas: 26,
      valores: [],
      formatos: {},
      oculta: false,
      congeladas: 0,
      setName(novo) {
        dono.folhas.delete(this.nome);
        this.nome = novo;
        dono.folhas.set(novo, this);
        return this;
      },
      hideSheet() {
        this.oculta = true;
        return this;
      },
      copyTo(destino) {
        const copia = criarFolha("Cópia de " + this.nome, destino);
        copia.valores = this.valores.map((linha) => linha.slice());
        destino.folhas.set(copia.nome, copia);
        return copia;
      },
      clear() {
        this.valores = [];
        this.formatos = {};
      },
      getMaxRows() {
        return this.linhas;
      },
      getMaxColumns() {
        return this.colunas;
      },
      insertRowsAfter(_, n) {
        this.linhas += n;
      },
      insertColumnsAfter(_, n) {
        this.colunas += n;
      },
      setFrozenRows(n) {
        this.congeladas = n;
      },
      getRange(linha, coluna, altura, largura) {
        const folha = this;
        if (linha + altura - 1 > folha.linhas || coluna + (largura || 1) - 1 > folha.colunas) throw Error("fora da folha");
        return {
          setNumberFormat(formato) {
            folha.formatos[coluna] = formato;
            return this;
          },
          setValues(valores) {
            folha.valores = valores.map((linha) => linha.slice());
            return this;
          },
          setFontWeight() {
            return this;
          },
        };
      },
    };
  }
  const contexto = {
    SpreadsheetApp: { getActive: () => planilha, flush() {} },
    LockService: { getDocumentLock: () => ({ waitLock() {}, releaseLock() {} }) },
    PropertiesService: { getDocumentProperties: () => ({ setProperty: (k, v) => (props[k] = v) }) },
    ContentService: { MimeType: { JSON: "json" }, createTextOutput: (texto) => ({ texto, setMimeType() { return this; } }) },
  };
  vm.createContext(contexto);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../robo-sap/apps-script.gs"), "utf8").replace("TROQUE-ESTA-CHAVE", "segredo"), contexto);
  const post = (pedido) => JSON.parse(contexto.doPost({ postData: { contents: JSON.stringify(pedido) } }).texto);
  const simples = (valor) => JSON.parse(JSON.stringify(valor));
  return { planilha, props, post, contexto, simples };
}

test("Apps Script: chave, aba permitida, cópia da aba anterior, texto e número", () => {
  const { planilha, props, post, contexto, simples } = appsScript();
  assert.equal(JSON.parse(contexto.doGet().texto).ok, true);
  assert.deepEqual(post({ chave: "errada", teste: true }), { ok: false, erro: "A chave do robô não confere com a do Apps Script." });
  assert.deepEqual(post({ chave: "segredo", teste: true }), { ok: true, planilha: "Controle de Produção" });
  assert.equal(post({ chave: "segredo", aba: "Planilha1", linhas: [["a"], ["b"]] }).erro, "Aba não permitida: Planilha1");
  assert.equal(post({ chave: "segredo", aba: "MB51", linhas: [["a"]] }).erro, "Nenhuma linha recebida.");
  const antiga = planilha.insertSheet("MB51");
  antiga.valores = [["Material", "Ordem"], ["velho", "1"]];
  const tabela = robo.montarMb51(LISTA, "dd.mm.yyyy");
  const linhas = [tabela.cabecalho, ...tabela.linhas];
  // Mais linhas do que a folha tem: ela cresce.
  for (let i = 0; i < 1200; i++) linhas.push(["11272431-00", "BR02", "7000", "261", "19000002673", "-1", "PC", "01.10.2026"]);
  const resposta = post({ chave: "segredo", aba: "MB51", numericas: tabela.numericas, linhas });
  assert.deepEqual(resposta, { ok: true, aba: "MB51", linhas: 1204 });
  const mb51 = planilha.getSheetByName("MB51");
  assert.equal(mb51.valores.length, 1205);
  assert.deepEqual(simples(mb51.valores[1]), ["11272431-00", "BR02", "7000", "261", "19000002673", -2, "PC", "01.10.2026"]);
  assert.equal(mb51.valores[4][0], "000000012345", "Código continua texto");
  assert.equal(mb51.formatos[1], "@");
  assert.equal(mb51.formatos[6], undefined, "Quantidade fica como número");
  assert.equal(mb51.congeladas, 1);
  const copia = planilha.getSheetByName("MB51 (anterior)");
  assert.deepEqual(simples(copia.valores), [["Material", "Ordem"], ["velho", "1"]]);
  assert.equal(copia.oculta, true);
  assert.ok(props["robo:MB51"]);
  // Segunda vez: a cópia é trocada pela versão anterior mais recente.
  post({ chave: "segredo", aba: "MB51", numericas: [5], linhas: linhas.slice(0, 3) });
  assert.equal(planilha.getSheetByName("MB51 (anterior)").valores.length, 1205);
  assert.equal(planilha.getSheetByName("MB51").valores.length, 3);
});
