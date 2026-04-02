/**
 * GET /api/v1/org/config
 * Retorna a configuração de tema e persona da organização do usuário logado.
 * Se não existir config, retorna null (frontend usa defaults).
 *
 * POST /api/v1/org/config
 * Salva/atualiza a configuração (apenas admin da org).
 */
export default async function orgRoutes(fastify) {

  // GET /org/config — público após login
  fastify.get('/config', {
    preHandler: [fastify.authenticate]
  }, async (req, reply) => {
    const userId = req.user.sub

    // Busca org_id do usuário
    const { data: profile } = await fastify.supabase
      .from('profiles')
      .select('org_id')
      .eq('id', userId)
      .single()

    if (!profile?.org_id) return { theme: null }

    // Busca config da org
    const { data: config } = await fastify.supabase
      .from('org_configs')
      .select('*')
      .eq('org_id', profile.org_id)
      .single()

    if (!config) return { theme: null }

    // Garante que novos módulos estejam sempre disponíveis
    const ALWAYS_AVAILABLE = ['obs']
    const stored = config?.modules_enabled
    const modules_enabled = stored
      ? [...new Set([...stored, ...ALWAYS_AVAILABLE])]
      : null  // null = todos liberados

    return {
      theme: {
        productName: config.product_name,
        logoUrl:     config.logo_url,
        persona: {
          name:        config.persona_name,
          title:       config.persona_title,
          description: config.persona_description,
          shortDesc:   config.persona_short_desc,
        },
        colors:  config.colors || {},
        font:    config.font_family,
        fontUrl: config.font_url,
      },
      modules_enabled,
      max_candidates:   config.max_candidates  || null,
      claude_model:     config.claude_model    || 'claude-sonnet-4-6',
    }
  })

  // POST /org/config — apenas admin
  fastify.post('/config', {
    preHandler: [fastify.authenticate],
    schema: {
      body: {
        type: 'object',
        properties: {
          product_name:        { type: 'string' },
          logo_url:            { type: 'string' },
          persona_name:        { type: 'string' },
          persona_title:       { type: 'string' },
          persona_description: { type: 'string' },
          persona_short_desc:  { type: 'string' },
          colors:              { type: 'object' },
          font_family:         { type: 'string' },
          font_url:            { type: 'string' },
        }
      }
    }
  }, async (req, reply) => {
    const userId = req.user.sub

    const { data: profile } = await fastify.supabase
      .from('profiles')
      .select('org_id, role')
      .eq('id', userId)
      .single()

    if (!profile?.org_id) return reply.status(400).send({ error: 'Usuário sem organização' })
    if (profile.role !== 'admin') return reply.status(403).send({ error: 'Apenas admins podem alterar o tema' })

    const { data, error } = await fastify.supabase
      .from('org_configs')
      .upsert({ org_id: profile.org_id, ...req.body }, { onConflict: 'org_id' })
      .select()
      .single()

    if (error) return reply.status(500).send({ error: error.message })
    return { ok: true, config: data }
  })
}
