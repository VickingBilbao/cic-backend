/**
 * Monitoring Worker — BullMQ
 * CIC — Centro de Inteligência de Campanha
 *
 * Processes jobs from the 'cic:monitoring' queue.
 *
 * Two job types:
 *   'sentiment'   — Analyse a batch of monitoring_events with Claude Sonnet
 *   'apify-fetch' — Fetch results from a completed Apify actor run
 *
 * Flow for 'sentiment':
 *   1. Load up to 50 unanalysed monitoring_events for a campaign
 *   2. Batch them into a single Claude Sonnet call
 *   3. Parse structured JSON response: { sentimento, score, topicos, resumo }
 *   4. Update each event row with sentiment data
 *   5. If avg score < -0.4 → create alert notification
 *
 * Flow for 'apify-fetch':
 *   1. Fetch results from Apify dataset via API
 *   2. Upsert as monitoring_events
 *   3. Enqueue 'sentiment' job for the new batch
 */

import { Worker, Queue } from 'bullmq'
import Anthropic from '@anthropic-ai/sdk'
import { createClient } from '@supabase/supabase-js'

export const MONITORING_QUEUE_NAME = 'cic:monitoring'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

// ---------------------------------------------------------------------------
// Sentiment analysis via Claude Sonnet
// ---------------------------------------------------------------------------

const SENTIMENT_SYSTEM = `Você é um especialista em análise de sentimento político.
Analise menções ao candidato/campanha e retorne JSON estruturado.
SEMPRE retorne um array JSON válido, sem markdown, sem texto extra.`

const SENTIMENT_USER_TEMPLATE = (candidato, mencoes) => `
Candidato: ${candidato}

Analise as seguintes ${mencoes.length} menções e retorne um array JSON onde cada objeto tem:
- id: o id da menção (string, exatamente como fornecido)
- sentimento: "positivo" | "negativo" | "neutro" | "misto"
- score: número de -1.0 (muito negativo) a 1.0 (muito positivo)
- topicos: array de strings com até 5 tópicos identificados
- resumo: string de 1 frase resumindo o conteúdo
- urgente: boolean — true se requer resposta imediata (crise, acusação grave, fake news)

Menções:
${mencoes.map(m => `---\nID: ${m.id}\nFonte: ${m.fonte}\nTexto: ${m.texto}\n`).join('\n')}

Retorne APENAS o array JSON, sem markdown.`

async function analyseSentiment(campaignId, candidato) {
  // Load pending events (sem análise)
  const { data: events } = await supabase
    .from('monitoring_events')
    .select('id, fonte, texto, sentimento')
    .eq('campaign_id', campaignId)
    .is('sentimento', null)
    .limit(50)

  if (!events || events.length === 0) return { analysed: 0 }

  const mencoes = events.map(e => ({ id: e.id, fonte: e.fonte ?? 'web', texto: (e.texto ?? '').slice(0, 400) }))

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4000,
    system: SENTIMENT_SYSTEM,
    messages: [{ role: 'user', content: SENTIMENT_USER_TEMPLATE(candidato, mencoes) }],
  })

  let results
  try {
    results = JSON.parse(message.content[0].text)
  } catch {
    throw new Error(`Claude returned invalid JSON for sentiment: ${message.content[0].text.slice(0, 200)}`)
  }

  // Batch update each event
  const updates = results.map(r =>
    supabase.from('monitoring_events').update({
      sentimento: r.sentimento,
      score_sentimento: r.score,
      topicos: r.topicos ?? [],
      resumo: r.resumo,
      urgente: r.urgente ?? false,
    }).eq('id', r.id)
  )
  await Promise.all(updates)

  // Alert if average sentiment < -0.4 or any urgent events
  const scores = results.map(r => r.score ?? 0)
  const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length
  const urgentEvents = results.filter(r => r.urgente)

  if (avgScore < -0.4 || urgentEvents.length > 0) {
    const msg = urgentEvents.length > 0
      ? `🚨 ${urgentEvents.length} menção(ões) urgente(s) detectada(s). Resposta imediata recomendada.`
      : `⚠️ Sentimento médio negativo (${avgScore.toFixed(2)}) em ${events.length} menções recentes.`

    await supabase.from('notificacoes').insert({
      campaign_id: campaignId,
      tipo: 'alerta_monitoramento',
      titulo: urgentEvents.length > 0 ? 'Crise detectada' : 'Sentimento negativo',
      mensagem: msg,
      metadados: { avgScore, urgentCount: urgentEvents.length, eventCount: events.length },
      lida: false,
    })
  }

  return { analysed: events.length, avgScore, urgentCount: urgentEvents.length }
}

// ---------------------------------------------------------------------------
// Apify result fetch
// ---------------------------------------------------------------------------
async function fetchApifyResults(campaignId, runId) {
  const token = process.env.APIFY_TOKEN
  if (!token) throw new Error('APIFY_TOKEN not set')

  const res = await fetch(
    `https://api.apify.com/v2/actor-runs/${runId}/dataset/items?token=${token}&format=json&limit=200`
  )
  if (!res.ok) throw new Error(`Apify fetch failed: ${res.status}`)
  const items = await res.json()

  if (!items.length) return { inserted: 0 }

  // Normalise Apify items → monitoring_events shape
  const eventos = items.map(item => ({
    campaign_id: campaignId,
    fonte: item.url?.includes('twitter') || item.url?.includes('x.com') ? 'twitter'
          : item.url?.includes('facebook') ? 'facebook'
          : item.url?.includes('instagram') ? 'instagram'
          : item.url?.includes('youtube') ? 'youtube'
          : 'web',
    texto: item.text ?? item.content ?? item.title ?? '',
    url: item.url ?? null,
    autor: item.author ?? item.username ?? null,
    data_publicacao: item.date ?? item.createdAt ?? new Date().toISOString(),
    raw: item,
  })).filter(e => e.texto.length > 10)

  const { error } = await supabase
    .from('monitoring_events')
    .upsert(eventos, { onConflict: 'url', ignoreDuplicates: true })

  if (error) throw new Error(`Upsert monitoring_events failed: ${error.message}`)
  return { inserted: eventos.length }
}

// ---------------------------------------------------------------------------
// Main job processor
// ---------------------------------------------------------------------------
async function processMonitoringJob(job) {
  const { type, campaignId, candidato, apifyRunId } = job.data

  if (type === 'sentiment') {
    return analyseSentiment(campaignId, candidato)
  }

  if (type === 'apify-fetch') {
    const fetchResult = await fetchApifyResults(campaignId, apifyRunId)
    // After fetching, trigger sentiment analysis on the new data
    const queue = new Queue(MONITORING_QUEUE_NAME, {
      connection: { url: process.env.REDIS_URL },
    })
    await queue.add('analyse', { type: 'sentiment', campaignId, candidato })
    await queue.close()
    return fetchResult
  }

  throw new Error(`Unknown monitoring job type: ${type}`)
}

// ---------------------------------------------------------------------------
// Worker export
// ---------------------------------------------------------------------------
export function startMonitoringWorker(connection) {
  const worker = new Worker(
    MONITORING_QUEUE_NAME,
    processMonitoringJob,
    {
      connection,
      concurrency: 3,
      removeOnComplete: { count: 500 },
      removeOnFail:    { count: 100 },
    }
  )

  worker.on('completed', job => {
    console.log(`[monitoring-worker] ✅ ${job.data.type} completed for campaign ${job.data.campaignId}`)
  })
  worker.on('failed', (job, err) => {
    console.error(`[monitoring-worker] ❌ Job ${job?.id} failed:`, err.message)
  })
  worker.on('error', err => console.error('[monitoring-worker] Worker error:', err))

  console.log('[monitoring-worker] Started — listening on cic:monitoring queue')
  return worker
}
