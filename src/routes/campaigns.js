// ── /api/v1/campaigns ─────────────────────────────────────────
export default async function campaignsRoutes(fastify) {

  // GET /campaigns — lista campanhas do usuário logado
  fastify.get('/', {
    preHandler: [fastify.authenticate]
  }, async (req, reply) => {
    const { data, error } = await fastify.supabase
      .from('campaigns')
      .select('id, name, cargo, city, state, status, color, initials, created_at')
      .eq('org_id', req.user.org_id)
      .order('created_at', { ascending: false })

    if (error) return reply.status(500).send({ error: error.message })
    return { campaigns: data }
  })

  // POST /campaigns — cria nova campanha
  fastify.post('/', {
    preHandler: [fastify.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['name', 'cargo', 'city', 'state'],
        properties: {
          name:            { type: 'string' },
          cargo:           { type: 'string' },
          city:            { type: 'string' },
          state:           { type: 'string' },
          ideology:        { type: 'string' },
          color:           { type: 'string', default: '#FF2D2D' },
          strengths:       { type: 'array', items: { type: 'string' } },
          vulnerabilities: { type: 'array', items: { type: 'string' } },
          rivals:          { type: 'object' }
        }
      }
    }
  }, async (req, reply) => {
    const initials = req.body.name.split(' ').slice(0, 2).map(w => w[0]).join('').toUpperCase()

    const { data, error } = await fastify.supabase
      .from('campaigns')
      .insert({ ...req.body, org_id: req.user.org_id, initials, status: 'active' })
      .select()
      .single()

    if (error) return reply.status(400).send({ error: error.message })
    return reply.status(201).send({ campaign: data })
  })

  // GET /campaigns/:id — detalhes da campanha
  fastify.get('/:id', {
    preHandler: [fastify.authenticate]
  }, async (req, reply) => {
    const { data, error } = await fastify.supabase
      .from('campaigns')
      .select('*')
      .eq('id', req.params.id)
      .eq('org_id', req.user.org_id)
      .single()

    if (error || !data) return reply.status(404).send({ error: 'Campanha não encontrada' })
    return { campaign: data }
  })

  // PATCH /campaigns/:id — atualiza campanha
  fastify.patch('/:id', {
    preHandler: [fastify.authenticate]
  }, async (req, reply) => {
    const { data, error } = await fastify.supabase
      .from('campaigns')
      .update(req.body)
      .eq('id', req.params.id)
      .eq('org_id', req.user.org_id)
      .select()
      .single()

    if (error) return reply.status(400).send({ error: error.message })
    return { campaign: data }
  })

  // DELETE /campaigns/:id — soft delete
  fastify.delete('/:id', {
    preHandler: [fastify.requireRole('admin')]
  }, async (req, reply) => {
    const { error } = await fastify.supabase
      .from('campaigns')
      .update({ status: 'deleted', deleted_at: new Date() })
      .eq('id', req.params.id)
      .eq('org_id', req.user.org_id)

    if (error) return reply.status(400).send({ error: error.message })
    return { message: 'Campanha removida com sucesso' }
  })
}
