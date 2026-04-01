/**
 * CIC — Content API
 * Endpoint central de geração com SSE streaming
 * POST /content/generate → enfileira job → retorna jobId
 * GET  /content/stream/:jobId → SSE com tokens em tempo real
 */

import { enqueueTextJob } from '../queues/index.js'
import { generateStream } from '../services/claude.js'

export default async function contentRoutes(fastify) {

  // POST /content/generate — enfileira job de geração
  fastify.post('/content/generate', {
    preHandler: [fastify.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['campaign_id', 'tipo', 'agente'],
        properties: {
          campaign_id: { type: 'string' },
          tipo:        { type: 'string' },
          agente:      { type: 'string', enum: ['roteiros','estrategia','crise','artigos','sentimento','visual','avatar','geral'] },
          parametros:  { type: 'object' },
          prompt:      { type: 'string' }
        }
      }
    }
  }, async (req, reply) => {
    const { campaign_id, tipo, agente, parametros = {}, prompt } = req.body

    // Cria registro do job no banco
    const { data: job } = await fastify.supabase.from('jobs').insert({
      campaign_id, type: `gerar_${tipo}`, status: 'queued',
      payload: { tipo, agente, parametros, prompt }
    }).select().single()

    // Enfileira no BullMQ
    const bullJobId = await enqueueTextJob({
      campaign_id, agente, tipo, parametros, prompt,
      job_db_id: job.id, user_id: req.user.id
    })

    return { jobId: job.id, bullJobId, status: 'queued', message: 'Job enfileirado — use /content/stream/:jobId para acompanhar' }
  })

  // GET /content/stream/:jobId — SSE com streaming do resultado
  // Dois modos: (1) job já na fila → aguarda conclusão via eventos BullMQ
  //             (2) streaming direto → gera e transmite tokens em tempo real
  fastify.get('/content/stream/:jobId', {
    preHandler: [fastify.authenticate]
  }, async (req, reply) => {
    const { jobId } = req.params

    reply.raw.writeHead(200, {
      'Content-Type':      'text/event-stream',
      'Cache-Control':     'no-cache',
      'Connection':        'keep-alive',
      'X-Accel-Buffering': 'no'
    })

    const sendEvent = (data) => reply.raw.write(`data: ${JSON.stringify(data)}\n\n`)

    // Busca job no banco para obter campaign_id e payload
    const { data: jobRecord } = await fastify.supabase
      .from('jobs').select('*').eq('id', jobId).single()

    if (!jobRecord) { sendEvent({ error: 'Job não encontrado' }); reply.raw.end(); return }
    if (jobRecord.status === 'done') { sendEvent({ done: true, contentId: jobRecord.result_id }); reply.raw.end(); return }

    const { campaign_id, payload } = jobRecord
    const { data: campaign } = await fastify.supabase.from('campaigns').select('*').eq('id', campaign_id).single()

    // Streaming direto com Claude (mais rápido para uso no chat)
    try {
      sendEvent({ status: 'streaming', agente: payload.agente })

      await generateStream({
        supabase:  fastify.supabase,
        campaign,
        mensagem:  payload.prompt || JSON.stringify(payload.parametros),
        agente:    payload.agente || 'geral',
        onToken:   (token) => sendEvent({ token }),
        onDone: async ({ fullText, usage, model, ragUsed }) => {
          // Salva resultado
          const { data: content } = await fastify.supabase.from('content_items').insert({
            campaign_id, agent: payload.agente, type: payload.tipo,
            prompt: payload.prompt, output: fullText, status: 'pending'
          }).select().single()

          await fastify.supabase.from('jobs').update({ status: 'done', result_id: content.id, done_at: new Date() }).eq('id', jobId)
          sendEvent({ done: true, contentId: content.id, tokens: usage?.output_tokens, model, ragUsed })
        }
      })
    } catch (err) {
      sendEvent({ error: err.message })
      await fastify.supabase.from('jobs').update({ status: 'failed', error: err.message }).eq('id', jobId)
    } finally {
      reply.raw.end()
    }
  })

  // GET /content/:campaignId — lista conteúdos de uma campanha
  fastify.get('/content/:campaignId', {
    preHandler: [fastify.authenticate]
  }, async (req, reply) => {
    const { status, agente, tipo, page = 1, limit = 20 } = req.query
    let query = fastify.supabase.from('content_items').select('*', { count: 'exact' })
      .eq('campaign_id', req.params.campaignId)
      .order('created_at', { ascending: false })
      .range((page - 1) * limit, page * limit - 1)
    if (status) query = query.eq('status', status)
    if (agente) query = query.eq('agent', agente)
    if (tipo)   query = query.eq('type', tipo)
    const { data, error, count } = await query
    if (error) return reply.status(500).send({ error: error.message })
    return { conteudos: data, total: count, page: Number(page) }
  })

  // PATCH /content/:id/approve — FC aprova
  fastify.patch('/content/:id/approve', {
    preHandler: [fastify.authenticate]
  }, async (req, reply) => {
    const { fc_note } = req.body || {}
    const { data, error } = await fastify.supabase.from('content_items')
      .update({ status: 'approved', approved_at: new Date(), fc_note })
      .eq('id', req.params.id).select().single()
    if (error) return reply.status(400).send({ error: error.message })
    return { content: data }
  })

  // PATCH /content/:id/reject — FC rejeita com nota
  fastify.patch('/content/:id/reject', {
    preHandler: [fastify.authenticate]
  }, async (req, reply) => {
    const { fc_note } = req.body || {}
    const { data, error } = await fastify.supabase.from('content_items')
      .update({ status: 'rejected', fc_note })
      .eq('id', req.params.id).select().single()
    if (error) return reply.status(400).send({ error: error.message })
    return { content: data }
  })

  // GET /content/job/:jobId/status — polling de status
  fastify.get('/content/job/:jobId/status', {
    preHandler: [fastify.authenticate]
  }, async (req, reply) => {
    const { data } = await fastify.supabase.from('jobs').select('*').eq('id', req.params.jobId).single()
    if (!data) return reply.status(404).send({ error: 'Job não encontrado' })
    return { job: data }
  })
}
