# Robô SAP (pasta robo-sap)

O robô roda no Windows, com o SAP aberto e logado. Ele roda a MB51 (BR02, movimentos 261/262, do dia 1 do mês anterior até hoje), exporta a lista e grava na aba MB51 da planilha por um App da Web do Apps Script. O portal não muda: depois é só clicar em **Atualizar dados**.

- `robo-sap.js` é o robô, em JScript do Windows Script Host; não precisa instalar nada.
- `Robo SAP.cmd` abre o robô; `config.txt` guarda URL, chave, centro, meses e layout.
- `apps-script.gs` é colado em Extensões → Apps Script da planilha. Ele só grava com a chave, só nas abas permitidas, e guarda a aba anterior em "<aba> (anterior)".
- A chave fica só nos arquivos entregues ao usuário. Aqui no repositório ela é `TROQUE-ESTA-CHAVE`.
- Testes: `tests/robo-sap.test.cjs` cobre a leitura da lista do SAP, os números e o Apps Script.

---

# MB51-73 — Senha de ADM para alterar; sem senha, só consulta

**Antes desta versão o portal publicado abria sem senha e com perfil ADMINISTRADOR para qualquer pessoa com o endereço** (dava para importar, marcar, editar e apagar). Agora:

- **Sem senha = Consulta.** Vê todas as abas, gráficos, PDFs e e-mails, mas nenhum botão de alterar aparece e o servidor recusa qualquer gravação (403), mesmo que alguém chame a API direto.
- **Senha de ADM = altera.** No topo, **Entrar como ADM** abre a página de entrada; depois de entrar, o topo mostra **ADM**, o botão **Acesso** e **Sair**. A sessão dura 8 horas.
- A senha de ADM é o Secret **`PORTAL_PASSWORD`** do Worker (mínimo de 12 caracteres). Se ele não existir, o portal fica só em consulta e a faixa azul avisa "A senha de ADM ainda não foi cadastrada".
- Analista (`PORTAL_ANALYST_PASSWORD`, opcional) continua escrevendo as observações da Ana e os formulários.

## Acesso (só ADM)

- **Aberto para consulta:** qualquer pessoa com o endereço vê tudo, sem alterar (o pedido desta versão).
- **Fechado (recomendado para dados sensíveis):** o endereço sozinho pede senha. Quem só consulta entra pelo **link de consulta** (fica 30 dias naquele navegador).
- **Gerar link novo** desliga o link anterior e todas as sessões abertas por ele. **Encerrar as outras sessões** derruba todo mundo menos você.

## Segurança

- Corrigido: o formulário de entrada mandava `Origin: null` (política `no-referrer`) e o servidor recusava a senha certa com "Origem inválida".
- Cabeçalhos em todas as respostas: CSP (sem script de fora nem `eval`), HSTS, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`, COOP/CORP e `noindex`.
- Proxy genérico `/api/sheets` (não era usado pela tela) removido.
- Freio contra robôs na consulta sem senha (600 pedidos por minuto por endereço) e limite de tentativas de senha e de link.
- Redirecionamento depois do login só para páginas do próprio portal.

## Publicação

1. Cloudflare → **Workers & Pages → controlofproduction → Settings → Variables and Secrets**: confira se existe o Secret **`PORTAL_PASSWORD`** com **12 caracteres ou mais**. Se não existir (ou for menor), **Add → Secret**. O `wrangler.jsonc` agora tem `REQUIRE_PASSWORD="false"`: a consulta começa aberta, e alterar sempre pede a senha.
2. Envie o pacote ao GitHub como sempre; o build publica sozinho.
3. Confira **MB51-73** no rodapé. Sem entrar, o topo mostra **CONSULTA**. Clique em **Entrar como ADM** e use a senha.

---

# MB51-72 — Enviar o GRÁFICO por e-mail para o Warehouse

Na aba **GRÁFICO**, o botão **Enviar por e-mail** (ao lado do número de OPs) monta um e-mail formal para o Warehouse com:

- **Gráfico do status das OPs**: todas as OPs da BOM, verdes (concluídas), amarelas (aguardando Warehouse) e vermelhas (não iniciadas), com a contagem de cada uma.
- **Gráfico de consumo por classe**: o percentual de materiais atendidos (MB51 + SCRAP) por OP nas classes A, B e C, igual ao da tela.
- **Materiais a enviar pelo Warehouse**: o que o saldo do 7000 não cobre, com a quantidade a enviar, o saldo do 2000 e a situação (transferir do 2000, reposição ou conferir o saldo), classe A primeiro. O corpo lista até 40 materiais; o resto fica na planilha.
- **Planilha em anexo**: a mesma do WAREHOUSE (Total_por_Item, Falta_por_OP e Criterios), só com os materiais a enviar.
- Resumo no começo (OPs por status, percentual atendido de cada classe, quantos materiais a enviar) e o pedido no fim: transferência do 2000 para o 7000 e previsão de reposição do que não tem saldo.

Os gráficos do e-mail têm fundo branco e trazem todas as OPs, sem paginar. Na janela dá para escolher o que vai (os dois gráficos, a lista, a planilha) e ver a prévia.

- **E-mail pronto (Outlook):** baixa um rascunho .eml. Ao abrir, o Outlook mostra a mensagem com os gráficos no corpo e a planilha anexada. É só conferir e enviar.
- **Abrir no e-mail:** abre o programa de e-mail padrão com um texto curto e baixa a planilha para anexar (link de e-mail não leva imagens).
- **Copiar texto:** copia o e-mail formatado, sem os gráficos.
- **Baixar gráficos:** baixa os dois gráficos em PNG.
- **Para**, **Cc** e **Assinar o e-mail como** ficam salvos no navegador. Na primeira vez, o Para vem dos destinatários do DOSSIÊ.

Sem **Atualizar dados**, a MB51 não foi lida: o e-mail leva só o status das OPs. A lista de faltas entra depois que os saldos do 7000 e do 2000 e as marcações da equipe terminam de carregar, a mesma regra da aba WAREHOUSE (OP concluída e item OK não entram).

---

# MB51-71 — Adicionar qualquer PDF, e-mail formal pronto e aba sempre na versão nova

## Adicionar PDFs (antes "Importar PDFs existentes")

Nas abas Scrap Forms e Baixa em CC, **Adicionar PDFs** guarda qualquer PDF de Scrap Form ou FO.FI.C.007: feito no Excel, emitido pelo portal, assinado ou não. O portal lê os itens e as assinaturas e guarda o arquivo.

- **PDF sem assinatura:** entra com o PDF guardado, em "Aguardando assinatura". Antes virava rascunho sem o arquivo.
- **PDF de um formulário que já está no portal** (por exemplo, o CC-2026-0003 assinado): entra como versão nova desse formulário.
  - Se esse PDF tiver menos assinaturas do que o formulário já tem, ele vem desmarcado. Marque para guardar mesmo assim.
- **PDF emitido pelo portal com um número que não está na lista:** entra como formulário novo.
- **Arquivo que já está guardado:** aparece como "Já está guardado no portal (nº)" e não é repetido.
- **FO.FI.C.007 com várias páginas:** a leitura passa por todas, tanto no formato antigo (20 itens na página 1) quanto no novo (40 por página). Descrições quebradas em duas linhas vêm inteiras, e o custo unitário vem com as casas que reproduzem o total.
- **PDF escaneado (sem texto):** entra com o PDF guardado e os itens vazios, para preencher em "Salvar dados".
- **Dados gravados no PDF:** os PDFs emitidos a partir desta versão levam os dados do formulário (Info "WBYDData"). Quando um deles volta ao portal, os dados entram exatos, sem depender da leitura do texto.

O único limite que continua é 1,5 MB por PDF.

## E-mail formal pronto

No quadro **Enviar** do Scrap Form e da Baixa em CC, o e-mail já vem escrito, em tom formal:

- saudação pela hora do dia;
- resumo (itens, quantidade, valor, centro de custo, depósito, motivo);
- lista dos itens (até 15; o resto fica no PDF);
- quem já assinou e quem falta;
- como assinar;
- despedida com o seu nome.

No formulário já assinado, o e-mail encaminha o documento e pede o lançamento no SAP. Se o Doc. SAP já estiver preenchido, o e-mail só informa o número.

- **E-mail pronto com PDF:** baixa um rascunho .eml. Ao abrir o arquivo, o Outlook mostra a mensagem nova formatada, com o PDF anexado. É só conferir e enviar.
- **Abrir no e-mail:** abre o programa de e-mail padrão com um texto mais curto e baixa o PDF para anexar.
- **Copiar texto:** copia formatado, pronto para colar no Outlook ou no Teams.
- **Assinar o e-mail como:** o nome que vai na despedida. O portal guarda esse nome no navegador.
- O assunto e a prévia do e-mail ficam logo abaixo dos botões.

## Aba sempre na versão nova

Uma aba aberta antes de uma atualização continuava com o código antigo e gerava o PDF no formato velho. Agora:

- **Gerar PDF para assinatura** confere a versão publicada. Se a aba estiver velha, o portal salva o rascunho, recarrega a página e gera o PDF já na versão nova, uma vez só.
- Quando a aba volta a ficar em foco e há versão nova, aparece a faixa **O portal foi atualizado → Atualizar agora**.
- A versão fica num lugar só (`lib/version.ts`), o mesmo no Worker (`/api/version`) e no rodapé.

---

# MB51-70 — Anexar qualquer PDF e FO.FI.C.007 com as assinaturas no fim

## Anexar PDF assinado aceita qualquer PDF

Scrap Form e Baixa em CC: **Anexar PDF assinado → Salvar esta versão** guarda qualquer PDF como nova versão do formulário. Não há mais bloqueio nem aviso para:

- PDF de outro formulário (outro número);
- PDF sem nenhuma assinatura;
- PDF com outro número de páginas ou outro conteúdo;
- arquivo igual à versão anterior;
- assinatura que não dá para conferir (arquivo regravado depois de assinado).

**Vale o que está no arquivo anexado.** Quem assinou num quadro conta como assinado. Um PDF sem assinatura deixa o formulário em "Aguardando assinatura".

O **Baixar PDF** e o **Ver PDF** usam sempre a última versão anexada. As anteriores ficam em **Histórico de PDFs**.

O único limite que continua é o tamanho: até 1,5 MB por PDF.

## FO.FI.C.007 com as assinaturas no fim

- O número do formulário (Nº CC-…, em vermelho) saiu do cabeçalho. Ele continua no rodapé e no nome do arquivo.
- **Até 20 itens:** tudo numa página, como antes.
- **Mais de 20 itens:** são 40 itens por página. O TOTAL, o REMARKS e o quadro de aprovação (as quatro assinaturas) ficam embaixo do último item. Por exemplo, 57 itens dão 40 na página 1 e 17 na página 2, com as assinaturas na página 2.
- Se a última página tiver mais de 24 itens, as assinaturas vão para uma página só delas, no fim.
- Para um formulário que já foi emitido no formato antigo: **Reabrir para corrigir → Gerar PDF para assinatura**.

---

# MB51-69 — DOSSIÊ: cobrança de transferências ao Warehouse

Nova aba **DOSSIÊ** (link direto `?modulo=dossie`). Para cada material transferido sem justificativa (por exemplo, 311 do 2000 para o 7000), o portal monta o dossiê com a prova da MB51 e acompanha a cobrança até o encerramento.

## Como abrir um dossiê

1. Na MB51, filtre o material (centro BR02). No layout, deixe também **Data de lançamento**, **Hora de entrada** e **Nome do usuário**: é o que mostra quem transferiu e quando.
2. Exporte com **Exportar ▸ Arquivo local… ▸ Na área de transferência**.
3. No portal: **DOSSIÊ ▸ Novo dossiê (colar MB51)**, cole (Ctrl+V) e clique **Ler MB51**. Também aceita o arquivo exportado (xlsx, xls, csv ou txt) e linhas copiadas do Excel com a linha de títulos.
4. A prévia mostra um dossiê por material que tem transferência para o depósito de destino (padrão 7000). Transferência que já está em outro dossiê aparece bloqueada. Clique **Abrir dossiê**.

A leitura entende números do SAP nos dois formatos (1.573,49- e 1,573.49-) e datas em dia/mês, mês/dia ou ano.mês.dia. Quando a data é ambígua, a prévia deixa escolher o formato.

## O que o dossiê mostra

- **Transferência cobrada:** documento, itens, TMv, de → para, quantidade, data e hora, usuário e texto do documento.
- **Depois da transferência, no destino:** consumo (261 menos 262), saída para outro depósito, sucata e o que continua parado, com valor e dias. As saídas abatem primeiro a entrada mais antiga do depósito (FIFO).
- **Constatações automáticas:** documento sem texto, nenhum consumo, material fora das BOMs cadastradas no portal (BOM × OP e plano) e colunas que faltaram na MB51.
- **Saldos e valor:** saldo de cada depósito pelos lançamentos colados. O botão **Conferir saldo atual na planilha** lê as abas 7000/2000/1500 e guarda o resultado no dossiê.
- **Preço:** o digitado no dossiê; senão o valor do estoque na planilha; senão a média dos lançamentos com valor na MB51.
- **Lançamentos da MB51:** todos os colados, com a transferência em destaque. **Colar mais lançamentos** inclui o que aconteceu depois, sem repetir documento.

## Cobrança e andamento

- **Copiar cobrança** (para e-mail ou Teams), **E-mail com PDF** (baixa o PDF e abre o e-mail) e **Baixar PDF**. O PDF é A4 e traz a prova, as constatações, os lançamentos, o texto da cobrança, o andamento e os prints.
- **Marcar como cobrado** registra a 1ª cobrança. **Registrar nova cobrança** registra os reforços, e o texto passa a dizer "Reforçando a cobrança enviada em …".
- **Resposta do Warehouse** e **Encerrar**: devolvido, justificado, estornado, baixa/ajuste ou outro, com o documento SAP. **Reabrir** volta o dossiê.
- **Prints:** até 5 por dossiê, em PNG ou JPG de até 1,5 MB. Com o dossiê aberto, Ctrl+V cola o print.
- **Histórico** de tudo, com data e perfil.
- **Lista:** situação, prazo vencido destacado, valor parado em andamento, **Copiar resumo** (todos os dossiês em andamento num texto só) e **Baixar planilha**.

Administrador e Analista abrem, cobram e encerram. O perfil Consulta vê, copia e baixa o PDF. Dossiê já cobrado ou com prints só o Administrador apaga. A numeração é DOS-2026-0001…, nunca reaproveitada.

**Publicação:** sem Secret novo. As tabelas `dossies`, `dossie_counters` e `dossie_files` são criadas sozinhas no primeiro acesso; os scripts de cópia do D1 e de preparação do Turso já incluem as três. Confirme **MB51-69** no rodapé ou `dossies: true` em `/api/version`.

---

# MB51-68 — Baixa em CC direto de uma planilha Excel

Na **Baixa em CC (FO.FI.C.007)**, o botão **Importar Excel** preenche todos os itens de uma vez a partir de uma planilha como a `LOSS 7000.xlsx` (exportada da MB52).

- **Colunas lidas:** Material, Texto breve material, Centro, Depósito, Utilização livre e Val.utiliz.livre. Comentários é opcional.
- **Nomes alternativos:** Código, Descrição, Qtd/Quantidade, Custo unitário e Centro de custo também servem. O cabeçalho pode estar abaixo de linhas de título.
- **Quantidade:** "Utilização livre" (estoque) vira saída do estoque, com quantidade negativa. Uma coluna "Quantidade" entra com o sinal que tiver.
- **Custo unitário:** é o valor da linha dividido pela quantidade, com as casas necessárias para o total bater com a planilha.
- **Linhas ignoradas:** linhas sem material ou com quantidade zero (por exemplo, a linha de total) ficam de fora, e a mensagem informa quantas.
- **Remarks:** com um único comentário (por exemplo, LOSS), o portal preenche Reason, Main reason e Action. Texto que você já digitou não é trocado.
- **Lista longa:** a partir de 13 itens, os itens aparecem numa tabela compacta e editável. Nela, **Centro de custo de todos os itens → Aplicar** troca o CC de uma vez, e a Action acompanha. **Limpar itens** esvazia a lista.
- **Até 300 itens por formulário.** O PDF traz 20 itens e os quatro quadros de assinatura na 1ª página. Os demais itens vão em páginas de continuação (40 por página), com "Página x/y" e o TOTAL geral. A conferência do PDF assinado compara todas as páginas.

---

# MB51-67 — Importação sem aviso de "regravado" e PR/PO em qualquer formulário

- **Importar PDFs existentes:** quem assinou o PDF antigo conta como assinado, mesmo que o arquivo tenha sido regravado depois. Saíram da importação os avisos de "não confere", "alterações depois da última assinatura" e "ID autoassinado". Quando alguém assina de novo um formulário importado, só essa assinatura nova é conferida.
- **PR, Data da PR, PO, centro de custo e Doc. SAP:**
  - **Rascunho** (inclusive um Scrap Form novo): o quadro **Reposição e baixa no SAP** aparece e salva junto com **Salvar rascunho**.
  - **Formulário importado:** salva com **Salvar dados**.
  - **Formulário emitido pelo portal:** ao mudar algum campo aparece **Salvar PR e PO** no rodapé. Na Baixa em CC, o botão é **Salvar Doc SAP**.

---

## Histórico da MB51-66 — BOMs do plano de produção (OEBOM) no 7000 × PROJETOS

A aba **7000 × PROJETOS** ganhou o quadro **BOMs do plano de produção (OEBOM)**. Serve para os projetos que não têm OPs cadastradas: você sobe o arquivo OEBOM da China e informa quantos ônibus ainda faltam, conforme o plano de produção.

## Como usar

1. **Adicionar BOMs (OEBOM)** → escolha um ou vários arquivos `…-DWB1339_OEBOM_A7_V9….xlsx`.
2. O portal lê no navegador:
   - a aba **采购明细（统计表）BOM（Stats）**, coluna **Overseas Factory Use Total** (quantidade usada no Brasil por ônibus; peças com 0, soldadas na China, ficam fora);
   - a aba **自制件KD清单 Self-made Part KD list** (peças KD). O mesmo material nas duas abas conta uma vez (vale a maior quantidade);
   - modelo, DWB e revisão pelo nome do arquivo (`BC22S02 · DWB1339`, `A7_V9`).
3. Informe os **ônibus restantes** de cada um (0 = projeto concluído) e clique **Salvar**. Mandar o mesmo DWB de novo substitui a BOM anterior.
4. **Analisar saldo 7000**. Demanda do projeto = quantidade por ônibus × ônibus restantes. Não usa OPs nem MB51.
5. Mudou o plano? Altere o número no card e clique **Salvar**: a análise já aberta recalcula na hora, sem ler o 7000 de novo.

As BOMs do plano entram junto com as BOMs × OP, com os mesmos papéis (Em produção, Vai entrar, Fora da análise) e a mesma planilha de devolução (coluna "Ônibus restantes (plano)"). Se um DWB do plano também estiver cadastrado como BOM × OP, a tela avisa para deixar um deles **Fora da análise** e não contar duas vezes.

Somente o **Administrador** cadastra, altera e apaga. O perfil Consulta vê. As BOMs do plano não aparecem no seletor da BOM × OP.

Conferência com os arquivos reais (12 OEBOMs + EXPORT 7000 de 02/10/2026): 597 manter, 19 excedente, 120 devolver tudo, R$ 512.246,36 para devolver — igual à planilha de análise feita à parte.

**Publicação:** igual às anteriores. Sem Secret novo e sem tabela nova (usa `datasets`/`entries` com id `plano:…`). Confirme **MB51-66** no rodapé ou `planBoms: true` em `/api/version`.

---

## Histórico da MB51-65 — Importar os formulários que já existem

Nas duas abas (Scrap Forms e Baixa em CC) há o botão **Importar PDFs existentes**. Ele cadastra os Scrap Forms e FO.FI.C.007 feitos antes do portal: PDF do Excel, assinado no Adobe.

1. Escolha vários PDFs de uma vez. Para cada um, o portal lê no próprio navegador:
   - o **tipo**: Scrap Form ou FO.FI.C.007. Dá para trocar na lista;
   - os **itens**: data, P/N, quantidade, descrição, defeito, causa, VIN, OP, preço e classe; no FO.FI.C.007, company/plant/WH, quantidade com sinal, custo e centro de custo;
   - a **data do formulário** e os **nomes** impressos no quadro de aprovação;
   - as **assinaturas**. Nos PDFs antigos os campos se chamam "Signature2…": cada um vale pela posição na linha de assinaturas (Produção, Qualidade, Logística, Financeiro, da esquerda para a direita) ou, no FO.FI.C.007, de cima para baixo (Solicitante, Gestor, SCM, Financeiro). O campo **Assinatura_Financeiro** já existente fica no quadro do Financeiro.
2. A lista mostra como cada um vai entrar. Por exemplo:
   - "Entra aguardando: falta Financeiro";
   - "Sem assinatura: entra como rascunho";
   - avisos de assinatura inválida, ID autoassinado ou PDF escaneado (sem texto).
3. **Importar**. Os formulários ganham número do portal em ordem de data (SCRAP-2026-0001…, CC-2026-0001…).
   - O PDF original fica guardado como versão 1, sem nenhuma alteração.
   - PDF sem nenhuma assinatura vira **rascunho**: o portal gera o PDF dele para assinar.
   - O mesmo PDF não entra duas vezes.
   - PDF assinado acima de 1,5 MB não cabe no portal e aparece bloqueado.
4. **Depois de importado:**
   - Os dados são só a transcrição do PDF e podem ser corrigidos com **Salvar dados**, sem mexer nas assinaturas. Use isso para preencher os itens de um PDF escaneado ou corrigir algo que a leitura errou.
   - Quando a Rosy assinar, anexe o PDF com **Anexar PDF assinado**, como num formulário do portal. A conferência compara a página com o PDF importado.

---

## Histórico da MB51-64 — Baixa em CC (FO.FI.C.007) no portal

A aba **SCRAP FORM** agora tem dois documentos, cada um com sua lista: **Scrap Forms** e **Baixa em CC · FO.FI.C.007**. O portal guarda e cria os PDFs dos dois. A aba BAIXA CC da planilha continua no Google Sheets e o portal não a lê.

## Fluxo da baixa em CC

1. **Nova baixa em CC**, ou **Criar baixa com eles** no quadro "Scrap Forms prontos para baixa". Esse quadro conta os Scrap Forms assinados por todos que ainda não estão em nenhum FO.FI.C.007.
2. **Origem: Scrap Forms.** Marque os formulários e clique em **Incluir itens dos selecionados**. Cada peça vira um item com:
   - **quantidade negativa**, que é a saída do estoque;
   - o **preço unitário do Scrap Form** como custo unitário;
   - BR00 / BR02 / 7000 e o centro de custo **BR000411 – Operational - Chassis** como padrão. O portal lembra o último centro de custo usado e tudo pode ser editado.

   Os textos de REMARKS (motivo principal, REASON e ACTION) são preenchidos em inglês, como no modelo. Texto editado à mão não é trocado.
3. **Itens à mão** também funcionam: company, plant, WH, código, descrição (vem da BOM), quantidade, custo unitário (MM60 ou último Scrap Form), centro de custo e a descrição dele. Quantidade positiva é entrada (sobra no inventário), e o portal avisa. Limite: 20 itens.
4. **Gerar PDF para assinatura.** O PDF sai em uma página A3 paisagem, no layout do *FO.FI.C.007 - INVENTORY ADJUSTMENT*:
   - cabeçalho com o mês de referência e o número **CC-2026-0001…**, uma numeração própria que nunca é reaproveitada;
   - tabela de itens com TOTAL de quantidade e de custo;
   - REMARKS;
   - quadro **APPROVAL** com os **4 campos de assinatura digital obrigatórios**: Assinatura_Solicitante (Requester), Assinatura_Gestor (Direct Manager), Assinatura_SCM (SCM Manager) e Assinatura_Financeiro (Finance Department).
5. **Enviar, assinar no Adobe e anexar o PDF assinado** funcionam como no Scrap Form, com as mesmas conferências (certificado, conteúdo igual ao emitido, cópia antiga, assinatura reaproveitada). A baixa só fica **Assinada** com os quatro quadros conferidos. Uma assinatura feita num campo do Scrap Form não conta aqui.
6. Depois de emitido, anote o **Documento SAP da baixa**. Ele fica só no portal.

Na lista de Scrap Forms, cada formulário incluído numa baixa mostra **Baixa CC-…**. O botão **Conferir um PDF** confere os dois tipos.

### Banco de dados

Há duas tabelas novas, `cc_forms` e `cc_counters`, que o portal cria sozinho no primeiro acesso. Os PDFs ficam na mesma tabela `scrap_files`. Os scripts de cópia do D1 e de preparação do Turso já incluem as tabelas novas.

---

## Histórico da MB51-63 — SCRAP FORM sem leitura da planilha

- O portal **não lê mais a aba BAIXA CC** do Google Sheets. A aba continua na planilha, do jeito que está; o portal só não depende dela.
- Saíram o botão "PDFs da planilha (BAIXA CC)", a rota que lia a aba e o arquivo `BAIXA_CC_modelo.xlsx`.
- Os Scrap Forms e os PDFs (gerado e assinados) ficam guardados no próprio portal, como na MB51-62.
- Novo quadro **Reposição e baixa no SAP** em cada formulário emitido: **PR**, **Data da PR**, **PO**, centro de custo e documento SAP da baixa. Ficam só no portal (não mudam o PDF assinado), aparecem na lista e entram na busca.

---

## Histórico da MB51-62 — SCRAP FORM: preencher, gerar o PDF para assinatura e guardar o PDF assinado

A aba **BAIXA CC** virou **SCRAP FORM**. O link antigo (`?modulo=baixas`) continua funcionando. A leitura da aba BAIXA CC da planilha continua disponível no botão **PDFs da planilha (BAIXA CC)**.

## Fluxo

1. **Novo Scrap Form.** Para cada item, preencha data, P/N SAP, quantidade, descrição do defeito, causa (A–H), N° VIN, ordem de produção e preço unitário.
   - Ao digitar o P/N, o portal busca a **descrição e a classe (A/B/C) nas BOMs cadastradas**. Se o P/N estiver em mais de uma BOM, vale a classe mais alta.
   - Se a descrição ou a classe digitada for diferente da BOM, aparece um aviso com o botão **Usar a da BOM**.
   - **Buscar preços na MM60** lê a aba MM60 e preenche os preços vazios (Preço ÷ Unidade preço).
   - Formulários anteriores sugerem o último preço do P/N e o VIN de cada OP.
   - **Duplicar** cria outro item com a mesma OP, VIN e defeito.
   - Limite: 18 itens por formulário.
2. **Gerar PDF para assinatura.** Se faltar algum campo, o portal salva o rascunho e destaca o que falta. Com tudo preenchido, ele gera o PDF e baixa o arquivo. O PDF tem:
   - uma página Carta paisagem, no layout do Scrap Form;
   - número próprio (SCRAP-2026-0001…), que nunca é reaproveitado;
   - datas em dd/mm/aaaa, valores em R$ e o total do formulário;
   - legenda das causas e nomes dos responsáveis;
   - **um campo de assinatura digital vazio em cada quadro**: Assinatura_Producao, Assinatura_Qualidade, Assinatura_Logistica e Assinatura_Financeiro.
   - O Financeiro só é exigido se houver item classe A ou B. Se todos os itens forem classe C, o quadro sai como "N/A".
3. **Enviar para assinatura.** O botão **E-mail com PDF** baixa o PDF e abre o e-mail já com o texto ("Falta: …"); é só anexar. Também dá para usar **Compartilhar…** (quando o navegador permite) ou **Copiar texto** para o Teams.
4. **Assinar no Adobe**, como hoje. Cada responsável abre o PDF, clica no campo do **próprio quadro** e assina com o ID digital.
5. **Anexar PDF assinado.** Toda vez que um PDF voltar com mais assinaturas, anexe-o no formulário. O portal confere no navegador:
   - **quem assinou** e em que quadro, pelo nome do certificado, não pelo nome digitado no Adobe;
   - se **cada assinatura é válida**: o conteúdo coberto não mudou e a assinatura criptográfica confere com o certificado. Uma assinatura que não dá para conferir não preenche o quadro;
   - se a página é **a mesma emitida pelo portal**, sem itens, valores ou nomes trocados e sem nada desenhado por cima;
   - se o arquivo é **mais antigo** que o já guardado, por faltar uma assinatura já registrada;
   - se a **mesma assinatura** foi reaproveitada em dois quadros;
   - **quem ainda falta**.

   Arquivo que falha nessas conferências não é salvo.
6. Com os quadros obrigatórios assinados, o formulário fica **Assinado**. O PDF final fica guardado no portal: **Baixar PDF assinado**, **E-mail com PDF** (marca como enviado), **Copiar texto**. Opcional: anote centro de custo e documento SAP da baixa.

## Outros pontos

- **Conferir um PDF**: confere as assinaturas de qualquer Scrap Form, inclusive os antigos feitos no Excel. Roda só no navegador; o arquivo não é enviado.
- Avisos que **não bloqueiam**:
  - mesma pessoa em dois quadros;
  - quem assinou é diferente do nome previsto (aparece "Previsto: …");
  - ID digital próprio (autoassinado);
  - alterações depois da última assinatura.
- O portal **não confere a cadeia do certificado** até a certificadora da BYD; isso continua sendo feito pelo Adobe.
- **Reabrir para corrigir** volta o formulário para rascunho. As assinaturas deixam de valer e os PDFs anteriores ficam no **Histórico de PDFs**. Um formulário já assinado por todos só pode ser reaberto pelo administrador.
- **Perfis**: Administrador e Analista preenchem e anexam. Consulta vê, baixa e envia. Apagar formulário já emitido: só o administrador.
- **Limites**: PDF de até 1,5 MB (o gerado tem cerca de 15 KB; com 4 assinaturas, cerca de 100 KB). O PDF fica no banco em partes, dentro dos limites do D1 e do Turso.

## Publicação

Envie o pacote para o GitHub como antes. **O pacote não traz o `wrangler.jsonc`**, e o do repositório fica como está. Não há Secret novo. As tabelas `scrap_forms`, `scrap_counters` e `scrap_files` são criadas sozinhas no primeiro uso. Nova dependência: `pdf-lib`, que o build instala pelo `package.json`/`pnpm-lock.yaml`. Confira **MB51-62** no rodapé.

Validação:
- 187 testes de regras. Os 18 novos do Scrap Form cobrem preenchimento, PDF, leitura de assinaturas válidas, adulteradas, forjadas, sem certificado, reaproveitadas e em campo fora do quadro, RSA-PSS, ECDSA, certificado por SKI e conteúdo trocado entre assinaturas.
- 49 testes de interface. Os 3 novos cobrem gerar, anexar o assinado e conferir um PDF.
- 6 testes da API e a suíte do banco em D1 e Turso: numeração sem reaproveitar, versões em partes, conflito, perfis, reabertura e exclusão.
- As assinaturas dos 16 PDFs reais do Scrap Form foram conferidas com o resultado idêntico ao do pyHanko.
- Build aprovado. Fluxo completo conferido no Chromium (desktop e celular): gerar no navegador, assinar os 4 quadros e anexar.

---

## Histórico da MB51-61 — Aba 1300 removida; nova aba BAIXA CC

## O que mudou

- A aba **1300 · ADITIVOS** saiu do portal (menu, rotas, leitura do Sheets e textos). Links antigos `?modulo=aditivos` abrem a tela inicial.
- Nova aba **BAIXA CC**: baixas de centro de custo (FO.FI.C.007) com o PDF de cada uma.

## Como montar a aba na planilha do portal

1. Crie uma aba chamada **BAIXA CC** (também vale `BAIXAS CC`, `BAIXA CENTRO DE CUSTO` ou `BAIXAS`).
2. Na primeira linha, coloque os títulos. A ordem não importa:

| Coluna | Obrigatória | Observação |
|---|---|---|
| Centro de custo | sim | ex.: CC1001 |
| Documento | sim, ou PDF | nº do FO.FI.C.007 / documento SAP |
| PDF | sim, ou Documento | link de compartilhamento do arquivo no **Google Drive** |
| Data | não | data da baixa (dd/mm/aaaa) |
| Descrição do centro de custo | não | nome da área |
| Material, Descrição, Quantidade, UMB | não | |
| Valor | não | em R$ |
| Motivo, Solicitante, OP, Status | não | |

3. Uma linha por baixa. Suba o PDF no Drive (botão direito → **Compartilhar → Copiar link**) e cole o link na coluna PDF, como texto. `=HYPERLINK("link";"texto")` também funciona quando o portal usa a conta de serviço Google. Chip de arquivo do Google ("@arquivo") não funciona: o portal não recebe o link do chip.

O arquivo `BAIXA_CC_modelo.xlsx` tem os títulos e uma linha de exemplo. Importe-o como nova aba da planilha (Arquivo → Importar → Inserir nova página) e renomeie a aba para **BAIXA CC**.

## Na tela

- A aba é lida uma vez ao abrir; depois, só em **Atualizar**.
- Indicadores: total de baixas, valor baixado, centros de custo e linhas sem PDF.
- Filtros: busca, centro de custo, mês e com/sem PDF. Os cartões por centro de custo também filtram.
- **Ver PDF** abre o arquivo do Drive dentro do site. Quem não tiver acesso ao arquivo no Google vê "Acesso negado"; aí é preciso compartilhar o arquivo ou a pasta com essa pessoa. **Abrir no Drive** abre em outra aba.
- **Baixar Excel** com todas as linhas do filtro e o total por centro de custo.
- O portal só consulta. Não grava na planilha, no Drive nem no SAP. Só links `http(s)` viram botão; o resto aparece como "Link inválido".

## Publicação

Pacote MB51-61: sem Secret novo e sem mudança de tabelas.

Validação: 169 testes de regras (7 novos da BAIXA CC: colunas, datas, links, PDF do Drive, leitura protegida contra a aba errada), 46 de interface, 6 da API e suíte do banco em D1 e Turso. Build aprovado. Conferido no Chromium em desktop e celular.

---

## Histórico da MB51-60 — Botão "Tudo OK"

Novo botão **✓ Tudo OK (N OPs)**, somente para o administrador. Fica na barra da **BOM × OP** (ao lado de "Marcar tudo como OK") e no **GRÁFICO**.

- Um clique, com confirmação, marca **todas as OPs da BOM ativa como Concluídas**. Os cartões e as barras ficam verdes (100%), e **todos os itens aparecem como OK** ("✓ OK · OP concluída", linha verde).
- É **uma única gravação** no banco (status das OPs), não uma marcação por material. Uma BOM com 74 OPs e 43 mil itens não gasta a cota de gravações do D1.
- As OPs concluídas saem dos pedidos do **Warehouse** e da reserva do **7000 × PROJETOS**.
- Nada é lançado no SAP. As diferenças BOM × MB51 continuam nas abas e no Excel para auditoria, com a observação de que a OP foi concluída pela equipe.
- Com todas as OPs concluídas, o botão vira **Reabrir todas as OPs**, que volta todas para "Não iniciada". As marcações feitas item a item continuam salvas.
- Uma OP pode continuar sendo concluída ou reaberta sozinha, no botão de status dela; os itens acompanham.
- "Marcar tudo como OK" (item a item) agora ignora itens de OPs já concluídas.

Validação: 162 testes de regras, 45 de interface (2 novos: Tudo OK/Reabrir e perfil consulta sem o botão), 6 da API e suíte do banco (lote de 74 OPs numa transação, OP de outra BOM recusa o lote, só admin). Build aprovado.

---

## Histórico da MB51-59 — Publicar no Worker `controlofproduction` (conta nova)

**Leia `MUDAR-DE-CONTA.md` antes de publicar.**

- O `wrangler.jsonc` usa o nome `controlofproduction` e **não tem `database_id`**. O deploy liga (ou cria) o banco `controle-producao-db` da conta onde publica. Isso resolve o erro `D1 binding 'DB' references database 'c21fba5e…' which was not found [code: 10181]`.
- `REQUIRE_PASSWORD=true` agora vem do próprio arquivo. Um Worker novo sem `PORTAL_PASSWORD` fica bloqueado, nunca aberto sem senha.
- Novo `scripts/copiar-banco-d1.mjs`: converte o `wrangler d1 export` da conta antiga num SQL que pode ser aplicado na conta nova. Funciona mesmo se as tabelas já existirem, não duplica nada ao repetir e não apaga o que já está lá. Copia BOMs, status, marcações e notas da Ana; não copia sessões.
- Ensaio feito com dois bancos D1 locais: exportar, converter e aplicar duas vezes num banco que já tinha uma nota nova. Resultado: contagens corretas, nota nova preservada, quebras de linha, aspas e acentos intactos.
- Nenhuma mudança nas regras do portal. 162 testes de regras, 43 de interface, 6 da API e suíte do banco (D1 e Turso) aprovados.

---

## Histórico da MB51-58 — Cadastro de BOM no formato SAP (sem OPs no cabeçalho)

## Por que a BOM 1363 não entrava

O arquivo `BOM BC22S02_1363.xlsx` tem as abas COMPARAÇÃO, **BOM SAP**, KIT ENC, MB52 e MM60.

- A janela abria na **primeira aba (COMPARAÇÃO)**, que não tem coluna UMB.
- A BOM de verdade está na aba **BOM SAP** (Item lista técnica, Material, Qtd.necessária, UMB, CLASSIFICAÇÃO), mas **não tem números de OP** em lugar nenhum. A versão anterior só aceitava BOM com as OPs nas colunas, como na aba CONSUMO da BOM 1268.
- O erro aparecia só num aviso rápido, e **Confirmar importação** ficava cinza sem explicação.

## O que mudou

- **Escolhe a aba certa sozinha.** Cada aba aparece com um resumo, por exemplo `BOM SAP · 582 materiais · sem OPs no cabeçalho`. Abas MB52, MM60, KOB1 e COOIS não são tratadas como BOM.
- **Confere sozinho** ao abrir o arquivo e a cada mudança. O erro fica **dentro da janela**, dizendo o que falta e qual aba usar.
- **OPs coladas.** Se a aba não tem OPs nas colunas, aparece o campo **OPs desta BOM**. Cole os números (um por linha, ou separados por espaço/vírgula). Também aceita uma aba **Ordens** com Modelo + Ordem.
- **Cabeçalho abaixo de título** e colunas SAP comuns (`Item lista técnica`, `SAP No.`, `BOM QTY`, `Unit`) são reconhecidos. `Qtd.necessária` tem prioridade sobre uma coluna "Quantidade" genérica.
- **Aba MB51 no arquivo é opcional.** Se ela não cruzar, a BOM entra assim mesmo e a MB51 do Google Sheets é lida em **Atualizar dados**.
- Modelo e revisão vêm do nome do arquivo (`BOM BC22S02_1363.xlsx` → **BC22S02**, **BOM 1363**). Dá para trocar antes de confirmar.
- **Corrigir nome/OPs**: além de nome e revisão, dá para **incluir OPs novas** liberadas para a mesma BOM. Depois clique em **Atualizar dados**.
- A janela rola por dentro em telas baixas (notebook 1366×768).

Teste com o arquivo real: aba BOM SAP detectada, 582 materiais (A 15 · B 42 · C 525; PCS, M, KG, L), cadastro enviado com as OPs coladas (~130 KB).

## Como cadastrar a BOM 1363

1. **BOM × OP → Cadastrar nova BOM** → escolha o arquivo.
2. Confira **Modelo** e **Revisão** e mantenha a aba **BOM SAP**.
3. Cole as **OPs desta BOM** e clique **Confirmar importação**.
4. Clique **Atualizar dados** para ler a MB51 dessas OPs.

## Validação

160 testes de regras (8 novos da importação), 43 de interface (importação completa pelo arquivo, erro na janela, OPs coladas), 6 da API e a suíte do banco em D1 e Turso (edição de OPs). Build aprovado. Publicação igual à anterior; confirme **MB51-58** no rodapé. Sem Secret novo e sem mudança de tabelas.

---

## Histórico da MB51-57 — Apagar/corrigir BOM, isolamento por BOM e revisão geral

## Apagar uma BOM cadastrada errada

Em **BOM × OP**, abaixo de **Cadastrar nova BOM**, o administrador tem:

- **Corrigir nome** — muda só o modelo/revisão que aparece no seletor (ex.: `BC22X — CONSUMO` → `BC22X — BOM 1339`). Linhas, OPs, status e marcações continuam iguais.
- **Apagar esta BOM** — abre uma confirmação com o resumo da BOM. **Baixar cópia antes** gera um Excel no formato de importação. **Apagar definitivamente** remove, numa única transação, a BOM, os **status das OPs** e as **marcações OK** dela. Não altera SAP, planilhas, depósitos, outras BOMs nem notas da Ana.

Proteções: somente **Administrador**; mesma origem; a BOM precisa estar na mesma versão aberta na tela (se outra pessoa reimportou, a exclusão é recusada). A BOM de referência do pacote (**BC22X — OP1268 · 02/09/2026**) não pode ser apagada nem renomeada, porque ela volta pelo pacote. Perfil **Consulta** não vê os botões.

Depois de apagar, o seletor passa para outra BOM automaticamente. Um link antigo para a BOM apagada também volta para uma BOM válida.

## Conferência: cada BOM puxa só os próprios dados

Conferido no código e em testes automáticos:

- A tela só aceita a resposta cujo `id` é a BOM selecionada; respostas atrasadas de outra BOM são descartadas.
- A MB51 é cruzada somente com as OPs da BOM ativa. Teste: a MB51 tem 9 PCS do mesmo material numa OP de outra BOM, e o consumo exibido continua sendo só o da OP desta BOM.
- Status das OPs e marcações OK são gravados por BOM. Apagar uma BOM não mexe nos status da outra.
- A tela da BOM é recriada ao trocar de BOM, sem herdar filtros, saldos ou marcações da anterior.
- A BOM ativa aparece no título da Visão geral (ex.: **BC22X · OP1268 · 02/09/2026 · Todas as 74 OPs desta BOM**) e fica no endereço (`?bom=`). Recarregar a página mantém a mesma BOM.

Correções encontradas na revisão:

- **Cadastrar nova BOM do rodapé** importava direto, usando o **nome da BOM que estava aberta** e o nome dela para escolher abas/OPs da planilha. Agora o rodapé abre o mesmo cadastro com **Modelo** e **Revisão**.
- O cadastro enviava junto os dados de MB51/SCRAP da BOM aberta (podia passar do limite de 15 MB). Agora envia só as linhas e OPs do arquivo novo.
- Ao conferir o arquivo, o cadastro avisa se **já existe BOM com o mesmo modelo e revisão** ou se **as OPs já estão em outra BOM**. Cada BOM tem status e marcações próprios, então OPs repetidas costumam indicar BOM duplicada.
- **7000 × PROJETOS**: com duas BOMs repetindo as mesmas OPs, uma OP **Concluída** numa BOM era contada como aberta na cópia. Agora a OP concluída em qualquer BOM considerada vale para todas, e a tela sugere apagar a BOM duplicada.
- **Marcar tudo como OK** mostrava, por exemplo, 42.846 itens, mas o servidor aceita até 5.000 por envio, então a ação falhava. Agora envia em partes de 1.000, mostra o progresso e ignora itens já atendidos pela MB51 (menos gravações no D1). O mesmo vale para **Limpar marcações**.
- Seletor de BOM mostra a quantidade de OPs e corta nomes longos com reticências no celular.

## Validação

- TypeScript e build aprovados.
- 152 testes de regras, 42 de interface (6 novos), 6 da API e a suíte do banco em **D1 e Turso** com exclusão/renomeação (permissão, origem, versão, BOM protegida, remoção de status/marcações só da BOM apagada).
- Varredura no Chromium de todas as 9 abas em desktop e celular com a BOM real do pacote e duas BOMs como as do seu print: sem erros de tela e sem rolagem horizontal da página.

## Publicação

Igual às anteriores: envie para a raiz do repositório, `pnpm run build`, deploy Wrangler. **Sem Secret novo e sem mudança de tabelas.** Confirme **MB51-57** no rodapé ou em `/api/version` (`bomDelete: true`).

---

## Histórico da MB51-56 — Saldo 7000 × Projetos (devolução ao 2000)

Nova aba **7000 × PROJETOS**. Ela cruza **todo o saldo livre do 7000** com **todas as BOMs cadastradas** (cada BOM = um projeto) e mostra, material por material:

- em qual projeto ele é usado (BC22X · OP1268, BC10X · BOM 1400…);
- quanto as OPs abertas desses projetos ainda precisam;
- quanto **manter no 7000** e quanto **devolver ao 2000** antes da entrada do próximo projeto.

Nada é reservado, movimentado ou lançado no SAP. É uma orientação para o Warehouse, com planilha para enviar.

## Como usar

1. Cadastre a BOM do projeto que vai entrar (rodapé **Cadastrar nova BOM**), com as OPs no cabeçalho, como nas outras BOMs.
2. Abra **7000 × PROJETOS**. Em **Projetos (BOMs)**, escolha o papel de cada BOM:
   - **Em produção** — segura saldo primeiro;
   - **Vai entrar** — segura o que sobrar depois dos projetos em produção;
   - **Fora da análise** — projeto encerrado: não segura saldo, aparece só como informação.
3. Clique **Analisar saldo 7000**. A leitura do 7000, da MB51 e do SCRAP acontece **somente nesse clique**. A MB51 é lida **uma única vez** e conciliada com todas as BOMs.
4. Filtre **Devolver ao 2000** e clique **Baixar planilha de devolução** (`Devolucao_2000`, `Uso_por_Projeto`, `Criterios`).

Trocar o papel de um projeto recalcula na hora, sem nova leitura. A escolha fica salva no navegador de quem usa; não altera BOMs, status das OPs nem o banco.

## Como a conta é feita

1. **Demanda restante por projeto** = soma, nas OPs abertas, de máximo(BOM − consumo efetivo MB51/SCRAP, 0) — a mesma conciliação da BOM × OP.
   - OP **Concluída** e item marcado **OK** pelo administrador não contam.
   - OP sem nenhum 261/262 na MB51 = ainda não iniciada → conta a **BOM cheia**.
   - Consumo sem conciliação confiável → conta a BOM cheia (lado seguro: devolve menos).
   - Com **Descontar o que a MB51 já consumiu** desmarcado, ou se a MB51 falhar, a demanda é a BOM cheia das OPs abertas.
2. O saldo do 7000 (material + unidade, centro BR02) é reservado **uma única vez**: primeiro **Em produção**, depois **Vai entrar**, na ordem da lista.
3. **Devolver ao 2000** = saldo livre 7000 − quantidade reservada.

| Saldo 7000 | BC22X (em produção) | BC10X (vai entrar) | Manter no 7000 | Devolver ao 2000 |
|---:|---:|---:|---:|---:|
| 20 PCS | precisa 6 | precisa 10 | 16 | **4** |
| 20 PCS | Fora da análise | precisa 10 | 10 | **10** |
| 20 PCS | precisa 0 (OPs já consumiram) | não usa | 0 | **20** |
| 8 PCS | precisa 6 | precisa 10 | 8 (faltam 8) | **0** |

| Situação | Significado |
|---|---|
| Devolver tudo ao 2000 | Nenhum projeto considerado usa o material, ou as OPs abertas não precisam mais dele. |
| Devolver excedente ao 2000 | Parte do saldo fica reservada; o restante volta. |
| Manter no 7000 | Todo o saldo é necessário; pode mostrar quanto ainda falta. |
| Conferir antes de mover | Unidade do 7000 diferente da BOM, saldo negativo/desconhecido ou BOM sem quantidade. Não há conversão automática. |

Cada linha tem **Ver conta** com a reserva de cada projeto. A mesma OP cadastrada em duas BOMs consideradas conta só na primeira (aviso na tela). Códigos com saldo zero ficam fora da lista.

**Limites:** o projeto novo precisa estar cadastrado como BOM; o saldo do 2000 não é consultado (a sugestão é só a quantidade a devolver); os papéis não são compartilhados entre usuários — o Excel registra em `Criterios` quais papéis foram usados.

## Outras mudanças da MB51-56

- Links diretos (`?modulo=projetos`, `?modulo=ana`, depósitos) não baixam mais a BOM padrão e os status antes de abrir a tela. Menos leituras no D1.
- Menu superior em 3 colunas no celular (9 módulos em 3 linhas).
- Leitura MB51/SCRAP reorganizada em funções reaproveitadas; as regras da BOM × OP, Warehouse e SCRAP não mudaram.

## Validação

- TypeScript e build de produção aprovados.
- 151 testes de regras (15 novos da aba 7000 × PROJETOS), 36 testes de interface em DOM (2 novos) e 6 testes da API aprovados.
- Teste no Chromium com a BOM real do pacote (BC22X OP1268, 74 OPs, 579 linhas), o 7000 do pacote (1.749 materiais) e uma segunda BOM de teste: análise em cerca de 1,7 s com 22 mil movimentos MB51 processados no Web Worker, sem erros no console e sem rolagem horizontal no celular. Os preços usados nesse teste visual eram fictícios; o pacote não altera dados.

## Publicação

Igual à MB51-55: envie o conteúdo para a raiz do repositório **Controle-de-produ-o-Wesley**, `pnpm run build` e o deploy Wrangler que já funciona. **Não há Secret novo nem mudança de tabelas.** Confirme **MB51-56** no rodapé ou em `/api/version` (`stock7000Projects: true`). Não envie `dist`, `node_modules` ou `.vite-cache`.

---

## Histórico da MB51-55 — integração Turso preparada

A versão permite escolher D1 ou Turso por configuração. A integração foi testada localmente; a conexão online, a migração dos dados reais e a publicação ainda dependem da conta e do backup do banco atual.

**Comece pelo arquivo `TURSO-PASSO-A-PASSO.md`.** Ele orienta o cadastro gratuito, a exportação do D1, a conferência da cópia e a ativação no Worker.

O padrão continua sendo D1. `DATABASE_PROVIDER=turso` exige URL, Secret e a cópia validada do banco. Um banco Turso vazio não é ativado. As regras do painel permanecem as da MB51-54.

## Histórico da MB51-54

# Consultas leves e erro do servidor identificável


## Correção da falha de carregamento

O print da MB51-53 mostra que o servidor falhou ao consultar a BOM e os status. A mensagem antiga era um retorno genérico HTTP 503, sem o motivo original. O erro exato do banco em produção ainda não pôde ser confirmado: as consultas externas ao portal foram bloqueadas e não houve acesso ao log da conta Cloudflare.

Nesta revisão:

- **Consulta das marcações mais leve:** quando a revisão não mudou, lê apenas uma linha de `manual_check_state`. A versão anterior contava todos os itens marcados a cada consulta. Essa varredura repetida aumentava o uso do banco; dependendo da quantidade de itens e usuários, pode contribuir para atingir a cota diária.
- Marcações antigas sem revisão continuam disponíveis por uma consulta indexada `LIMIT 1`; nenhuma marcação foi removida ou recriada.
- O erro do servidor informa um código: limite diário de leitura/gravação, limite de armazenamento, estrutura incompatível ou vínculo DB incorreto. O detalhe técnico fica no log com uma referência, sem colocar SQL na mensagem pública.
- Após erro, as consultas automáticas de status/marcações deixam de insistir a cada cinco segundos. Respeitam o prazo informado pelo servidor; falhas comuns usam intervalos progressivos de 30 segundos até cinco minutos.
- Em funcionamento normal, as marcações continuam sincronizando a cada cinco segundos na aba visível. MB51, SCRAP e depósitos continuam sob atualização manual.
- **Tentar novamente** recarrega a BOM, a lista de modelos e os status juntos. **Tentar status novamente** reinicia somente a consulta dos status.

A atualização não altera o vínculo D1, o esquema das tabelas, as BOMs ou os lançamentos SAP. Corrige uma consulta excessiva e torna o diagnóstico acessível; não garante remover uma limitação já ativa na conta Cloudflare.

### Se continuar bloqueado após publicar

Confirme **MB51-54** no rodapé e copie o código da nova mensagem. Não é necessário apagar o banco nem importar a BOM novamente para testar.

| Código | Significado / próximo passo |
| --- | --- |
| D1_DAILY_READ_LIMIT | Cota diária de leitura atingida. Conferir uso do D1 no painel Cloudflare. |
| D1_DAILY_WRITE_LIMIT | Cota diária de gravação atingida. Conferir uso do D1 no painel Cloudflare. |
| D1_STORAGE_LIMIT | Armazenamento atingiu o limite; avaliar a base antes de qualquer alteração. |
| D1_SCHEMA_MISMATCH | Tabelas/colunas não correspondem ao código; enviar o código e a referência para conferir a estrutura existente. |
| D1_NOT_FOUND / D1_BINDING_INVALID | Conferir o vínculo D1 chamado DB no Worker do Controle de Produção. |
| D1_QUERY_FAILED / SERVER_ERROR | Conferir no log do Worker o evento `portal_request_failed` com a referência exibida. |

Segundo a [documentação oficial do D1](https://developers.cloudflare.com/changelog/post/2026-09-01-d1-free-tier-limit-enforcement/), o limite diário do plano gratuito bloqueia consultas até a renovação à meia-noite UTC, sem apagar dados. Esse horário corresponde a **21h em São Paulo**. Só se aplica quando a mensagem confirmar limite diário.

Validação específica: testado que uma revisão inalterada executa **uma consulta indexada de revisão, sem COUNT**, que dados legados permanecem visíveis, que uma falha simulada de cota aparece com o código correto e que o botão de nova tentativa recupera BOM e status quando o serviço volta.

## Publicação

1. Extraia o ZIP. Envie o conteúdo para a **raiz do repositório Controle-de-produ-o-Wesley**, mantendo as pastas `app`, `lib`, `worker`, `scripts` e `public`.
2. Preserve o banco D1, as BOMs cadastradas e as variáveis/Secrets existentes. Build: `pnpm run build`. Mantenha o comando de deploy Wrangler que já funciona.
3. Publique interface e Worker juntos. Confirme **MB51-54** no rodapé ou em `/api/version`.
4. Em **BOM × OP**, selecione a revisão correta e clique em **Atualizar dados**. A conferência de consumo precisa da MB51 atual. Para os depósitos, use **Atualizar depósitos**; em **1300 · ADITIVOS**, use **Atualizar dados**.

Este ZIP contém o código completo. Não envie a pasta `dist` ou `node_modules`. A preparação deste pacote não publicou alterações nem modificou seu banco de produção.

## O que mudou

- **1300 · ADITIVOS** é a única aba de aditivos e líquidos. Lê a aba `1300` do Sheets; não usa uma aba `ADITIVOS` separada. Links antigos com `modulo=aditivos` abrem o 1300.
- Nova marca **W branca / WBYD**, cabeçalho opaco e tabela principal com oito colunas. A largura disponível da página é aproveitada, e a rolagem da tabela continua acessível no topo.
- Cada material mostra **Ver lançamentos e cálculo**: saídas 261, estornos 262, documentos, depósito, revisão da BOM, ajuste SCRAP e diferença resultante. Até cinco lançamentos são exibidos como amostra; a soma usa todos os registros válidos.
- A leitura e a conciliação de MB51/SCRAP passam para um Web Worker do navegador. A interface pode continuar respondendo durante esse processamento. Há retorno de erro e limite de tempo para consultas interrompidas.
- Cabeçalhos e chaves são preparados uma vez por leitura. Filtros e busca usam os dados já carregados. A atualização pesada continua **somente por clique**.

## Como a conta é feita

1. A chave é **Material + Ordem** das colunas SAP. NEW COD não sobrescreve uma Ordem preenchida. Uma OP abreviada só é reconhecida se identificar uma única OP da BOM.
2. No centro BR02, consumo líquido = soma das quantidades absolutas 261 − soma das quantidades absolutas 262. O depósito não restringe esse consumo: lançamentos do **2000 também entram**. Outros tipos não são presumidos como consumo de produção.
3. Documento + ano + item identifica cópias repetidas. O ano pode vir da data do documento/lançamento. Valores conflitantes ou unidades básicas incompatíveis ficam para conferência.
4. SCRAP já presente na MB51, pelo mesmo documento/ano/item e mesmos dados, **não é somado novamente**. Um documento SCRAP separado só complementa o consumo se tiver quantidade e tipo 261/262 comprováveis. Documento conflitante ou quantidade ausente não gera uma peça presumida. A nova regra vale para a leitura atualizada do Sheets.
5. A quantidade prevista vem da **BOM selecionada**. Diferença = máximo(previsto − consumo efetivo, 0). Ausência na extração não comprova falta física; pode indicar revisão, código ou período diferentes. OP sem movimentos fica para conferência.
6. Só depois se consulta o estoque: **7000 primeiro**, **2000 para o restante**, **1500 separado**. O saldo do 1300 aparece em sua própria aba e não é duplicado na cobertura.

Uma OP marcada como **Concluída** fica verde e 100% no acompanhamento da equipe e sai dos pedidos Warehouse. Essa marcação não altera documentos SAP. Diferenças da fonte permanecem auditáveis, com mensagem explícita na OP concluída.

## Aba 1300 no Google Sheets

Cabeçalhos na primeira linha, em qualquer ordem:

| Campo | Uso |
| --- | --- |
| Material | Obrigatório; código SAP como texto |
| UM básica | Obrigatório; KG, L, PCS etc. |
| Utilização livre | Obrigatório; saldo disponível |
| Texto breve material | Descrição opcional |
| Centro | BR02, quando informado |
| Depósito | Se presente, só entram linhas 1300 |
| Val.utiliz.livre | Valor opcional; campo vazio não vira preço zero |

O filtro **Unidade** separa KG, L e outras unidades. Não há conversão automática. A aba `ADITIVOS` pode continuar no seu Sheets, mas esta versão não a consulta.

## A OP 19000002315 dos prints

Foi consultada a MB51 real do Sheets em 28/09/2026. Dois exemplos explicam por que não é seguro forçar 100% no consumo:

- **20513481-00**: consumo 2 e estorno 2 no depósito 2000 → líquido **0**.
- **19667866-00**: nenhum lançamento desse código nessa OP na extração consultada.

Confira `AUDITORIA-MB51-53.md` e a amostra salva em `audit/`. Isso não confirma falta física. A BOM atual do banco do site e os dados internos do SAP não ficaram acessíveis nesta sessão; a comparação completa das 108 diferenças do print ainda exige a revisão correspondente e a extração SAP completa.

## Recursos mantidos da MB51-51

- Abas do cabeçalho com espaço entre os nomes, principalmente Warehouse e Check Ana. A navegação se reorganiza em telas menores.
- Filtro **Classe**: Todas, A, B, C e A + B. Funciona junto da busca por material/OP e do filtro de situação.
- Indicadores, tabela e Excel acompanham os filtros escolhidos. **Limpar filtros** volta à lista completa.
- Busca e filtros reunidos em um painel; informações de cálculo recolhidas em **Fontes e critérios do resumo**; classes com etiquetas e solicitação com destaque na tabela.
- O filtro seleciona os materiais depois da consolidação. O saldo não é recalculado nem duplicado ao trocar a classe. Quando um mesmo material aparece em mais de uma classe, sua quantidade consolidada de todas as OPs permanece identificada.
- O Excel registra a classe selecionada em `Criterios` e contém todos os materiais do filtro, inclusive os de outras páginas.
- Filtrar não consulta Google Sheets novamente. A atualização das fontes continua manual.

## Recursos mantidos da MB51-50

- **GRÁFICO** abre as marcações salvas sem precisar atualizar a MB51. Ao salvar **Concluída**, a OP fica verde e **100%** no acompanhamento operacional. **Aguardando Warehouse** fica amarela, sem percentual ou quantidade presumidos.
- O administrador pode mudar o status nos próprios cartões do gráfico. Usuários de consulta recebem o status compartilhado, sem permissão para alterá-lo.
- Os números de diferenças SAP foram retirados dos cartões ao lado das OPs e do acompanhamento operacional. Quantidades originais continuam disponíveis em **Consumo por classe** e **Diferenças BOM × SAP**; a marcação manual não cria lançamentos SAP.
- A nova aba **WAREHOUSE** consolida **todas as OPs da BOM ativa**, agrupando material e unidade. O seletor de BOM continua separando revisões; o resumo não mistura modelos diferentes.
- OPs concluídas e materiais marcados como OK pelo administrador são retirados da solicitação. Reabrir a OP ou desmarcar o item devolve a diferença existente à lista.
- Cada saldo 7000 é usado **uma única vez** para a soma da demanda de todas as OPs abertas. O 2000 cobre somente o restante; o 1500 é referência. Não há reserva nem movimentação de estoque.
- Exemplo: duas OPs precisam de 5 e 4 PCS; saldo 7000 = 6, saldo 2000 = 2. Demanda = 9, cobertura 7000 = 6, solicitar = 3, transferível do 2000 = 2, reposição adicional = 1 PCS. O saldo 6 não é contado uma vez para cada OP.
- **Baixar planilha para o Lougas** exporta `Total_por_Item`, `Falta_por_OP` e `Criterios`, com todas as linhas do filtro, inclusive as de outras páginas. O saldo compartilhado aparece somente no total por material.
- A busca por OP localiza materiais; os totais mantêm a demanda das demais OPs abertas que usam o mesmo material. Expanda **ver quantidades** para consultar cada ordem.

A MB51, o SCRAP e os depósitos continuam sendo atualizados **somente por clique**. Marcações usam uma consulta pequena a cada 5 segundos na aba visível (15 segundos em segundo plano), sem reler Google Sheets. Falhas ao salvar não são apresentadas como conclusão. Resultados sem saldo ou consumo confiáveis ficam identificados para conferência.

## Layout e navegação preservados

- Corrigido o painel de observações da Ana: o estilo de outra área dividia o conteúdo em duas colunas dentro da lateral. Agora ele tem uma única coluna, com largura própria.
- O gráfico da direita usa cartões por OP, com número da ordem, situação, total de materiais e contagens identificadas por cor e texto. As barras mantêm a proporção documental e não são porcentagens de fechamento físico.
- **Conferência e observações** leva direto aos filtros e à tabela. Clicar em um cartão abre a OP, reabre as notas e leva à conferência.
- **Recolher observações** libera a largura da tabela. Reabrir mantém o rascunho enquanto o módulo continuar aberto. O texto só é compartilhado depois de **Salvar observação**.
- Cabeçalho, filtros, indicadores, cartões, bordas, tipografia e espaçamentos foram padronizados. O portal continua usando a largura da página, com margens pequenas.
- As tabelas mantêm rolagem interna e a barra horizontal superior. OP/material permanece visível na rolagem horizontal do Check Ana e das diferenças BOM × SAP.
- Em telas menores, os gráficos passam para uma coluna, as notas ficam abaixo da tabela e os controles se reorganizam. As cores continuam acompanhadas de texto.
- O tema permanece escuro com detalhes claros; foram reduzidos efeitos de desfoque nos painéis. Nenhuma nova biblioteca de gráficos ou fonte externa foi adicionada.

A conciliação SAP, a prioridade do 7000, a atualização manual e as permissões existentes foram mantidas. A nova visão Warehouse acrescenta a consolidação do saldo entre OPs; os detalhes abaixo descrevem a consulta individual da BOM × OP.

## Saldo 7000 e 2000, lado a lado

Em todas as classes A, B e C, a comparação começa na **BOM da revisão selecionada × consumo MB51 da OP**, com a conciliação SCRAP existente. Estoque disponível não é consumo já apontado.

1. **Diferença de consumo** = máximo(BOM − consumo efetivo, 0).
2. **Coberto no 7000** = mínimo(diferença de consumo, saldo disponível 7000).
3. **Necessário do 2000** = diferença de consumo − coberto no 7000.
4. **Pode transferir do 2000** = mínimo(necessário do 2000, saldo disponível 2000).
5. **Sem saldo nos dois** = necessário do 2000 − pode transferir do 2000.

| Diferença de consumo | Saldo 7000 | Saldo 2000 | Necessário do 2000 | Pode transferir | Sem saldo nos dois |
|---:|---:|---:|---:|---:|---:|
| 10 | 10 | 0 | 0 | 0 | 0 |
| 10 | 4 | 6 | 6 | 6 | 0 |
| 10 | 4 | 2 | 6 | 2 | 4 |
| 0 | 0 | 0 | 0 | 0 | 0 |

Os exemplos usam uma única unidade. Se o 7000 cobre tudo, a orientação é **“Não precisa solicitar ao 2000”**. Ter saldo somente no 2000 ainda exige transferência. O estoque do 1500 aparece separado e não entra nessa conta.

Na lista, **Ver conta 7000 + 2000** abre os números usados naquela OP/material. As fontes e horários consultados estão em **Fontes e critérios de cálculo**. Os mesmos números entram no resumo exportado.

| Cor das linhas BOM × OP | Significado |
|---|---|
| Verde | Consumo atendido ou marcação manual do administrador, identificada na linha. |
| Azul | Há saldo no 7000; o consumo SAP ainda precisa ser conferido/apontado. |
| Amarelo | O restante pode ser transferido do 2000. |
| Vermelho | O saldo dos dois depósitos é insuficiente para a diferença de consumo. |
| Cinza | A base de consumo, a classe ou um saldo necessário precisa de conferência. |

**Nenhum saldo é reservado por este painel.** Cada OP consulta o saldo disponível do mesmo material e unidade no centro BR02. A mesma quantidade pode aparecer em várias OPs; isso não significa que cubra todas simultaneamente. Para decidir sobre várias OPs ao mesmo tempo, é necessária uma regra de prioridade/reserva.

Saldos negativos são exibidos, mas valem zero para disponibilidade. Base ausente ou unidade incompatível fica **desconhecida**, nunca é convertida automaticamente em saldo zero. Um depósito explicitamente diferente é excluído da consulta.

## OP ausente na MB51 e pendências falsas

Quando nenhuma linha de movimento 261/262 da OP aparece na MB51 recebida, o resultado fica em **Conferir dados**, com a orientação para verificar o período e a extração. A ausência da OP não gera centenas de faltas nem um percentual de consumo igual a zero. O valor da soma original é preservado internamente para auditoria.

Uma OP com movimentos válidos continua sendo comparada material a material: item não localizado nessa extração tem consumo zero na soma. A presença de alguns movimentos não comprova que o período exportado esteja completo. Confirme a revisão da BOM e a abrangência do export para a OP analisada.

Status manual ou encerramento na COOIS não cria consumo nem apaga divergências. Os gráficos distinguem o acompanhamento da equipe da cobertura documental. Sem dados comparáveis, mostram **—**. A ausência de SCRAP sozinha aparece como **SEM SCRAP**; não é um motivo para acusar duplicidade.

A atualização das fontes pesadas continua **somente por clique**. Filtros, gráficos e a abertura da conta usam os dados já carregados. O Check Ana, as notas compartilhadas e as marcações da versão anterior continuam disponíveis.

## Gráficos dentro do CHECK ANA

O gráfico circular conta **OPs**. As barras contam **materiais por OP**, com números ao lado. Clique na legenda para filtrar uma situação, ou em uma barra para abrir a conferência da ordem e a caixa de observações. A classificação da OP sempre considera todos os seus materiais, mesmo quando a tabela está filtrada.

| Cor no Check Ana | Significado |
|---|---|
| Verde | Todos os materiais comparáveis da OP estão sem diferenças. |
| Amarelo | Há apontamento identificado na COOIS e material com consumo KOB1 abaixo da BOM ZPP009. |
| Vermelho | Há consumo abaixo da BOM, sem evidência de apontamento na COOIS recebida. |
| Lilás | Há consumo acima da BOM, sem item abaixo dela. |
| Cinza | Há quantidade ou unidade a conferir. |
| Azul acinzentado | A OP está ausente de uma fonte; a conclusão fica suspensa. |

A confirmação é identificada por CONF/CNF, PCNF/MCNF ou quantidade boa confirmada positiva. A interface informa quando a confirmação é parcial. FORN, TECO, entrega física ou encerramento isolados não comprovam apontamento. A ausência de confirmação nesta leitura não afirma que ela inexiste no SAP.

**COOIS não gera consumo e não zera diferenças.** Esta regra amarela é do Check Ana. As cores manuais da aba GRÁFICO e da BOM × OP continuam sendo as marcações salvas pela equipe. As novas barras não representam percentual de fechamento físico.

## Caixa de escrita da Ana

Na lateral direita da tabela, selecione uma OP ou clique na ordem do gráfico. Digite e clique em **Salvar observação**. Em telas pequenas, a caixa aparece abaixo da tabela.

- **Anotar material**, na linha da tabela, vincula o texto àquela OP e código SAP.
- **Ver toda a OP** mostra as anotações gerais e as dos materiais dessa ordem.
- O histórico fica no banco compartilhado do site e permanece após novas leituras da planilha, importações e recarregamento da página.
- Quem salva vê o texto após a confirmação do servidor. Outros usuários com a mesma OP aberta recebem as notas na próxima consulta, a cada **15 segundos**, enquanto a aba está visível. O botão ao lado de Histórico permite consultar imediatamente.
- Essas consultas leem apenas notas. Não atualizam Google Sheets nem recalculam o check.
- O texto só é compartilhado após salvar. Um erro de gravação mantém o rascunho para tentar novamente. Trocar a OP preserva rascunhos enquanto o Check Ana estiver aberto; sair do módulo ou recarregar descarta o que ainda não foi salvo.
- O histórico é acrescentado: uma pessoa não sobrescreve a observação de outra. Para corrigir, registre uma nova observação. Há limite de 4.000 caracteres por nota.

### Acesso de escrita para Ana

**Administrador** já pode escrever. O acesso **Consulta** apenas lê.

Para Ana escrever sem poder mudar marcações, status das OPs ou importar bases, existe o perfil **Analista**. No mesmo Worker, em **Settings → Runtime → Variables and Secrets**, adicione um Secret chamado `PORTAL_ANALYST_PASSWORD`, com uma senha exclusiva de pelo menos 12 caracteres, e publique a configuração. É uma variável do **Runtime**, não da seção Builds. Ana usa essa senha na entrada normal do portal; o cabeçalho mostra **ANALISTA**.

Mantenha `REQUIRE_PASSWORD=true`, a senha administrativa e a senha de consulta já existentes. Não inclua senhas no GitHub. O histórico identifica o perfil que escreveu, não a identidade de uma pessoa que compartilhe a senha. No modo sem autenticação existente, todos os acessos continuam administrativos.

## Descrições em português

A tela e o CSV mostram a descrição em português. **Ver descrição original** mantém o texto do export e informa a origem do nome utilizado.

A prioridade é a descrição portuguesa da MM60 da leitura atual, seguida do texto português do próprio export. Para descrições estrangeiras dos códigos conhecidos, o pacote inclui o cadastro português SAP de referência e traduções técnicas identificadas. Foram cobertos os **655 códigos com texto chinês** na ZPP009 disponível para esta atualização. A descrição é apenas apresentação: não participa da chave nem dos cálculos.

Para um código novo sem nome português disponível, o site mantém o original com indicação de tradução não cadastrada. Inclua a descrição portuguesa na MM60 ou atualize o cadastro. Não há envio de materiais a um serviço externo de tradução, nem tradução automática garantida de códigos futuros.

## Conta e atualização

**Diferença = soma Qtd.total entrada KOB1 − soma BOM QTY ZPP009, por OP + Material.**

Estornos mantêm o sinal. Uma OP inteira ausente de uma das fontes é Base incompleta, não falta comprovada. Unidades incompatíveis suspendem o cálculo. COOIS, cores e observações não alteram quantidade ou valor. A MM60 continua prioritária para preços; estimativas por custo e moedas são identificadas.

A leitura das planilhas continua **somente por clique**. Gráficos usam os dados já carregados, com seis OPs por página; a tabela continua com 50 materiais por página. O módulo do Check Ana e seu catálogo são carregados sob demanda.

## Validação desta versão

- TypeScript e build de produção aprovados.
- 136 testes de regras, 34 testes de interface em DOM e 6 testes da API aprovados. Incluem documento repetido, estorno, unidade incompatível, SCRAP já contabilizado, processamento em thread separada, 1300, persistência D1, perfis e atualização compartilhada das marcações.
- Comparação real dos 597 lançamentos da OP 19000002315, com extrato e achados documentados.
- Medição local da função de conciliação, com 44.178 registros, 579 materiais e 74 OPs: versão anterior 5.347 ms; versão nova 322 ms. Uma execução por versão em Node; não mede Google Sheets, rede, renderização ou dispositivo do usuário.
- O arquivo principal de JavaScript tem aproximadamente 154 KB comprimido; o processamento das fontes usa um arquivo separado. Excel e Check Ana continuam carregados sob demanda.

Não foi possível fazer uma validação visual no navegador real nesta sessão. Os testes de interface montam os componentes, navegam, atualizam dados e verificam os resultados em DOM. Nenhum resultado foi declarado como conferência integral do SAP.

Comandos: `pnpm check`, `pnpm test`, `pnpm test:ui`, `pnpm test:api`, `pnpm build`.

A auditoria anterior do Check Ana permanece em `AUDITORIA-MB51-46.md`. Para auditar uma planilha de referência: `pnpm audit:ana "/caminho/BR00 - Check OPs 09.2026.xlsx" relatorio.json`.
