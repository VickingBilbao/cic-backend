// ── /api/v1/campaigns/:id/pesquisas ──────────────────────────
export default async function pesquisasRoutes(fastify) {

  fastify.get('/:id/pesquisas', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const { data, error } = await fastify.supabase.from('pesquisas')
      .select('*').eq('campaign_id', req.params.id).order('created_at', { ascending: false })
    if (error) return reply.status(500).send({ error: error.message })
    return { pesquisas: data }
  })

  fastify.post('/:id/pesquisas', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const { data, error } = await fastify.supabase.from('pesquisas')
      .insert({ ...req.body, campaign_id: req.params.id, status: 'rascunho', criado_por: req.user.id }).select().single()
    if (error) return reply.status(400).send({ error: error.message })
    return reply.status(201).send({ pesquisa: data })
  })

  fastify.patch('/:id/pesquisas/:pid/status', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const { status } = req.body
    const { data, error } = await fastify.supabase.from('pesquisas')
      .update({ status }).eq('id', req.params.pid).eq('campaign_id', req.params.id).select().single()
    if (error) return reply.status(400).send({ error: error.message })
    return { pesquisa: data }
  })
}