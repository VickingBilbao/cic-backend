-- Migration 003: Org Configs for white-label multi-tenancy
-- Run this in your Supabase SQL editor

CREATE TABLE IF NOT EXISTS public.org_configs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL UNIQUE,
  product_name text NOT NULL DEFAULT 'CIC',
  logo_url text,
  favicon_url text,
  persona_name text NOT NULL DEFAULT 'Aria',
  persona_title text NOT NULL DEFAULT 'Inteligência de Campanha',
  persona_description text NOT NULL DEFAULT 'Sua estrategista política com IA avançada',
  persona_short_desc text NOT NULL DEFAULT 'IA Estratégica',
  colors jsonb NOT NULL DEFAULT '{
    "red": "#e63946",
    "cyan": "#06b6d4",
    "green": "#22c55e",
    "amber": "#f59e0b",
    "sidebar_bg": "rgba(15,23,42,0.95)",
    "card_bg": "rgba(30,41,59,0.6)",
    "surface_bg": "rgba(15,23,42,0.8)",
    "input_bg": "rgba(30,41,59,0.8)",
    "text_primary": "rgba(255,255,255,0.95)",
    "text_secondary": "rgba(148,163,184,0.9)",
    "text_muted": "rgba(100,116,139,0.8)",
    "accent_primary": "#06b6d4",
    "accent_secondary": "#8b5cf6"
  }'::jsonb,
  font_family text NOT NULL DEFAULT 'Inter',
  font_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.org_configs ENABLE ROW LEVEL SECURITY;

-- Policy: users can only read their own org config
CREATE POLICY "Users can read own org config"
  ON public.org_configs FOR SELECT
  USING (
    org_id = (
      SELECT org_id FROM public.profiles
      WHERE id = auth.uid()
    )
  );

-- Policy: only service role / admins can write
CREATE POLICY "Service role can manage org configs"
  ON public.org_configs FOR ALL
  USING (auth.role() = 'service_role');

-- Trigger to auto-update updated_at
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER org_configs_updated_at
  BEFORE UPDATE ON public.org_configs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Seed: Fernando Carreiro org (replace ORG_ID with actual uuid from profiles table)
-- INSERT INTO public.org_configs (org_id, product_name, persona_name, persona_title, persona_description)
-- VALUES (
--   'YOUR-ORG-UUID-HERE',
--   'CIC - Centro de Inteligência de Campanha',
--   'Aria',
--   'Estrategista Política com IA',
--   'Análise profunda, estratégia precisa e execução inteligente para sua campanha'
-- );
