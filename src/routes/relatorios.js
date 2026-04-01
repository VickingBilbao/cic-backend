// ── /api/v1/campaigns/:id/relatorios ─────────────────────────
export default async function relatoriosRoutes(fastify) {

  fastify.post('/:id/relatorios/gerar', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const { tipo, params: relParams } = req.body
    const { data: campaign } = await fastify.supabase.from('campaigns').select('name, cargo, city').eq('id', req.params.id).single()
    const { data: relatorio } = await fastify.supabase.from('relatorios')
      .insert({ campaign_id: req.params.id, tipo, status: 'gerado', gerado_por: req.user.id, params: relParams, url: null })
      .select().single()
    return { relatorioId: relatorio.id, status: 'gerado', tipo, campanha: campaign?.name }
  })

  fastify.get('/:id/relatorios/historico', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const { data, error } = await fastify.supabase.from('relatorios')
      .select('*').eq('campaign_id', req.params.id).order('created_at', { ascending: false })
    if (error) return reply.status(500).send({ error: error.message })
    return { relatorios: data }
  })
}