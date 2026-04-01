import Anthropic from '@anthropic-ai/sdk'
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

// ── /api/v1/campaigns/:id/debate ─────────────────────────────
export default async function debateRoutes(fastify) {

  fastify.post('/:id/debate/iniciar', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const { oponente = 'agressivo' } = req.body
    const oponentes = {
      agressivo: 'Você é um oponente político agressivo, que ataca propostas e histórico.',
      tecnico:   'Você é um oponente técnico, que questiona dados e detalhes.',
      moderador: 'Você é um moderador imparcial que faz perguntas difíceis.'
    }
    const { data: sessao } = await fastify.supabase.from('debate_sessoes')
      .insert({ campaign_id: req.params.id, user_id: req.user.id, oponente, status: 'ativa', score_total: 0 })
      .select().single()
    const pergunta = 'Bom dia. Explique sua proposta principal para saúde em 30 segundos.'
    return { sessaoId: sessao.id, oponente, perguntaInicial: pergunta, persona: oponentes[oponente] }
  })

  fastify.post('/:id/debate/responder', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const { sessaoId, resposta } = req.body
    const { data: sessao } = await fastify.supabase.from('debate_sessoes').select('*').eq('id', sessaoId).single()
    const { data: campaign } = await fastify.supabase.from('campaigns').select('*').eq('id', req.params.id).single()

    const feedbackResponse = await anthropic.messages.create({
      model: 'claude-sonnet-4-6', max_tokens: 512,
      messages: [{ role: 'user', content: `Avalie esta resposta de debate político (score 0-10, feedback construtivo em 2 linhas): "${resposta}". Candidato: ${campaign.name}, ${campaign.cargo}. Responda JSON: {score, feedback, proximaPergunta}` }]
    })

    let parsed = { score: 7, feedback: 'Boa resposta, mas seja mais específico.', proximaPergunta: 'E quanto à educação?' }
    try { parsed = JSON.parse(feedbackResponse.content[0].text) } catch {}

    await fastify.supabase.from('debate_sessoes').update({ score_total: (sessao.score_total || 0) + parsed.score }).eq('id', sessaoId)
    return { score: parsed.score, feedback: parsed.feedback, proximaPergunta: parsed.proximaPergunta }
  })

  fastify.get('/:id/debate/stats', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const { data } = await fastify.supabase.from('debate_sessoes').select('score_total, created_at').eq('campaign_id', req.params.id)
    const sessoes = data || []
    const scoresMedio = sessoes.length ? sessoes.reduce((s, e) => s + (e.score_total || 0), 0) / sessoes.length : 0
    return { sessoes: sessoes.length, scoreMedio: scoresMedio.toFixed(1), ultimaSessao: sessoes[0]?.created_at }
  })
}