-- ================================================================
-- CIC — Schema PostgreSQL + pgvector
-- Executar no Supabase SQL Editor
-- Ordem: extensões → tabelas → índices → funções RPC
-- ================================================================

-- Habilitar extensão pgvector
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ================================================================
-- ORGANIZAÇÕES
-- ================================================================
CREATE TABLE IF NOT EXISTS organizations (
  id         uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  name       text NOT NULL,
  slug       text UNIQUE NOT NULL,
  plan       text DEFAULT 'essencial' CHECK (plan IN ('essencial','profissional','enterprise')),
  created_at timestamptz DEFAULT now()
);

-- ================================================================
-- PERFIS DE USUÁRIO (extends Supabase auth.users)
-- ================================================================
CREATE TABLE IF NOT EXISTS profiles (
  id         uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email      text NOT NULL,
  name       text,
  org_id     uuid REFERENCES organizations(id),
  role       text DEFAULT 'editor' CHECK (role IN ('admin','editor','viewer')),
  avatar_url text,
  telefone   text,
  created_at timestamptz DEFAULT now()
);

-- ================================================================
-- CAMPANHAS
-- ================================================================
CREATE TABLE IF NOT EXISTS campaigns (
  id               uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id           uuid REFERENCES organizations(id) ON DELETE CASCADE,
  name             text NOT NULL,
  cargo            text NOT NULL,
  city             text NOT NULL,
  state            text NOT NULL,
  ideology         text,
  color            text DEFAULT '#FF2D2D',
  initials         text,
  strengths        text[],
  vulnerabilities  text[],
  rivals           jsonb,
  avatar_id        text,          -- HeyGen avatar ID
  status           text DEFAULT 'active' CHECK (status IN ('active','pre','maintenance','deleted')),
  deleted_at       timestamptz,
  created_at       timestamptz DEFAULT now()
);

-- ================================================================
-- DEMANDAS
-- ================================================================
CREATE TABLE IF NOT EXISTS demandas (
  id          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  campaign_id uuid REFERENCES campaigns(id) ON DELETE CASCADE,
  titulo      text NOT NULL,
  descricao   text,
  tipo        text NOT NULL,
  prioridade  text DEFAULT 'media' CHECK (prioridade IN ('alta','media','baixa')),
  status      text DEFAULT 'nova' CHECK (status IN ('nova','em_andamento','concluida','cancelada')),
  prazo       date,
  criado_por  uuid REFERENCES profiles(id),
  assigned_to uuid REFERENCES profiles(id),
  updated_at  timestamptz,
  created_at  timestamptz DEFAULT now()
);

-- ================================================================
-- CONTEÚDOS GERADOS (IA)
-- ================================================================
CREATE TABLE IF NOT EXISTS content_items (
  id                  uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  campaign_id         uuid REFERENCES campaigns(id) ON DELETE CASCADE,
  agent               text NOT NULL,
  type                text NOT NULL,
  prompt              text,
  output              text,
  status              text DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  fc_note             text,
  obsidian_note_path  text,
  approved_at         timestamptz,
  updated_at          timestamptz,
  created_at          timestamptz DEFAULT now()
);

-- ================================================================
-- KNOWLEDGE CHUNKS — Core do RAG
-- ================================================================
CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id         uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  source     text NOT NULL,       -- 'segundo_cerebro' | 'campanha' | 'vault'
  chapter    int,
  title      text,
  content    text NOT NULL,
  embedding  vector(1536),        -- OpenAI text-embedding-3-small
  tags       text[],
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS knowledge_chunks_embedding_idx
  ON knowledge_chunks USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- ================================================================
-- MONITORAMENTO DE EVENTOS
-- ================================================================
CREATE TABLE IF NOT EXISTS monitoring_events (
  id          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  campaign_id uuid REFERENCES campaigns(id) ON DELETE CASCADE,
  platform    text,
  content     text,
  sentiment   text CHECK (sentiment IN ('positive','negative','neutral')),
  reach       int DEFAULT 0,
  alert_level int DEFAULT 0 CHECK (alert_level BETWEEN 0 AND 3),
  created_at  timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS monitoring_events_campaign_idx ON monitoring_events(campaign_id, created_at DESC);

-- ================================================================
-- JOBS (fila de processamento)
-- ================================================================
CREATE TABLE IF NOT EXISTS jobs (
  id          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  campaign_id uuid REFERENCES campaigns(id),
  type        text NOT NULL,
  status      text DEFAULT 'queued' CHECK (status IN ('queued','processing','done','failed')),
  payload     jsonb,
  result_id   uuid,
  error       text,
  done_at     timestamptz,
  created_at  timestamptz DEFAULT now()
);

-- ================================================================
-- MEDIA ASSETS (imagens e vídeos gerados)
-- ================================================================
CREATE TABLE IF NOT EXISTS media_assets (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  campaign_id     uuid REFERENCES campaigns(id) ON DELETE CASCADE,
  type            text CHECK (type IN ('image','video')),
  url             text,
  r2_key          text,
  prompt          text,
  model           text,
  status          text DEFAULT 'gerado',
  heygen_video_id text,
  cost_usd        decimal(8,4),
  created_at      timestamptz DEFAULT now()
);

-- ================================================================
-- MÓDULOS OPERACIONAIS
-- ================================================================

CREATE TABLE IF NOT EXISTS pesquisas_eleitorais (
  id          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  campaign_id uuid REFERENCES campaigns(id) ON DELETE CASCADE,
  instituto   text, data date, intencao_voto decimal(5,2),
  rejeicao decimal(5,2), margem_erro decimal(4,2), created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS swot_items (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), campaign_id uuid REFERENCES campaigns(id) ON DELETE CASCADE,
  quadrante text CHECK (quadrante IN ('forcas','fraquezas','oportunidades','ameacas')),
  descricao text, peso int DEFAULT 5, created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS eleitores (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), campaign_id uuid REFERENCES campaigns(id) ON DELETE CASCADE,
  nome text NOT NULL, email text, telefone text, perfil text, regiao text,
  score int DEFAULT 50, tags text[], created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS segmentos (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), campaign_id uuid REFERENCES campaigns(id) ON DELETE CASCADE,
  nome text NOT NULL, criterios jsonb, total_eleitores int DEFAULT 0, created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS doadores (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), campaign_id uuid REFERENCES campaigns(id) ON DELETE CASCADE,
  nome text NOT NULL, cpf_cnpj text, tipo text CHECK (tipo IN ('PF','PJ')),
  limite_legal decimal(12,2), created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS doacoes (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), campaign_id uuid REFERENCES campaigns(id) ON DELETE CASCADE,
  doador_id uuid REFERENCES doadores(id), valor decimal(12,2) NOT NULL,
  data date NOT NULL, forma_pagamento text, created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS disparos (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), campaign_id uuid REFERENCES campaigns(id) ON DELETE CASCADE,
  canal text CHECK (canal IN ('whatsapp','sms','email','ligacao')),
  template_id uuid, segmento_id uuid, mensagem text, status text DEFAULT 'enviado',
  enviado_por uuid REFERENCES profiles(id), created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS templates (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), campaign_id uuid REFERENCES campaigns(id) ON DELETE CASCADE,
  nome text NOT NULL, canal text, conteudo text, created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS voluntarios (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), campaign_id uuid REFERENCES campaigns(id) ON DELETE CASCADE,
  nome text NOT NULL, email text, telefone text, regiao text, status text DEFAULT 'ativo',
  pontos int DEFAULT 0, avatar_url text, created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tarefas_voluntarios (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), campaign_id uuid REFERENCES campaigns(id) ON DELETE CASCADE,
  titulo text NOT NULL, descricao text, status text DEFAULT 'pendente' CHECK (status IN ('pendente','fazendo','concluida')),
  voluntario_id uuid REFERENCES voluntarios(id), prazo date, created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agenda (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), campaign_id uuid REFERENCES campaigns(id) ON DELETE CASCADE,
  titulo text NOT NULL, local text, tema text, tipo text, inicio timestamptz, fim timestamptz,
  cor text, created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS debate_sessoes (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), campaign_id uuid REFERENCES campaigns(id) ON DELETE CASCADE,
  user_id uuid REFERENCES profiles(id), oponente text, status text DEFAULT 'ativa',
  score_total int DEFAULT 0, created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS relatorios (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), campaign_id uuid REFERENCES campaigns(id) ON DELETE CASCADE,
  tipo text NOT NULL, status text DEFAULT 'gerado', url text, params jsonb,
  gerado_por uuid REFERENCES profiles(id), created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pesquisas (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), campaign_id uuid REFERENCES campaigns(id) ON DELETE CASCADE,
  titulo text NOT NULL, perguntas jsonb, status text DEFAULT 'rascunho',
  criado_por uuid REFERENCES profiles(id), created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS gotv_checklist (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), campaign_id uuid REFERENCES campaigns(id) ON DELETE CASCADE,
  item text NOT NULL, concluido boolean DEFAULT false, ordem int DEFAULT 0,
  updated_at timestamptz, created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS social_posts (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), campaign_id uuid REFERENCES campaigns(id) ON DELETE CASCADE,
  plataforma text, conteudo text, midia_url text, agendado_para timestamptz,
  status text DEFAULT 'agendado', alcance int, engajamento int,
  criado_por uuid REFERENCES profiles(id), created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS decisoes (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), campaign_id uuid REFERENCES campaigns(id) ON DELETE CASCADE,
  titulo text NOT NULL, contexto text, recomendacao_ia text,
  status text DEFAULT 'pendente' CHECK (status IN ('pendente','aprovada','rejeitada')),
  fc_nota text, decidido_em timestamptz, decidido_por uuid REFERENCES profiles(id),
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ia_historico (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), campaign_id uuid REFERENCES campaigns(id) ON DELETE CASCADE,
  user_id uuid REFERENCES profiles(id), agente text, pergunta text, resposta text,
  tokens int DEFAULT 0, created_at timestamptz DEFAULT now()
);

-- Tabelas de mapa (simplificadas — expandir com dados reais)
CREATE TABLE IF NOT EXISTS mapa_regioes (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), campaign_id uuid REFERENCES campaigns(id) ON DELETE CASCADE,
  nome text, score_prioridade int DEFAULT 50, votos_estimados int, status text DEFAULT 'Disputada',
  created_at timestamptz DEFAULT now()
);
CREATE TABLE IF NOT EXISTS mapa_zonas (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), campaign_id uuid REFERENCES campaigns(id) ON DELETE CASCADE,
  zona text, municipio text, eleitores int, status text, created_at timestamptz DEFAULT now()
);
CREATE TABLE IF NOT EXISTS mapa_demografico (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), campaign_id uuid REFERENCES campaigns(id) ON DELETE CASCADE,
  faixa_etaria jsonb, genero jsonb, renda jsonb, escolaridade jsonb, created_at timestamptz DEFAULT now()
);
CREATE TABLE IF NOT EXISTS narrativa (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), campaign_id uuid REFERENCES campaigns(id) ON DELETE CASCADE UNIQUE,
  mensagem_central text, eixos jsonb, created_at timestamptz DEFAULT now()
);
CREATE TABLE IF NOT EXISTS timeline_estrategia (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), campaign_id uuid REFERENCES campaigns(id) ON DELETE CASCADE,
  semana int, acoes jsonb, created_at timestamptz DEFAULT now()
);
CREATE TABLE IF NOT EXISTS cenarios (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), campaign_id uuid REFERENCES campaigns(id) ON DELETE CASCADE,
  turno text, percentual decimal(5,2), projecao_ia jsonb, created_at timestamptz DEFAULT now()
);
CREATE TABLE IF NOT EXISTS posicionamento (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), campaign_id uuid REFERENCES campaigns(id) ON DELETE CASCADE,
  tema text, candidato text, posicao text, created_at timestamptz DEFAULT now()
);

-- ================================================================
-- FUNÇÃO RPC PARA BUSCA VETORIAL (RAG)
-- ================================================================
CREATE OR REPLACE FUNCTION match_knowledge(
  query_embedding vector(1536),
  match_threshold float DEFAULT 0.75,
  match_count     int   DEFAULT 5
)
RETURNS TABLE(id uuid, content text, title text, chapter int, similarity float)
LANGUAGE sql STABLE AS $$
  SELECT
    id,
    content,
    title,
    chapter,
    1 - (embedding <=> query_embedding) AS similarity
  FROM knowledge_chunks
  WHERE 1 - (embedding <=> query_embedding) > match_threshold
  ORDER BY similarity DESC
  LIMIT match_count;
$$;

-- ================================================================
-- TRIGGER: atualiza profiles ao criar usuário
-- ================================================================
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO profiles (id, email, name, role)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'name', split_part(NEW.email, '@', 1)),
    COALESCE(NEW.raw_user_meta_data->>'role', 'editor')
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- ================================================================
-- ROW LEVEL SECURITY (RLS) — ativar nas tabelas principais
-- ================================================================
ALTER TABLE campaigns         ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_items     ENABLE ROW LEVEL SECURITY;
ALTER TABLE monitoring_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE media_assets      ENABLE ROW LEVEL SECURITY;

-- Política: usuário vê apenas campanhas da sua organização
CREATE POLICY "campaigns_org_isolation" ON campaigns
  USING (org_id = (SELECT org_id FROM profiles WHERE id = auth.uid()));

CREATE POLICY "content_items_campaign_isolation" ON content_items
  USING (campaign_id IN (
    SELECT id FROM campaigns WHERE org_id = (SELECT org_id FROM profiles WHERE id = auth.uid())
  ));

-- ================================================================
-- GOTV: dados iniciais de checklist
-- ================================================================
-- Execute após criar a primeira campanha:
-- INSERT INTO gotv_checklist (campaign_id, item, ordem) VALUES
--   (:cid, 'Confirmar lista de eleitores cadastrados', 1),
--   (:cid, 'Organizar equipe de transporte', 2),
--   (:cid, 'Enviar lembrete SMS/WhatsApp', 3),
--   (:cid, 'Briefing para fiscais', 4),
--   (:cid, 'Confirmar pontos de apoio', 5),
--   (:cid, 'Verificar materiais impressos', 6),
--   (:cid, 'Ativar monitoramento em tempo real', 7),
--   (:cid, 'Configurar dashboard de apuração', 8);

-- ================================================================
-- TABELAS SEMANA 2: Bot Telegram + Notificações
-- ================================================================

CREATE TABLE IF NOT EXISTS telegram_candidatos (
  id           uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  campaign_id  uuid REFERENCES campaigns(id) ON DELETE CASCADE,
  chat_id      text UNIQUE NOT NULL,
  nome_candidato text NOT NULL,
  ativo        boolean DEFAULT true,
  created_at   timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notificacoes (
  id          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  campaign_id uuid REFERENCES campaigns(id) ON DELETE CASCADE,
  tipo        text NOT NULL,
  mensagem    text NOT NULL,
  content_id  uuid REFERENCES content_items(id),
  lida        boolean DEFAULT false,
  created_at  timestamptz DEFAULT now()
);

-- Index para notificações não lidas
CREATE INDEX IF NOT EXISTS notificacoes_nao_lidas ON notificacoes(campaign_id, lida, created_at DESC);
