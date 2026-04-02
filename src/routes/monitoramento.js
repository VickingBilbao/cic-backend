/**
 * Monitoramento — Routes
 * CIC — Centro de Inteligência de Campanha
 */

import Anthropic from '@anthropic-ai/sdk'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

// Mapeia sentimento PT (do Claude) → EN (padrão do banco)
const sentimentoToEN = { positivo: 'positive', negativo: 'negative', neutro: 'neutral', misto: 'neutral' }

// ── Analisa sentimento via Claude Haiku (rápido/barato)
async function analisarSentimento(texto, candidato) {
  try {
    const res = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      system: `Você analisa sentimento político de textos brasileiros.
Retorne SOMENTE JSON válido: { sentimento, score, topicos, urgente, resumo }
- sentimento: "positivo" | "negativo" | "neutro" | "misto"
- score: número de -1.0 a +1.0
- topicos: array de strings com temas (max 5)
- urgente: boolean (true se crítico/crise/denúncia)
- resumo: 1 frase resumindo o conteúdo`,
      messages: [{ role: 'user', content: `Candidato: ${candidato}\n\nTexto: ${texto.slice(0, 1500)}` }]
    })
    const raw = res.content[0].text.replace(/```json\n?|\n?```/g, '').trim()
    const parsed = JSON.parse(raw)
    return {
      ...parsed,
      sentimentoDB: sentimentoToEN[parsed.sentimento] || 'neutral', // valor para o DB
    }
  } catch {
    return { sentimento: 'neutro', sentimentoDB: 'neutral', score: 0, topicos: [], urgente: false, resumo: texto.slice(0, 100) }
  }
}

// ── Busca e parseia Google News RSS
async function fetchGoogleNewsRSS(query, maxItems = 10) {
  const encoded = encodeURIComponent(query)
  const url = `https://news.google.com/rss/search?q=${encoded}&hl=pt-BR&gl=BR&ceid=BR:pt-419`

  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CIC-Monitor/1.0)' },
    signal: AbortSignal.timeout(10000)
  })

  if (!res.ok) throw new Error(`Google News RSS error: ${res.status}`)
  const xml = await res.text()

  const items = []
  const itemMatches = xml.matchAll(/<item>([\s\S]*?)<\/item>/g)

  for (const match of itemMatches) {
    const block = match[1]
    const title   = (block.match(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/)  || [])[1]?.trim() || ''
    const link    = (block.match(/<link>(.*?)<\/link>/)                               || [])[1]?.trim() || ''
    const pubDate = (block.match(/<pubDate>(.*?)<\/pubDate>/)                         || [])[1]?.trim() || ''
    const source  = (block.match(/<source[^>]*>(.*?)<\/source>/)                      || [])[1]?.trim() || 'news'
    const desc    = (block.match(/<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/) || [])[1]
      ?.replace(/<[^>]+>/g, '').trim().slice(0, 500) || ''

    if (title) items.push({ title, link, pubDate, source, desc })
    if (items.length >= maxItems) break
  }

  return items
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
      .from('profiles').select('org_id, is_super_admin').eq('id', userId).single()
    if (!profile) return null
    if (profile.is_super_admin) return data
    if (profile.org_id !== data.org_id) return null
    return data
  }

  // ── GET /campaigns/:id/monitoramento
  fastify.get('/:id/monitoramento', {
    onRequest: [fastify.authenticate],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          sentimento: { type: 'string' },
          fonte:      { type: 'string' },
          urgente:    { type: 'boolean' },
          desde:      { type: 'string' },
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
      .order('created_at', { ascending: false })
      .range(request.query.offset, request.query.offset + (request.query.limite || 50) - 1)

    if (request.query.sentimento) {
      // Aceita PT ou EN
      const s = sentimentoToEN[request.query.sentimento] || request.query.sentimento
      q = q.eq('sentiment', s)
    }
    if (request.query.fonte) q = q.eq('platform', request.query.fonte)
    if (request.query.urgente !== undefined) q = q.eq('urgente', request.query.urgente)
    if (request.query.desde) q = q.gte('created_at', request.query.desde)

    const { data, error } = await q
    if (error) return reply.status(500).send({ error: error.message })
    return { eventos: data || [] }
  })

  // ── POST /campaigns/:id/monitoramento — evento manual com análise automática
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
    const analise = await analisarSentimento(texto, campaign.name)

    const { data, error } = await supabase
      .from('monitoring_events')
      .insert({
        campaign_id:      campaign.id,
        content:          texto,
        platform:         fonte ?? 'manual',
        url,
        autor,
        data_publicacao:  data_publicacao ?? new Date().toISOString(),
        sentiment:        analise.sentimentoDB,
        score_sentimento: analise.score,
        topicos:          analise.topicos,
        urgente:          analise.urgente,
        resumo:           analise.resumo,
      })
      .select('id').single()

    if (error) return reply.status(500).send({ error: error.message })
    return reply.status(201).send({ id: data.id, analise })
  })

  // ── GET /campaigns/:id/monitoramento/stats
  fastify.get('/:id/monitoramento/stats', {
    onRequest: [fastify.authenticate],
  }, async (request, reply) => {
    const campaign = await getCampaign(request.params.id, request.user.id)
    if (!campaign) return reply.status(404).send({ error: 'Campanha não encontrada' })

    const { data: recent } = await supabase
      .from('monitoring_events')
      .select('sentiment, score_sentimento, topicos, urgente')
      .eq('campaign_id', campaign.id)
      .order('created_at', { ascending: false })
      .limit(200)

    const events = recent ?? []
    const counts = {
      positivo: events.filter(e => e.sentiment === 'positive').length,
      negativo: events.filter(e => e.sentiment === 'negative').length,
      neutro:   events.filter(e => e.sentiment === 'neutral').length,
      urgentes: events.filter(e => e.urgente).length,
    }

    const topicMap = {}
    events.forEach(e => {
      ;(e.topicos ?? []).forEach(t => { topicMap[t] = (topicMap[t] ?? 0) + 1 })
    })
    const topTopicos = Object.entries(topicMap)
      .sort((a, b) => b[1] - a[1]).slice(0, 10)
      .map(([topic, count]) => ({ topic, count }))

    const scores = events.map(e => e.score_sentimento ?? 0)
    const avgScore = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0

    return { counts, topTopicos, avgScore: parseFloat(avgScore.toFixed(3)), total: events.length }
  })

  // ── POST /campaigns/:id/monitoramento/analisar — analisa eventos sem sentimento
  fastify.post('/:id/monitoramento/analisar', {
    onRequest: [fastify.authenticate],
  }, async (request, reply) => {
    const campaign = await getCampaign(request.params.id, request.user.id)
    if (!campaign) return reply.status(404).send({ error: 'Campanha não encontrada' })

    const { data: pendentes } = await supabase
      .from('monitoring_events')
      .select('id, content')
      .eq('campaign_id', campaign.id)
      .is('sentiment', null)
      .limit(20)

    if (!pendentes?.length) return { message: 'Nenhum evento pendente', analisados: 0 }

    let analisados = 0
    for (const evento of pendentes) {
      const analise = await analisarSentimento(evento.content, campaign.name)
      await supabase.from('monitoring_events').update({
        sentiment:        analise.sentimentoDB,
        score_sentimento: analise.score,
        topicos:          analise.topicos,
        urgente:          analise.urgente,
        resumo:           analise.resumo,
      }).eq('id', evento.id)
      analisados++
    }

    return reply.status(202).send({ analisados, status: 'concluido' })
  })

  // ── POST /campaigns/:id/monitoramento/buscar-news — Google News RSS
  fastify.post('/:id/monitoramento/buscar-news', {
    onRequest: [fastify.authenticate],
    schema: {
      body: {
        type: 'object',
        properties: {
          keywords: { type: 'array', items: { type: 'string' } },
          maxItems: { type: 'integer', default: 10, maximum: 20 },
        },
      },
    },
  }, async (request, reply) => {
    const campaign = await getCampaign(request.params.id, request.user.id)
    if (!campaign) return reply.status(404).send({ error: 'Campanha não encontrada' })

    const keywords = request.body?.keywords ?? [campaign.name, `${campaign.name} ${campaign.cargo}`]
    const maxItems = request.body?.maxItems ?? 10
    const saved = [], errors = []

    for (const kw of keywords.slice(0, 3)) {
      try {
        const items = await fetchGoogleNewsRSS(kw, maxItems)

        for (const item of items) {
          if (item.link) {
            const { data: existing } = await supabase
              .from('monitoring_events').select('id').eq('url', item.link).single()
            if (existing) continue
          }

          const texto  = `${item.title}. ${item.desc}`
          const analise = await analisarSentimento(texto, campaign.name)

          const { data: ev, error } = await supabase.from('monitoring_events').insert({
            campaign_id:      campaign.id,
            content:          item.title,
            platform:         'news',
            url:              item.link || null,
            autor:            item.source,
            resumo:           item.desc?.slice(0, 300),
            data_publicacao:  item.pubDate ? new Date(item.pubDate).toISOString() : new Date().toISOString(),
            sentiment:        analise.sentimentoDB,
            score_sentimento: analise.score,
            topicos:          analise.topicos,
            urgente:          analise.urgente,
          }).select('id').single()

          if (!error && ev) saved.push(ev.id)
        }
      } catch (err) {
        errors.push({ keyword: kw, error: err.message })
      }
    }

    return {
      salvos: saved.length, ids: saved, erros: errors, keywords,
      message: `${saved.length} eventos coletados e analisados`
    }
  })

  // ── POST /campaigns/:id/monitoramento/buscar — Apify ou fallback
  fastify.post('/:id/monitoramento/buscar', {
    onRequest: [fastify.authenticate],
  }, async (request, reply) => {
    const campaign = await getCampaign(request.params.id, request.user.id)
    if (!campaign) return reply.status(404).send({ error: 'Campanha não encontrada' })

    if (!process.env.APIFY_TOKEN) {
      return reply.redirect(307, `/${request.params.id}/monitoramento/buscar-news`)
    }

    const token    = process.env.APIFY_TOKEN
    const keywords = request.body?.keywords ?? [campaign.name, campaign.cargo, campaign.city].filter(Boolean)
    const webhookUrl = `${process.env.API_BASE_URL ?? 'https://cic-backend-production-74a6.up.railway.app'}/api/v1/campaigns/${campaign.id}/monitoramento/webhook`

    const res = await fetch(`https://api.apify.com/v2/acts/apify~google-search-scraper/runs?token=${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ queries: keywords.join('\n'), maxPagesPerQuery: 1, resultsPerPage: 10,
        webhooks: [{ eventTypes: ['ACTOR.RUN.SUCCEEDED'], requestUrl: webhookUrl }] }),
    })

    const json = await res.json()
    if (!res.ok) return reply.status(502).send({ error: 'Apify trigger failed', detail: json })
    return reply.status(202).send({ apifyRunId: json.data?.id, status: 'running', keywords })
  })

  // ── POST /campaigns/:id/monitoramento/webhook
  fastify.post('/:id/monitoramento/webhook', {
    config: { skipAuth: true },
  }, async (request, reply) => {
    const secret = process.env.APIFY_WEBHOOK_SECRET
    if (secret) {
      const provided = request.headers['x-apify-secret'] ?? request.headers['authorization']
      if (provided !== secret && provided !== `Bearer ${secret}`) {
        return reply.status(401).send({ error: 'Invalid webhook secret' })
      }
    }
    const runId = request.body?.resource?.id ?? request.body?.actorRunId
    if (!runId) return reply.status(400).send({ error: 'Missing actor run ID' })
    return { ok: true }
  })

  // ── GET /campaigns/:id/monitoramento/alertas
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
      .order('created_at', { ascending: false })
      .limit(20)

    if (error) return reply.status(500).send({ error: error.message })
    return { alertas: data || [] }
  })

  // ── PATCH /campaigns/:id/monitoramento/:eventId
  fastify.patch('/:id/monitoramento/:eventId', {
    onRequest: [fastify.authenticate],
  }, async (request, reply) => {
    const campaign = await getCampaign(request.params.id, request.user.id)
    if (!campaign) return reply.status(404).send({ error: 'Campanha não encontrada' })
    const { error } = await supabase.from('monitoring_events')
      .update(request.body).eq('id', request.params.eventId).eq('campaign_id', campaign.id)
    if (error) return reply.status(500).send({ error: error.message })
    return { ok: true }
  })

  // ── GET /campaigns/:id/monitoramento/redes
  fastify.get('/:id/monitoramento/redes', {
    onRequest: [fastify.authenticate],
  }, async (request, reply) => {
    const campaign = await getCampaign(request.params.id, request.user.id)
    if (!campaign) return reply.status(404).send({ error: 'Campanha não encontrada' })

    const { data, error } = await supabase
      .from('monitoring_events')
      .select('id, platform, content, url, sentiment, score_sentimento, topicos, resumo, data_publicacao, autor')
      .eq('campaign_id', campaign.id)
      .order('created_at', { ascending: false })
      .limit(50)

    if (error) return reply.status(500).send({ error: error.message })

    const byPlatform = {}
    for (const ev of (data || [])) {
      const p = ev.platform || 'outros'
      if (!byPlatform[p]) byPlatform[p] = { total: 0, positive: 0, negative: 0, neutral: 0 }
      byPlatform[p].total++
      if (ev.sentiment) byPlatform[p][ev.sentiment] = (byPlatform[p][ev.sentiment] || 0) + 1
    }

    return { eventos: data || [], porPlataforma: byPlatform, total: data?.length || 0 }
  })

  // ── GET /campaigns/:id/monitoramento/crises
  fastify.get('/:id/monitoramento/crises', {
    onRequest: [fastify.authenticate],
  }, async (request, reply) => {
    const campaign = await getCampaign(request.params.id, request.user.id)
    if (!campaign) return reply.status(404).send({ error: 'Campanha não encontrada' })

    const { data, error } = await supabase
      .from('monitoring_events')
      .select('id, platform, content, url, sentiment, score_sentimento, topicos, resumo, data_publicacao, urgente, autor')
      .eq('campaign_id', campaign.id)
      .eq('sentiment', 'negative')
      .order('created_at', { ascending: false })
      .limit(30)

    if (error) return reply.status(500).send({ error: error.message })

    return {
      crises:         (data || []).filter(e => e.urgente),
      alertas:        (data || []).filter(e => !e.urgente),
      total_critico:  (data || []).filter(e => e.urgente).length,
      total_negativo: data?.length || 0,
    }
  })

  // ── GET /campaigns/:id/monitoramento/adversarios
  fastify.get('/:id/monitoramento/adversarios', {
    onRequest: [fastify.authenticate],
  }, async (request, reply) => {
    const campaign = await getCampaign(request.params.id, request.user.id)
    if (!campaign) return reply.status(404).send({ error: 'Campanha não encontrada' })

    const { data, error } = await supabase
      .from('monitoring_events')
      .select('id, platform, content, url, sentiment, score_sentimento, topicos, resumo, data_publicacao, autor, tags')
      .eq('campaign_id', campaign.id)
      .contains('tags', ['adversario'])
      .order('created_at', { ascending: false })
      .limit(30)

    if (error) return { adversarios: [], total: 0 }
    return { adversarios: data || [], total: data?.length || 0 }
  })
}

export default monitoramentoRoutes
