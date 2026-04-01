// ── /api/v1/campaigns/:id/gotv ───────────────────────────────
export default async function gotvRoutes(fastify) {

  fastify.get('/:id/gotv/status', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const eleicao = new Date('2026-10-04')
    const hoje = new Date()
    const diasRestantes = Math.max(0, Math.floor((eleicao - hoje) / 86400000))
    return { diasParaEleicao: diasRestantes, kpis: { eleitoresMobilizados: 0, transportesOrganizados: 0, pontosFiscal: 0, urnasFiscalizadas: 0 } }
  })

  fastify.get('/:id/gotv/checklist', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const { data, error } = await fastify.supabase.from('gotv_checklist')
      .select('*').eq('campaign_id', req.params.id).order('ordem', { ascending: true })
    if (error) return reply.status(500).send({ error: error.message })
    return { checklist: data }
  })

  fastify.patch('/:id/gotv/checklist/:cid', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const { concluido } = req.body
    const { data, error } = await fastify.supabase.from('gotv_checklist')
      .update({ concluido, updated_at: new Date() }).eq('id', req.params.cid).eq('campaign_id', req.params.id).select().single()
    if (error) return reply.status(400).send({ error: error.message })
    return { item: data }
  })
}