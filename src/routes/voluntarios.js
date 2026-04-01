// ── /api/v1/campaigns/:id/voluntarios ────────────────────────
export default async function voluntariosRoutes(fastify) {

  fastify.get('/:id/voluntarios', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const { data, error } = await fastify.supabase.from('voluntarios')
      .select('*').eq('campaign_id', req.params.id).order('pontos', { ascending: false })
    if (error) return reply.status(500).send({ error: error.message })
    return { voluntarios: data }
  })

  fastify.post('/:id/voluntarios', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const { data, error } = await fastify.supabase.from('voluntarios')
      .insert({ ...req.body, campaign_id: req.params.id, status: 'ativo', pontos: 0 }).select().single()
    if (error) return reply.status(400).send({ error: error.message })
    return reply.status(201).send({ voluntario: data })
  })

  fastify.get('/:id/voluntarios/tarefas', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const { data, error } = await fastify.supabase.from('tarefas_voluntarios')
      .select('*').eq('campaign_id', req.params.id).order('created_at', { ascending: false })
    if (error) return reply.status(500).send({ error: error.message })
    const kanban = { pendente: [], fazendo: [], concluida: [] }
    for (const t of (data || [])) { kanban[t.status]?.push(t) }
    return { kanban }
  })

  fastify.post('/:id/voluntarios/tarefas', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const { data, error } = await fastify.supabase.from('tarefas_voluntarios')
      .insert({ ...req.body, campaign_id: req.params.id, status: 'pendente' }).select().single()
    if (error) return reply.status(400).send({ error: error.message })
    return reply.status(201).send({ tarefa: data })
  })

  fastify.get('/:id/voluntarios/ranking', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const { data, error } = await fastify.supabase.from('voluntarios')
      .select('nome, pontos, avatar_url').eq('campaign_id', req.params.id).order('pontos', { ascending: false }).limit(10)
    if (error) return reply.status(500).send({ error: error.message })
    return { ranking: data }
  })
}