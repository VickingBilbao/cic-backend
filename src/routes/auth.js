// ── /api/v1/auth ──────────────────────────────────────────────
export default async function authRoutes(fastify) {

  // POST /auth/login
  fastify.post('/login', {
    schema: {
      body: {
        type: 'object',
        required: ['email', 'password'],
        properties: {
          email:    { type: 'string', format: 'email' },
          password: { type: 'string', minLength: 6 }
        }
      }
    }
  }, async (req, reply) => {
    const { email, password } = req.body

    const { data, error } = await fastify.supabasePublic.auth.signInWithPassword({ email, password })
    if (error) return reply.status(401).send({ error: error.message })

    const { session, user } = data

    // Busca perfil completo
    const { data: profile } = await fastify.supabase
      .from('profiles')
      .select('id, email, name, org_id, role, avatar_url')
      .eq('id', user.id)
      .single()

    // Gera JWT próprio do CIC com claims úteis
    const token = fastify.jwt.sign(
      { sub: user.id, email: user.email, role: profile?.role || 'viewer' },
      { expiresIn: '8h' }
    )

    return { token, user: profile, supabaseSession: session }
  })

  // POST /auth/refresh
  fastify.post('/refresh', async (req, reply) => {
    const { refreshToken } = req.body || {}
    if (!refreshToken) return reply.status(400).send({ error: 'refreshToken obrigatório' })

    const { data, error } = await fastify.supabasePublic.auth.refreshSession({ refresh_token: refreshToken })
    if (error) return reply.status(401).send({ error: error.message })

    const token = fastify.jwt.sign(
      { sub: data.user.id, email: data.user.email },
      { expiresIn: '8h' }
    )
    return { token, supabaseSession: data.session }
  })

  // POST /auth/logout
  fastify.post('/logout', {
    preHandler: [fastify.authenticate]
  }, async (req, reply) => {
    await fastify.supabasePublic.auth.signOut()
    return { message: 'Logout realizado com sucesso' }
  })

  // GET /auth/me
  fastify.get('/me', {
    preHandler: [fastify.authenticate]
  }, async (req, reply) => {
    return { user: req.user }
  })

  // POST /auth/forgot-password
  fastify.post('/forgot-password', {
    schema: { body: { type: 'object', required: ['email'], properties: { email: { type: 'string' } } } }
  }, async (req, reply) => {
    const { error } = await fastify.supabasePublic.auth.resetPasswordForEmail(req.body.email, {
      redirectTo: `${process.env.FRONTEND_URL}/reset-password`
    })
    if (error) return reply.status(400).send({ error: error.message })
    return { message: 'Email de recuperação enviado' }
  })
}
