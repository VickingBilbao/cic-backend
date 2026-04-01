import fp from 'fastify-plugin'

async function authPlugin(fastify) {
  // Decorator que valida JWT e injeta req.user
  fastify.decorate('authenticate', async function (req, reply) {
    try {
      await req.jwtVerify()

      // Busca usuário no Supabase para confirmar que existe e está ativo
      const { data: user, error } = await fastify.supabase
        .from('profiles')
        .select('id, email, org_id, role')
        .eq('id', req.user.sub)
        .single()

      if (error || !user) {
        return reply.status(401).send({ error: 'Usuário não encontrado ou inativo' })
      }

      req.user = { ...req.user, ...user }
    } catch (err) {
      reply.status(401).send({ error: 'Token inválido ou expirado' })
    }
  })

  // Decorator que verifica role mínimo
  fastify.decorate('requireRole', function (minRole) {
    const hierarchy = { viewer: 0, editor: 1, admin: 2 }
    return async function (req, reply) {
      await fastify.authenticate(req, reply)
      const userLevel = hierarchy[req.user.role] ?? -1
      const minLevel  = hierarchy[minRole] ?? 99
      if (userLevel < minLevel) {
        return reply.status(403).send({ error: 'Permissão insuficiente' })
      }
    }
  })
}

export default fp(authPlugin, {
  name: 'auth',
  fastify: '4.x',
  dependencies: ['supabase']
})
