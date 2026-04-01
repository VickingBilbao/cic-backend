# CIC Backend — Centro de Inteligência de Campanha

API REST completa para gestão de campanhas eleitorais com IA.  
**Stack:** Node 22 · Fastify 4 · Supabase · BullMQ · Redis · Cloudflare R2

---

## Pré-requisitos

- Node.js 22+
- Redis (local ou Railway)
- Conta Supabase
- Conta Cloudflare (R2)
- API keys: Anthropic, Google Gemini, HeyGen, OpenAI (embeddings)

---

## Setup em 8 passos

### 1. Instalar dependências

```bash
cd backend
npm install
```

### 2. Configurar variáveis de ambiente

```bash
cp .env.example .env
# Edite .env com suas chaves reais
```

Variáveis obrigatórias para funcionamento completo:

| Variável | Para que serve |
|---|---|
| `SUPABASE_URL` + `SUPABASE_SERVICE_KEY` | Banco de dados |
| `JWT_SECRET` | Autenticação |
| `REDIS_URL` | Filas BullMQ |
| `ANTHROPIC_API_KEY` | Geração de texto (Claude) |
| `GOOGLE_API_KEY` | Geração de imagem (Gemini) |
| `HEYGEN_API_KEY` | Vídeos com avatar |
| `CLOUDFLARE_ACCOUNT_ID` + `R2_*` | Storage de mídia |
| `OPENAI_API_KEY` | Embeddings para RAG |

### 3. Criar banco de dados no Supabase

1. Acesse o **SQL Editor** no painel Supabase
2. Execute o arquivo `database/schema.sql` completo
3. Verifique que as extensões `vector` e `uuid-ossp` foram habilitadas

```sql
-- Confirme que está tudo ok:
SELECT * FROM pg_extension WHERE extname IN ('vector', 'uuid-ossp');
```

### 4. Configurar Cloudflare R2

1. No painel Cloudflare, acesse **R2 → Create Bucket**
2. Nome do bucket: `cic-media` (ou o que definir em `R2_BUCKET_NAME`)
3. Acesse **R2 → Manage R2 API Tokens** → Create Token com permissão **Edit**
4. Copie `Access Key ID` e `Secret Access Key` para o `.env`
5. (Opcional) Configure um domínio público no bucket e defina `R2_PUBLIC_URL`

> Sem `R2_PUBLIC_URL`, a API gera URLs pré-assinadas com validade de 1 hora. 
> Com `R2_PUBLIC_URL`, as URLs são permanentes via CDN — recomendado para produção.

### 5. Popular RAG com o Segundo Cérebro

Coloque os 43 arquivos `.md` (capítulos do Segundo Cérebro do Fernando Carreiro)
na pasta `scripts/conhecimento/` e execute:

```bash
npm run seed-rag
```

Isso vai:
- Quebrar cada arquivo em chunks de ~500 palavras (50 palavras de overlap)
- Gerar embeddings via OpenAI `text-embedding-3-small`
- Inserir na tabela `knowledge_chunks` com pgvector

### 6. Iniciar em desenvolvimento

```bash
# Com Redis rodando localmente:
redis-server

# Em outro terminal:
npm run dev
```

Servidor sobe em `http://localhost:3001`  
Workers BullMQ iniciam automaticamente no mesmo processo.

### 7. Build e deploy no Railway

```bash
# railway.json já está configurado na raiz
railway up
```

Variáveis de ambiente devem ser configuradas no painel do Railway.  
Redis no Railway: adicione um plugin Redis e a variável `REDIS_URL` é preenchida automaticamente.

### 8. Verificar funcionamento

```bash
# Health check
curl http://localhost:3001/health

# Login de teste
curl -X POST http://localhost:3001/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"seu@email.com","password":"sua-senha"}'
```

---

## Arquitetura

```
index.js                    ← Entry point: Fastify + Workers
src/
  plugins/
    supabase.js             ← Decorator: fastify.supabase (service key)
    redis.js                ← Decorator: fastify.redis (ioredis)
    auth.js                 ← Decorators: authenticate, requireRole()
  routes/
    auth.js                 ← POST /auth/login, /refresh, /logout
    campaigns.js            ← CRUD /campaigns
    dashboard.js            ← GET /:id/dashboard
    demandas.js             ← CRUD /:id/demandas
    diagnostico.js          ← SWOT, narrativa, posicionamento
    monitoramento.js        ← Menções, sentimento, alertas
    crm.js                  ← Eleitores, segmentos
    fundraising.js          ← Doadores, doações, metas
    comunicacao.js          ← Disparos, templates, WhatsApp
    voluntarios.js          ← Cadastro, tarefas, gamificação
    producao.js             ← Materiais, aprovação
    agenda.js               ← Eventos, compromissos
    debate.js               ← Prep de debate, argumentos
    relatorios.js           ← PDFs, relatórios executivos
    pesquisas.js            ← Pesquisas eleitorais, intenção de voto
    gotv.js                 ← Get Out The Vote, zonas eleitorais
    mapa.js                 ← Mapa eleitoral, dados geográficos
    estrategia.js           ← Timeline, cenários, decisões
    social.js               ← Posts, calendário de conteúdo
    content.js              ← Geração de conteúdo via IA (queue)
    ia.js                   ← Chat SSE streaming, histórico, notificações
    image.js                ← Estúdio de Imagem (upload + Nano Banana 2)
    avatar.js               ← Estúdio de Avatar (HeyGen end-to-end)
    config.js               ← Usuários, equipe, permissões
  services/
    rag.js                  ← pgvector retrieval, embedding, prompt builder
    claude.js               ← generateStream(), generate(), classifyRequest()
    r2.js                   ← Cloudflare R2: upload, presigned URLs, resolve
  queues/
    index.js                ← BullMQ queues: text, image, video
  workers/
    text.worker.js          ← Claude text generation worker (concurrency 3)
    image.worker.js         ← Gemini image generation worker (concurrency 2)
    video.worker.js         ← HeyGen video worker (concurrency 1, 15min poll)
database/
  schema.sql                ← PostgreSQL schema completo com pgvector + RLS
scripts/
  seed-rag.js               ← Popula knowledge_chunks com embeddings
  conhecimento/             ← Coloque os 43 .md do Segundo Cérebro aqui
bot/
  telegram.js               ← Telegram bot para candidatos
```

---

## Módulos de IA

| Agente | Modelo | Uso |
|---|---|---|
| `roteiros` | Claude Opus 4.6 | Roteiros de campanha e discursos |
| `estrategia` | Claude Opus 4.6 | Estratégia eleitoral e cenários |
| `crise` | Claude Opus 4.6 | Gestão de crise e resposta rápida |
| `artigos` | Claude Sonnet 4.6 | Artigos, releases, manifestos |
| `sentimento` | Claude Sonnet 4.6 | Análise de sentimento e monitoramento |
| `visual` | Claude Sonnet 4.6 | Briefings visuais e identidade |
| `avatar` | Claude Sonnet 4.6 | Scripts para vídeos com avatar |
| `bot` | Claude Haiku 4.5 | Classificação de demandas do Telegram |
| `Nano Banana 2` | Gemini 2.0 Flash Preview Image | Geração de imagens de campanha |
| Avatar Video | HeyGen API v2 | Vídeos com avatar do candidato |

---

## Semana 4 — O que vem a seguir

- Webhook Apify para monitoramento em tempo real
- Análise de sentimento automática com Claude Sonnet
- Obsidian knowledge graph com D3.js
- Testes E2E com Fernando Carreiro
- Domínio próprio + HTTPS + compliance LGPD
- Painel de administração multi-tenant

---

## Contato

CIC — Centro de Inteligência de Campanha  
Desenvolvido com a metodologia FC+ de Fernando Carreiro  
bilbaodesign@gmail.com
