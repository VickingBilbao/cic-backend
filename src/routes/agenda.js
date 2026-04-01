// ── /api/v1/campaigns/:id/agenda ─────────────────────────────
export default async function agendaRoutes(fastify) {

  fastify.get('/:id/agenda', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const { vista = 'semana' } = req.query
    let query = fastify.supabase.from('agenda').select('*').eq('campaign_id', req.params.id).order('inicio', { ascending: true })
    const now = new Date()
    if (vista === 'hoje')   { const d = new Date(now); d.setHours(23,59,59); query = query.gte('inicio', now.toISOString()).lte('inicio', d.toISOString()) }
    if (vista === 'semana') { const d = new Date(now); d.setDate(d.getDate() + 7); query = query.gte('inicio', now.toISOString()).lte('inicio', d.toISOString()) }
    if (vista === 'mes')    { const d = new Date(now); d.setMonth(d.getMonth() + 1); query = query.gte('inicio', now.toISOString()).lte('inicio', d.toISOString()) }
    const { data, error } = await query
    if (error) return reply.status(500).send({ error: error.message })
    return { compromissos: data }
  })

  fastify.post('/:id/agenda', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const { data, error } = await fastify.supabase.from('agenda')
      .insert({ ...req.body, campaign_id: req.params.id }).select().single()
    if (error) return reply.status(400).send({ error: error.message })
    return reply.status(201).send({ compromisso: data })
  })

  fastify.delete('/:id/agenda/:aid', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const { error } = await fastify.supabase.from('agenda').delete()
      .eq('id', req.params.aid).eq('campaign_id', req.params.id)
    if (error) return reply.status(400).send({ error: error.message })
    return { message: 'Compromisso removido' }
  })

  fastify.get('/:id/agenda/:aid/briefing', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const { data: comp } = await fastify.supabase.from('agenda').select('*').eq('id', req.params.aid).single()
    if (!comp) return reply.status(404).send({ error: 'Compromisso não encontrado' })
    return { briefing: `Briefing automático para: ${comp.titulo} em ${comp.local || 'local a confirmar'}. Prepare pontos principais sobre ${comp.tema || 'tema do evento'}.` }
  })
}