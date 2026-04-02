/**
 * CIC — Content API
 * Endpoint central de geração com SSE streaming
 *
 * POST /content/generate → tenta BullMQ, fallback para job DB direto
 * GET  /content/stream/:jobId → streaming direto sem depender de Redis
 */

import { generateStream } from '../services/claude.js'

// Tenta importar enqueueTextJob, mas funciona sem Redis
async function tryEnqueue(payload) {
  if (!process.env.REDIS_URL) return null
  try {
    const { enqueueTextJob } = await import('../queues/index.js')
    return await enqueueTextJob(payload)
  } catch (err) {
    return null // Redis falhou — continua sem fila
  }
}

export default async function contentRoutes(fastify) {

  // POST /content/generate — cria job e opcionalmente enfileira
  fastify.post('/content/generate', {
    preHandler: [fastify.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['campaign_id', 'tipo', 'agente'],
        properties: {
          campaign_id: { type: 'string' },
          tipo:        { type: 'string' },
          agente:      { type: 'string', enum: ['roteiros','estrategia','crise','artigos','sentimento','visual','avatar','conteudo','geral'] },
          parametros:  { type: 'object' },
          prompt:      { type: 'string' }
        }
      }
    }
  }, async (req, reply) => {
    const { campaign_id, tipo, agente, parametros = {}, prompt } = req.body

    // Cria registro no banco
    const { data: job, error: jobErr } = await fastify.supabase.from('jobs').insert({
      campaign_id, type: `gerar_${tipo}`, status: 'queued',
      payload: { tipo, agente, parametros, prompt }
    }).select().single()

    if (jobErr) return reply.status(500).send({ error: jobErr.message })

    // Tenta enfileirar no BullMQ (não-bloqueante — funciona sem Redis)
    const bullJobId = await tryEnqueue({
      campaign_id, agente, tipo, parametros, prompt,
      job_db_id: job.id, user_id: req.user.id
    })

    return {
      jobId:    job.id,
      bullJobId: bullJobId?.id || null,
      status:   'queued',
      mode:     bullJobId ? 'async' : 'stream',
      message:  bullJobId
        ? 'Job enfileirado — use GET /content/stream/:jobId para acompanhar'
        : 'Modo direto (sem Redis) — use GET /content/stream/:jobId para streaming'
    }
  })

  // GET /content/stream/:jobId — SSE com streaming direto do Claude
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

    const { data: jobRecord } = await fastify.supabase
      .from('jobs').select('*').eq('id', jobId).single()

    if (!jobRecord) {
      sendEvent({ error: 'Job não encontrado' })
      reply.raw.end()
      return
    }

    if (jobRecord.status === 'done') {
      sendEvent({ done: true, contentId: jobRecord.result_id })
      reply.raw.end()
      return
    }

    const { campaign_id, payload } = jobRecord
    const { data: campaign } = await fastify.supabase
      .from('campaigns').select('*').eq('id', campaign_id).single()

    if (!campaign) {
      sendEvent({ error: 'Campanha não encontrada' })
      reply.raw.end()
      return
    }

    try {
      sendEvent({ status: 'streaming', agente: payload.agente, model: null })

      await generateStream({
        supabase:  fastify.supabase,
        campaign,
        mensagem:  payload.prompt || (payload.parametros ? JSON.stringify(payload.parametros) : 'Gere o conteúdo solicitado'),
        agente:    payload.agente || 'geral',
        historico: [],
        onToken:   (token) => sendEvent({ token }),
        onDone: async ({ fullText, usage, model, ragUsed }) => {
          // Salva conteúdo gerado
          const { data: content, error: cErr } = await fastify.supabase
            .from('content_items')
            .insert({
              campaign_id,
              agent:    payload.agente,
              type:     payload.tipo,
              titulo:   payload.parametros?.titulo || `${payload.tipo} — ${new Date().toLocaleDateString('pt-BR')}`,
              prompt:   payload.prompt,
              output:   fullText,
              status:   'pending',
              tokens:   usage?.output_tokens || 0,
              model,
            })
            .select()
            .single()

          if (!cErr) {
            await fastify.supabase.from('jobs')
              .update({ status: 'done', result_id: content.id, done_at: new Date() })
              .eq('id', jobId)
          }

          sendEvent({
            done:      true,
            contentId: content?.id || null,
            tokens:    usage?.output_tokens,
            model,
            ragUsed
          })
        }
      })
    } catch (err) {
      fastify.log.error('Content stream error:', err.message)
      sendEvent({ error: err.message })
      await fastify.supabase.from('jobs')
        .update({ status: 'failed', error: err.message })
        .eq('id', jobId)
    } finally {
      reply.raw.end()
    }
  })

  // GET /content/:campaignId — lista conteúdos de uma campanha
  fastify.get('/content/:campaignId', {
    preHandler: [fastify.authenticate]
  }, async (req, reply) => {
    const { status, agente, tipo, page = 1, limit = 20 } = req.query
    let query = fastify.supabase.from('content_items')
      .select('id, type, agent, titulo, status, tokens, model, created_at', { count: 'exact' })
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

  // GET /content/:id/full — conteúdo completo (com output)
  fastify.get('/content/:id/full', {
    preHandler: [fastify.authenticate]
  }, async (req, reply) => {
    const { data, error } = await fastify.supabase
      .from('content_items').select('*').eq('id', req.params.id).single()
    if (error || !data) return reply.status(404).send({ error: 'Conteúdo não encontrado' })
    return data
  })

  // PATCH /content/:id/approve
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

  // PATCH /content/:id/reject
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

  // GET /content/job/:jobId/status
  fastify.get('/content/job/:jobId/status', {
    preHandler: [fastify.authenticate]
  }, async (req, reply) => {
    const { data } = await fastify.supabase
      .from('jobs').select('id, type, status, result_id, error, created_at, done_at')
      .eq('id', req.params.jobId).single()
    if (!data) return reply.status(404).send({ error: 'Job não encontrado' })
    return { job: data }
  })
}
