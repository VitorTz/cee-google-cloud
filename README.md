# CEE — FastAPI + TypeScript (Cloud Run)

Sistema operacional para o CEE dos Correios, migrado de JavaScript estático para
FastAPI (Python) + frontend TypeScript compilado com Vite. A identidade visual,
HTML e CSS originais são mantidos.

## O que foi mantido

- **Registros:** caminhões, CDLs, LOEC, malotes, notas e relatórios.
- **Endereços:** CEPs, logradouros, regras de numeração e consulta de faixas.
- **Funcionários:** cadastro, presença, afastamentos, férias e processamento de ponto.
- **Help Desk:** chamados, chat em tempo real, notificações e anexos.
- **Minha Conta**, métricas para administradores, análise de LOEC, contato e bugs.
- Autenticação Supabase com e-mail/CPF/matrícula, autorização por função e RLS.
- Interface responsiva original (uso no navegador de computadores e celulares).

## Alterações

- Todos os **arquivos do frontend são `.ts`**. Os módulos principais `src/api.ts`,
  `src/supabase-client.ts`, `src/utils.ts`, `src/combobox.ts` e `app.ts` receberam
  tipos explícitos e checagem TypeScript. Nos módulos operacionais mais extensos,
  `// @ts-nocheck` preserva a lógica legada, que ainda pode ser gradualmente tipada.
- `src/supabase-client.ts` usa `@supabase/supabase-js` via npm, sem CDN.
- **Leituras, gravações e RPCs PostgREST** passam por `FastAPI /api/db/*`.
  FastAPI valida o JWT diretamente com Supabase Auth e encaminha a identidade
  original do usuário para as consultas: as políticas RLS continuam em vigor.
- Consultas de logradouros e detalhamento por CEP usam os endpoints
  `/api/streets/search` e `/api/streets/{id}/zips` com contratos tipados.
- **Supabase Auth, Realtime e Storage** continuam com conexão direta do navegador
  ao projeto existente. Isso mantém login, anexos, assinaturas e atualizações em
  tempo real compatíveis com o sistema anterior.
- O módulo de **geocodificação**, já oculto/desativado na navegação original, foi
  retirado. A instalação como app PWA/desktop/mobile também foi removida:
  sem `manifest.json`, `sw.js` ou ícones de instalação. A versão nova tenta
  desregistrar o Service Worker antigo ao ser aberta.
- `db/clone_schema.sql` é preservado como referência. **Não o execute contra
  uma base em uso:** o deploy utiliza o Supabase atual sem migração de esquema.

## Estrutura

```text
backend/main.py          FastAPI, Supabase Auth, proxy RLS, rotas e frontend estático
src/api.ts               Cliente HTTP tipado para consulta de endereços
src/supabase-client.ts   Cliente Supabase, métricas e encaminhamento PostgREST
src/tabs/                Módulos operacionais migrados para TypeScript
src/main.ts              Entrada da aplicação web (sem PWA)
app.ts                   Inicialização da interface
config.js                URL e chave anon/publishable do Supabase original
index.html, style.css    Interface e aparência originais
Dockerfile               Build Vite/Node e execução Python
requirements.txt         Dependências FastAPI/httpx
```

## 1. Executar localmente no Arch Linux

Pré-requisitos: Node.js 22+, npm e Python 3.12+.

No terminal 1, na raiz do projeto:

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn backend.main:app --host 127.0.0.1 --port 8000 --reload
```

No terminal 2, também na raiz:

```bash
npm install
npm run dev
```

Abra **http://localhost:5173**. O Vite encaminha `/api` para FastAPI na porta
8000. A autenticação continua sendo feita pelo mesmo Supabase do `config.js`.

Para simular a versão de produção localmente:

```bash
npm run build
uvicorn backend.main:app --host 0.0.0.0 --port 8080
```

Acesse **http://localhost:8080**. O backend serve `dist/` e a API na mesma origem.

## 2. Implantar no Google Cloud Run

O Cloud Run executará apenas o contêiner Python. O build gera os arquivos web na
primeira etapa do Dockerfile, sem serviço Node/Vite em produção.

No Arch Linux, com o [Google Cloud CLI](https://cloud.google.com/sdk/docs/install)
configurado, dentro do projeto:

```bash
gcloud auth login
gcloud config set project SEU_PROJECT_ID

gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com

gcloud run deploy cee-operacional \
  --source . \
  --region southamerica-east1 \
  --port 8080 \
  --allow-unauthenticated \
  --min-instances 0 \
  --max-instances 2 \
  --memory 512Mi
```

Esse comando usa o **Dockerfile** existente. O Cloud Run fornece uma URL HTTPS.
Com `--allow-unauthenticated`, a tela de login é acessível publicamente; **dados
internos só devem ser retornados mediante sessão Supabase válida e políticas RLS**.
Se a organização exigir restrição também ao acesso à página, use IAP/controle de
identidade do Cloud Run e revise a configuração antes de publicar.

Verifique o serviço:

```bash
curl https://SUA_URL_DO_CLOUD_RUN/api/health
```

Resposta esperada: `{"status":"ok"}`.

## 3. Supabase e segurança

O arquivo `config.js` original é a **única fonte de URL e chave pública** do
Supabase utilizada tanto no build do frontend quanto no backend:

```js
export const SUPABASE_URL = 'https://SEU-PROJETO.supabase.co';
export const SUPABASE_ANON_KEY = 'SUA_CHAVE_ANON_OU_PUBLISHABLE';
```

A chave **anon/publishable é pública por natureza**; use a original do projeto,
mas **NUNCA coloque `service_role`/secret key em `config.js`**. O backend não
usa chaves com privilégios elevados nem ignora as políticas RLS. Não faça o
deploy sem revisar as policies do banco e dos buckets Storage, especialmente
informações pessoais dos funcionários e anexos do Help Desk.

Após qualquer alteração em `config.js`, reconstrua a imagem/versão (`npm run
build` e novo deploy). Não há necessidade de migrar as tabelas existentes.

> A rede do navegador deve ter acesso ao domínio do Supabase para autenticação,
> downloads, uploads, Edge Functions ainda utilizadas e canais Realtime.
> As bibliotecas gráficas Chart.js, Quill e ExcelJS continuam carregadas por CDN.

## 4. Testes

```bash
# Validação do frontend + build de produção
npm run build

# Testes unitários/mocks da API; nenhum dado real é consultado
pip install pytest
python -m pytest -q tests/
```

O backend também pode ser testado independentemente via `/api/health`. Valide
login, gravação de registros, upload de anexos e atualizações Realtime **em uma
instância de homologação** antes de disponibilizar para funcionários. O projeto
não inclui credenciais de usuários nem acesso aos dados reais para testes ponta
a ponta.
