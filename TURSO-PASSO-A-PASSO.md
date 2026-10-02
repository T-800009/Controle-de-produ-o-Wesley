# MB51-55 — testar o banco Turso

O código está preparado. A conta Turso, a exportação real do D1, a importação online e a ativação no site ainda precisam ser feitas. O pacote continua usando D1 enquanto `DATABASE_PROVIDER` estiver ausente ou definido como `d1`.

## Primeiro passo

Abra https://app.turso.tech/ e crie/acesse sua conta no plano Free. Entre no painel e envie um print da tela inicial para continuarmos uma etapa por vez. Não envie o token de acesso no print.

O restante deste guia é para realizar a migração acompanhada no computador. Os comandos são executados na pasta do projeto, com Node.js 22.13 ou superior, pnpm e Turso CLI instalados.

## 1. Preparar a cópia do D1

Combine uma janela em que a equipe não importe BOMs, altere marcações/status, grave observações ou faça novos logins. A cópia é um retrato do banco; alterações posteriores no D1 não serão sincronizadas automaticamente com o Turso.

Instale as dependências do pacote:

```sh
pnpm install --frozen-lockfile
```

Na conta Cloudflare que contém o banco do portal, exporte o banco completo:

```sh
pnpm exec wrangler login
pnpm exec wrangler d1 export controle-producao-db --remote --output=backup-d1.sql
```

O nome acima vem do `wrangler.jsonc` desta versão. Se a exportação falhar por limite da conta, precisamos obter um backup completo antes de prosseguir. A exportação pode bloquear consultas durante sua execução. Não apague o D1.

Converta a exportação para SQLite e valide a cópia:

```sh
pnpm run turso:prepare backup-d1.sql backup-turso.sqlite
```

Esse comando trabalha somente com arquivos locais. Copia as tabelas do portal, mantém índices, revisões, sessões, marcações e notas, e confere a quantidade e o conteúdo dos registros. Metadados internos `_cf_` do Cloudflare não são transferidos. Tabelas desconhecidas interrompem o processo para conferência. O arquivo SQL original é preservado e nenhum arquivo de saída existente é sobrescrito.

O programa gera um registro de validação dentro da cópia. A versão Turso do portal exige esse registro, evitando ativar um banco recém-criado e vazio.

## 2. Criar o banco Turso com a cópia

Instalação oficial do Turso CLI: https://docs.turso.tech/cli/installation

```sh
turso auth login
turso db create controle-producao-wesley --from-file ./backup-turso.sqlite
turso db show controle-producao-wesley --url
turso db tokens create controle-producao-wesley
```

Use um nome novo caso esse banco já exista. O comando com `--from-file` aceita arquivos SQLite de até 2 GB segundo a documentação consultada. Guarde o token em local privado. Os backups incluem informações do portal; não os envie para o repositório.

## 3. Conferir o banco importado antes da troca

Crie um arquivo local `.dev.vars`, que está excluído do Git, com a URL e o token reais:

```dotenv
TURSO_DATABASE_URL="libsql://ENDERECO-DO-SEU-BANCO.turso.io"
TURSO_AUTH_TOKEN="TOKEN-DO-BANCO"
```

Execute:

```sh
pnpm run turso:check
```

O comando faz leituras para comparar contagens e resumos SHA-256 de todas as tabelas importadas com o backup. Só prossiga quando elas aparecerem como **Idêntica ao backup**. A verificação consome leituras do Turso. Depois que o portal começar a gravar no Turso, diferenças em relação ao backup serão normais; esse comando é uma conferência anterior à ativação.

## 4. Configurar e publicar no Cloudflare

Atualize o código no mesmo repositório do site com o conteúdo deste ZIP, incluindo `package.json` e `pnpm-lock.yaml`. As configurações atuais do Worker e do vínculo D1 já estão preservadas em `wrangler.jsonc`.

No Worker **controle-de-produ-o-wesley**, configure as variáveis de execução:

| Nome | Tipo | Valor |
|---|---|---|
| `TURSO_DATABASE_URL` | Texto | URL do banco importado |
| `TURSO_AUTH_TOKEN` | Secret | Token do banco importado |
| `DATABASE_PROVIDER` | Texto | `turso` |

Mantenha as senhas e os Secrets do Google existentes. O token Turso é usado somente no Worker; nunca use uma variável `VITE_` para ele. Ative `DATABASE_PROVIDER=turso` apenas depois da importação e conferência.

Build e deploy, pelo fluxo existente do Cloudflare ou pelo terminal autenticado:

```sh
pnpm run build
pnpm run deploy
```

Se publicar o código antes de ativar a variável, a versão continuará usando D1. `keep_vars: true` mantém as variáveis do painel. Quando o provedor escolhido é Turso, falhas de conexão não redirecionam gravações silenciosamente para D1.

## 5. Conferir a ativação

Abra `/api/version` no endereço do site. Deve retornar `version: MB51-55-TURSO` e `databaseProvider: turso`.

Confira as BOMs, marcações, status e observações atuais. Depois, faça uma marcação de teste identificável e uma observação de teste, verificando em outro navegador/perfil se aparecem. As regras de consumo, as fontes Google e a atualização manual permanecem as da MB51-54.

Se precisar desistir **antes de qualquer gravação no Turso**, volte `DATABASE_PROVIDER` para `d1` e publique novamente. O bloqueio de franquia do D1 ainda poderá existir. Depois de novas gravações no Turso, é necessário reconciliar essas alterações antes de voltar ao D1; os dois bancos não se sincronizam sozinhos.

## Resultado dos testes deste pacote

- Checagem TypeScript e build Vite aprovados.
- A suíte existente de armazenamento, notas, status e autenticação passou em D1 local e em libSQL local pelo adaptador Turso.
- Sete testes específicos passaram: cópia do backup, preservação de códigos e notas, recusa de exportações erradas, seleção de provedor, transação com rollback, bloqueio de Turso vazio e erros sem exposição de dados.
- A compilação do Worker em modo de simulação foi aprovada, sem publicar.
- Os dados e a conta reais ainda não foram acessados. O funcionamento online e a suficiência da franquia dependem da validação após conectar sua conta.

Para repetir as verificações:

```sh
pnpm run check
pnpm run test:turso
pnpm run test:turso:unit
node tests/storage.test.cjs
pnpm run build
```

## Referências

- Integração oficial Cloudflare/Turso: https://developers.cloudflare.com/workers/databases/third-party-integrations/turso/
- Exportação D1: https://developers.cloudflare.com/d1/best-practices/import-export-data/
- Importação SQLite no Turso: https://docs.turso.tech/cli/db/create
- Franquia e preços: https://turso.tech/pricing
