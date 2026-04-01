/**
 * CIC — Rota Assistente IA
 * Chat com o Agente FC+ usando RAG real (pgvector) + streaming SSE
 */

import { generateStream } from '../services/claude.js'

// ── /api/v1/campaigns/:id/ia ─────────────────────────────────
export default async function iaRoutes(fastify) {

  // POST /campaigns/:id/ia/chat — streaming com SSE + RAG
  fastify.post('/:id/ia/chat', {
    preHandler: [fastify.authenticate]
  }, async (req, reply) => {
    const { mensagem, agente = 'geral', historico = [] } = req.body
    const cid = req.params.id

    // Busca contexto da campanha
    const { data: campaign } = await fastify.supabase
      .from('campaigns').select('*').eq('id', cid).single()

    if (!campaign) return reply.status(404).send({ error: 'Campanha não encontrada' })

    // ── SSE headers
    reply.raw.writeHead(200, {
      'Content-Type':      'text/event-stream',
      'Cache-Control':     'no-cache',
      'Connection':        'keep-alive',
      'X-Accel-Buffering': 'no'
    })

    const send = (data) => reply.raw.write(`data: ${JSON.stringify(data)}\n\n`)

    try {
      send({ status: 'thinking', agente })

      let fullText = ''
      let metaInfo = {}

      await generateStream({
        supabase:  fastify.supabase,
        campaign,
        mensagem,
        agente,
        historico,
        onToken: (token) => {
          fullText += token
          send({ token })
        },
        onDone: async ({ fullText: text, usage, model, ragUsed }) => {
          fullText = text
          metaInfo = { usage, model, ragUsed }
        }
      })

      // Salva no histórico
      const { data: hist } = await fastify.supabase.from('ia_historico').insert({
        campaign_id: cid,
        user_id:     req.user.id,
        agente,
        pergunta:    mensagem,
        resposta:    fullText,
        tokens:      metaInfo.usage?.output_tokens || 0
      }).select().single()

      send({
        done:       true,
        historicoId: hist?.id,
        model:      metaInfo.model,
        ragUsed:    metaInfo.ragUsed,
        tokens:     metaInfo.usage?.output_tokens
      })

    } catch (err) {
      fastify.log.error('IA stream error:', err)
      send({ error: err.message })
    } finally {
      reply.raw.end()
    }
  })

  // GET /campaigns/:id/ia/historico
  fastify.get('/:id/ia/historico', {
    preHandler: [fastify.authenticate]
  }, async (req, reply) => {
    const { limit = 30 } = req.query
    const { data, error } = await fastify.supabase
      .from('ia_historico')
      .select('id, agente, pergunta, resposta, tokens, created_at')
      .eq('campaign_id', req.params.id)
      .order('created_at', { ascending: false })
      .limit(Number(limit))

    if (error) return reply.status(500).send({ error: error.message })
    return { historico: data }
  })

  // GET /campaigns/:id/ia/notificacoes — notificações não lidas (para badge no dashboard)
  fastify.get('/:id/ia/notificacoes', {
    preHandler: [fastify.authenticate]
  }, async (req, reply) => {
    const { data, error } = await fastify.supabase
      .from('notificacoes')
      .select('*')
      .eq('campaign_id', req.params.id)
      .eq('lida', false)
      .order('created_at', { ascending: false })
      .limit(20)

    if (error) return reply.status(500).send({ error: error.message })
    return { notificacoes: data, total: data.length }
  })

  // PATCH /campaigns/:id/ia/notificacoes/:nid/ler
  fastify.patch('/:id/ia/notificacoes/:nid/ler', {
    preHandler: [fastify.authenticate]
  }, async (req, reply) => {
    await fastify.supabase.from('notificacoes')
      .update({ lida: true }).eq('id', req.params.nid)
    return { ok: true }
  })
}
