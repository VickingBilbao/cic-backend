/**
 * Estúdio de Avatar — Routes
 * CIC — Centro de Inteligência de Campanha
 *
 * Endpoints:
 *   GET    /campaigns/:id/avatar/avatares       — List available HeyGen avatars
 *   GET    /campaigns/:id/avatar/vozes          — List available HeyGen voices (pt-BR)
 *   POST   /campaigns/:id/avatar/gerar          — Enqueue async avatar video job
 *   GET    /campaigns/:id/avatar/job/:jobId     — Poll job status
 *   GET    /campaigns/:id/avatar/galeria        — List completed avatar videos
 *   DELETE /campaigns/:id/avatar/:assetId       — Delete video asset
 *   GET    /campaigns/:id/avatar/config         — Get campaign avatar config (avatarId, voiceId)
 *   PATCH  /campaigns/:id/avatar/config         — Set campaign avatar config
 */

import fp from 'fastify-plugin'
import { enqueueVideoJob } from '../queues/index.js'
import { resolveAssetUrls, deleteObject, resolveUrl } from '../services/r2.js'

const HEYGEN_BASE = 'https://api.heygen.com'

function heygenHeaders() {
  const key = process.env.HEYGEN_API_KEY
  if (!key) throw new Error('HEYGEN_API_KEY not set')
  return { 'X-Api-Key': key, 'Content-Type': 'application/json', Accept: 'application/json' }
}

async function avatarRoutes(fastify, opts) {
  const { supabase } = fastify

  // -------------------------------------------------------------------------
  // Helper: get campaign + verify access
  // -------------------------------------------------------------------------
  async function getCampaign(campaignId, userId) {
    const { data } = await supabase
      .from('campaigns')
      .select('id, org_id, candidato, partido, municipio, configuracoes')
      .eq('id', campaignId)
      .single()
    if (!data) return null
    const { data: profile } = await supabase
      .from('profiles').select('org_id').eq('id', userId).single()
    if (!profile || profile.org_id !== data.org_id) return null
    return data
  }

  // -------------------------------------------------------------------------
  // GET /campaigns/:id/avatar/avatares
  // Proxy HeyGen avatar list (cached 5 min in memory)
  // -------------------------------------------------------------------------
  let _avatarCache = null
  let _avatarCacheAt = 0

  fastify.get('/:id/avatar/avatares', {
    onRequest: [fastify.authenticate],
  }, async (request, reply) => {
    const campaign = await getCampaign(request.params.id, request.user.id)
    if (!campaign) return reply.status(404).send({ error: 'Campanha não encontrada' })

    if (_avatarCache && Date.now() - _avatarCacheAt < 300_000) {
      return { avatares: _avatarCache }
    }

    const res = await fetch(`${HEYGEN_BASE}/v2/avatars`, { headers: heygenHeaders() })
    const json = await res.json()
    if (!res.ok) return reply.status(502).send({ error: 'HeyGen API error', detail: json })

    _avatarCache = json.data?.avatars ?? []
    _avatarCacheAt = Date.now()
    return { avatares: _avatarCache }
  })

  // -------------------------------------------------------------------------
  // GET /campaigns/:id/avatar/vozes
  // Proxy HeyGen voices filtered to Portuguese
  // -------------------------------------------------------------------------
  let _voiceCache = null
  let _voiceCacheAt = 0

  fastify.get('/:id/avatar/vozes', {
    onRequest: [fastify.authenticate],
    schema: {
      querystring: {
        type: 'object',
        properties: { idioma: { type: 'string', default: 'pt' } },
      },
    },
  }, async (request, reply) => {
    const campaign = await getCampaign(request.params.id, request.user.id)
    if (!campaign) return reply.status(404).send({ error: 'Campanha não encontrada' })

    if (_voiceCache && Date.now() - _voiceCacheAt < 300_000) {
      return { vozes: _voiceCache }
    }

    const res = await fetch(`${HEYGEN_BASE}/v2/voices`, { headers: heygenHeaders() })
    const json = await res.json()
    if (!res.ok) return reply.status(502).send({ error: 'HeyGen API error', detail: json })

    const lang = request.query.idioma ?? 'pt'
    const vozes = (json.data?.voices ?? []).filter(v =>
      v.language?.toLowerCase().startsWith(lang)
    )
    _voiceCache = vozes
    _voiceCacheAt = Date.now()
    return { vozes }
  })

  // -------------------------------------------------------------------------
  // GET/PATCH /campaigns/:id/avatar/config
  // Store avatarId + voiceId chosen for this campaign
  // -------------------------------------------------------------------------
  fastify.get('/:id/avatar/config', {
    onRequest: [fastify.authenticate],
  }, async (request, reply) => {
    const campaign = await getCampaign(request.params.id, request.user.id)
    if (!campaign) return reply.status(404).send({ error: 'Campanha não encontrada' })
    const cfg = campaign.configuracoes?.avatar ?? {}
    return { avatarId: cfg.avatarId ?? null, voiceId: cfg.voiceId ?? null }
  })

  fastify.patch('/:id/avatar/config', {
    onRequest: [fastify.authenticate, fastify.requireRole('editor')],
    schema: {
      body: {
        type: 'object',
        properties: {
          avatarId: { type: 'string' },
          voiceId:  { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const campaign = await getCampaign(request.params.id, request.user.id)
    if (!campaign) return reply.status(404).send({ error: 'Campanha não encontrada' })

    // Merge into existing configuracoes.avatar
    const current = campaign.configuracoes ?? {}
    const updated = {
      ...current,
      avatar: { ...(current.avatar ?? {}), ...request.body },
    }

    const { error } = await supabase
      .from('campaigns')
      .update({ configuracoes: updated })
      .eq('id', campaign.id)

    if (error) return reply.status(500).send({ error: error.message })
    return updated.avatar
  })

  // -------------------------------------------------------------------------
  // POST /campaigns/:id/avatar/gerar
  // Enqueue HeyGen video generation job
  // -------------------------------------------------------------------------
  fastify.post('/:id/avatar/gerar', {
    onRequest: [fastify.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['script'],
        properties: {
          script:    { type: 'string', minLength: 10, maxLength: 5000 },
          avatarId:  { type: 'string' },   // override campaign default
          voiceId:   { type: 'string' },   // override campaign default
          titulo:    { type: 'string' },
          background:{ type: 'string' },   // hex color e.g. '#ffffff'
          ratio:     { type: 'string', enum: ['16:9', '9:16', '1:1'], default: '16:9' },
          roteiro_id:{ type: 'string' },   // content_item id to link back to
        },
      },
    },
  }, async (request, reply) => {
    const campaign = await getCampaign(request.params.id, request.user.id)
    if (!campaign) return reply.status(404).send({ error: 'Campanha não encontrada' })

    // Resolve avatar/voice: body overrides → campaign config → error
    const cfg = campaign.configuracoes?.avatar ?? {}
    const avatarId = request.body.avatarId ?? cfg.avatarId
    const voiceId  = request.body.voiceId  ?? cfg.voiceId

    if (!avatarId) return reply.status(400).send({ error: 'avatarId não configurado. Configure em /avatar/config primeiro.' })
    if (!voiceId)  return reply.status(400).send({ error: 'voiceId não configurado. Configure em /avatar/config primeiro.' })

    // Create job record
    const { data: jobRow, error: jobErr } = await supabase
      .from('jobs')
      .insert({
        campaign_id: campaign.id,
        tipo: 'video',
        status: 'queued',
        payload: request.body,
      })
      .select('id')
      .single()

    if (jobErr) return reply.status(500).send({ error: 'Erro ao criar job' })

    await enqueueVideoJob({
      jobId: jobRow.id,
      campaignId: campaign.id,
      orgId: campaign.org_id,
      data: { ...request.body, avatarId, voiceId },
    })

    return reply.status(202).send({ jobId: jobRow.id, status: 'queued' })
  })

  // -------------------------------------------------------------------------
  // GET /campaigns/:id/avatar/job/:jobId — Poll status
  // -------------------------------------------------------------------------
  fastify.get('/:id/avatar/job/:jobId', {
    onRequest: [fastify.authenticate],
  }, async (request, reply) => {
    const campaign = await getCampaign(request.params.id, request.user.id)
    if (!campaign) return reply.status(404).send({ error: 'Campanha não encontrada' })

    const { data: job, error } = await supabase
      .from('jobs')
      .select('id, status, result, error, created_at, finished_at')
      .eq('id', request.params.jobId)
      .eq('campaign_id', campaign.id)
      .single()

    if (error || !job) return reply.status(404).send({ error: 'Job não encontrado' })

    if (job.status === 'completed' && job.result?.storageKey) {
      job.result.url = await resolveUrl(job.result.storageKey)
    }

    return job
  })

  // -------------------------------------------------------------------------
  // GET /campaigns/:id/avatar/galeria — List videos
  // -------------------------------------------------------------------------
  fastify.get('/:id/avatar/galeria', {
    onRequest: [fastify.authenticate],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          limit:  { type: 'integer', default: 20 },
          offset: { type: 'integer', default: 0 },
        },
      },
    },
  }, async (request, reply) => {
    const campaign = await getCampaign(request.params.id, request.user.id)
    if (!campaign) return reply.status(404).send({ error: 'Campanha não encontrada' })

    const { data: assets, error } = await supabase
      .from('media_assets')
      .select('*')
      .eq('campaign_id', campaign.id)
      .eq('tipo', 'video_avatar')
      .order('created_at', { ascending: false })
      .range(request.query.offset, request.query.offset + request.query.limit - 1)

    if (error) return reply.status(500).send({ error: error.message })

    const withUrls = await resolveAssetUrls(assets)
    return { videos: withUrls }
  })

  // -------------------------------------------------------------------------
  // DELETE /campaigns/:id/avatar/:assetId
  // -------------------------------------------------------------------------
  fastify.delete('/:id/avatar/:assetId', {
    onRequest: [fastify.authenticate, fastify.requireRole('editor')],
  }, async (request, reply) => {
    const campaign = await getCampaign(request.params.id, request.user.id)
    if (!campaign) return reply.status(404).send({ error: 'Campanha não encontrada' })

    const { data: asset, error } = await supabase
      .from('media_assets')
      .select('id, storage_key')
      .eq('id', request.params.assetId)
      .eq('campaign_id', campaign.id)
      .single()

    if (error || !asset) return reply.status(404).send({ error: 'Asset não encontrado' })

    await deleteObject(asset.storage_key)
    await supabase.from('media_assets').delete().eq('id', asset.id)
    return reply.status(204).send()
  })
}

export default fp(avatarRoutes)
