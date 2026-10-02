# Auditoria de 25/09/2026

## Conta do CHECK ANA

Comparação local com o arquivo original BR00 - Check OPs 09.2026.xlsx: **43.874 pares OP/material**, com diferenças de quantidade e valor financeiro com MM60 iguais aos resultados salvos em Check Final. Nenhuma divergência numérica ou par ausente nessa comparação.

A validação verifica a fórmula do Excel, inclusive estornos com sinal, agregação por chave e referência MM60. Não consulta diretamente o SAP e não certifica que uma extração esteja completa ou que sua BOM seja a revisão correta para uma OP específica.

## Fontes atuais do Google Sheets

Leitura pública sem modificar a planilha de origem. KOB1: 5.001 linhas recebidas, incluindo uma linha final de total; 5.000 linhas com ordem. ZPP009: 43.357 linhas, incluindo 74 cabeçalhos de produto.

| Medida | Resultado |
|---|---:|
| OPs com componentes na ZPP009 | 74 |
| OPs com materiais na KOB1 | 9 |
| OPs sem materiais na KOB1 | 65 |
| Pares OP/material na união das duas fontes | 43.292 |
| Pares com quantidades iguais, em OPs presentes nas duas fontes | 4.667 |
| Pares abaixo da BOM nessas OPs | 534 |
| Pares acima da BOM nessas OPs | 28 |
| Pares com base incompleta | 38.063 |
| Códigos únicos com diferença entre fontes nas 9 OPs | 95 |

As 562 diferenças (534 + 28) são **diferenças entre documentos**, não 562 peças fisicamente faltantes nem 562 códigos diferentes. As 9 OPs com materiais na KOB1 são 19000002315 a 19000002323. Presença nessas fontes não garante que todos os lançamentos da ordem estejam no export.

O total 880 informado pelo usuário não foi reproduzido nessa leitura. A interface agora apresenta os filtros, a data, a contagem de pares, a contagem de códigos únicos e a cobertura para tornar essa comparação rastreável.

MM60 não foi validada na leitura pública atual: o Google retornou um cabeçalho incompatível com a aba solicitada. O site trata isso como fonte opcional indisponível. A verificação financeira exata acima usou a MM60 do Excel de referência. As estimativas KOB1/ZPP009 não equivalem automaticamente ao preço MM60.

## Percentual de OP fechada

O gráfico anterior media a proporção de materiais atendidos na BOM selecionada. O status manual da OP não alterava essa conta, mas a apresentação permitia confundir consumo com fechamento.

Agora existem duas visões explícitas: **Status das OPs**, com as cores salvas pela equipe, e **Consumo por classe**, com numerador, denominador e origem. Um teste de interface cobre uma OP marcada Concluída com 13 de 20 materiais atendidos: ela fica verde como concluída, e a conta de consumo continua 65%, identificada corretamente. O sistema não inventa os sete apontamentos restantes.

As BOMs de referência disponíveis também apresentaram quantidades diferentes entre si. Não é seguro atribuir uma delas à OP do usuário sem conhecer a revisão ativa no site. A BOM de produção, os filtros exatos dos 880 registros e a OP específica do percentual informado não foram acessíveis nesta execução. Portanto, não foi comprovado um percentual SAP de 100% para essa OP.

## Validação do pacote

93 testes de regras, 18 testes de interface, 6 testes de API, TypeScript, build e simulação de deploy do Worker aprovados. Os testes de interface montam os componentes React em DOM de teste; não representam inspeção visual do navegador em produção.

Nenhum banco de produção, Google Sheet, status manual ou valor de BOM foi alterado por esta auditoria. O pacote precisa ser publicado no repositório do Controle de Produção para que as correções apareçam no site.
