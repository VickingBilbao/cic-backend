-- Migration 005: Demo seed data for new client campaigns
-- Run after creating a new campaign via /sadmin to populate useful starting data.
-- Replace :campaign_id with the actual campaign UUID.
--
-- Usage (in Supabase SQL editor):
--   SELECT seed_demo_campaign('YOUR-CAMPAIGN-UUID-HERE');
-- ============================================================

CREATE OR REPLACE FUNCTION seed_demo_campaign(cid uuid)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  existing_count int;
BEGIN
  SELECT COUNT(*) INTO existing_count FROM gotv_checklist WHERE campaign_id = cid;
  IF existing_count > 0 THEN
    RETURN 'already seeded';
  END IF;

  -- ── GOTV Checklist ─────────────────────────────────────────
  INSERT INTO gotv_checklist (campaign_id, item, ordem, concluido) VALUES
    (cid, 'Cadastrar mesários voluntários por seção eleitoral',    1,  false),
    (cid, 'Mapear seções com maior concentração de indecisos',     2,  false),
    (cid, 'Contratar veículos para transporte de eleitores',       3,  false),
    (cid, 'Criar lista de eleitores que precisam de transporte',   4,  false),
    (cid, 'Disparar mensagem de lembrete D-3 para a base',         5,  false),
    (cid, 'Disparar mensagem D-1: horário e local de votação',     6,  false),
    (cid, 'Disparar mensagem no dia: mobilização final',           7,  false),
    (cid, 'Cadastrar fiscais em todas as seções prioritárias',     8,  false),
    (cid, 'Orientar fiscais sobre procedimentos de urna',          9,  false),
    (cid, 'Criar grupo de WhatsApp dos fiscais por região',        10, false),
    (cid, 'Definir pontos de apoio nas zonas eleitorais',          11, false),
    (cid, 'Preparar kits com água e lanche para voluntários',      12, false);

  -- ── SWOT Items ─────────────────────────────────────────────
  INSERT INTO swot_items (campaign_id, quadrante, descricao, peso) VALUES
    (cid, 'forcas',        'Alta aprovação na pauta de saúde (>60% positivo)',           90),
    (cid, 'forcas',        'Presença digital forte nas redes sociais',                   85),
    (cid, 'forcas',        'Histórico comprovado de entregas no mandato',                80),
    (cid, 'fraquezas',     'Rejeição elevada em segmento específico do eleitorado',      70),
    (cid, 'fraquezas',     'Baixa capilaridade em região prioritária',                   65),
    (cid, 'oportunidades', 'Pauta econômica em alta — oportunidade de alinhamento',     85),
    (cid, 'oportunidades', 'Voto jovem ainda indeciso — alto potencial de captação',    80),
    (cid, 'ameacas',       'Campanha de desinformação crescendo nas redes',              90),
    (cid, 'ameacas',       'Possível aliança entre adversários',                         75);

  -- ── Decisões Estratégicas Pendentes ────────────────────────
  INSERT INTO decisoes (campaign_id, titulo, contexto, recomendacao_ia, status) VALUES
    (cid,
     'Responder ao ataque do adversário nas redes sociais?',
     'Adversário lançou conteúdo com dados distorcidos. Equipe divide-se: rebater ou ignorar.',
     'Resposta técnica em 24h com dados reais. Silêncio pode ser interpretado como confirmação.',
     'pendente'),
    (cid,
     'Intensificar presença nas regiões com mais indecisos?',
     'Pesquisa interna: >25% de indecisos na região prioritária. Alto custo, alto retorno.',
     '+1.2pp estimado com 3 eventos presenciais + cobertura digital.',
     'pendente'),
    (cid,
     'Participar do próximo debate proposto pela imprensa?',
     'Principal adversário aceitou. Formato 45 min, sem tréplica.',
     'Participar. Ausência seria interpretada negativamente neste momento.',
     'pendente');

  -- ── Timeline Estratégica ────────────────────────────────────
  INSERT INTO timeline_estrategia (campaign_id, semana, acoes) VALUES
    (cid, 1, '{"fase":"Diagnóstico","objetivo":"Mapear cenário e definir persona","status":"concluida","itens":["Pesquisa qualitativa","SWOT completo","Eixos narrativos"]}'),
    (cid, 2, '{"fase":"Posicionamento","objetivo":"Consolidar narrativa vs adversário","status":"concluida","itens":["Workshop equipe","Slogan","Teste A/B"]}'),
    (cid, 3, '{"fase":"Lançamento digital","objetivo":"Ativar presença nas redes","status":"em_andamento","itens":["TikTok","Instagram","Vídeo"]}'),
    (cid, 4, '{"fase":"Capilarização","objetivo":"Expandir base nas zonas prioritárias","status":"pendente","itens":["Eventos regionais","Parcerias","Voluntários"]}'),
    (cid, 5, '{"fase":"Intensificação","objetivo":"Converter indecisos — reta final","status":"pendente","itens":["Impulsionamento","Debates","GOTV"]}');

  -- ── Cenários Eleitorais ────────────────────────────────────
  INSERT INTO cenarios (campaign_id, turno, percentual, projecao_ia) VALUES
    (cid, '1º turno', 34.7, '{"cenario":"Provável 2º turno","confianca":75,"recomendacao":"Focar indecisos para ultrapassar 40%"}'),
    (cid, '2º turno', 52.0, '{"cenario":"Vitória em 2T","confianca":65,"recomendacao":"Manter vantagem no eleitorado de centro"}');

  -- ── Posicionamento por Tema ────────────────────────────────
  INSERT INTO posicionamento (campaign_id, tema, candidato, posicao) VALUES
    (cid, 'Saúde',      'Candidato', 'Único com histórico de entregas em saúde. Proposta: ampliar atendimento em 30%.'),
    (cid, 'Transporte', 'Candidato', 'Plano de mobilidade para áreas periféricas. Parceria com governo federal.'),
    (cid, 'Educação',   'Candidato', '100 novas creches em tempo integral para famílias trabalhadoras.'),
    (cid, 'Segurança',  'Candidato', 'Câmeras inteligentes em pontos críticos + reforço de agentes municipais.');

  RETURN 'seeded successfully';
END;
$$;

-- SELECT seed_demo_campaign('CAMPAIGN-UUID-HERE');
