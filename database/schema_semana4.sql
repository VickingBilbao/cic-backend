-- =============================================================================
-- CIC Schema — Semana 4 Additions
-- Run AFTER the main schema.sql
-- =============================================================================

-- ---------------------------------------------------------------------------
-- LGPD Consent Log
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lgpd_consentimentos (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID REFERENCES profiles(id) ON DELETE SET NULL,
  tipo        TEXT NOT NULL,          -- 'marketing' | 'analytics' | 'comunicacao' | 'todos'
  aceito      BOOLEAN NOT NULL,
  ip_hash     TEXT,                   -- SHA-256 of IP + salt, first 16 chars
  user_agent  TEXT,
  created_at  TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lgpd_consentimentos_user ON lgpd_consentimentos(user_id);

-- RLS: users can only see their own consent records
ALTER TABLE lgpd_consentimentos ENABLE ROW LEVEL SECURITY;
CREATE POLICY lgpd_own ON lgpd_consentimentos
  FOR ALL USING (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Obsidian Strategic Notes
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS obsidian_notas (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  titulo      TEXT NOT NULL,
  corpo       TEXT NOT NULL,
  tags        TEXT[] DEFAULT '{}',
  created_by  UUID REFERENCES profiles(id),
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_obsidian_notas_campaign ON obsidian_notas(campaign_id);
CREATE INDEX IF NOT EXISTS idx_obsidian_notas_tags ON obsidian_notas USING gin(tags);

-- ---------------------------------------------------------------------------
-- Monitoring Events — additional columns for Semana 4 sentiment fields
-- (idempotent — ALTER COLUMN IF NOT EXISTS equivalent)
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  BEGIN ALTER TABLE monitoring_events ADD COLUMN score_sentimento FLOAT; EXCEPTION WHEN duplicate_column THEN NULL; END;
  BEGIN ALTER TABLE monitoring_events ADD COLUMN topicos TEXT[]; EXCEPTION WHEN duplicate_column THEN NULL; END;
  BEGIN ALTER TABLE monitoring_events ADD COLUMN resumo TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END;
  BEGIN ALTER TABLE monitoring_events ADD COLUMN urgente BOOLEAN DEFAULT false; EXCEPTION WHEN duplicate_column THEN NULL; END;
  BEGIN ALTER TABLE monitoring_events ADD COLUMN tags TEXT[] DEFAULT '{}'; EXCEPTION WHEN duplicate_column THEN NULL; END;
  BEGIN ALTER TABLE monitoring_events ADD COLUMN notas TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END;
  BEGIN ALTER TABLE monitoring_events ADD COLUMN url TEXT UNIQUE; EXCEPTION WHEN duplicate_column THEN NULL; END;
  BEGIN ALTER TABLE monitoring_events ADD COLUMN autor TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END;
  BEGIN ALTER TABLE monitoring_events ADD COLUMN data_publicacao TIMESTAMPTZ; EXCEPTION WHEN duplicate_column THEN NULL; END;
  BEGIN ALTER TABLE monitoring_events ADD COLUMN raw JSONB; EXCEPTION WHEN duplicate_column THEN NULL; END;
END $$;

-- Performance indexes for monitoring queries
CREATE INDEX IF NOT EXISTS idx_monitoring_sentimento  ON monitoring_events(campaign_id, sentimento);
CREATE INDEX IF NOT EXISTS idx_monitoring_urgente     ON monitoring_events(campaign_id, urgente) WHERE urgente = true;
CREATE INDEX IF NOT EXISTS idx_monitoring_topicos     ON monitoring_events USING gin(topicos);
CREATE INDEX IF NOT EXISTS idx_monitoring_data        ON monitoring_events(campaign_id, data_publicacao DESC);

-- ---------------------------------------------------------------------------
-- media_assets — additional columns for R2 (Semana 3)
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  BEGIN ALTER TABLE media_assets ADD COLUMN storage_key TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END;
  BEGIN ALTER TABLE media_assets ADD COLUMN metadados JSONB DEFAULT '{}'; EXCEPTION WHEN duplicate_column THEN NULL; END;
END $$;

CREATE INDEX IF NOT EXISTS idx_media_assets_tipo    ON media_assets(campaign_id, tipo);
CREATE INDEX IF NOT EXISTS idx_media_assets_storage ON media_assets(storage_key);

-- ---------------------------------------------------------------------------
-- jobs table — ensure all required columns exist
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  BEGIN ALTER TABLE jobs ADD COLUMN tipo TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END;
  BEGIN ALTER TABLE jobs ADD COLUMN payload JSONB; EXCEPTION WHEN duplicate_column THEN NULL; END;
  BEGIN ALTER TABLE jobs ADD COLUMN result JSONB; EXCEPTION WHEN duplicate_column THEN NULL; END;
  BEGIN ALTER TABLE jobs ADD COLUMN error TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END;
  BEGIN ALTER TABLE jobs ADD COLUMN started_at TIMESTAMPTZ; EXCEPTION WHEN duplicate_column THEN NULL; END;
  BEGIN ALTER TABLE jobs ADD COLUMN finished_at TIMESTAMPTZ; EXCEPTION WHEN duplicate_column THEN NULL; END;
END $$;

CREATE INDEX IF NOT EXISTS idx_jobs_campaign_status ON jobs(campaign_id, status);
CREATE INDEX IF NOT EXISTS idx_jobs_tipo ON jobs(tipo, status);

-- ---------------------------------------------------------------------------
-- Notificacoes — ensure lida column + index
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  BEGIN ALTER TABLE notificacoes ADD COLUMN lida BOOLEAN DEFAULT false; EXCEPTION WHEN duplicate_column THEN NULL; END;
  BEGIN ALTER TABLE notificacoes ADD COLUMN metadados JSONB; EXCEPTION WHEN duplicate_column THEN NULL; END;
END $$;

CREATE INDEX IF NOT EXISTS idx_notificacoes_unread ON notificacoes(campaign_id, lida) WHERE lida = false;

-- ---------------------------------------------------------------------------
-- RPC: monitoring_sentiment_counts
-- Returns count per sentimento for a campaign
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION monitoring_sentiment_counts(p_campaign_id UUID)
RETURNS TABLE(sentimento TEXT, total BIGINT) AS $$
  SELECT
    COALESCE(sentimento, 'sem_analise') AS sentimento,
    COUNT(*) AS total
  FROM monitoring_events
  WHERE campaign_id = p_campaign_id
  GROUP BY sentimento
  ORDER BY total DESC;
$$ LANGUAGE SQL STABLE;

-- ---------------------------------------------------------------------------
-- Helper: bump updated_at on obsidian_notas
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_obsidian_notas_updated ON obsidian_notas;
CREATE TRIGGER trg_obsidian_notas_updated
  BEFORE UPDATE ON obsidian_notas
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
