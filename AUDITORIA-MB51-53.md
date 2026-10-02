# Conferência MB51-53 — OP 19000002315

Consulta à fonte em 28/09/2026. Arquivos em `audit/` são evidências desta consulta, não dados de demonstração nem alterações da BOM do portal. Não são servidos como saldo atual da aplicação.

## Fonte e recorte

[Google Sheets configurado pelo usuário](https://docs.google.com/spreadsheets/d/1E36Lf79omaeXrk2etiSdKJRVCtJbeYdYR5gnaOwAMQE/edit#gid=0), aba `MB51`.

Consulta: `select A,C,D,G,H,I,J,L,M,R,S,T where D = 19000002315`.

Foram obtidos **597 registros**, sendo **588 movimentos 261** e **9 movimentos 262**; **538 registros do depósito 7000** e **59 do 2000**. A consulta seleciona uma única OP. Ela não permite certificar as outras OPs, a completude da extração em relação ao SAP ou qual BOM deveria ser aplicada.

## Materiais conferidos

| Material | Soma 261 | Soma 262 | Líquido | Achado |
| --- | ---: | ---: | ---: | --- |
| 20513481-00 | 2 | 2 | 0 | O consumo foi integralmente estornado nesta extração |
| 19667866-00 | — | — | — | Nenhum lançamento desse material nessa OP |
| 17329419-00 | 4 | 2 | 2 | Consumo e estorno no depósito 2000 |
| 11242550-00 | 30 | 15 | 15 | Tirreno: líquido 15, com unidade KG da BOM |

A MB51 deste recorte não informou unidade básica; a coluna UM pedido está vazia. A interface identifica quando a unidade exibida veio da BOM, sem conversão automática.

### Documentos de 20513481-00

- Documento **4900665403**, item **1**, data **04/09/2026**, movimento **261**, quantidade na exportação **−2**, depósito **2000**.
- Documento **4900720549**, item **1**, data **04/09/2026**, movimento **262**, quantidade na exportação **+2**, depósito **2000**.
- Fórmula equivalente à soma assinada do Excel nesse caso: `−(−2 + 2) = 0`. A regra `|261| − |262|` também resulta em zero.

A coluna NEW COD dessas linhas contém `BR02`, mas as colunas Material e Ordem estão preenchidas. A versão nova usa essas colunas reais; não associa BR02 a um material ou a uma OP.

### Código não localizado

**19667866-00** não aparece para essa OP no extrato consultado. Há outro material, **17857440-00**, com descrição `CONJUNTO DE DISCO ARTICULADO` e consumo líquido 1. Isso pode orientar uma investigação de troca de código ou revisão; **não comprova equivalência**. Nenhuma substituição automática entre esses códigos foi feita.

## O que precisa de confirmação da fonte

A consulta ao banco atual do portal retornou HTTP 403. Não foram alteradas permissões nem utilizados dados de outra revisão como se fossem a BOM atual. A BOM inicial incluída no projeto não contém os dois primeiros códigos do print; ela não representa necessariamente a BOM salva no D1.

Portanto, este pacote não afirma que os 108 itens do print são faltas reais e não muda o consumo para fabricar 100%. Para encerrar essa diferença documental, conferir no SAP:

1. A revisão da BOM efetivamente usada pela OP 19000002315.
2. Se 19667866-00 foi substituído formalmente por outro código nessa revisão.
3. Se houve novo 261 de 20513481-00 após o estorno e se ele está na MB51 completa enviada ao Sheets.

A conclusão física/operacional informada pela equipe continua separada da conciliação documental.

## Correções verificadas

- Material + Ordem reais prevalecem sobre NEW COD; abreviação ambígua não é atribuída à OP errada.
- 261 e 262 são considerados independentemente do depósito, incluindo 2000.
- Documento/ano/item repetido é contado uma vez; conflito permanece desconhecido.
- SCRAP já contido na MB51 não é somado novamente. Sem prova da quantidade/documento, não há peça inferida.
- As métricas de consumo usam o mesmo ajuste SCRAP da conferência, sem dupla contagem em linhas de BOM repetidas.
- Unidades básicas incompatíveis permanecem para conferência.
- Um teste da interface reproduz consumo 2, estorno 2 e um novo consumo 1: a diferença desaparece após atualizar com o novo documento, sem forçar uma marcação verde.

## Desempenho

A função de conciliação foi medida localmente com 44.178 movimentos artificiais derivados desta amostra, documentos separados para cada uma das 74 OPs e 579 materiais. MB51-52: 5.347 ms. MB51-53: 322 ms. Medição de uma execução por versão; não é um tempo garantido de atualização do site.
