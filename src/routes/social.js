// ── /api/v1/campaigns/:id/social ─────────────────────────────
export default async function socialRoutes(fastify) {

  fastify.post('/:id/social/agendar', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const { data, error } = await fastify.supabase.from('social_posts')
      .insert({ ...req.body, campaign_id: req.params.id, status: 'agendado', criado_por: req.user.id }).select().single()
    if (error) return reply.status(400).send({ error: error.message })
    return reply.status(201).send({ post: data })
  })

  fastify.get('/:id/social/agendados', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const { data, error } = await fastify.supabase.from('social_posts')
      .select('*').eq('campaign_id', req.params.id).eq('status', 'agendado').order('agendado_para', { ascending: true })
    if (error) return reply.status(500).send({ error: error.message })
    return { posts: data }
  })

  fastify.get('/:id/social/calendario', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const { data, error } = await fastify.supabase.from('social_posts')
      .select('*').eq('campaign_id', req.params.id).order('agendado_para', { ascending: true })
    if (error) return reply.status(500).send({ error: error.message })
    return { calendario: data }
  })

  fastify.get('/:id/social/analytics', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const { data, error } = await fastify.supabase.from('social_posts')
      .select('plataforma, alcance, engajamento').eq('campaign_id', req.params.id).eq('status', 'publicado')
    if (error) return reply.status(500).send({ error: error.message })
    return { analytics: data }
  })
}