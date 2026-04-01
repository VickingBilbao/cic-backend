// ── /api/v1/campaigns/:id/diagnostico ────────────────────────
export default async function diagnosticoRoutes(fastify) {

  fastify.get('/:id/diagnostico/pesquisas', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const { data, error } = await fastify.supabase
      .from('pesquisas_eleitorais').select('*').eq('campaign_id', req.params.id).order('data', { ascending: false })
    if (error) return reply.status(500).send({ error: error.message })
    return { pesquisas: data }
  })

  fastify.post('/:id/diagnostico/pesquisas', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const { data, error } = await fastify.supabase
      .from('pesquisas_eleitorais').insert({ ...req.body, campaign_id: req.params.id }).select().single()
    if (error) return reply.status(400).send({ error: error.message })
    return reply.status(201).send({ pesquisa: data })
  })

  fastify.get('/:id/diagnostico/swot', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const { data, error } = await fastify.supabase
      .from('swot_items').select('*').eq('campaign_id', req.params.id)
    if (error) return reply.status(500).send({ error: error.message })
    const swot = { forcas: [], fraquezas: [], oportunidades: [], ameacas: [] }
    for (const item of (data || [])) { swot[item.quadrante]?.push(item) }
    return { swot }
  })

  fastify.get('/:id/diagnostico/cenarios', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const { data, error } = await fastify.supabase
      .from('cenarios').select('*').eq('campaign_id', req.params.id)
    if (error) return reply.status(500).send({ error: error.message })
    return { cenarios: data }
  })

  fastify.get('/:id/diagnostico/posicionamento', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const { data, error } = await fastify.supabase
      .from('posicionamento').select('*').eq('campaign_id', req.params.id)
    if (error) return reply.status(500).send({ error: error.message })
    return { posicionamento: data }
  })
}