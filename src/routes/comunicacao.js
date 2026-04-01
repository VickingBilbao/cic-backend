// ── /api/v1/campaigns/:id/comunicacao ────────────────────────
export default async function comunicacaoRoutes(fastify) {

  fastify.post('/:id/comunicacao/disparos', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const { canal, template_id, segmento_id, mensagem } = req.body
    const { data, error } = await fastify.supabase.from('disparos')
      .insert({ campaign_id: req.params.id, canal, template_id, segmento_id, mensagem, status: 'enviado', enviado_por: req.user.id })
      .select().single()
    if (error) return reply.status(400).send({ error: error.message })
    return reply.status(201).send({ disparo: data })
  })

  fastify.get('/:id/comunicacao/disparos', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const { data, error } = await fastify.supabase.from('disparos')
      .select('*').eq('campaign_id', req.params.id).order('created_at', { ascending: false })
    if (error) return reply.status(500).send({ error: error.message })
    return { disparos: data }
  })

  fastify.get('/:id/comunicacao/templates', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const { data, error } = await fastify.supabase.from('templates')
      .select('*').eq('campaign_id', req.params.id)
    if (error) return reply.status(500).send({ error: error.message })
    return { templates: data }
  })

  fastify.post('/:id/comunicacao/templates', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const { data, error } = await fastify.supabase.from('templates')
      .insert({ ...req.body, campaign_id: req.params.id }).select().single()
    if (error) return reply.status(400).send({ error: error.message })
    return reply.status(201).send({ template: data })
  })

  fastify.get('/:id/comunicacao/metricas', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const { data } = await fastify.supabase.from('disparos')
      .select('canal, status').eq('campaign_id', req.params.id)
    const metricas = {}
    for (const d of (data || [])) { if (!metricas[d.canal]) metricas[d.canal] = 0; metricas[d.canal]++ }
    return { metricas }
  })
}