/**
 * Monitoramento — Routes
 * CIC — Centro de Inteligência de Campanha
 *
 * Endpoints:
 *   GET    /campaigns/:id/monitoramento              — List events with filters
 *   POST   /campaigns/:id/monitoramento              — Manual event insert
 *   GET    /campaigns/:id/monitoramento/stats        — Sentiment aggregates + trending topics
 *   POST   /campaigns/:id/monitoramento/analisar     — Trigger sentiment analysis job
 *   POST   /campaigns/:id/monitoramento/buscar       — Trigger Apify actor to scrape keywords
 *   POST   /campaigns/:id/monitoramento/webhook      — Apify webhook (called when run completes)
 *   GET    /campaigns/:id/monitoramento/alertas      — Unread urgent alerts
 *   PATCH  /campaigns/:id/monitoramento/:eventId     — Mark event read / update tags
 */

import fp from 'fastify-plugin'
import { Queue } from 'bullmq'
const MONITORING_QUEUE_NAME = 'cic:monitoring'

function monitoringQueue(connection) {
  return new Queue(MONITORING_QUEUE_NAME, { connection })
}

async function monitoramentoRoutes(fastify, opts) {
  const { supabase } = fastify

  async function getCampaign(campaignId, userId) {
    const { data } = await supabase
      .from('campaigns')
      .select('id, org_id, name, cargo, city, state')
      .eq('id', campaignId).single()
    if (!data) return null
    const { data: profile } = await supabase
      .from('profiles').select('org_id').eq('id', userId).single()
    if (!profile || profile.org_id !== data.org_id) return null
    return data
  }

  // -------------------------------------------------------------------------
  // GET /campaigns/:id/monitoramento — list events
  // -------------------------------------------------------------------------
  fastify.get('/:id/monitoramento', {
    onRequest: [fastify.authenticate],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          sentimento: { type: 'string', enum: ['positivo','negativo','neutro','misto'] },
          fonte:      { type: 'string' },
          urgente:    { type: 'boolean' },
          desde:      { type: 'string', format: 'date' },
          limite:     { type: 'integer', default: 50 },
          offset:     { type: 'integer', default: 0 },
        },
      },
    },
  }, async (request, reply) => {
    const campaign = await getCampaign(request.params.id, request.user.id)
    if (!campaign) return reply.status(404).send({ error: 'Campanha não encontrada' })

    let q = supabase
      .from('monitoring_events')
      .select('*')
      .eq('campaign_id', campaign.id)
      .order('data_publicacao', { ascending: false })
      .range(request.query.offset, request.query.offset + request.query.limite - 1)

    if (request.query.sentimento) q = q.eq('sentiment', request.query.sentimento)
    if (request.query.fonte)      q = q.eq('platform', request.query.fonte)
    if (request.query.urgente !== undefined) q = q.eq('urgente', request.query.urgente)
    if (request.query.desde)      q = q.gte('data_publicacao', request.query.desde)

    const { data, error } = await q
    if (error) return reply.status(500).send({ error: error.message })
    return { eventos: data }
  })

  // -------------------------------------------------------------------------
  // POST /campaigns/:id/monitoramento — manual event insert
  // -------------------------------------------------------------------------
  fastify.post('/:id/monitoramento', {
    onRequest: [fastify.authenticate],
    schema: {
      body: {
        type: 'object', required: ['texto'],
        properties: {
          texto:           { type: 'string' },
          fonte:           { type: 'string' },
          url:             { type: 'string' },
          autor:           { type: 'string' },
          data_publicacao: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const campaign = await getCampaign(request.params.id, request.user.id)
    if (!campaign) return reply.status(404).send({ error: 'Campanha não encontrada' })

    const { texto, fonte, url, autor, data_publicacao } = request.body
    const { data, error } = await supabase
      .from('monitoring_events')
      .insert({
        campaign_id: campaign.id,
        content: texto,
        platform: fonte ?? 'manual',
        url,
        autor,
        data_publicacao,
      })
      .select('id').single()

    if (error) return reply.status(500).send({ error: error.message })
    return reply.status(201).send({ id: data.id })
  })

  // -------------------------------------------------------------------------
  // GET /campaigns/:id/monitoramento/stats — sentiment aggregates
  // -------------------------------------------------------------------------
  fastify.get('/:id/monitoramento/stats', {
    onRequest: [fastify.authenticate],
  }, async (request, reply) => {
    const campaign = await getCampaign(request.params.id, request.user.id)
    if (!campaign) return reply.status(404).send({ error: 'Campanha não encontrada' })

    // Aggregate counts by sentiment
    const { data: counts } = await supabase.rpc('monitoring_sentiment_counts', {
      p_campaign_id: campaign.id,
    })

    // Recent events for trending topics
    const { data: recent } = await supabase
      .from('monitoring_events')
      .select('topicos, score_sentimento')
      .eq('campaign_id', campaign.id)
      .not('topicos', 'is', null)
      .order('created_at', { ascending: false })
      .limit(100)

    // Flatten and count topics
    const topicMap = {}
    ;(recent ?? []).forEach(e => {
      ;(e.topicos ?? []).forEach(t => {
        topicMap[t] = (topicMap[t] ?? 0) + 1
      })
    })
    const topTopicos = Object.entries(topicMap)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([topic, count]) => ({ topic, count }))

    // Average score
    const scores = (recent ?? []).map(e => e.score_sentimento ?? 0)
    const avgScore = scores.length
      ? scores.reduce((a, b) => a + b, 0) / scores.length
      : 0

    return {
      counts: counts ?? [],
      topTopicos,
      avgScore: parseFloat(avgScore.toFixed(3)),
      totalAnalisados: recent?.length ?? 0,
    }
  })

  // -------------------------------------------------------------------------
  // POST /campaigns/:id/monitoramento/analisar — trigger Claude sentiment job
  // -------------------------------------------------------------------------
  fastify.post('/:id/monitoramento/analisar', {
    onRequest: [fastify.authenticate],
  }, async (request, reply) => {
    const campaign = await getCampaign(request.params.id, request.user.id)
    if (!campaign) return reply.status(404).send({ error: 'Campanha não encontrada' })

    const q = monitoringQueue({ url: process.env.REDIS_URL })
    const job = await q.add('analyse', {
      type: 'sentiment',
      campaignId: campaign.id,
      candidato: campaign.name,
    })
    await q.close()

    return reply.status(202).send({ jobId: job.id, status: 'queued' })
  })

  // -------------------------------------------------------------------------
  // POST /campaigns/:id/monitoramento/buscar — trigger Apify scrape
  // -------------------------------------------------------------------------
  fastify.post('/:id/monitoramento/buscar', {
    onRequest: [fastify.authenticate, fastify.requireRole('editor')],
    schema: {
      body: {
        type: 'object',
        properties: {
          keywords:  { type: 'array', items: { type: 'string' } },
          fontes:    { type: 'array', items: { type: 'string' },
                       default: ['twitter', 'facebook', 'news'] },
          periodoH:  { type: 'integer', default: 24, description: 'Horas para trás' },
        },
      },
    },
  }, async (request, reply) => {
    const campaign = await getCampaign(request.params.id, request.user.id)
    if (!campaign) return reply.status(404).send({ error: 'Campanha não encontrada' })

    const token = process.env.APIFY_TOKEN
    if (!token) return reply.status(503).send({ error: 'APIFY_TOKEN não configurado' })

    const keywords = request.body.keywords ?? [
      campaign.name, campaign.cargo, campaign.city,
    ].filter(Boolean)

    // Trigger Apify Web Scraper actor
    const webhookUrl = `${process.env.API_BASE_URL ?? 'https://cic-backend.railway.app'}/api/v1/campaigns/${campaign.id}/monitoramento/webhook`

    const res = await fetch(`https://api.apify.com/v2/acts/apify~google-search-scraper/runs?token=${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        queries: keywords.join('\n'),
        maxPagesPerQuery: 1,
        resultsPerPage: 10,
        webhooks: [{
          eventTypes: ['ACTOR.RUN.SUCCEEDED'],
          requestUrl: webhookUrl,
          headersTemplate: `{"X-Campaign-Id": "${campaign.id}"}`,
        }],
      }),
    })

    const json = await res.json()
    if (!res.ok) return reply.status(502).send({ error: 'Apify trigger failed', detail: json })

    return reply.status(202).send({ apifyRunId: json.data?.id, status: 'running', keywords })
  })

  // -------------------------------------------------------------------------
  // POST /campaigns/:id/monitoramento/webhook — Apify calls this when done
  // No auth — secured by shared secret in header
  // -------------------------------------------------------------------------
  fastify.post('/:id/monitoramento/webhook', {
    config: { skipAuth: true },  // public webhook endpoint
  }, async (request, reply) => {
    // Verify Apify webhook secret if configured
    const secret = process.env.APIFY_WEBHOOK_SECRET
    if (secret) {
      const provided = request.headers['x-apify-secret'] ?? request.headers['authorization']
      if (provided !== secret && provided !== `Bearer ${secret}`) {
        return reply.status(401).send({ error: 'Invalid webhook secret' })
      }
    }

    const body = request.body
    const runId = body?.resource?.id ?? body?.actorRunId
    if (!runId) return reply.status(400).send({ error: 'Missing actor run ID in webhook payload' })

    const campaignId = request.params.id

    // Verify campaign exists
    const { data: campaign } = await supabase
      .from('campaigns')
      .select('id, name')
      .eq('id', campaignId)
      .single()

    if (!campaign) return reply.status(404).send({ error: 'Campaign not found' })

    // Enqueue fetch + analyse job
    const q = monitoringQueue({ url: process.env.REDIS_URL })
    await q.add('apify-fetch', {
      type: 'apify-fetch',
      campaignId,
      candidato: campaign.name,
      apifyRunId: runId,
    })
    await q.close()

    fastify.log.info(`[webhook] Apify run ${runId} completed → enqueued for campaign ${campaignId}`)
    return { ok: true }
  })

  // -------------------------------------------------------------------------
  // GET /campaigns/:id/monitoramento/alertas — urgent unread alerts
  // -------------------------------------------------------------------------
  fastify.get('/:id/monitoramento/alertas', {
    onRequest: [fastify.authenticate],
  }, async (request, reply) => {
    const campaign = await getCampaign(request.params.id, request.user.id)
    if (!campaign) return reply.status(404).send({ error: 'Campanha não encontrada' })

    const { data, error } = await supabase
      .from('monitoring_events')
      .select('id, platform, content, url, sentiment, score_sentimento, topicos, resumo, data_publicacao, urgente, autor')
      .eq('campaign_id', campaign.id)
      .eq('urgente', true)
      .order('data_publicacao', { ascending: false })
      .limit(20)

    if (error) return reply.status(500).send({ error: error.message })
    return { alertas: data }
  })

  // -------------------------------------------------------------------------
  // PATCH /campaigns/:id/monitoramento/:eventId — update tags / mark read
  // -------------------------------------------------------------------------
  fastify.patch('/:id/monitoramento/:eventId', {
    onRequest: [fastify.authenticate],
    schema: {
      body: {
        type: 'object',
        properties: {
          urgente: { type: 'boolean' },
          tags:    { type: 'array', items: { type: 'string' } },
          notas:   { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const campaign = await getCampaign(request.params.id, request.user.id)
    if (!campaign) return reply.status(404).send({ error: 'Campanha não encontrada' })

    const { error } = await supabase
      .from('monitoring_events')
      .update(request.body)
      .eq('id', request.params.eventId)
      .eq('campaign_id', campaign.id)

    if (error) return reply.status(500).send({ error: error.message })
    return { ok: true }
  })
  // -------------------------------------------------------------------------
  // GET /campaigns/:id/monitoramento/redes — social media summary
  // -------------------------------------------------------------------------
  fastify.get('/:id/monitoramento/redes', {
    onRequest: [fastify.authenticate],
  }, async (request, reply) => {
    const campaign = await getCampaign(request.params.id, request.user.id)
    if (!campaign) return reply.status(404).send({ error: 'Campanha não encontrada' })

    const { data, error } = await supabase
      .from('monitoring_events')
      .select('id, platform, content, url, sentiment, score_sentimento, topicos, resumo, data_publicacao, autor')
      .eq('campaign_id', campaign.id)
      .in('platform', ['twitter', 'instagram', 'facebook', 'tiktok', 'youtube', 'manual'])
      .order('data_publicacao', { ascending: false })
      .limit(50)

    if (error) return reply.status(500).send({ error: error.message })

    // Agrupa métricas por plataforma
    const byPlatform = {}
    for (const ev of (data || [])) {
      const p = ev.platform || 'outros'
      if (!byPlatform[p]) byPlatform[p] = { total: 0, positivo: 0, negativo: 0, neutro: 0 }
      byPlatform[p].total++
      if (ev.sentiment) byPlatform[p][ev.sentiment] = (byPlatform[p][ev.sentiment] || 0) + 1
    }

    return { eventos: data, porPlataforma: byPlatform, total: data?.length || 0 }
  })

  // -------------------------------------------------------------------------
  // GET /campaigns/:id/monitoramento/crises — active crisis events
  // -------------------------------------------------------------------------
  fastify.get('/:id/monitoramento/crises', {
    onRequest: [fastify.authenticate],
  }, async (request, reply) => {
    const campaign = await getCampaign(request.params.id, request.user.id)
    if (!campaign) return reply.status(404).send({ error: 'Campanha não encontrada' })

    const { data, error } = await supabase
      .from('monitoring_events')
      .select('id, platform, content, url, sentiment, score_sentimento, topicos, resumo, data_publicacao, urgente, autor')
      .eq('campaign_id', campaign.id)
      .eq('sentiment', 'negativo')
      .order('score_sentimento', { ascending: true })
      .limit(30)

    if (error) return reply.status(500).send({ error: error.message })

    const crises_ativas = (data || []).filter(e => e.urgente)
    const alertas_negativos = (data || []).filter(e => !e.urgente)

    return {
      crises: crises_ativas,
      alertas: alertas_negativos,
      total_critico: crises_ativas.length,
      total_negativo: data?.length || 0
    }
  })

  // -------------------------------------------------------------------------
  // GET /campaigns/:id/monitoramento/adversarios — competitor monitoring
  // -------------------------------------------------------------------------
  fastify.get('/:id/monitoramento/adversarios', {
    onRequest: [fastify.authenticate],
  }, async (request, reply) => {
    const campaign = await getCampaign(request.params.id, request.user.id)
    if (!campaign) return reply.status(404).send({ error: 'Campanha não encontrada' })

    // Busca eventos marcados como adversário (tag ou plataforma específica)
    const { data, error } = await supabase
      .from('monitoring_events')
      .select('id, platform, content, url, sentiment, score_sentimento, topicos, resumo, data_publicacao, autor, tags')
      .eq('campaign_id', campaign.id)
      .contains('tags', ['adversario'])
      .order('data_publicacao', { ascending: false })
      .limit(30)

    if (error) {
      // Se falhar (ex: campo tags não existe ainda), retorna vazio
      return { adversarios: [], total: 0, message: 'Monitoramento de adversários disponível após configurar tracking' }
    }

    return { adversarios: data || [], total: data?.length || 0 }
  })
}

export default monitoramentoRoutes
