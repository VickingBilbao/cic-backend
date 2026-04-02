-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 006: Multi-Tenant Architecture
-- Adds: seats model, org_invites, full RLS coverage on all module tables
-- Run in Supabase SQL Editor
-- ═══════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Add seats_limit to org_configs (cadeiras = team seats per marketeiro)
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.org_configs
  ADD COLUMN IF NOT EXISTS seats_limit integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS owner_name  text;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. org_invites — invite team members to an org
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.org_invites (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL,
  email       text NOT NULL,
  role        text NOT NULL DEFAULT 'member',   -- 'admin' | 'member' | 'viewer'
  token       text NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(32), 'hex'),
  invited_by  uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  expires_at  timestamptz NOT NULL DEFAULT now() + interval '7 days',
  accepted_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT org_invites_role_check CHECK (role IN ('admin','member','viewer'))
);

CREATE INDEX IF NOT EXISTS idx_org_invites_org    ON public.org_invites(org_id);
CREATE INDEX IF NOT EXISTS idx_org_invites_email  ON public.org_invites(email);
CREATE INDEX IF NOT EXISTS idx_org_invites_token  ON public.org_invites(token);

ALTER TABLE public.org_invites ENABLE ROW LEVEL SECURITY;

-- Org admins can see/manage invites for their own org
CREATE POLICY "Org admins manage invites"
  ON public.org_invites FOR ALL
  USING (
    org_id = (SELECT org_id FROM public.profiles WHERE id = auth.uid())
    AND EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid() AND role IN ('admin','super_admin')
    )
  );

-- Service role full access
CREATE POLICY "Service role manages invites"
  ON public.org_invites FOR ALL USING (auth.role() = 'service_role');

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Helper function — get org_id for current user
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION current_user_org_id()
RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT org_id FROM public.profiles WHERE id = auth.uid() LIMIT 1;
$$;

-- Helper: is a campaign in current user's org?
CREATE OR REPLACE FUNCTION campaign_in_my_org(p_campaign_id uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.campaigns
    WHERE id = p_campaign_id
      AND org_id = current_user_org_id()
  );
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Full RLS coverage on all module tables
--    Pattern: data must belong to a campaign in the user's org
-- ─────────────────────────────────────────────────────────────────────────────

-- ── demandas ─────────────────────────────────────────────────────────────────
ALTER TABLE public.demandas ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "demandas_org_isolation" ON public.demandas;
CREATE POLICY "demandas_org_isolation" ON public.demandas
  FOR ALL USING (campaign_in_my_org(campaign_id));

-- ── content_items (already has RLS, add campaign-level policy) ───────────────
DROP POLICY IF EXISTS "Users can access own org content" ON public.content_items;
CREATE POLICY "content_items_org_isolation" ON public.content_items
  FOR ALL USING (campaign_in_my_org(campaign_id));

-- ── knowledge_chunks ─────────────────────────────────────────────────────────
ALTER TABLE public.knowledge_chunks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "knowledge_chunks_org_isolation" ON public.knowledge_chunks;
CREATE POLICY "knowledge_chunks_org_isolation" ON public.knowledge_chunks
  FOR ALL USING (
    org_id = current_user_org_id()
    OR campaign_id IS NULL  -- global knowledge (Segundo Cérebro) readable by all
    OR campaign_in_my_org(campaign_id)
  );

-- ── monitoring_events (already has RLS) ──────────────────────────────────────
DROP POLICY IF EXISTS "Users can access own org monitoring" ON public.monitoring_events;
CREATE POLICY "monitoring_org_isolation" ON public.monitoring_events
  FOR ALL USING (campaign_in_my_org(campaign_id));

-- ── ia_historico ─────────────────────────────────────────────────────────────
ALTER TABLE public.ia_historico ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ia_historico_org_isolation" ON public.ia_historico;
CREATE POLICY "ia_historico_org_isolation" ON public.ia_historico
  FOR ALL USING (campaign_in_my_org(campaign_id));

-- ── relatorios ───────────────────────────────────────────────────────────────
ALTER TABLE public.relatorios ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "relatorios_org_isolation" ON public.relatorios;
CREATE POLICY "relatorios_org_isolation" ON public.relatorios
  FOR ALL USING (campaign_in_my_org(campaign_id));

-- ── agenda ───────────────────────────────────────────────────────────────────
ALTER TABLE public.agenda ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "agenda_org_isolation" ON public.agenda;
CREATE POLICY "agenda_org_isolation" ON public.agenda
  FOR ALL USING (campaign_in_my_org(campaign_id));

-- ── eleitores ────────────────────────────────────────────────────────────────
ALTER TABLE public.eleitores ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "eleitores_org_isolation" ON public.eleitores;
CREATE POLICY "eleitores_org_isolation" ON public.eleitores
  FOR ALL USING (campaign_in_my_org(campaign_id));

-- ── segmentos ────────────────────────────────────────────────────────────────
ALTER TABLE public.segmentos ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "segmentos_org_isolation" ON public.segmentos;
CREATE POLICY "segmentos_org_isolation" ON public.segmentos
  FOR ALL USING (campaign_in_my_org(campaign_id));

-- ── doadores ─────────────────────────────────────────────────────────────────
ALTER TABLE public.doadores ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "doadores_org_isolation" ON public.doadores;
CREATE POLICY "doadores_org_isolation" ON public.doadores
  FOR ALL USING (campaign_in_my_org(campaign_id));

-- ── doacoes ──────────────────────────────────────────────────────────────────
ALTER TABLE public.doacoes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "doacoes_org_isolation" ON public.doacoes;
CREATE POLICY "doacoes_org_isolation" ON public.doacoes
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM public.doadores d
      WHERE d.id = doacoes.doador_id
        AND campaign_in_my_org(d.campaign_id)
    )
  );

-- ── disparos ─────────────────────────────────────────────────────────────────
ALTER TABLE public.disparos ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "disparos_org_isolation" ON public.disparos;
CREATE POLICY "disparos_org_isolation" ON public.disparos
  FOR ALL USING (campaign_in_my_org(campaign_id));

-- ── templates ────────────────────────────────────────────────────────────────
ALTER TABLE public.templates ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "templates_org_isolation" ON public.templates;
CREATE POLICY "templates_org_isolation" ON public.templates
  FOR ALL USING (campaign_in_my_org(campaign_id));

-- ── voluntarios ──────────────────────────────────────────────────────────────
ALTER TABLE public.voluntarios ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "voluntarios_org_isolation" ON public.voluntarios;
CREATE POLICY "voluntarios_org_isolation" ON public.voluntarios
  FOR ALL USING (campaign_in_my_org(campaign_id));

-- ── tarefas_voluntarios ───────────────────────────────────────────────────────
ALTER TABLE public.tarefas_voluntarios ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tarefas_voluntarios_org_isolation" ON public.tarefas_voluntarios;
CREATE POLICY "tarefas_voluntarios_org_isolation" ON public.tarefas_voluntarios
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM public.voluntarios v
      WHERE v.id = tarefas_voluntarios.voluntario_id
        AND campaign_in_my_org(v.campaign_id)
    )
  );

-- ── pesquisas_eleitorais ──────────────────────────────────────────────────────
ALTER TABLE public.pesquisas_eleitorais ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "pesquisas_org_isolation" ON public.pesquisas_eleitorais;
CREATE POLICY "pesquisas_org_isolation" ON public.pesquisas_eleitorais
  FOR ALL USING (campaign_in_my_org(campaign_id));

-- ── swot_items ────────────────────────────────────────────────────────────────
ALTER TABLE public.swot_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "swot_org_isolation" ON public.swot_items;
CREATE POLICY "swot_org_isolation" ON public.swot_items
  FOR ALL USING (campaign_in_my_org(campaign_id));

-- ── debate_sessoes ────────────────────────────────────────────────────────────
ALTER TABLE public.debate_sessoes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "debate_org_isolation" ON public.debate_sessoes;
CREATE POLICY "debate_org_isolation" ON public.debate_sessoes
  FOR ALL USING (campaign_in_my_org(campaign_id));

-- ── social_posts ─────────────────────────────────────────────────────────────
ALTER TABLE public.social_posts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "social_posts_org_isolation" ON public.social_posts;
CREATE POLICY "social_posts_org_isolation" ON public.social_posts
  FOR ALL USING (campaign_in_my_org(campaign_id));

-- ── decisoes ─────────────────────────────────────────────────────────────────
ALTER TABLE public.decisoes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "decisoes_org_isolation" ON public.decisoes;
CREATE POLICY "decisoes_org_isolation" ON public.decisoes
  FOR ALL USING (campaign_in_my_org(campaign_id));

-- ── gotv_checklist ────────────────────────────────────────────────────────────
ALTER TABLE public.gotv_checklist ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "gotv_org_isolation" ON public.gotv_checklist;
CREATE POLICY "gotv_org_isolation" ON public.gotv_checklist
  FOR ALL USING (campaign_in_my_org(campaign_id));

-- ── mapa_regioes ──────────────────────────────────────────────────────────────
ALTER TABLE public.mapa_regioes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "mapa_regioes_org_isolation" ON public.mapa_regioes;
CREATE POLICY "mapa_regioes_org_isolation" ON public.mapa_regioes
  FOR ALL USING (campaign_in_my_org(campaign_id));

-- ── mapa_zonas ────────────────────────────────────────────────────────────────
ALTER TABLE public.mapa_zonas ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "mapa_zonas_org_isolation" ON public.mapa_zonas;
CREATE POLICY "mapa_zonas_org_isolation" ON public.mapa_zonas
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM public.mapa_regioes r
      WHERE r.id = mapa_zonas.regiao_id
        AND campaign_in_my_org(r.campaign_id)
    )
  );

-- ── mapa_demografico ──────────────────────────────────────────────────────────
ALTER TABLE public.mapa_demografico ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "mapa_demografico_org_isolation" ON public.mapa_demografico;
CREATE POLICY "mapa_demografico_org_isolation" ON public.mapa_demografico
  FOR ALL USING (campaign_in_my_org(campaign_id));

-- ── narrativa ─────────────────────────────────────────────────────────────────
ALTER TABLE public.narrativa ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "narrativa_org_isolation" ON public.narrativa;
CREATE POLICY "narrativa_org_isolation" ON public.narrativa
  FOR ALL USING (campaign_in_my_org(campaign_id));

-- ── timeline_estrategia ───────────────────────────────────────────────────────
ALTER TABLE public.timeline_estrategia ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "timeline_org_isolation" ON public.timeline_estrategia;
CREATE POLICY "timeline_org_isolation" ON public.timeline_estrategia
  FOR ALL USING (campaign_in_my_org(campaign_id));

-- ── cenarios ──────────────────────────────────────────────────────────────────
ALTER TABLE public.cenarios ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "cenarios_org_isolation" ON public.cenarios;
CREATE POLICY "cenarios_org_isolation" ON public.cenarios
  FOR ALL USING (campaign_in_my_org(campaign_id));

-- ── posicionamento ────────────────────────────────────────────────────────────
ALTER TABLE public.posicionamento ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "posicionamento_org_isolation" ON public.posicionamento;
CREATE POLICY "posicionamento_org_isolation" ON public.posicionamento
  FOR ALL USING (campaign_in_my_org(campaign_id));

-- ── pesquisas ─────────────────────────────────────────────────────────────────
ALTER TABLE public.pesquisas ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "pesquisas_table_org_isolation" ON public.pesquisas;
CREATE POLICY "pesquisas_table_org_isolation" ON public.pesquisas
  FOR ALL USING (campaign_in_my_org(campaign_id));

-- ── jobs ──────────────────────────────────────────────────────────────────────
ALTER TABLE public.jobs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "jobs_org_isolation" ON public.jobs;
CREATE POLICY "jobs_org_isolation" ON public.jobs
  FOR ALL USING (
    org_id = current_user_org_id()
    OR campaign_in_my_org(campaign_id)
  );

-- ── media_assets (already has RLS) ───────────────────────────────────────────
DROP POLICY IF EXISTS "Users can access own org media" ON public.media_assets;
CREATE POLICY "media_assets_org_isolation" ON public.media_assets
  FOR ALL USING (org_id = current_user_org_id());

-- ── telegram_candidatos ───────────────────────────────────────────────────────
ALTER TABLE public.telegram_candidatos ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "telegram_org_isolation" ON public.telegram_candidatos;
CREATE POLICY "telegram_org_isolation" ON public.telegram_candidatos
  FOR ALL USING (campaign_in_my_org(campaign_id));

-- ── notificacoes ──────────────────────────────────────────────────────────────
ALTER TABLE public.notificacoes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "notificacoes_org_isolation" ON public.notificacoes;
CREATE POLICY "notificacoes_org_isolation" ON public.notificacoes
  FOR ALL USING (
    user_id = auth.uid()
    OR org_id = current_user_org_id()
  );

-- ── profiles — members can see others in same org ─────────────────────────────
DROP POLICY IF EXISTS "profiles_same_org" ON public.profiles;
CREATE POLICY "profiles_same_org" ON public.profiles
  FOR SELECT USING (
    id = auth.uid()
    OR org_id = current_user_org_id()
  );

CREATE POLICY "profiles_self_update" ON public.profiles
  FOR UPDATE USING (id = auth.uid());

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Service-role bypass for all tables (so backend can operate freely)
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  tbl text;
  tbls text[] := ARRAY[
    'demandas','knowledge_chunks','ia_historico','relatorios','agenda',
    'eleitores','segmentos','doadores','doacoes','disparos','templates',
    'voluntarios','tarefas_voluntarios','pesquisas_eleitorais','swot_items',
    'debate_sessoes','social_posts','decisoes','gotv_checklist','mapa_regioes',
    'mapa_zonas','mapa_demografico','narrativa','timeline_estrategia',
    'cenarios','posicionamento','pesquisas','jobs','telegram_candidatos',
    'notificacoes','org_invites'
  ];
BEGIN
  FOREACH tbl IN ARRAY tbls LOOP
    EXECUTE format(
      'DROP POLICY IF EXISTS "service_role_bypass_%s" ON public.%I;
       CREATE POLICY "service_role_bypass_%s" ON public.%I
         FOR ALL USING (auth.role() = ''service_role'');',
      tbl, tbl, tbl, tbl
    );
  END LOOP;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Update org_configs: super admins bypass RLS
-- ─────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "super_admin_bypass_org_configs" ON public.org_configs;
CREATE POLICY "super_admin_bypass_org_configs" ON public.org_configs
  FOR ALL USING (
    auth.role() = 'service_role'
    OR EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid() AND is_super_admin = true
    )
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. View: org_members — easy way to list team members per org
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.org_members AS
  SELECT
    p.id,
    p.org_id,
    p.name,
    p.email,
    p.role,
    p.created_at,
    p.updated_at
  FROM public.profiles p
  ORDER BY p.created_at ASC;

-- ─────────────────────────────────────────────────────────────────────────────
-- End of migration 006
-- ─────────────────────────────────────────────────────────────────────────────
