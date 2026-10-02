# Mudar o portal para o Worker `controlofproduction`

O deploy falhou porque o `wrangler.jsonc` apontava para o banco da **conta antiga** (`c21fba5e…`), e esse banco não existe na conta nova (`4a9063df…`).

Nesta versão o `wrangler.jsonc` **não tem mais `database_id`**. No deploy, o Wrangler liga o banco chamado `controle-producao-db` da conta onde está publicando. Se esse banco não existir, ele cria um. A senha passa a ser obrigatória pelo próprio arquivo (`REQUIRE_PASSWORD=true`).

Siga nesta ordem. A cópia dos dados vem **antes** de usar o site novo.

## 1. Criar o banco na conta nova

Cloudflare (conta do `controlofproduction`) → **Storage & Databases → D1 SQL Database → Create**.
Nome exato: `controle-producao-db`. A localização pode ficar automática.

## 2. Copiar os dados da conta antiga

Isso copia BOMs cadastradas, status das OPs, marcações OK e notas da Ana. Sessões de login não são copiadas; cada pessoa entra de novo.

Precisa do **Node.js 22 LTS** no computador. Use uma **pasta vazia**, fora da pasta do projeto. Copie para ela o arquivo `scripts\copiar-banco-d1.mjs` deste pacote.

No PowerShell:

```powershell
mkdir C:\migracao-portal
cd C:\migracao-portal
npx wrangler login
npx wrangler whoami
```

No `wrangler login`, entre com a **conta antiga**. O `whoami` lista as contas desse login e os IDs delas.

**Se as duas contas aparecem no mesmo login:**

```powershell
$env:CLOUDFLARE_ACCOUNT_ID="ID_DA_CONTA_ANTIGA"
npx wrangler d1 export controle-producao-db --remote --output=backup-d1.sql
node copiar-banco-d1.mjs backup-d1.sql copia-d1.sql
$env:CLOUDFLARE_ACCOUNT_ID="4a9063dfbea31ba193e5bfe3f7b5daa4"
npx wrangler d1 execute controle-producao-db --remote --file=copia-d1.sql
```

**Se cada conta tem um e-mail diferente:**

```powershell
npx wrangler d1 export controle-producao-db --remote --output=backup-d1.sql
node copiar-banco-d1.mjs backup-d1.sql copia-d1.sql
npx wrangler logout
npx wrangler login
npx wrangler d1 execute controle-producao-db --remote --file=copia-d1.sql
```

No `wrangler login` do meio, entre com a **conta nova**.

O `execute` pergunta se pode continuar: responda `y`. O script mostra quantas linhas copiou de cada tabela. Aplicar a cópia duas vezes não duplica nada, e nada que já exista no banco novo é apagado.

Se o `export` der limite diário do D1, tente depois das **21h** (horário em que o limite da conta antiga renova).

Não envie `backup-d1.sql` nem `copia-d1.sql` ao GitHub. Apague os dois depois de conferir o site.

## 3. Senhas no Worker novo

**Workers & Pages → controlofproduction → Settings → Variables and Secrets → Add**, tipo **Secret**:

| Nome | Uso |
|---|---|
| `PORTAL_PASSWORD` | Senha do administrador (obrigatória) |
| `PORTAL_VIEWER_PASSWORD` | Consulta (Lougas), se usava |
| `PORTAL_ANALYST_PASSWORD` | Analista (Ana), se usava |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Somente se existia no Worker antigo. Cole o JSON original; o painel não mostra o valor salvo |

Sem `PORTAL_PASSWORD`, o site mostra "O responsável precisa configurar a senha do portal". Ele nunca abre sem senha.

## 4. Atualizar o GitHub

Envie o conteúdo deste pacote para a raiz do repositório `Controle-de-produ-o-Wesley`. O `wrangler.jsonc` já está com o nome `controlofproduction`. O build publica sozinho. No log deve aparecer:

```
env.DB (controle-producao-db)     D1 Database
env.REQUIRE_PASSWORD ("true")     Environment Variable
Success
```

## 5. Conferir

Abra o endereço `controlofproduction…workers.dev` e entre com a senha. Confira:

- **MB51-59** no rodapé;
- as BOMs copiadas no seletor **BOM ativa**;
- depois clique em **Atualizar dados**.

O site antigo continua no ar com os dados antigos. O que for alterado nele depois da cópia não passa para o novo.
