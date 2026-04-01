-- Migration 004: Super Admin + Subscription Plans + Module Gating
-- Run in Supabase SQL Editor

-- 1. Add super admin flag to profiles
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS is_super_admin boolean NOT NULL DEFAULT false;

-- 2. Add modules_enabled + api keys to org_configs
ALTER TABLE public.org_configs
  ADD COLUMN IF NOT EXISTS modules_enabled jsonb NOT NULL
    DEFAULT '["dash","ia","agenda","crm","demandas","comm","config"]'::jsonb,
  ADD COLUMN IF NOT EXISTS max_candidates integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS claude_api_key text,
  ADD COLUMN IF NOT EXISTS claude_model text NOT NULL DEFAULT 'claude-sonnet-4-6',
  ADD COLUMN IF NOT EXISTS plan_id uuid,
  ADD COLUMN IF NOT EXISTS plan_status text NOT NULL DEFAULT 'trial',
  ADD COLUMN IF NOT EXISTS plan_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS monthly_value numeric(10,2),
  ADD COLUMN IF NOT EXISTS setup_paid boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS notes text;

-- 3. Subscription plans table
CREATE TABLE IF NOT EXISTS public.subscription_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  description text,
  price_monthly numeric(10,2) NOT NULL,
  price_setup numeric(10,2) NOT NULL DEFAULT 0,
  modules jsonb NOT NULL DEFAULT '[]'::jsonb,
  max_candidates integer NOT NULL DEFAULT 1,
  features jsonb NOT NULL DEFAULT '[]'::jsonb,
  is_active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- RLS for subscription_plans (public read, service role write)
ALTER TABLE public.subscription_plans ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can read active plans"
  ON public.subscription_plans FOR SELECT USING (is_active = true);
CREATE POLICY "Service role manages plans"
  ON public.subscription_plans FOR ALL USING (auth.role() = 'service_role');

-- Trigger for updated_at
CREATE TRIGGER plans_updated_at
  BEFORE UPDATE ON public.subscription_plans
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- 4. Seed default plans
-- ─────────────────────────────────────────────────────────────────────────────
-- Modelo de negócio:
--   • Venda do sistema (white-label + configuração): R$ 200.000 (uma vez)
--   • Manutenção mensal: R$ 5k / R$ 10k / R$ 15k conforme plano
--   • API Claude: custo do próprio cliente (chave deles, não nossa)
--   • Projeção: 10 clientes = R$ 50k–150k MRR limpo
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO public.subscription_plans
  (name, slug, description, price_monthly, price_setup, modules, max_candidates, features, sort_order)
VALUES
(
  'Manutenção Essencial', 'essencial',
  'Suporte técnico + 7 módulos core. Ideal para operações menores.',
  5000.00, 200000.00,
  '["dash","ia","agenda","crm","demandas","comm","config"]'::jsonb,
  1,
  '["Dashboard analítico","Assistente IA personalizado","Agenda do candidato","CRM eleitores","Central de demandas","Comunicação","Suporte técnico mensal","Chave Claude do cliente"]'::jsonb,
  1
),
(
  'Manutenção Profissional', 'profissional',
  'Suporte técnico + 14 módulos. Para operações com múltiplos candidatos.',
  10000.00, 200000.00,
  '["dash","ia","agenda","crm","demandas","comm","diag","mon","vol","fund","prod","estr","pesq","config"]'::jsonb,
  3,
  '["14 módulos inclusos","Até 3 candidatos","Diagnóstico & SWOT","Monitoramento adversários","Fundraising","Voluntários","Produção IA","Estratégia","Pesquisas","Persona IA custom","Visual white-label completo"]'::jsonb,
  2
),
(
  'Manutenção Estratégico', 'estrategico',
  'Suporte técnico + todos os módulos. Operação eleitoral completa.',
  15000.00, 200000.00,
  '["dash","ia","agenda","crm","demandas","comm","diag","mon","vol","fund","prod","estr","pesq","gotv","mapa","debate","relat","social","config"]'::jsonb,
  999,
  '["Todos os 19 módulos","Candidatos ilimitados","GOTV Dia da Eleição","Mapa Eleitoral","Simulador Debate","Publicação Social","Relatórios avançados","Suporte prioritário","Onboarding dedicado","SLA garantido"]'::jsonb,
  3
)
ON CONFLICT (slug) DO NOTHING;

-- 5. Set Victor & Marcos as super admins
-- UPDATE public.profiles SET is_super_admin = true WHERE email IN ('bilbaodesign@gmail.com', 'marcos@email.com');
-- ↑ Descomente e substitua o email do Marcos antes de rodar
