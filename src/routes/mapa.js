// ── /api/v1/campaigns/:id/mapa ───────────────────────────────
export default async function mapaRoutes(fastify) {

  fastify.get('/:id/mapa/regioes', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const { data, error } = await fastify.supabase.from('mapa_regioes')
      .select('*').eq('campaign_id', req.params.id)
    if (error) return reply.status(500).send({ error: error.message })
    return { regioes: data }
  })

  fastify.get('/:id/mapa/zonas', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const { data, error } = await fastify.supabase.from('mapa_zonas')
      .select('*').eq('campaign_id', req.params.id)
    if (error) return reply.status(500).send({ error: error.message })
    return { zonas: data }
  })

  fastify.get('/:id/mapa/demografico', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const { data, error } = await fastify.supabase.from('mapa_demografico')
      .select('*').eq('campaign_id', req.params.id)
    if (error) return reply.status(500).send({ error: error.message })
    return { demografico: data }
  })

  fastify.get('/:id/mapa/prioridades', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const { data, error } = await fastify.supabase.from('mapa_regioes')
      .select('*').eq('campaign_id', req.params.id).order('score_prioridade', { ascending: false }).limit(5)
    if (error) return reply.status(500).send({ error: error.message })
    return { prioridades: data }
  })
}