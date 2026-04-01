import Anthropic from '@anthropic-ai/sdk'
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

// ── /api/v1/campaigns/:id/producao ───────────────────────────
export default async function producaoRoutes(fastify) {

  fastify.post('/:id/producao/gerar', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const { tipo, parametros, agente = 'roteiros' } = req.body
    const { data: campaign } = await fastify.supabase.from('campaigns').select('*').eq('id', req.params.id).single()

    const { data: job } = await fastify.supabase.from('jobs')
      .insert({ campaign_id: req.params.id, type: `gerar_${tipo}`, status: 'queued', payload: { tipo, parametros, agente, campaign } })
      .select().single()

    const prompt = `Gere ${tipo} para candidato ${campaign.name} (${campaign.cargo} - ${campaign.city}/${campaign.state}). Parâmetros: ${JSON.stringify(parametros)}`
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6', max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }]
    })
    const output = response.content[0]?.text || ''

    const { data: content } = await fastify.supabase.from('content_items')
      .insert({ campaign_id: req.params.id, agent: agente, type: tipo, prompt, output, status: 'pending' })
      .select().single()

    await fastify.supabase.from('jobs').update({ status: 'done', result_id: content.id }).eq('id', job.id)
    return { jobId: job.id, contentId: content.id, preview: output.slice(0, 300) }
  })

  fastify.get('/:id/producao/gerados', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const { data, error } = await fastify.supabase.from('content_items')
      .select('*').eq('campaign_id', req.params.id).order('created_at', { ascending: false })
    if (error) return reply.status(500).send({ error: error.message })
    return { conteudos: data }
  })

  fastify.put('/:id/producao/gerados/:gid', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const { status, fc_note } = req.body
    const updates = { status, updated_at: new Date() }
    if (fc_note) updates.fc_note = fc_note
    if (status === 'approved') updates.approved_at = new Date()
    const { data, error } = await fastify.supabase.from('content_items')
      .update(updates).eq('id', req.params.gid).eq('campaign_id', req.params.id).select().single()
    if (error) return reply.status(400).send({ error: error.message })
    return { content: data }
  })
}