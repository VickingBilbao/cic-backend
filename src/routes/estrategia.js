// ── /api/v1/campaigns/:id/estrategia ─────────────────────────
export default async function estrategiaRoutes(fastify) {

  fastify.get('/:id/estrategia/decisoes', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const { data, error } = await fastify.supabase.from('decisoes')
      .select('*').eq('campaign_id', req.params.id).eq('status', 'pendente').order('created_at', { ascending: false })
    if (error) return reply.status(500).send({ error: error.message })
    return { decisoes: data }
  })

  fastify.patch('/:id/estrategia/decisoes/:did', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const { acao, nota } = req.body
    const { data, error } = await fastify.supabase.from('decisoes')
      .update({ status: acao, fc_nota: nota, decidido_em: new Date(), decidido_por: req.user.id })
      .eq('id', req.params.did).eq('campaign_id', req.params.id).select().single()
    if (error) return reply.status(400).send({ error: error.message })
    return { decisao: data }
  })

  fastify.get('/:id/estrategia/narrativa', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const { data, error } = await fastify.supabase.from('narrativa')
      .select('*').eq('campaign_id', req.params.id).single()
    if (error) return { narrativa: null }
    return { narrativa: data }
  })

  fastify.get('/:id/estrategia/timeline', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const { data, error } = await fastify.supabase.from('timeline_estrategia')
      .select('*').eq('campaign_id', req.params.id).order('semana', { ascending: true })
    if (error) return reply.status(500).send({ error: error.message })
    return { timeline: data }
  })
}