import { test } from "node:test";
import assert from "node:assert/strict";
import { buildEml, emailFileName, encodeHeader, formEmail, greeting } from "../lib/form-email.ts";
import type { ScrapForm, ScrapSignature } from "../lib/scrap-form.ts";
import type { CcForm } from "../lib/cc-form.ts";

const ccApprovers = { requester: "Pessoa Solicitante", manager: "Pessoa Gestor", scm: "Pessoa SCM", finance: "Pessoa Financeiro" };
const sig = (slot: ScrapSignature["slot"], signer: string): ScrapSignature => ({ field: `Assinatura_${slot}`, slot, signer, signedAt: "2026-10-07T13:00:00.000Z", check: "valid", coversWholeFile: false, detail: "" });
const ccItem = (index: number) => ({
  company: "BR00",
  plant: "BR02",
  wh: "7000",
  material: `1000${String(index).padStart(4, "0")}-00`,
  description: `PARAFUSO SEXTAVADO M8 ${index}`,
  quantity: -index,
  unitCost: 1.2345,
  costCenter: "BR000411",
  costCenterDescription: "Operational - Chassis",
});
const ccForm = (patch: Partial<CcForm> = {}, items = 2): CcForm => ({
  id: "7a2c1b4d-0000-4000-8000-000000000005",
  number: "CC-2026-0005",
  status: "signing",
  data: {
    period: "2026-10",
    items: Array.from({ length: items }, (_, index) => ccItem(index + 1)),
    mainReason: "Materials listed as LOSS in warehouse 7000.",
    reason: "LOSS",
    action: "Write off.",
    approvers: ccApprovers,
    scrapForms: [],
    sapDocument: "",
    notes: "",
  },
  signatures: [],
  fileVersion: 1,
  files: [],
  revision: 2,
  createdAt: "2026-10-07T09:00:00Z",
  updatedAt: "2026-10-07T09:00:00Z",
  createdBy: "admin",
  signedAt: null,
  sentAt: null,
  ...patch,
});
const morning = new Date(2026, 9, 7, 9, 30);

test("saudação pelo horário", () => {
  assert.equal(greeting(new Date(2026, 9, 7, 8)), "bom dia");
  assert.equal(greeting(new Date(2026, 9, 7, 13)), "boa tarde");
  assert.equal(greeting(new Date(2026, 9, 7, 19)), "boa noite");
});

test("FO.FI.C.007 para assinatura: e-mail formal com resumo, itens, quem falta e como assinar", () => {
  const mail = formEmail("cc", ccForm({ signatures: [sig("requester", "Pessoa Solicitante")] }, 18), { sender: "Pessoa Solicitante", link: "https://portal.test/?modulo=baixas&cc=x", now: morning });
  assert.equal(mail.subject, "Solicitação de assinatura – FO.FI.C.007 nº CC-2026-0005 – Ajuste de inventário de Outubro/2026");
  assert.match(mail.text, /^Prezados, bom dia\.\n\nEncaminho, em anexo, o formulário FO\.FI\.C\.007 – Inventory Adjustment nº CC-2026-0005, referente ao ajuste de inventário de Outubro\/2026, para análise e assinatura digital\./);
  assert.match(mail.text, /Resumo:\n• Itens: 18\n• Quantidade total: -171\n• Valor total: -R\$\s211,09\n• Centro de custo: BR000411 – Operational - Chassis\n• Depósito: 7000\n• Motivo: LOSS – Materials listed as LOSS in warehouse 7000\./);
  assert.match(mail.text, /• 15 · 10000015-00 · PARAFUSO SEXTAVADO M8 15 · -15 · R\$\s1,2345 · -R\$\s18,52\n… e mais 3 itens\. A lista completa está no PDF em anexo\./);
  assert.doesNotMatch(mail.text, /10000016-00/, "Lista longa: os primeiros 15 e o resto no PDF");
  assert.match(mail.text, /Já assinaram:\n• Solicitante: Pessoa Solicitante \(assinado em 07\/10\/2026\)/);
  assert.match(mail.text, /Aguardando assinatura de:\n• Gestor: Pessoa Gestor\n• SCM: Pessoa SCM\n• Financeiro: Pessoa Financeiro/);
  assert.match(mail.text, /Como assinar:\n1\. Abra o PDF em anexo no Adobe Acrobat Reader\./);
  assert.match(mail.text, /https:\/\/portal\.test\/\?modulo=baixas&cc=x/);
  assert.match(mail.text, /Agradeço desde já e fico à disposição para qualquer esclarecimento\.\n\nAtenciosamente,\nPessoa Solicitante$/);
  // HTML: o mesmo conteúdo, com tabela e negrito.
  assert.match(mail.html, /<b>FO\.FI\.C\.007 – Inventory Adjustment nº CC-2026-0005<\/b>/);
  assert.match(mail.html, /<th[^>]*>Material<\/th>/);
  assert.match(mail.html, /<li[^>]*>Gestor: Pessoa Gestor<\/li>/);
  // Versão curta (link de e-mail): sem itens e sem o passo a passo numerado.
  assert.ok(mail.short.length < 1500, `mailto curto (${mail.short.length})`);
  assert.doesNotMatch(mail.short, /10000001-00|Como assinar:/);
  assert.match(mail.short, /Os itens estão detalhados no PDF em anexo\./);
  assert.match(mail.short, /Para assinar, abra o PDF no Adobe Acrobat Reader/);
});

test("FO.FI.C.007 assinado: pede o lançamento no SAP ou só informa o documento", () => {
  const all = [sig("requester", "Pessoa Solicitante"), sig("manager", "Pessoa Gestor"), sig("scm", "Pessoa SCM"), sig("finance", "Pessoa Financeiro")];
  const mail = formEmail("cc", ccForm({ status: "signed", signatures: all }), { now: new Date(2026, 9, 7, 15) });
  assert.equal(mail.subject, "FO.FI.C.007 nº CC-2026-0005 assinado – Ajuste de inventário de Outubro/2026");
  assert.match(mail.text, /^Prezados, boa tarde\./);
  assert.match(mail.text, /devidamente assinado por todos os responsáveis\./);
  assert.match(mail.text, /Assinaturas:\n• Solicitante: Pessoa Solicitante \(assinado em 07\/10\/2026\)/);
  assert.match(mail.text, /Solicito, por gentileza, a efetivação do ajuste no SAP e o retorno com o número do documento gerado\./);
  assert.doesNotMatch(mail.text, /Como assinar|Aguardando assinatura/);
  assert.match(mail.text, /Atenciosamente,$/, "Sem nome: só a despedida");
  const posted = formEmail("cc", ccForm({ status: "signed", signatures: all, data: { ...ccForm().data, sapDocument: "4900012345" } }), { now: morning });
  assert.match(posted.text, /• Documento SAP: 4900012345/);
  assert.match(posted.text, /O ajuste já foi lançado no SAP \(documento 4900012345\)\. Encaminho para conhecimento e arquivo\./);
});

test("Scrap Form: itens com OP, VIN e classe; Financeiro só quando exigido", () => {
  const item = { date: "2026-09-24", material: "11272431-00", quantity: 1, name: "UNID DE CONTROLE <ELETR>", defect: "Queimou", cause: "F", vin: "1076", op: "19000002673", unitPrice: 1054.87, classification: "C" };
  const scrap: ScrapForm = {
    id: "5d1f6a3e-0000-4000-8000-000000000007",
    number: "SCRAP-2026-0007",
    status: "signing",
    data: { formDate: "2026-09-24", items: [item], approvers: { production: "André", quality: "Marcus", logistics: "Gleiber", finance: "Rosy" }, costCenter: "", sapDocument: "", pr: "", prDate: "", po: "", notes: "" },
    signatures: [],
    fileVersion: 1,
    files: [],
    revision: 2,
    createdAt: "2026-09-24T12:00:00Z",
    updatedAt: "2026-09-24T12:00:00Z",
    createdBy: "admin",
    signedAt: null,
    sentAt: null,
  };
  const mail = formEmail("scrap", scrap, { sender: "Pessoa Planejamento", now: morning });
  assert.equal(mail.subject, "Solicitação de assinatura – Scrap Form nº SCRAP-2026-0007 (24/09/2026)");
  assert.match(mail.text, /Encaminho, em anexo, o Formulário de Scrap A-B nº SCRAP-2026-0007, de 24\/09\/2026, para análise e assinatura digital\./);
  assert.match(mail.text, /• 11272431-00 · UNID DE CONTROLE <ELETR> · 1 · R\$\s1\.054,87 · 19000002673 · 1076 · C/);
  assert.match(mail.text, /• Ordem de produção: 19000002673/);
  assert.match(mail.text, /Aguardando assinatura de:\n• Produção: André\n• Qualidade: Marcus\n• Logística: Gleiber\n\n/, "Só classe C: sem o Financeiro");
  assert.match(mail.html, /UNID DE CONTROLE &lt;ELETR&gt;/, "Texto do formulário escapado no HTML");
  const signed = formEmail("scrap", { ...scrap, status: "signed", signatures: [sig("production", "André"), sig("quality", "Marcus"), sig("logistics", "Gleiber")] }, { now: morning });
  assert.equal(signed.subject, "Scrap Form nº SCRAP-2026-0007 assinado (24/09/2026)");
  assert.match(signed.text, /Solicito, por gentileza, o lançamento da baixa no SAP/);
});

test("rascunho .eml: abre no Outlook como mensagem nova, com HTML, texto e o PDF anexado", () => {
  const mail = formEmail("cc", ccForm(), { sender: "Pessoa Solicitante", now: morning });
  const pdf = new TextEncoder().encode("%PDF-1.7 conteúdo de teste");
  const eml = buildEml({ to: "a@empresa.test; b@empresa.test, inválido", subject: mail.subject, text: mail.text, html: mail.html, attachment: { name: "FO.FI.C.007 CC-2026-0005 Março-2026 - para assinatura.pdf", bytes: pdf } });
  assert.match(eml, /^X-Unsent: 1\r\nTo: a@empresa\.test, b@empresa\.test\r\nSubject: =\?UTF-8\?B\?/);
  assert.ok(eml.split("\r\n").every((line) => line.length <= 998), "Linhas dentro do limite do e-mail");
  const subject = [...eml.matchAll(/=\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=/g)].slice(0, 3).map((match) => Buffer.from(match[1], "base64").toString("utf8")).join("");
  assert.equal(subject, mail.subject, "Assunto com acentos codificado sem perder nada");
  const part = (type: string) => {
    const match = new RegExp(`Content-Type: ${type.replace("/", "\\/")}[^\\r]*\\r\\n(?:[^\\r]+\\r\\n)*\\r\\n([A-Za-z0-9+/=\\r\\n]+?)\\r\\n(?:\\r\\n)?--`).exec(eml);
    assert.ok(match, type);
    return Buffer.from(match[1].replace(/\r\n/g, ""), "base64");
  };
  assert.equal(part("text/plain").toString("utf8"), mail.text);
  assert.match(part("text/html").toString("utf8"), /^<!DOCTYPE html><html><head><meta charset="utf-8"><\/head><body><div style=/);
  assert.deepEqual(new Uint8Array(part("application/pdf")), pdf);
  assert.match(eml, /Content-Disposition: attachment; filename="=\?UTF-8\?B\?/, "Nome do anexo com acento codificado");
  assert.match(buildEml({ to: "", subject: "Teste", text: "a", html: "<p>a</p>" }), /^X-Unsent: 1\r\nSubject: Teste\r\n/, "Sem destinatário: o Outlook pede na hora");
  assert.equal(encodeHeader("Scrap Form SCRAP-2026-0007"), "Scrap Form SCRAP-2026-0007");
  assert.ok(encodeHeader("Solicitação de assinatura – FO.FI.C.007 nº CC-2026-0005 – Ajuste de inventário").split("\r\n ").every((word) => word.length <= 75));
  assert.equal(emailFileName("FO.FI.C.007 CC-2026-0005 Outubro-2026 - para assinatura.pdf"), "FO.FI.C.007 CC-2026-0005 Outubro-2026 - para assinatura - e-mail.eml");
});
