// ── /api/v1/campaigns/:id/dashboard ──────────────────────────
export default async function dashboardRoutes(fastify) {

  // ── Helper: calcula health score a partir de dados reais ──
  async function calcHealthScore(supabase, cid) {
    const [monRes, contentRes, iaRes, demandasRes] = await Promise.all([
      supabase.from('monitoring_events')
        .select('sentiment, urgente')
        .eq('campaign_id', cid)
        .order('created_at', { ascending: false })
        .limit(200),
      supabase.from('content_items')
        .select('status')
        .eq('campaign_id', cid),
      supabase.from('ia_historico')
        .select('id')
        .eq('campaign_id', cid)
        .gte('created_at', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()),
      supabase.from('demandas')
        .select('status')
        .eq('campaign_id', cid)
        .in('status', ['nova', 'em_andamento'])
    ])

    let score = 60 // base

    // +/- Sentimento de monitoramento (max ±20)
    const events = monRes.data || []
    if (events.length > 0) {
      const pos = events.filter(e => e.sentiment === 'positivo' || e.sentiment === 'positive').length
      const neg = events.filter(e => e.sentiment === 'negativo' || e.sentiment === 'negative').length
      const ratio = pos / (pos + neg || 1)
      score += Math.round((ratio - 0.5) * 40) // -20 a +20
    }

    // + Atividade de conteúdo (max +15)
    const contents = contentRes.data || []
    const approved = contents.filter(c => c.status === 'approved' || c.status === 'aprovado').length
    score += Math.min(approved * 3, 15)

    // + Atividade IA recente (max +10)
    const iaActivity = (iaRes.data || []).length
    score += Math.min(iaActivity * 2, 10)

    // - Demandas abertas (penalidade, max -15)
    const demandasAbertas = (demandasRes.data || []).length
    score -= Math.min(demandasAbertas * 3, 15)

    // - Alertas urgentes (max -20)
    const urgentes = events.filter(e => e.urgente).length
    score -= Math.min(urgentes * 5, 20)

    return Math.max(0, Math.min(100, Math.round(score)))
  }

  // GET /campaigns/:id/dashboard — KPIs gerais
  fastify.get('/:id/dashboard', {
    preHandler: [fastify.authenticate]
  }, async (req, reply) => {
    const cid = req.params.id

    const [alertsRes, eventsRes, contentRes, pesquisaRes, demandasRes, iaRes] = await Promise.all([
      fastify.supabase.from('monitoring_events')
        .select('id, urgente').eq('campaign_id', cid).eq('urgente', true),
      fastify.supabase.from('monitoring_events')
        .select('sentiment').eq('campaign_id', cid)
        .order('created_at', { ascending: false }).limit(500),
      fastify.supabase.from('content_items')
        .select('status').eq('campaign_id', cid),
      fastify.supabase.from('pesquisas_eleitorais')
        .select('intencao_voto, rejeicao, data')
        .eq('campaign_id', cid)
        .order('data', { ascending: false })
        .limit(1),
      fastify.supabase.from('demandas')
        .select('status').eq('campaign_id', cid),
      fastify.supabase.from('ia_historico')
        .select('id')
        .eq('campaign_id', cid)
        .order('created_at', { ascending: false })
        .limit(1)
    ])

    const events  = eventsRes.data || []
    const pos     = events.filter(e => e.sentiment === 'positivo' || e.sentiment === 'positive').length
    const neg     = events.filter(e => e.sentiment === 'negativo' || e.sentiment === 'negative').length
    const total   = events.length || 0

    // KPIs de pesquisa — null se não houver dado real
    const ultimaPesquisa = (pesquisaRes.data || [])[0] || null
    const intencaoVoto   = ultimaPesquisa?.intencao_voto ?? null
    const rejeicao       = ultimaPesquisa?.rejeicao      ?? null

    // Engajamento calculado: % do conteúdo aprovado + atividade IA
    const contents     = contentRes.data || []
    const approved     = contents.filter(c => c.status === 'approved' || c.status === 'aprovado').length
    const engajamento  = contents.length > 0
      ? Math.round((approved / contents.length) * 100)
      : null

    // Health score real
    const healthScore = await calcHealthScore(fastify.supabase, cid)
    const healthLabel = healthScore >= 70 ? 'Saudável' : healthScore >= 40 ? 'Atenção' : 'Crítica'

    // Demandas
    const demandas       = demandasRes.data || []
    const demandasNovas  = demandas.filter(d => d.status === 'nova').length
    const demandasEmAnd  = demandas.filter(d => d.status === 'em_andamento').length
    const demandasFechad = demandas.filter(d => d.status === 'concluida').length

    return {
      kpis: {
        intencaoVoto,                    // null se sem dados de pesquisa
        rejeicao,                        // null se sem dados de pesquisa
        mencoes: {
          positivas: total > 0 ? Math.round((pos / total) * 100) : 0,
          negativas: total > 0 ? Math.round((neg / total) * 100) : 0,
          total
        },
        engajamento,                     // null se sem conteúdo
        healthScore,
        healthLabel,
        ultimaPesquisaEm: ultimaPesquisa?.data ?? null,
      },
      conteudos: {
        gerados:   contents.length,
        aprovados: approved,
        pendentes: contents.filter(c => c.status === 'pending' || c.status === 'pendente').length,
        rejeitados: contents.filter(c => c.status === 'rejected' || c.status === 'rejeitado').length,
      },
      demandas: {
        novas:      demandasNovas,
        em_andamento: demandasEmAnd,
        concluidas: demandasFechad,
        total:      demandas.length,
      },
      alertas:      (alertsRes.data || []).length,
      temIAAtiva:   (iaRes.data || []).length > 0,
    }
  })

  // GET /campaigns/:id/dashboard/health — score de saúde detalhado
  fastify.get('/:id/dashboard/health', {
    preHandler: [fastify.authenticate]
  }, async (req, reply) => {
    const cid   = req.params.id
    const score = await calcHealthScore(fastify.supabase, cid)
    const label = score >= 70 ? 'Saudável' : score >= 40 ? 'Atenção' : 'Crítica'
    return { score, label, updatedAt: new Date() }
  })

  // GET /campaigns/:id/dashboard/alerts — alertas ativos
  fastify.get('/:id/dashboard/alerts', {
    preHandler: [fastify.authenticate]
  }, async (req, reply) => {
    const { data, error } = await fastify.supabase
      .from('monitoring_events')
      .select('id, platform, content, sentiment, urgente, created_at')
      .eq('campaign_id', req.params.id)
      .eq('urgente', true)
      .order('created_at', { ascending: false })
      .limit(10)

    if (error) return reply.status(500).send({ error: error.message })
    return { alerts: data }
  })

  // GET /campaigns/:id/dashboard/summary — resumo executivo (para super admin)
  fastify.get('/:id/dashboard/summary', {
    preHandler: [fastify.authenticate]
  }, async (req, reply) => {
    const cid = req.params.id

    const [campRes, iaCountRes, contentCountRes, monCountRes] = await Promise.all([
      fastify.supabase.from('campaigns').select('name, cargo, city, state, status, color, created_at').eq('id', cid).single(),
      fastify.supabase.from('ia_historico').select('id', { count: 'exact', head: true }).eq('campaign_id', cid),
      fastify.supabase.from('content_items').select('id', { count: 'exact', head: true }).eq('campaign_id', cid),
      fastify.supabase.from('monitoring_events').select('id', { count: 'exact', head: true }).eq('campaign_id', cid),
    ])

    return {
      campanha:          campRes.data,
      totalInteracoesIA: iaCountRes.count ?? 0,
      totalConteudos:    contentCountRes.count ?? 0,
      totalEventosMon:   monCountRes.count ?? 0,
      healthScore:       await calcHealthScore(fastify.supabase, cid),
    }
  })
}
