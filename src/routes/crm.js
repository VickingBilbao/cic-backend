// ── /api/v1/campaigns/:id/crm ────────────────────────────────
export default async function crmRoutes(fastify) {

  fastify.get('/:id/crm/eleitores', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const { perfil, regiao, page = 1, limit = 50 } = req.query
    let query = fastify.supabase.from('eleitores').select('*', { count: 'exact' })
      .eq('campaign_id', req.params.id).range((page - 1) * limit, page * limit - 1)
    if (perfil) query = query.eq('perfil', perfil)
    if (regiao) query = query.eq('regiao', regiao)
    const { data, error, count } = await query
    if (error) return reply.status(500).send({ error: error.message })
    return { eleitores: data, total: count, page: Number(page) }
  })

  fastify.post('/:id/crm/eleitores', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const { data, error } = await fastify.supabase.from('eleitores')
      .insert({ ...req.body, campaign_id: req.params.id }).select().single()
    if (error) return reply.status(400).send({ error: error.message })
    return reply.status(201).send({ eleitor: data })
  })

  fastify.get('/:id/crm/segmentos', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const { data, error } = await fastify.supabase.from('segmentos')
      .select('*').eq('campaign_id', req.params.id)
    if (error) return reply.status(500).send({ error: error.message })
    return { segmentos: data }
  })

  fastify.get('/:id/crm/scoring', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const { data } = await fastify.supabase.from('eleitores')
      .select('score').eq('campaign_id', req.params.id)
    const scores = (data || []).map(e => e.score).filter(Boolean)
    const distribuicao = { alto: scores.filter(s => s >= 70).length, medio: scores.filter(s => s >= 40 && s < 70).length, baixo: scores.filter(s => s < 40).length }
    return { distribuicao, total: scores.length }
  })
}