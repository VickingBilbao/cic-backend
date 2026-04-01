// ── /api/v1/campaigns/:id/fundraising ────────────────────────
export default async function fundraisingRoutes(fastify) {

  fastify.get('/:id/fundraising/overview', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const { data, error } = await fastify.supabase.from('doacoes')
      .select('valor, data').eq('campaign_id', req.params.id)
    if (error) return reply.status(500).send({ error: error.message })
    const total = (data || []).reduce((s, d) => s + Number(d.valor), 0)
    return { arrecadado: total, meta: 1200000, percentual: Math.round((total / 1200000) * 100) }
  })

  fastify.get('/:id/fundraising/doadores', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const { data, error } = await fastify.supabase.from('doadores')
      .select('*, doacoes(valor, data)').eq('campaign_id', req.params.id).order('created_at', { ascending: false })
    if (error) return reply.status(500).send({ error: error.message })
    return { doadores: data }
  })

  fastify.post('/:id/fundraising/doadores', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const { data, error } = await fastify.supabase.from('doadores')
      .insert({ ...req.body, campaign_id: req.params.id }).select().single()
    if (error) return reply.status(400).send({ error: error.message })
    return reply.status(201).send({ doador: data })
  })

  fastify.post('/:id/fundraising/doacoes', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const { data, error } = await fastify.supabase.from('doacoes')
      .insert({ ...req.body, campaign_id: req.params.id }).select().single()
    if (error) return reply.status(400).send({ error: error.message })
    return reply.status(201).send({ doacao: data })
  })

  fastify.get('/:id/fundraising/compliance', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    return { status: 'regular', alertas: [], proximoPrazo: '2026-06-30' }
  })
}