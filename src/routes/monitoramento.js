/**
 * Monitoramento — Routes
 * CIC — Centro de Inteligência de Campanha
 *
 * Fontes cobertas:
 *  - Google News RSS (candidato + adversários + cidade)
 *  - Agência Brasil (EBC) RSS — notícias oficiais federais
 *  - G1 Política RSS — cobertura nacional/regional
 *  - Câmara dos Deputados RSS — legislativo federal
 *  - TSE Notícias RSS — justiça eleitoral
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
      sentimentoDB: sentimentoToEN[parsed.sentimento] || 'neutral',
    }
  } catch {
    return { sentimento: 'neutro', sentimentoDB: 'neutral', score: 0, topicos: [], urgente: false, resumo: texto.slice(0, 100) }
  }
}

// ── Parser genérico de RSS/Atom XML
function parseRSS(xml, maxItems = 15) {
  const items = []
  // Suporta <item> (RSS) e <entry> (Atom)
  const tagRgx = xml.includes('<entry') ? /<entry>([\s\S]*?)<\/entry>/g : /<item>([\s\S]*?)<\/item>/g
  for (const match of xml.matchAll(tagRgx)) {
    const block = match[1]
    const title   = (block.match(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/)  || [])[1]?.trim().replace(/&amp;/g,'&').replace(/&lt;/g,'<') || ''
    const link    = (block.match(/<link[^>]*>([^<]+)<\/link>/)                        || block.match(/<link[^/]*href="([^"]+)"/))[1]?.trim()        || ''
    const pubDate = (block.match(/<pubDate>(.*?)<\/pubDate>/)
                  || block.match(/<published>(.*?)<\/published>/)                     || [])[1]?.trim() || ''
    const source  = (block.match(/<source[^>]*>(.*?)<\/source>/)                      || [])[1]?.trim() || ''
    const desc    = (block.match(/<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/)
                  || block.match(/<summary[^>]*>([\s\S]*?)<\/summary>/)               || [])[1]
      ?.replace(/<[^>]+>/g, '').replace(/&amp;/g,'&').replace(/&#\d+;/g,' ').trim().slice(0, 500) || ''

    if (title) items.push({ title, link, pubDate, source, desc })
    if (items.length >= maxItems) break
  }
  return items
}

// ── Fetch genérico de RSS com timeout
async function fetchRSS(url, maxItems = 10) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CIC-Monitor/2.0; +https://cic.com.br)' },
    signal: AbortSignal.timeout(12000)
  })
  if (!res.ok) throw new Error(`RSS fetch error ${res.status}: ${url}`)
  const xml = await res.text()
  return parseRSS(xml, maxItems)
}

// ── Google News RSS
async function fetchGoogleNewsRSS(query, maxItems = 10) {
  const encoded = encodeURIComponent(query)
  return fetchRSS(
    `https://news.google.com/rss/search?q=${encoded}&hl=pt-BR&gl=BR&ceid=BR:pt-419`,
    maxItems
  )
}

// ── Agência Brasil (EBC) — feeds oficiais
const AGENCIA_BRASIL_FEEDS = {
  politica:    'https://agenciabrasil.ebc.com.br/politica/feed/atom/',
  eleicoes:    'https://agenciabrasil.ebc.com.br/politica/eleicoes/feed/atom/',
  geral:       'https://agenciabrasil.ebc.com.br/feed/atom/',
}
async function fetchAgenciaBrasil(categoria = 'politica', maxItems = 8) {
  const url = AGENCIA_BRASIL_FEEDS[categoria] || AGENCIA_BRASIL_FEEDS.geral
  const items = await fetchRSS(url, maxItems)
  return items.map(i => ({ ...i, fonte_sistema: 'agencia_brasil' }))
}

// ── G1 Política RSS
async function fetchG1Politica(maxItems = 8) {
  const items = await fetchRSS('https://g1.globo.com/politica/rss2.xml', maxItems)
  return items.map(i => ({ ...i, fonte_sistema: 'g1_politica' }))
}

// ── Câmara dos Deputados RSS
const CAMARA_FEEDS = {
  noticias: 'https://www.camara.leg.br/noticias/rss/',
  votacoes: 'https://www.camara.leg.br/votacoesWeb/rss/votacao-deputado/',
}
async function fetchCamara(maxItems = 6) {
  const items = await fetchRSS(CAMARA_FEEDS.noticias, maxItems)
  return items.map(i => ({ ...i, fonte_sistema: 'camara_deputados' }))
}

// ── TSE Notícias
async function fetchTSE(maxItems = 6) {
  const items = await fetchRSS('https://www.tse.jus.br/comunicacao/noticias/rss.xml', maxItems)
  return items.map(i => ({ ...i, fonte_sistema: 'tse' }))
}

// ── Salva itens RSS no banco com análise Claude
async function saveNewsItems(supabase, campaign, items, plataforma, extraTags = []) {
  const saved = []
  for (const item of items) {
    if (item.link) {
      const { data: existing } = await supabase
        .from('monitoring_events').select('id').eq('url', item.link).maybeSingle()
      if (existing) continue
    }

    const texto   = `${item.title}. ${item.desc}`
    const analise = await analisarSentimento(texto, campaign.name)

    const tags = [...extraTags, item.fonte_sistema].filter(Boolean)

    const { data: ev, error } = await supabase.from('monitoring_events').insert({
      campaign_id:      campaign.id,
      content:          item.title,
      platform:         plataforma,
      url:              item.link || null,
      autor:            item.source || plataforma,
      resumo:           item.desc?.slice(0, 300),
      tags,
      data_publicacao:  item.pubDate ? new Date(item.pubDate).toISOString() : new Date().toISOString(),
      sentiment:        analise.sentimentoDB,
      score_sentimento: analise.score,
      topicos:          analise.topicos,
      urgente:          analise.urgente,
    }).select('id').single()

    if (!error && ev) saved.push(ev.id)
  }
  return saved
}

// ───────────────────────────────────────────────────────────────────────────
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

  // ── POST /campaigns/:id/monitoramento — evento manual
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

    const { data, error } = await supabase.from('monitoring_events').insert({
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
    }).select('id').single()

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
      .select('sentiment, score_sentimento, topicos, urgente, platform')
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
    events.forEach(e => (e.topicos ?? []).forEach(t => { topicMap[t] = (topicMap[t] ?? 0) + 1 }))
    const topTopicos = Object.entries(topicMap)
      .sort((a, b) => b[1] - a[1]).slice(0, 10)
      .map(([topic, count]) => ({ topic, count }))

    const fonteMap = {}
    events.forEach(e => { const p = e.platform || 'outros'; fonteMap[p] = (fonteMap[p] ?? 0) + 1 })

    const scores  = events.map(e => e.score_sentimento ?? 0)
    const avgScore = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0

    return { counts, topTopicos, fontes: fonteMap, avgScore: parseFloat(avgScore.toFixed(3)), total: events.length }
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

  // ── POST /campaigns/:id/monitoramento/buscar-news — Google News RSS (candidato)
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

    const keywords = request.body?.keywords ?? [
      campaign.name,
      `${campaign.name} ${campaign.cargo}`,
      `${campaign.name} ${campaign.city}`,
    ]
    const maxItems = request.body?.maxItems ?? 10
    const saved = [], errors = []

    for (const kw of keywords.slice(0, 4)) {
      try {
        const items = await fetchGoogleNewsRSS(kw, maxItems)
        const ids = await saveNewsItems(supabase, campaign, items, 'news', ['google_news'])
        saved.push(...ids)
      } catch (err) {
        errors.push({ keyword: kw, error: err.message })
      }
    }

    return {
      salvos: saved.length, ids: saved, erros: errors, keywords,
      message: `${saved.length} eventos coletados via Google News`
    }
  })

  // ── POST /campaigns/:id/monitoramento/buscar-fontes-oficiais
  //    Coleta em paralelo: Agência Brasil + G1 Política + Câmara + TSE
  //    + Google News filtrado por cidade/estado
  fastify.post('/:id/monitoramento/buscar-fontes-oficiais', {
    onRequest: [fastify.authenticate],
    schema: {
      body: {
        type: 'object',
        properties: {
          fontes: {
            type: 'array',
            items: { type: 'string', enum: ['agencia_brasil', 'g1', 'camara', 'tse', 'google_news'] },
            default: ['agencia_brasil', 'g1', 'camara', 'tse', 'google_news'],
          },
          maxPorFonte: { type: 'integer', default: 6, maximum: 15 },
        },
      },
    },
  }, async (request, reply) => {
    const campaign = await getCampaign(request.params.id, request.user.id)
    if (!campaign) return reply.status(404).send({ error: 'Campanha não encontrada' })

    const fontes     = request.body?.fontes ?? ['agencia_brasil', 'g1', 'camara', 'tse', 'google_news']
    const maxPorFonte = request.body?.maxPorFonte ?? 6

    // Fetch em paralelo
    const fetchTasks = {}
    if (fontes.includes('agencia_brasil')) fetchTasks.agencia_brasil = fetchAgenciaBrasil('politica', maxPorFonte).catch(e => ({ error: e.message }))
    if (fontes.includes('g1'))             fetchTasks.g1             = fetchG1Politica(maxPorFonte).catch(e => ({ error: e.message }))
    if (fontes.includes('camara'))         fetchTasks.camara         = fetchCamara(maxPorFonte).catch(e => ({ error: e.message }))
    if (fontes.includes('tse'))            fetchTasks.tse            = fetchTSE(maxPorFonte).catch(e => ({ error: e.message }))
    if (fontes.includes('google_news')) {
      // Busca contextual: cidade + estado + cargo
      const q = `eleições ${campaign.city} ${campaign.state} ${campaign.cargo}`
      fetchTasks.google_news_local = fetchGoogleNewsRSS(q, maxPorFonte).catch(e => ({ error: e.message }))
      fetchTasks.google_news_cand  = fetchGoogleNewsRSS(campaign.name, maxPorFonte).catch(e => ({ error: e.message }))
    }

    const results   = await Promise.all(Object.entries(fetchTasks).map(([k, p]) => p.then(r => [k, r])))
    const summary   = {}
    const allSaved  = []
    const allErrors = []

    for (const [fonte, itemsOrErr] of results) {
      if (itemsOrErr?.error) {
        allErrors.push({ fonte, error: itemsOrErr.error })
        summary[fonte] = { error: itemsOrErr.error }
        continue
      }
      const plataforma = fonte.startsWith('google_news') ? 'news' : fonte
      const tags       = [fonte]
      const saved = await saveNewsItems(supabase, campaign, itemsOrErr, plataforma, tags)
      allSaved.push(...saved)
      summary[fonte] = { coletados: itemsOrErr.length, salvos: saved.length }
    }

    return reply.status(202).send({
      total_salvos:  allSaved.length,
      por_fonte:     summary,
      erros:         allErrors,
      message:       `${allSaved.length} eventos coletados de ${Object.keys(summary).length} fontes oficiais`,
    })
  })

  // ── POST /campaigns/:id/monitoramento/buscar — Apify ou fallback
  fastify.post('/:id/monitoramento/buscar', {
    onRequest: [fastify.authenticate],
  }, async (request, reply) => {
    const campaign = await getCampaign(request.params.id, request.user.id)
    if (!campaign) return reply.status(404).send({ error: 'Campanha não encontrada' })

    if (!process.env.APIFY_TOKEN) {
      // Usa fontes oficiais como fallback robusto
      return reply.redirect(307, `/api/v1/campaigns/${request.params.id}/monitoramento/buscar-fontes-oficiais`)
    }

    const token    = process.env.APIFY_TOKEN
    const keywords = request.body?.keywords ?? [campaign.name, campaign.cargo, campaign.city].filter(Boolean)
    const webhookUrl = `${process.env.API_BASE_URL ?? 'https://cic-backend-production-74a6.up.railway.app'}/api/v1/campaigns/${campaign.id}/monitoramento/webhook`

    const res = await fetch(`https://api.apify.com/v2/acts/apify~google-search-scraper/runs?token=${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        queries:          keywords.join('\n'),
        maxPagesPerQuery: 1,
        resultsPerPage:   10,
        webhooks: [{ eventTypes: ['ACTOR.RUN.SUCCEEDED'], requestUrl: webhookUrl }],
      }),
    })

    const json = await res.json()
    if (!res.ok) return reply.status(502).send({ error: 'Apify trigger failed', detail: json })
    return reply.status(202).send({ apifyRunId: json.data?.id, status: 'running', keywords })
  })

  // ── POST /campaigns/:id/monitoramento/webhook — Apify callback
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
      .select('id, platform, content, url, sentiment, score_sentimento, topicos, resumo, data_publicacao, urgente, autor, tags')
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
      .select('id, platform, content, url, sentiment, score_sentimento, topicos, resumo, data_publicacao, autor, tags')
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
      .select('id, platform, content, url, sentiment, score_sentimento, topicos, resumo, data_publicacao, urgente, autor, tags')
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

  // ── GET /campaigns/:id/monitoramento/fontes — lista fontes disponíveis
  fastify.get('/:id/monitoramento/fontes', {
    onRequest: [fastify.authenticate],
  }, async (request, reply) => {
    return {
      fontes: [
        { id: 'agencia_brasil', nome: 'Agência Brasil (EBC)', tipo: 'oficial', url: 'https://agenciabrasil.ebc.com.br', cobertura: 'Federal' },
        { id: 'g1',            nome: 'G1 Política',           tipo: 'imprensa', url: 'https://g1.globo.com/politica', cobertura: 'Nacional' },
        { id: 'camara',        nome: 'Câmara dos Deputados',  tipo: 'oficial', url: 'https://www.camara.leg.br', cobertura: 'Federal' },
        { id: 'tse',           nome: 'TSE Notícias',          tipo: 'eleitoral', url: 'https://www.tse.jus.br', cobertura: 'Federal' },
        { id: 'google_news',   nome: 'Google News',           tipo: 'agregador', url: 'https://news.google.com', cobertura: 'Regional/Nacional' },
      ],
    }
  })
}

export default monitoramentoRoutes
