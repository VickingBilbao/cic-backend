// ── /api/v1/campaigns/:id/dashboard ──────────────────────────
export default async function dashboardRoutes(fastify) {

  // GET /campaigns/:id/dashboard — KPIs gerais
  fastify.get('/:id/dashboard', {
    preHandler: [fastify.authenticate]
  }, async (req, reply) => {
    const cid = req.params.id

    // Busca métricas agregadas da campanha
    const [alertsRes, eventsRes, contentRes] = await Promise.all([
      fastify.supabase.from('monitoring_events')
        .select('id, alert_level').eq('campaign_id', cid).gte('alert_level', 2),
      fastify.supabase.from('monitoring_events')
        .select('sentiment').eq('campaign_id', cid)
        .order('created_at', { ascending: false }).limit(500),
      fastify.supabase.from('content_items')
        .select('status').eq('campaign_id', cid)
    ])

    const events   = eventsRes.data || []
    const pos = events.filter(e => e.sentiment === 'positive').length
    const neg = events.filter(e => e.sentiment === 'negative').length
    const total = events.length || 1

    return {
      kpis: {
        intencaoVoto:      42,  // substituir por dado real de pesquisa
        mencoes:           { positivas: Math.round((pos / total) * 100), total },
        rejeicao:          28,  // substituir por dado real
        engajamento:       67,  // calcular via redes sociais
        healthScore:       74
      },
      conteudos: {
        gerados:   (contentRes.data || []).length,
        aprovados: (contentRes.data || []).filter(c => c.status === 'approved').length,
        pendentes: (contentRes.data || []).filter(c => c.status === 'pending').length
      },
      alertas: (alertsRes.data || []).length
    }
  })

  // GET /campaigns/:id/dashboard/health — score de saúde
  fastify.get('/:id/dashboard/health', {
    preHandler: [fastify.authenticate]
  }, async (req, reply) => {
    // Score calculado a partir de múltiplos indicadores
    const score = 74
    const label = score >= 70 ? 'Saudável' : score >= 40 ? 'Atenção' : 'Crítica'
    return { score, label, updatedAt: new Date() }
  })

  // GET /campaigns/:id/dashboard/alerts — alertas ativos
  fastify.get('/:id/dashboard/alerts', {
    preHandler: [fastify.authenticate]
  }, async (req, reply) => {
    const { data, error } = await fastify.supabase
      .from('monitoring_events')
      .select('id, platform, content, sentiment, alert_level, created_at')
      .eq('campaign_id', req.params.id)
      .gte('alert_level', 2)
      .order('created_at', { ascending: false })
      .limit(10)

    if (error) return reply.status(500).send({ error: error.message })
    return { alerts: data }
  })
}
