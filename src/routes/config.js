// ── /api/v1/users & /api/v1/campaigns/:id/equipe ─────────────
export default async function configRoutes(fastify) {

  fastify.get('/users/me', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const { data, error } = await fastify.supabase.from('profiles')
      .select('*').eq('id', req.user.id).single()
    if (error) return reply.status(500).send({ error: error.message })
    return { user: data }
  })

  fastify.put('/users/me', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const allowed = ['name', 'telefone', 'avatar_url']
    const updates = Object.fromEntries(Object.entries(req.body).filter(([k]) => allowed.includes(k)))
    const { data, error } = await fastify.supabase.from('profiles')
      .update(updates).eq('id', req.user.id).select().single()
    if (error) return reply.status(400).send({ error: error.message })
    return { user: data }
  })

  fastify.get('/campaigns/:id/equipe', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const { data, error } = await fastify.supabase.from('profiles')
      .select('id, name, email, role, avatar_url').eq('org_id', req.user.org_id)
    if (error) return reply.status(500).send({ error: error.message })
    return { equipe: data }
  })

  fastify.post('/campaigns/:id/equipe', { preHandler: [fastify.requireRole('admin')] }, async (req, reply) => {
    const { email, role } = req.body
    const { data: invite, error } = await fastify.supabase.auth.admin.inviteUserByEmail(email, {
      data: { org_id: req.user.org_id, role }
    })
    if (error) return reply.status(400).send({ error: error.message })
    return { message: `Convite enviado para ${email}`, invite }
  })
}