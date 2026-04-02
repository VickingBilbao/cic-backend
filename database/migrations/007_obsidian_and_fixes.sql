-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 007: Obsidian Notas + gotv_checklist seed + knowledge_chunks idx
-- ═══════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. obsidian_notas — free-form strategic notes for the knowledge graph
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.obsidian_notas (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES public.campaigns(id) ON DELETE CASCADE,
  titulo      text NOT NULL,
  corpo       text NOT NULL DEFAULT '',
  tags        text[] NOT NULL DEFAULT '{}',
  gerada_ia   boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_obsidian_notas_campaign ON public.obsidian_notas(campaign_id);
CREATE INDEX IF NOT EXISTS idx_obsidian_notas_tags     ON public.obsidian_notas USING GIN(tags);

ALTER TABLE public.obsidian_notas ENABLE ROW LEVEL SECURITY;
CREATE POLICY "obsidian_notas_org_isolation" ON public.obsidian_notas
  FOR ALL USING (campaign_in_my_org(campaign_id));
CREATE POLICY "obsidian_notas_service_role" ON public.obsidian_notas
  FOR ALL USING (auth.role() = 'service_role');

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. knowledge_chunks — add campaign_id + org_id columns for scoping
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.knowledge_chunks
  ADD COLUMN IF NOT EXISTS campaign_id uuid REFERENCES public.campaigns(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS org_id      uuid,
  ADD COLUMN IF NOT EXISTS tipo        text DEFAULT 'geral',     -- 'geral'|'estrategia'|'contexto'|'referencia'
  ADD COLUMN IF NOT EXISTS relevancia  integer DEFAULT 5;        -- 1-10

CREATE INDEX IF NOT EXISTS idx_kc_campaign ON public.knowledge_chunks(campaign_id);
CREATE INDEX IF NOT EXISTS idx_kc_org      ON public.knowledge_chunks(org_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. gotv_checklist — seed default items if table is empty per campaign
--    (items will be created by the seed endpoint, this just ensures the
--    table has the right columns)
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.gotv_checklist
  ADD COLUMN IF NOT EXISTS responsavel text,
  ADD COLUMN IF NOT EXISTS prazo       date,
  ADD COLUMN IF NOT EXISTS categoria   text DEFAULT 'geral';

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. monitoring_events — add tags column (referenced in adversarios route)
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.monitoring_events
  ADD COLUMN IF NOT EXISTS tags    text[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS resumo  text,
  ADD COLUMN IF NOT EXISTS urgente boolean DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_mon_tags ON public.monitoring_events USING GIN(tags);

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Service-role bypass for new tables
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.gotv_checklist ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_bypass_gotv_checklist" ON public.gotv_checklist;
CREATE POLICY "service_role_bypass_gotv_checklist" ON public.gotv_checklist
  FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "gotv_checklist_org_isolation" ON public.gotv_checklist
  FOR ALL USING (campaign_in_my_org(campaign_id));
